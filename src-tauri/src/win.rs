//! 윈도우 창 관리: 최상단 유지, 하단 위치 지정, 작업 영역 점유.
//!
//! 모든 좌표는 per-monitor DPI 인식 프로세스의 "물리 픽셀"이다. 프런트엔드는
//! 논리 좌표를 쓰므로 경계가 겹칠 때만 비교하고, 위치 지정은 타우리 API에 맡긴다.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowLongPtrW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindowVisible, SetForegroundWindow, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, SystemParametersInfoW, GWL_EXSTYLE, HWND_TOPMOST,
    SPI_GETWORKAREA, SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_SETWORKAREA,
    SW_MINIMIZE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

/// 독이 화면 하단에서 차지하는 논리 높이(작업 영역 점유량). 독 본체 + 하단 여백.
pub const DOCK_RESERVE_LOGICAL: f64 = 74.0;

/// 점유 전 원래 작업 영역. 프로세스가 죽어도 화면이 굳지 않게 복원 지점을 남긴다.
static ORIGINAL_WORK_AREA: Mutex<Option<RECT>> = Mutex::new(None);

/// per-monitor v2 DPI 인식은 창이 만들어지기 전에 설정해야 물리 좌표가 흔들리지 않는다.
pub fn enable_per_monitor_dpi() {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

fn hwnd_of(window: &WebviewWindow) -> tauri::Result<HWND> {
    window.hwnd()
}

/// 주 모니터의 모니터 영역과 작업 영역을 물리 픽셀로 돌려준다.
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

/// 독을 주 모니터 가로 중앙·세로 맨 아래에 붙인다. 화면이 바뀌면 다시 불러야 한다.
pub fn position_dock(window: &WebviewWindow) -> tauri::Result<()> {
    let hwnd = hwnd_of(window)?;
    let mi = unsafe { monitor_info(hwnd) };
    let size = window.outer_size()?;
    let x = mi.rcMonitor.left + ((mi.rcMonitor.right - mi.rcMonitor.left) - size.width as i32) / 2;
    let y = mi.rcMonitor.bottom - size.height as i32;
    window.set_position(tauri::PhysicalPosition::new(x, y))?;
    Ok(())
}

/// 프런트엔드가 그린 실제 크기를 알려 주면 창을 그에 맞춰 줄인 뒤 하단에 다시 붙인다.
/// 창이 내용물보다 커야 하는 이유는 없다 — 커지면 보이지 않는 여백이 클릭을 먹는다.
#[tauri::command]
pub fn resize_dock(window: WebviewWindow, width: f64, height: f64) -> tauri::Result<()> {
    window.set_size(tauri::LogicalSize::new(width.max(160.0), height.max(80.0)))?;
    position_dock(&window)
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

/// 화면 하단을 작업 영역에서 비워, 최대화된 창이 독을 덮지 않게 한다.
pub fn reserve_work_area(reserve_px: i32) {
    let mut current = RECT::default();
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut current as *mut RECT as *mut core::ffi::c_void),
            Default::default(),
        );
    }
    if let Ok(mut guard) = ORIGINAL_WORK_AREA.lock() {
        if guard.is_none() {
            *guard = Some(current);
        }
    }
    let mut updated = current;
    updated.bottom = (updated.bottom - reserve_px).max(updated.top + 160);
    unsafe {
        let _ = SystemParametersInfoW(
            SPI_SETWORKAREA,
            0,
            Some(&mut updated as *mut RECT as *mut core::ffi::c_void),
            SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
        );
    }
}

/// 점유한 작업 영역을 되돌린다. 종료 경로마다 거치도록 RunEvent::Exit에서 호출한다.
pub fn restore_work_area() {
    let Ok(mut guard) = ORIGINAL_WORK_AREA.lock() else {
        return;
    };
    if let Some(rect) = guard.take() {
        let mut r = rect;        unsafe {
            let _ = SystemParametersInfoW(
                SPI_SETWORKAREA,
                0,
                Some(&mut r as *mut RECT as *mut core::ffi::c_void),
                SPIF_UPDATEINIFILE | SPIF_SENDCHANGE,
            );
        }
    }
}

/// 독은 항상 최상단에 있어야 한다. 게임 뷰어 같은 앱이 순위를 빼앗으면
/// 0.5초 안에 되찾는다. 창 목록이 바뀌면 프런트엔드에 알린다.
pub fn start_topmost_keeper(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last_signature = String::new();
        let mut tick: u32 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            let Ok(hwnd) = hwnd_of(&window) else {
                continue;
            };
            unsafe {
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOPMOST),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                );
            }

            // 창 목록 변화는 1.2초마다 한 번씩만 살핀다. 제목이 자주 바뀌는
            // 앱(브라우저 탭 등)이 이벤트를 폭주시키지 않도록 값만 비교한다.
            tick = tick.wrapping_add(1);
            if tick % 3 == 0 {
                let signature = unsafe { collect_running() }
                    .iter()
                    .map(|w| format!("{}|{}", w.hwnd, w.title))
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
    pub icon: Option<String>,
}

/// 작업표시줄에 뜨는 창 목록. 도구 창·가려진 창·독 자신은 뺀다.
#[tauri::command]
pub fn list_running_windows() -> Result<Vec<RunningWindow>, String> {
    Ok(unsafe { collect_running() })
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let list = &mut *(lparam.0 as *mut Vec<RunningWindow>);
    if list.len() >= 14 {
        return windows::core::BOOL::from(false);
    }
    if let Some(entry) = describe_window(hwnd) {
        list.push(entry);
    }
    windows::core::BOOL::from(true)
}

unsafe fn describe_window(hwnd: HWND) -> Option<RunningWindow> {
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
    let exe = process_path(pid)?;

    Some(RunningWindow {
        hwnd: hwnd.0 as u64,
        title,
        icon: crate::apps::icon_data_url(&exe),
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

unsafe fn collect_running() -> Vec<RunningWindow> {
    let mut list: Vec<RunningWindow> = Vec::new();
    let _ = EnumWindows(
        Some(enum_proc),
        LPARAM(&mut list as *mut Vec<RunningWindow> as isize),
    );
    list
}

/// 독 아이콘을 누르면 그 창으로 점프한다. 이미 앞으로 나와 있으면 최소화 —
/// 작업표시줄을 누르는 감각과 같다.
#[tauri::command]
pub fn focus_window(hwnd: u64) -> Result<(), String> {
    let target = HWND(hwnd as *mut _);
    unsafe {
        if GetForegroundWindow() == target {
            let _ = ShowWindow(target, SW_MINIMIZE);
        } else {
            let _ = SetForegroundWindow(target);
        }
    }
    Ok(())
}
