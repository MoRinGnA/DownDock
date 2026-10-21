//! 윈도우 창 관리: 오른쪽 가장자리 Dock 배치, 실행 중인 창 감지.
//!
//! 모든 좌표는 per-monitor DPI 인식 프로세스의 "물리 픽셀"이다. 프런트엔드는
//! 논리 좌표를 쓰므로 경계가 겹칠 때만 비교하고, 위치 지정은 타우리 API에 맡긴다.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};

use windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentThreadId, OpenProcess, QueryFullProcessImageNameW,
    PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HALFTONE, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GetAncestor, GetForegroundWindow, GetWindowLongPtrW,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    PostMessageW, SetForegroundWindow, SetWindowDisplayAffinity, SetWindowLongPtrW, ShowWindow,
    SwitchToThisWindow, GA_ROOT, GWL_EXSTYLE, SW_MINIMIZE, SW_RESTORE, WDA_EXCLUDEFROMCAPTURE,
    WM_CLOSE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/// per-monitor v2 DPI 인식은 창이 만들어지기 전에 설정해야 물리 좌표가 흔들리지 않는다.
pub fn enable_per_monitor_dpi() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

fn hwnd_of(window: &WebviewWindow) -> tauri::Result<HWND> {
    window.hwnd()
}

/// 창이 위치한 모니터의 화면 경계를 물리 픽셀로 돌려준다.
unsafe fn monitor_info(hwnd: HWND) -> MONITORINFO {
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        rcMonitor: RECT::default(),
        rcWork: RECT::default(),
        dwFlags: 0,
    };
    let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTOPRIMARY);
    let _ = GetMonitorInfoW(hmon, &mut mi);
    mi
}

fn active_monitor_bounds(window: &WebviewWindow) -> tauri::Result<RECT> {
    let hwnd = hwnd_of(window)?;
    let info = unsafe { monitor_info(hwnd) };
    // 작업 표시줄을 뺀 작업 영역을 쓴다. 화면 전체 높이를 기준으로 잡으면
    // 98% 높이 + 위아래 여백이 화면을 넘쳐 펼친 패널의 끝이 잘린다.
    let work = info.rcWork;
    if work.right > work.left && work.bottom > work.top {
        return Ok(work);
    }
    // 작업 영역을 못 읽으면 기존처럼 모니터 전체 경계로 물러난다.
    if let Some(monitor) = window.current_monitor()? {
        let position = monitor.position();
        let size = monitor.size();
        return Ok(RECT {
            left: position.x,
            top: position.y,
            right: position.x + size.width as i32,
            bottom: position.y + size.height as i32,
        });
    }
    Ok(info.rcMonitor)
}

// 화면 위·아래에서 띄우는 여백. 독이 작업 표시줄 위에 살짝 떠 보이게 한다.
const SCREEN_MARGIN: i32 = 24;

/// 화면 가장자리에 붙이고 세로로는 align에 따라 배치한다.
/// side가 "left"면 왼쪽 가장자리에 붙어 오른쪽으로 자라고, 아니면 오른쪽 가장자리에서 왼쪽으로 자란다.
/// "top" | "center" | "bottom"은 접힌 레일이 화면의 어느 높이에 놓일지를 정한다.
pub fn position_dock(
    window: &WebviewWindow,
    side: &str,
    align: &str,
    dock_inset: f64,
) -> tauri::Result<()> {
    let size = window.outer_size()?;
    let scale = window.scale_factor()?;
    let bounds = active_monitor_bounds(window)?;
    let inset = (dock_inset * scale).round() as i32;
    // 왼쪽 독은 창의 왼쪽 끝을 고정해야 패널이 펼쳐질 때 오른쪽으로 자란다.
    let x = match side {
        "left" => bounds.left + inset,
        _ => bounds.right - size.width as i32 - inset,
    };
    let y = match align {
        "top" => bounds.top + SCREEN_MARGIN,
        "center" => bounds.top + ((bounds.bottom - bounds.top) - size.height as i32) / 2,
        _ => bounds.bottom - size.height as i32 - SCREEN_MARGIN,
    };
    window.set_position(tauri::PhysicalPosition::new(x, y))?;
    Ok(())
}

/// 프런트엔드가 그린 내용물 크기를 반영하고 Dock이 붙은 가장자리·세로 정렬을 유지한다.
#[tauri::command]
pub fn resize_dock(
    window: WebviewWindow,
    width: f64,
    height: f64,
    side: String,
    align: String,
) -> tauri::Result<f64> {
    // 작업 표시줄을 뺀 작업 영역 안에서만 창을 키운다. 위아래 여백을 양쪽에서
    // 빼야 펼친 패널이 화면 밖으로 밀려나거나 끝이 잘리지 않는다.
    let scale = window.scale_factor()?;
    let bounds = active_monitor_bounds(&window)?;
    let work_height = (bounds.bottom - bounds.top) as f64 / scale;
    let max_height = (work_height - SCREEN_MARGIN as f64 * 2.0).clamp(200.0, 2400.0);
    // 프런트엔드가 넘기는 높이에는 가장자리 여백(EDGE_ROOM*2 = 24px)이 포함된다.
    let max_surface = (max_height - 24.0).max(200.0);
    // 폭도 작업 영역에 맞춰 자른다. 예전 상한(520px)은 680px 설정 패널보다 좁아
    // 펼쳤을 때 패널 오른쪽이 창 밖으로 잘렸다.
    let work_width = (bounds.right - bounds.left) as f64 / scale;
    let max_width = (work_width - SCREEN_MARGIN as f64 * 2.0).clamp(200.0, 1400.0);
    let w = width.max(1.0).min(max_width);
    let h = height.max(1.0).min(max_height);
    window.set_size(tauri::LogicalSize::new(w, h))?;
    position_dock(&window, &side, &align, 0.0)?;
    Ok(max_surface)
}

/// 독 자신은 화면 캡처에서 빼서, 바탕화면을 캡처해도 독이 다시 찍히지 않게 한다.
pub fn exclude_from_capture(window: &WebviewWindow) -> tauri::Result<()> {
    let hwnd = hwnd_of(window)?;
    unsafe {
        let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
    }
    Ok(())
}

/// 프런트엔드가 넘긴 표면 사각형(뷰포트 기준 CSS px) 뒤의 화면을 BMP로 돌려준다.
/// 좌표를 물리 픽셀로 바꿔 정확히 그 영역만 캡처하므로, 프런트엔드는 결과 이미지를
/// 표면 크기에 그대로 늘려 쓰면 된다. DPI 배율이 달라도 어긋나지 않는다.
#[tauri::command]
pub fn capture_backdrop(
    window: WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<tauri::ipc::Response, String> {
    if width < 1.0 || height < 1.0 {
        return Err("캡처할 영역이 없습니다".into());
    }

    // inner_position은 클라이언트 영역의 좌상단(물리 픽셀)이다. getBoundingClientRect도
    // 같은 기준이므로 배율만 곱하면 화면 좌표가 된다.
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let origin = window.inner_position().map_err(|e| e.to_string())?;
    let px = origin.x + (x * scale).round() as i32;
    let py = origin.y + (y * scale).round() as i32;
    let w = ((width * scale).round() as i32).max(1);
    let h = ((height * scale).round() as i32).max(1);

    let pixels = unsafe { capture_screen_rect(px, py, w, h) }
        .ok_or_else(|| "화면 캡처에 실패했습니다".to_string())?;
    Ok(tauri::ipc::Response::new(encode_bmp(w, h, pixels)))
}

unsafe fn capture_screen_rect(x: i32, y: i32, w: i32, h: i32) -> Option<Vec<u8>> {
    let screen = GetDC(None);
    if screen.0.is_null() {
        return None;
    }
    let mem = CreateCompatibleDC(Some(screen));
    let bmp = CreateCompatibleBitmap(screen, w, h);
    let old = SelectObject(mem, bmp.into());
    let copied = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY).is_ok();
    // GetDIBits는 비트맵이 DC에 선택되어 있으면 안 된다. 픽셀을 읽기 전에 되돌린다.
    SelectObject(mem, old);

    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let lines = GetDIBits(
        mem,
        bmp,
        0,
        h as u32,
        Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
        &mut info,
        DIB_RGB_COLORS,
    );

    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);

    (copied && lines == h).then_some(buf)
}

/// 창 하나를 축소해 미리보기용 data URL(BMP)로 돌려준다.
/// 화면에 가려져 있어도 PrintWindow가 창 자신을 그리므로 썸네일로 쓸 수 있다.
#[tauri::command]
pub fn capture_window(hwnd: u64, max_width: u32) -> Result<String, String> {
    let target = unsafe { GetAncestor(HWND(hwnd as *mut _), GA_ROOT) };
    if !unsafe { IsWindow(Some(target)) }.as_bool() {
        return Err("그 창은 이미 닫혔습니다".into());
    }

    // 그림자까지 포함한 실제 경계. GetWindowRect는 보이지 않는 테두리를 더한다.
    let mut bounds = RECT::default();
    let framed = unsafe {
        DwmGetWindowAttribute(
            target,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut bounds as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if framed.is_err() && unsafe { GetWindowRect(target, &mut bounds) }.is_err() {
        return Err("창 크기를 읽을 수 없습니다".into());
    }
    let (w, h) = (bounds.right - bounds.left, bounds.bottom - bounds.top);
    if w <= 0 || h <= 0 {
        return Err("창 크기를 읽을 수 없습니다".into());
    }

    let (tw, th, pixels) =
        unsafe { capture_window_thumb(target, w, h, max_width.clamp(120, 640) as i32) }
            .ok_or("이 창은 미리보기를 만들 수 없습니다")?;
    let bmp = encode_bmp(tw, th, pixels);
    Ok(format!(
        "data:image/bmp;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bmp)
    ))
}

unsafe fn capture_window_thumb(
    hwnd: HWND,
    w: i32,
    h: i32,
    max_w: i32,
) -> Option<(i32, i32, Vec<u8>)> {
    let screen = GetDC(None);
    if screen.0.is_null() {
        return None;
    }

    let src = CreateCompatibleDC(Some(screen));
    let shot = CreateCompatibleBitmap(screen, w, h);
    let old_src = SelectObject(src, shot.into());
    // PW_RENDERFULLCONTENT(2): DWM이 그리는 창(브라우저 · UWP)도 내용이 나온다.
    let printed = PrintWindow(hwnd, src, PRINT_WINDOW_FLAGS(2)).as_bool();

    // 미리보기는 폭 몇백 px이면 충분하다. HALFTONE으로 줄여야 글자가 뭉개지지 않는다.
    let scale = (max_w as f32 / w as f32).min(1.0);
    let tw = ((w as f32 * scale).round() as i32).max(1);
    let th = ((h as f32 * scale).round() as i32).max(1);
    let dest = CreateCompatibleDC(Some(screen));
    let thumb = CreateCompatibleBitmap(screen, tw, th);
    let old_dest = SelectObject(dest, thumb.into());
    let _ = SetStretchBltMode(dest, HALFTONE);
    let stretched = StretchBlt(dest, 0, 0, tw, th, Some(src), 0, 0, w, h, SRCCOPY).as_bool();

    // GetDIBits는 비트맵이 DC에 선택되어 있으면 안 된다.
    SelectObject(dest, old_dest);
    SelectObject(src, old_src);

    let mut info: BITMAPINFO = std::mem::zeroed();
    info.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: tw,
        biHeight: -th,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        ..Default::default()
    };
    let mut buf = vec![0u8; (tw * th * 4) as usize];
    let lines = GetDIBits(
        dest,
        thumb,
        0,
        th as u32,
        Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
        &mut info,
        DIB_RGB_COLORS,
    );

    let _ = DeleteObject(thumb.into());
    let _ = DeleteDC(dest);
    let _ = DeleteObject(shot.into());
    let _ = DeleteDC(src);
    ReleaseDC(None, screen);

    (printed && stretched && lines == th).then_some((tw, th, buf))
}

/// GDI가 준 32비트 BGRA 픽셀을 알파 255의 BMP 파일로 감싼다.
fn encode_bmp(w: i32, h: i32, mut pixels: Vec<u8>) -> Vec<u8> {
    for px in pixels.chunks_exact_mut(4) {
        px[3] = 255;
    }
    let data_len = pixels.len() as u32;
    let mut out = Vec::with_capacity(54 + pixels.len());
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(54 + data_len).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&w.to_le_bytes());
    out.extend_from_slice(&(-h).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(&[0u8; 16]);
    out.extend_from_slice(&pixels);
    out
}

/// 앱 전환기(Alt+Tab)에 독이 뜨지 않도록 도구 창 스타일을 붙인다.
pub fn decorate(window: &WebviewWindow) -> tauri::Result<()> {
    let hwnd = hwnd_of(window)?;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TOOLWINDOW.0 as isize);
    }
    Ok(())
}

/// 독이 마지막으로 기억한 "사용자가 쓰던 창". 독을 누르면 독이 전경 창이 되므로
/// GetForegroundWindow만으로는 토글 대상을 알 수 없다. 감시 스레드가 독이 아닌
/// 전경 창을 계속 기록해 두고, focus_window가 이 값과 비교해 최소화 여부를 정한다.
static LAST_FOREGROUND: AtomicU64 = AtomicU64::new(0);

/// 창 목록 변화를 프런트엔드에 알린다.
/// Dock은 Windows 셸이 활성화될 때 다른 최상단 창보다 위에 남는다고 보장되지 않는다.
pub fn start_window_monitor(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_signature = String::new();
        let mut tick: u32 = 0;
        loop {
            // 전경 창 추적은 짧게 돌린다. 간격이 길면 앱을 바꾼 직후 독을 눌렀을 때
            // 이전 앱을 "지금 쓰던 창"으로 착각해 엉뚱한 창을 최소화한다.
            std::thread::sleep(std::time::Duration::from_millis(120));
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            let Ok(ours) = hwnd_of(&window) else {
                continue;
            };

            // 독이 아닌 전경 창을 기억한다. 클릭 직전 값이 남아 있어 독이 전경이 된
            // 뒤에도 "아까 쓰던 창"을 정확히 가리킨다.
            let foreground = unsafe { GetForegroundWindow() }.0 as u64;
            if foreground != 0 && foreground != ours.0 as u64 {
                LAST_FOREGROUND.store(foreground, Ordering::Relaxed);
            }

            // 창 목록 변화는 1.2초마다 한 번씩만 살핀다. 제목이 자주 바뀌는
            // 앱(브라우저 탭 등)이 이벤트를 폭주시키지 않도록 값만 비교한다.
            tick = tick.wrapping_add(1);
            if tick % 10 == 0 {
                // 활성 창도 서명에 넣는다. 목록은 그대로여도 전환했다면 레일 표시를 갱신해야 한다.
                let signature = unsafe { collect_running(ours.0 as u64) }
                    .iter()
                    .map(|w| format!("{}|{}|{}|{}", w.hwnd, w.title, w.active, w.minimized))
                    .collect::<Vec<_>>()
                    .join(";");
                if signature != last_signature {
                    last_signature = signature;
                    let _ = app.emit("windows:changed", ());
                }
            }
        }
    });
}

/// 작업표시줄에 뜨는 창 하나 — 독의 "실행 중" 영역에 그린다.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RunningWindow {
    pub hwnd: u64,
    pub title: String,
    /// 실행 파일 전체 경로. 독에서 고정 아이콘과 실행 중 창을 같은 앱으로 묶는 데 쓴다.
    pub exe: String,
    pub icon: Option<String>,
    /// 지금 사용자가 보고 있는 창인지. 순서를 바꾸는 대신 이 표시만 바꾼다.
    pub active: bool,
    /// 최소화되어 화면에 떠 있지 않은 창인지. 레일에서는 꺼진 획으로 보인다.
    pub minimized: bool,
}

/// 작업표시줄에 뜨는 창 목록. 도구 창·가려진 창·독 자신은 뺀다.
#[tauri::command]
pub fn list_running_windows(window: WebviewWindow) -> Result<Vec<RunningWindow>, String> {
    let ours = window.hwnd().map(|h| h.0 as u64).unwrap_or(0);
    Ok(unsafe { collect_running(ours) })
}

/// 독에 한꺼번에 그릴 실행 중 창의 상한. 넘치면 나머지는 목록에서 뺀다.
const MAX_RUNNING_WINDOWS: usize = 14;

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let list = &mut *(lparam.0 as *mut Vec<RunningWindow>);
    if list.len() >= MAX_RUNNING_WINDOWS {
        return windows::core::BOOL::from(false);
    }
    if let Some(entry) = describe_window(hwnd) {
        list.push(entry);
    }
    windows::core::BOOL::from(true)
}

/// 작업표시줄에 올릴 만한 창인지 보고 (제목, 실행 파일 경로)를 돌려준다.
/// 아이콘 추출은 하지 않는다 — 트레이 목록처럼 경로만 필요한 곳도 쓰기 때문이다.
unsafe fn shown_window(hwnd: HWND) -> Option<(String, PathBuf)> {
    if !IsWindowVisible(hwnd).as_bool() {
        return None;
    }
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
    if ex & (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) != 0 {
        return None;
    }
    let mut cloaked: u32 = 0;
    let _ = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED,
        &mut cloaked as *mut u32 as *mut core::ffi::c_void,
        std::mem::size_of::<u32>() as u32,
    );
    if cloaked != 0 {
        return None;
    }

    let mut title_buf = [0u16; 256];
    let len = GetWindowTextW(hwnd, &mut title_buf);
    if len == 0 {
        return None;
    }
    let title = String::from_utf16_lossy(&title_buf[..len as usize]);

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    Some((title, process_path(pid)?))
}

unsafe fn describe_window(hwnd: HWND) -> Option<RunningWindow> {
    let (title, exe) = shown_window(hwnd)?;
    Some(RunningWindow {
        hwnd: hwnd.0 as u64,
        title,
        exe: exe.to_string_lossy().into_owned(),
        icon: crate::apps::icon_data_url(&exe),
        // 실제 활성 여부는 열거가 끝난 뒤 collect_running이 채운다(전경 창을 한 번만 읽으려고).
        active: false,
        minimized: IsIconic(hwnd).as_bool(),
    })
}

unsafe fn process_path(pid: u32) -> Option<PathBuf> {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 512];
    let mut size = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_FORMAT(0),
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut size,
    );
    let _ = CloseHandle(handle);
    ok.ok()?;
    let path = String::from_utf16_lossy(&buf[..size as usize]);
    Some(PathBuf::from(path))
}

/// 화면에 창이 떠 있는 실행 파일 경로. 트레이 전용 프로그램과 구분하는 데 쓴다.
/// 독에 그릴 목록이 아니라 "이 프로그램은 지금 화면에 있나"만 아는 판별용이므로
/// 아이콘은 뽑지 않고, 창 개수 상한(MAX_RUNNING_WINDOWS)도 두지 않는다.
/// 상한을 두면 15번째 이후 창을 가진 앱이 숨김으로 잘못 분류된다.
pub(crate) fn visible_exe_paths() -> std::collections::HashSet<String> {
    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
        let paths = &mut *(lparam.0 as *mut std::collections::HashSet<String>);
        if let Some((_, exe)) = shown_window(hwnd) {
            paths.insert(exe.to_string_lossy().to_lowercase());
        }
        windows::core::BOOL::from(true)
    }

    let mut paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect),
            LPARAM(&mut paths as *mut std::collections::HashSet<String> as isize),
        );
    }
    paths
}

/// 프로세스의 실행 파일 전체 경로. 트레이 목록이 레지스트리에 적힌 경로와
/// 지금 돌고 있는 프로세스를 맞춰 볼 때 쓴다.
pub(crate) fn process_exe(pid: u32) -> Option<PathBuf> {
    unsafe { process_path(pid) }
}

/// 실행 중인 창을 모아 활성 표시를 붙인다. 독 자신이 전경이면 직전에 쓰던 창을 활성으로 본다
/// (독을 누른 순간 GetForegroundWindow는 독이 되기 때문).
unsafe fn collect_running(ours: u64) -> Vec<RunningWindow> {
    let mut list: Vec<RunningWindow> = Vec::new();
    let _ = EnumWindows(
        Some(enum_proc),
        LPARAM(&mut list as *mut Vec<RunningWindow> as isize),
    );
    let foreground = GetForegroundWindow().0 as u64;
    let active = if foreground != 0 && foreground != ours {
        foreground
    } else {
        LAST_FOREGROUND.load(Ordering::Relaxed)
    };
    for entry in &mut list {
        // 접힌 창은 "지금 보는 창"이 아니다. 창을 전부 접은 뒤에도 LAST_FOREGROUND가
        // 마지막 창을 가리키고 있어서, 이걸 빼지 않으면 접힌 그룹이 계속 활성으로
        // 보이고 작업표시줄처럼 다시 누를 때 펴지지 않고 또 접으려 든다.
        entry.active = entry.hwnd == active && !entry.minimized;
    }
    list
}

/// 열거된 창을 최상위 창으로 맞춘다. 이미 닫혔으면 에러.
fn root_window(hwnd: u64) -> Result<HWND, String> {
    let target = unsafe { GetAncestor(HWND(hwnd as *mut _), GA_ROOT) };
    if !unsafe { IsWindow(Some(target)) }.as_bool() {
        return Err("그 창은 이미 닫혔습니다".into());
    }
    Ok(target)
}

/// 창을 닫는다. WM_CLOSE를 보내는 것이라 저장 확인창은 그 앱이 띄운다 —
/// 작업표시줄 미리보기의 ✕와 같은 동작이다.
#[tauri::command]
pub fn close_window(hwnd: u64) -> Result<(), String> {
    let target = root_window(hwnd)?;
    unsafe { PostMessageW(Some(target), WM_CLOSE, WPARAM(0), LPARAM(0)) }
        .map_err(|e| format!("창을 닫지 못했습니다: {e}"))
}

/// 창을 앞으로 가져온다. 이미 그 창을 보고 있어도 최소화하지 않는다 —
/// 메뉴의 "전환"이나 창 목록에서 고를 때는 '그 창으로 가라'는 뜻이기 때문이다.
/// (레일 막대를 누르는 동작은 focus_window가 맡는다: 그쪽은 작업표시줄처럼 토글한다.)
#[tauri::command]
pub fn activate_window(hwnd: u64) -> Result<(), String> {
    let target = root_window(hwnd)?;
    unsafe {
        if IsIconic(target).as_bool() {
            let _ = ShowWindow(target, SW_RESTORE);
        }
        activate(target);
        if GetForegroundWindow() != target {
            return Err("창을 앞으로 가져오지 못했습니다".into());
        }
    }
    LAST_FOREGROUND.store(target.0 as u64, Ordering::Relaxed);
    Ok(())
}

/// 창을 최소화한다. 복원은 focus_window가 한다.
#[tauri::command]
pub fn minimize_window(hwnd: u64) -> Result<(), String> {
    let target = root_window(hwnd)?;
    unsafe {
        let _ = ShowWindow(target, SW_MINIMIZE);
    }
    Ok(())
}

/// 같은 앱의 창 전체를 접는다(작업표시줄에서 그룹 버튼을 눌렀을 때와 같다).
/// 이미 최소화된 창은 그대로 두고, 닫힌 창은 건너뛴다.
#[tauri::command]
pub fn minimize_windows(hwnds: Vec<u64>) -> Result<(), String> {
    let mut folded = false;
    for hwnd in hwnds {
        let target = unsafe { GetAncestor(HWND(hwnd as *mut _), GA_ROOT) };
        if !unsafe { IsWindow(Some(target)) }.as_bool() || unsafe { IsIconic(target) }.as_bool() {
            continue;
        }
        unsafe {
            let _ = ShowWindow(target, SW_MINIMIZE);
        }
        folded = true;
    }
    if folded {
        Ok(())
    } else {
        Err("접을 창이 없습니다".into())
    }
}

/// 같은 앱의 창 전체를 되살린다. 최소화된 창을 먼저 모두 복원하고, 마지막에 `focus`
/// 창을 앞으로 가져온다 — 마지막에 활성화해야 그 창이 맨 위에 남는다.
#[tauri::command]
pub fn restore_windows(hwnds: Vec<u64>, focus: u64) -> Result<(), String> {
    for hwnd in &hwnds {
        let target = unsafe { GetAncestor(HWND(*hwnd as *mut _), GA_ROOT) };
        if !unsafe { IsWindow(Some(target)) }.as_bool() {
            continue;
        }
        if unsafe { IsIconic(target) }.as_bool() {
            unsafe {
                let _ = ShowWindow(target, SW_RESTORE);
            }
        }
    }
    activate_window(focus)
}

/// 독 아이콘을 누르면 그 창으로 점프한다. 이미 쓰고 있던 창이면 최소화 —
/// 작업표시줄을 누르는 감각과 같다. 최소화된 창은 항상 복원한다.
#[tauri::command]
pub fn focus_window(window: WebviewWindow, hwnd: u64) -> Result<(), String> {
    // 열거된 창이 자식 창일 수 있으니 최상위 창으로 맞춘다.
    let target = root_window(hwnd)?;
    let ours = window.hwnd().map(|h| h.0 as u64).unwrap_or(0);

    unsafe {
        let last = LAST_FOREGROUND.load(Ordering::Relaxed);
        let iconic = IsIconic(target).as_bool();
        if !iconic && last == target.0 as u64 && last != 0 && last != ours {
            let _ = ShowWindow(target, SW_MINIMIZE);
            return Ok(());
        }

        if iconic {
            let _ = ShowWindow(target, SW_RESTORE);
        }
        activate(target);
        LAST_FOREGROUND.store(target.0 as u64, Ordering::Relaxed);

        // 포커스를 실제로 가져왔는지 확인한다. 실패하면 프런트가 알 수 있게 오류로 돌려준다.
        if GetForegroundWindow() != target {
            return Err("창을 앞으로 가져오지 못했습니다".into());
        }
    }
    Ok(())
}

/// 다른 프로세스가 전경 창일 때도 SetForegroundWindow가 먹히도록 입력 큐를 붙였다 뗀다.
/// (Windows의 포그라운드 잠금은 백그라운드 프로세스의 창 전환을 막는다)
unsafe fn activate(target: HWND) {
    let foreground = GetForegroundWindow();
    let this = GetCurrentThreadId();
    let foreground_thread = if foreground.0.is_null() {
        0
    } else {
        GetWindowThreadProcessId(foreground, None)
    };
    let target_thread = GetWindowThreadProcessId(target, None);

    let mut attached: Vec<u32> = Vec::new();
    for thread in [foreground_thread, target_thread] {
        if thread != 0 && thread != this && !attached.contains(&thread) {
            if AttachThreadInput(this, thread, true).as_bool() {
                attached.push(thread);
            }
        }
    }

    let _ = BringWindowToTop(target);
    if !SetForegroundWindow(target).as_bool() {
        // 입력 큐 연결만으로 안 되면 셸의 창 전환 루틴을 마지막으로 시도한다.
        SwitchToThisWindow(target, true);
    }

    for thread in attached {
        let _ = AttachThreadInput(this, thread, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

    // 화면이 있는 세션에서만 의미가 있으므로 기본 실행에서는 뺀다.
    // `cargo test --lib -- --ignored`로 직접 확인한다.
    #[test]
    #[ignore]
    fn capture_screen_returns_real_pixels() {
        let (w, h) = (256, 256);
        let (sw, sh) = unsafe {
            (
                GetSystemMetrics(SM_CXSCREEN),
                GetSystemMetrics(SM_CYSCREEN),
            )
        };
        println!("화면 크기 = {sw}x{sh}");
        let spots = [(0, 0), (sw / 2 - w / 2, sh / 2 - h / 2), (sw - w, sh - h)];
        let mut best = 0usize;
        for (x, y) in spots {
            let pixels = unsafe { capture_screen_rect(x, y, w, h) }.expect("화면 캡처 실패");
            assert_eq!(pixels.len(), (w * h * 4) as usize);
            let mut distinct = std::collections::HashSet::new();
            for px in pixels.chunks_exact(4) {
                distinct.insert([px[0], px[1], px[2], px[3]]);
            }
            println!(
                "({x},{y}) 첫 픽셀 = {:?}, 서로 다른 색 = {}",
                &pixels[0..4],
                distinct.len()
            );
            best = best.max(distinct.len());
        }
        assert!(best > 4, "화면이 단색으로만 찍혔습니다");
    }

    // 포그라운드 잠금을 뚫고 창을 앞으로 가져오는지 확인한다. 실제 창이 필요하므로
    // 기본 실행에서는 뺀다. `cargo test --lib -- --ignored activation`로 직접 확인한다.
    // (메모장이 잠깐 앞으로 나왔다 닫힌다)
    #[test]
    #[ignore]
    fn activation_brings_a_window_to_front() {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::{LPARAM, WPARAM};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::{
            PostMessageW, SW_SHOWNORMAL, WM_CLOSE,
        };
        use windows::core::{PCWSTR, w};

        let wide: Vec<u16> = std::ffi::OsStr::new("notepad.exe")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let opened = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        assert!(opened.0 as isize > 32, "메모장을 실행하지 못했습니다");

        let mut found = None;
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(300));
            // 테스트에는 독 창이 없으므로 ours=0. 활성 판정은 전경 창을 그대로 쓴다.
            found = unsafe { collect_running(0) }
                .into_iter()
                .find(|w| w.exe.to_lowercase().ends_with("notepad.exe"));
            if found.is_some() {
                break;
            }
        }
        let window = found.expect("메모장 창을 찾지 못했습니다");
        let hwnd = HWND(window.hwnd as *mut _);

        unsafe { activate(hwnd) };
        let foreground = unsafe { GetAncestor(GetForegroundWindow(), GA_ROOT) };
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
        assert_eq!(foreground, hwnd, "창을 앞으로 가져오지 못했습니다");
    }

    // 미리보기 카드의 창 버튼이 실제로 먹는지 본다. 메모장이 잠깐 떴다 사라진다.
    // `cargo test --lib -- --ignored preview`로 직접 확인한다.
    #[test]
    #[ignore]
    fn preview_buttons_minimize_and_close_a_window() {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        use windows::core::{PCWSTR, w};

        let wide: Vec<u16> = std::ffi::OsStr::new("notepad.exe")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let opened = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        assert!(opened.0 as isize > 32, "메모장을 실행하지 못했습니다");

        let mut found = None;
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(300));
            found = unsafe { collect_running(0) }
                .into_iter()
                .find(|w| w.exe.to_lowercase().ends_with("notepad.exe"));
            if found.is_some() {
                break;
            }
        }
        let hwnd = found.expect("메모장 창을 찾지 못했습니다").hwnd;

        // 최소화 — 창은 남아 있고 아이콘화 상태여야 한다.
        minimize_window(hwnd).expect("최소화 실패");
        let target = HWND(hwnd as *mut _);
        assert!(unsafe { IsIconic(target) }.as_bool(), "최소화되지 않았습니다");

        // 닫기 — WM_CLOSE를 받고 창이 사라져야 한다.
        close_window(hwnd).expect("닫기 실패");
        let mut closed = false;
        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            if !unsafe { IsWindow(Some(target)) }.as_bool() {
                closed = true;
                break;
            }
        }
        assert!(closed, "창이 닫히지 않았습니다");
    }

    // 메뉴의 "전환"은 이미 그 창을 보고 있어도 최소화하지 않아야 한다(막대 클릭과 다른 점).
    // `cargo test --lib -- --ignored menu_activation --nocapture`로 확인한다.
    #[test]
    #[ignore]
    fn menu_activation_keeps_the_window_open() {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        use windows::core::{PCWSTR, w};

        let wide: Vec<u16> = std::ffi::OsStr::new("notepad.exe")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let opened = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(wide.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        assert!(opened.0 as isize > 32, "메모장을 실행하지 못했습니다");

        let mut found = None;
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_millis(300));
            found = unsafe { collect_running(0) }
                .into_iter()
                .find(|w| w.exe.to_lowercase().ends_with("notepad.exe"));
            if found.is_some() {
                break;
            }
        }
        let hwnd = found.expect("메모장 창을 찾지 못했습니다").hwnd;
        let target = HWND(hwnd as *mut _);

        activate_window(hwnd).expect("활성화 실패");
        assert_eq!(
            unsafe { GetForegroundWindow() },
            target,
            "창을 앞으로 가져오지 못했습니다"
        );
        // 한 번 더 활성화해도 최소화되지 않는다.
        activate_window(hwnd).expect("두 번째 활성화 실패");
        assert!(!unsafe { IsIconic(target) }.as_bool(), "이미 보는 창을 최소화했습니다");

        close_window(hwnd).expect("닫기 실패");
    }

    // 그룹 접기/펴기가 두 창을 함께 다루는지 본다. 메모장 두 개가 잠깐 떴다 사라진다.
    // `cargo test --lib -- --ignored group_fold --nocapture`로 확인한다.
    #[test]
    #[ignore]
    fn group_fold_folds_and_restores_every_window() {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        use windows::core::{PCWSTR, w};

        let wide: Vec<u16> = std::ffi::OsStr::new("notepad.exe")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // 메모장 두 개. 창이 둘 모이는지 먼저 확인한다.
        for _ in 0..2 {
            let opened = unsafe {
                ShellExecuteW(
                    None,
                    w!("open"),
                    PCWSTR(wide.as_ptr()),
                    PCWSTR::null(),
                    PCWSTR::null(),
                    SW_SHOWNORMAL,
                )
            };
            assert!(opened.0 as isize > 32, "메모장을 실행하지 못했습니다");
            std::thread::sleep(std::time::Duration::from_millis(700));
        }

        let mut hwnds: Vec<u64> = Vec::new();
        for _ in 0..30 {
            hwnds = unsafe { collect_running(0) }
                .into_iter()
                .filter(|w| w.exe.to_lowercase().ends_with("notepad.exe"))
                .map(|w| w.hwnd)
                .collect();
            if hwnds.len() >= 2 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        assert!(hwnds.len() >= 2, "메모장 창을 둘 찾지 못했습니다: {}", hwnds.len());

        // 전체 접기 → 둘 다 아이콘화된다.
        minimize_windows(hwnds.clone()).expect("그룹 접기 실패");
        for hwnd in &hwnds {
            let target = unsafe { GetAncestor(HWND(*hwnd as *mut _), GA_ROOT) };
            assert!(unsafe { IsIconic(target) }.as_bool(), "창이 접히지 않았습니다");
        }

        // 접힌 창은 "지금 보는 창"으로 남지 않아야 한다. 남으면 레일 알약이 계속 활성으로
        // 보이고, 두 번째 클릭이 펴기가 아니라 또 접기가 된다.
        let previous = LAST_FOREGROUND.load(Ordering::Relaxed);
        LAST_FOREGROUND.store(hwnds[0], Ordering::Relaxed);
        // 전경을 독으로 넘겨 기억값을 쓰게 만든다(독을 누른 직후와 같은 상황).
        let foreground = unsafe { GetForegroundWindow() }.0 as u64;
        let listed = unsafe { collect_running(foreground) };
        LAST_FOREGROUND.store(previous, Ordering::Relaxed);
        let still_active: Vec<u64> = listed
            .iter()
            .filter(|w| hwnds.contains(&w.hwnd) && w.active)
            .map(|w| w.hwnd)
            .collect();
        assert!(
            still_active.is_empty(),
            "접힌 창이 활성으로 남았습니다: {still_active:?}"
        );

        // 전체 펴기 → 둘 다 복원되고, 지정한 창이 맨 앞에 선다.
        let focus = hwnds[1];
        restore_windows(hwnds.clone(), focus).expect("그룹 펴기 실패");
        for hwnd in &hwnds {
            let target = unsafe { GetAncestor(HWND(*hwnd as *mut _), GA_ROOT) };
            assert!(!unsafe { IsIconic(target) }.as_bool(), "창이 복원되지 않았습니다");
        }
        assert_eq!(
            unsafe { GetForegroundWindow() },
            unsafe { GetAncestor(HWND(focus as *mut _), GA_ROOT) },
            "지정한 창이 앞에 오지 않았습니다"
        );

        for hwnd in &hwnds {
            let _ = close_window(*hwnd);
        }
    }

    #[test]
    fn bmp_header_describes_the_image() {
        let bmp = encode_bmp(2, 1, vec![0u8; 8]);
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(bmp.len(), 54 + 8);
        assert_eq!(u32::from_le_bytes(bmp[18..22].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -1);
        assert_eq!(bmp[54 + 3], 255, "알파가 불투명으로 채워져야 합니다");
    }
}
