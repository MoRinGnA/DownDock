//! 데스크톱 복제(DXGI Desktop Duplication)로 유리 표면 뒤 픽셀을 실시간으로 받는다.
//!
//! GDI BitBlt는 화면 한 장에 ~17ms가 들어 실시간이 불가능하다. DDA는 합성된 프레임을
//! GPU 텍스처로 주므로, 관심 영역만 잘라 읽으면 한 프레임에 1ms 안쪽으로 끝난다.
//! 캡처 스레드는 요청된 사각형(도크/패널 표면)만 잘라 최신 프레임 하나를 공유 상태에
//! 넣고, 프런트엔드는 `backdrop_frame`으로 새 세대(generation)일 때만 가져간다.

use std::sync::{Arc, Mutex};

use tauri::WebviewWindow;
use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BOX,
    D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    IDXGIAdapter, IDXGIDevice, IDXGIOutput1, IDXGIOutputDuplication, DXGI_ERROR_ACCESS_LOST,
    DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTPUT_DESC,
};

/// 1:1로 쓴다. 줄이면 175% 화면에서 2배 넘게 다시 늘어나 유리가 뿌옇게 보인다.
const DOWNSCALE: i32 = 1;

/// 복제를 새로 만든 뒤 버릴 프레임 수. 이 동안은 아직 칠해지지 않은 검은 화면이 온다.
const WARMUP_FRAMES: u32 = 3;

/// 화면 물리 픽셀 기준 사각형.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Region {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone)]
pub struct Frame {
    pub gen: u64,
    pub width: u32,
    pub height: u32,
    /// 프레임 평균 밝기(0..255). 배경이 어두우면 프런트가 어두운 테마로 바꾼다.
    pub luminance: u32,
    pub rgba: Vec<u8>,
}

/// `backdrop_frame` 응답 헤더: gen(8) + width(4) + height(4) + luminance(4).
pub const HEADER_LEN: usize = 20;

struct Shared {
    /// 화면 전체 좌표(물리) 기준으로 잡아 둔 캡처 영역.
    region: Option<Region>,
    latest: Option<Frame>,
    gen: u64,
    /// 복제 객체를 만들지 못했으면 프런트엔드가 GDI 캡처로 폴백한다.
    alive: bool,
}

pub struct Backdrop {
    shared: Arc<Mutex<Shared>>,
}

impl Backdrop {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared {
                region: None,
                latest: None,
                gen: 0,
                alive: false,
            })),
        }
    }

    pub fn start(&self) {
        let shared = Arc::clone(&self.shared);
        std::thread::spawn(move || run(shared));
    }
}

/// 프런트엔드가 표면 사각형(뷰포트 기준 CSS px)을 알려 준다.
#[tauri::command]
pub fn set_backdrop_region(
    window: WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    backdrop: tauri::State<Backdrop>,
) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let region = Region {
        x: origin.x + (x * scale).round() as i32,
        y: origin.y + (y * scale).round() as i32,
        width: ((width * scale).round() as i32).max(1),
        height: ((height * scale).round() as i32).max(1),
    };
    let mut shared = backdrop.shared.lock().map_err(|e| e.to_string())?;
    if shared.region != Some(region) {
        shared.region = Some(region);
        // 영역이 바뀌면 이전 프레임은 다른 위치의 픽셀이라 버린다.
        shared.latest = None;
        shared.gen += 1;
    }
    Ok(())
}

/// 새 프레임이 있으면 [gen(8) | width(4) | height(4) | luminance(4) | RGBA] 를,
/// 없으면 빈 바이트를 준다.
#[tauri::command]
pub fn backdrop_frame(since: u64, backdrop: tauri::State<Backdrop>) -> tauri::ipc::Response {
    let shared = match backdrop.shared.lock() {
        Ok(g) => g,
        Err(_) => return tauri::ipc::Response::new(Vec::new()),
    };
    let Some(frame) = shared.latest.as_ref() else {
        return tauri::ipc::Response::new(Vec::new());
    };
    if frame.gen <= since {
        return tauri::ipc::Response::new(Vec::new());
    }
    let mut out = Vec::with_capacity(HEADER_LEN + frame.rgba.len());
    out.extend_from_slice(&frame.gen.to_le_bytes());
    out.extend_from_slice(&frame.width.to_le_bytes());
    out.extend_from_slice(&frame.height.to_le_bytes());
    out.extend_from_slice(&frame.luminance.to_le_bytes());
    out.extend_from_slice(&frame.rgba);
    tauri::ipc::Response::new(out)
}

/// 복제를 만들 수 있었는지. 프런트엔드는 false면 GDI 캡처로 폴백한다.
#[tauri::command]
pub fn backdrop_alive(backdrop: tauri::State<Backdrop>) -> bool {
    backdrop.shared.lock().map(|s| s.alive).unwrap_or(false)
}

fn run(shared: Arc<Mutex<Shared>>) {
    let Some((device, context)) = create_device() else {
        return;
    };
    let mut capture: Option<Duplicator> = None;
    let mut warmup = 0u32;

    loop {
        // 캡처는 디스플레이 주사율을 그대로 따라간다. AcquireNextFrame이 다음 프레임까지
        // (최대 16ms) 블록하므로 인위적인 대기 없이도 60fps로 자연히 제한되고, 화면이
        // 그대로면 타임아웃으로 돌아와 비용이 들지 않는다. 예전에는 33ms 예산을 두어
        // 30fps로 잘랐는데, 그 양자화 때문에 독이 눈에 띄게 끊겨 보였다.
        let region = match shared.lock() {
            Ok(s) => s.region,
            Err(_) => return,
        };
        let Some(region) = region else {
            std::thread::sleep(std::time::Duration::from_millis(40));
            continue;
        };

        if capture.as_ref().map(|c| c.region) != Some(region) {
            capture = Duplicator::new(&device, region);
            // 복제를 새로 만들면 첫 장은 아직 칠해지지 않은 검은 화면이다.
            // 그대로 쓰면 유리가 잠깐 검게 번쩍이므로 초기 프레임은 버린다.
            warmup = WARMUP_FRAMES;
            let alive = capture.is_some();
            if let Ok(mut s) = shared.lock() {
                s.alive = alive;
            }
            if capture.is_none() {
                // 다른 프로그램이 복제를 점유했거나 출력을 찾지 못한 경우.
                std::thread::sleep(std::time::Duration::from_millis(500));
                continue;
            }
        }

        let grabbed = match capture.as_mut() {
            Some(d) => d.grab(&context),
            None => continue,
        };

        match grabbed {
            Ok(Some(frame)) => {
                if warmup > 0 {
                    warmup -= 1;
                    continue;
                }
                if let Ok(mut s) = shared.lock() {
                    // 화면이 그대로인데도 커서 이동 같은 이유로 60fps로 프레임이 온다.
                    // 픽셀이 같으면 세대를 올리지 않아 IPC와 텍스처 업로드를 건너뛴다.
                    let unchanged = s.latest.as_ref().is_some_and(|prev| {
                        prev.width == frame.width
                            && prev.height == frame.height
                            && prev.rgba == frame.rgba
                    });
                    if !unchanged {
                        s.gen += 1;
                        let gen = s.gen;
                        s.latest = Some(Frame { gen, ..frame });
                    }
                }
            }
            Ok(None) => {}
            Err(GrabError::Lost) => {
                // 해상도 변경·전체화면 전환·세션 전환 뒤에는 복제를 다시 만들어야 한다.
                capture = None;
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }

    }
}

fn create_device() -> Option<(ID3D11Device, ID3D11DeviceContext)> {
    let mut device: Option<ID3D11Device> = None;
    let mut context: Option<ID3D11DeviceContext> = None;
    let mut level = D3D_FEATURE_LEVEL::default();
    unsafe {
        D3D11CreateDevice(
            None::<&IDXGIAdapter>,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            Default::default(),
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            Some(&mut level),
            Some(&mut context),
        )
        .ok()?;
    }
    Some((device?, context?))
}

enum GrabError {
    Lost,
}

struct Duplicator {
    duplication: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    /// 모니터 좌상단을 0으로 둔 크롭 위치.
    offset: (i32, i32),
    /// 스테이징 텍스처는 다운스케일 전 원본 크기다.
    size: (i32, i32),
    region: Region,
}

impl Duplicator {
    fn new(device: &ID3D11Device, region: Region) -> Option<Self> {
        let dxgi: IDXGIDevice = device.cast().ok()?;
        let adapter = unsafe { dxgi.GetAdapter().ok()? };
        let mut index = 0u32;
        loop {
            let output = unsafe { adapter.EnumOutputs(index).ok()? };
            let desc: DXGI_OUTPUT_DESC = unsafe { output.GetDesc().ok()? };
            let bounds = desc.DesktopCoordinates;
            let inside = region.x >= bounds.left
                && region.x < bounds.right
                && region.y >= bounds.top
                && region.y < bounds.bottom;
            if inside {
                let out1: IDXGIOutput1 = output.cast().ok()?;
                let duplication = unsafe { out1.DuplicateOutput(device).ok()? };
                // 화면 가장자리를 넘어가는 여백(도크가 화면 오른쪽 끝에 붙을 때)은
                // 복제 텍스처 범위를 벗어나므로 모니터 안쪽으로 잘라 낸다.
                let mut x = region.x - bounds.left;
                let mut y = region.y - bounds.top;
                if x < 0 {
                    x = 0;
                }
                if y < 0 {
                    y = 0;
                }
                let max_w = (bounds.right - bounds.left - x).max(1);
                let max_h = (bounds.bottom - bounds.top - y).max(1);
                let w = region.width.min(max_w);
                let h = region.height.min(max_h);
                let staging = create_staging(device, w, h)?;
                return Some(Self {
                    duplication,
                    staging,
                    offset: (x, y),
                    size: (w, h),
                    region,
                });
            }
            index += 1;
        }
    }

    fn grab(&mut self, context: &ID3D11DeviceContext) -> Result<Option<Frame>, GrabError> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource = None;
        if let Err(err) = unsafe { self.duplication.AcquireNextFrame(16, &mut info, &mut resource) } {
            let code = err.code();
            if code == DXGI_ERROR_ACCESS_LOST {
                return Err(GrabError::Lost);
            }
            // WAIT_TIMEOUT: 화면이 그대로라 새 프레임이 없다.
            return Ok(None);
        }

        let frame = (|| -> Option<Frame> {
            let resource = resource?;
            let texture: ID3D11Texture2D = resource.cast().ok()?;
            let (w, h) = self.size;
            let src = D3D11_BOX {
                left: self.offset.0.max(0) as u32,
                top: self.offset.1.max(0) as u32,
                front: 0,
                right: (self.offset.0 + w).max(0) as u32,
                bottom: (self.offset.1 + h).max(0) as u32,
                back: 1,
            };
            unsafe {
                context.CopySubresourceRegion(&self.staging, 0, 0, 0, 0, &texture, 0, Some(&src));
            }
            self.readback(context)
        })();

        unsafe {
            let _ = self.duplication.ReleaseFrame();
        }
        Ok(frame)
    }

    /// 스테이징 텍스처를 읽어 RGBA로 바꾸고 평균 밝기를 낸다.
    fn readback(&mut self, context: &ID3D11DeviceContext) -> Option<Frame> {
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe { context.Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.ok()?;

        let (w, h) = self.size;
        let row_pitch = mapped.RowPitch as usize;
        let src = mapped.pData as *const u8;
        let out_w = (w / DOWNSCALE).max(1) as u32;
        let out_h = (h / DOWNSCALE).max(1) as u32;
        let mut rgba = vec![0u8; (out_w * out_h * 4) as usize];

        // BGRA(위→아래) → RGBA. 행 단위로 바로 써서 재할당 없이 복사한다.
        let out_w_usize = out_w as usize;
        let mut luma_sum: u64 = 0;
        for oy in 0..out_h as usize {
            let src_row = unsafe { src.add(oy * row_pitch) };
            let dst = &mut rgba[oy * out_w_usize * 4..(oy + 1) * out_w_usize * 4];
            for ox in 0..out_w_usize {
                let px = unsafe { src_row.add(ox * 4) };
                let b = unsafe { *px };
                let g = unsafe { *px.add(1) };
                let r = unsafe { *px.add(2) };
                let o = ox * 4;
                dst[o] = r;
                dst[o + 1] = g;
                dst[o + 2] = b;
                dst[o + 3] = 255;
                // 사람 눈이 느끼는 밝기(Rec.601 근사).
                luma_sum += (r as u64 * 77 + g as u64 * 150 + b as u64 * 29) >> 8;
            }
        }
        let luminance = (luma_sum / (out_w as u64 * out_h as u64).max(1)) as u32;
        unsafe {
            context.Unmap(&self.staging, 0);
        }
        Some(Frame {
            gen: 0,
            width: out_w,
            height: out_h,
            luminance,
            rgba,
        })
    }
}

fn create_staging(device: &ID3D11Device, width: i32, height: i32) -> Option<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width.max(1) as u32,
        Height: height.max(1) as u32,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut texture: Option<ID3D11Texture2D> = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)).ok()? };
    texture
}
