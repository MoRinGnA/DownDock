//! 작업표시줄 ^ 안의 숨겨진 프로그램(트레이 전용 앱) 목록.
//!
//! Windows는 트레이 아이콘을 공개 API로 열거하지 않는다. 대신 Windows 11이
//! 아이콘마다 남기는 HKCU\Control Panel\NotifyIconSettings의 실행 파일 경로를 읽고,
//! 지금 실행 중이면서 화면에 창이 없는 것만 골라낸다. 그래서 카카오톡처럼
//! X로 닫아 백그라운드에 남은 프로그램이 여기에 뜬다.

use std::collections::HashSet;
use std::path::PathBuf;

use serde::Serialize;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use crate::apps::icon_data_url;
use crate::win::visible_exe_paths;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayApp {
    pub id: String,
    pub name: String,
    /// 실행 파일 전체 경로. 누르면 이 경로로 실행해 이미 떠 있는 인스턴스를 깨운다.
    pub exe: String,
    pub icon: Option<String>,
}

const MAX_TRAY_APPS: usize = 18;

/// 지금 실행 중인 프로세스의 실행 파일 이름(소문자).
fn running_process_names() -> HashSet<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut names = HashSet::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return names;
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
        while ok {
            let name = String::from_utf16_lossy(&entry.szExeFile)
                .trim_end_matches('\0')
                .to_lowercase();
            if !name.is_empty() {
                names.insert(name);
            }
            ok = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    names
}

/// 레지스트리는 Program Files 같은 경로를 KNOWNFOLDERID GUID로 적어 둔다.
/// 알려진 세 개만 풀고, 나머지는 그대로 둔다(절대 경로는 바로 쓸 수 있다).
fn expand_known_folder(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if !raw.starts_with('{') {
        return Some(PathBuf::from(raw));
    }
    let end = raw.find('}')?;
    let guid = raw[..=end].to_uppercase();
    let rest = raw[end + 1..].trim_start_matches('\\');
    let base = match guid.as_str() {
        // FOLDERID_ProgramFiles
        "{6D809377-6AF0-444B-8957-A3773F02200E}" => std::env::var_os("ProgramFiles"),
        // FOLDERID_ProgramFilesX86
        "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}" => std::env::var_os("ProgramFiles(x86)"),
        // FOLDERID_Windows
        "{F38BF404-1D43-42F2-9305-67DE0B28FC23}" => std::env::var_os("SystemRoot"),
        _ => None,
    }?;
    Some(PathBuf::from(base).join(rest))
}

/// 화면에 창이 없고 트레이에만 남아 있는 실행 중 프로그램.
pub fn collect_tray_apps() -> Vec<TrayApp> {
    let running = running_process_names();
    let visible = visible_exe_paths();

    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Control Panel\NotifyIconSettings")
    else {
        return Vec::new();
    };

    let mut apps: Vec<TrayApp> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for id in key.enum_keys().flatten() {
        let Ok(sub) = key.open_subkey(&id) else {
            continue;
        };
        let Ok(raw) = sub.get_value::<String, _>("ExecutablePath") else {
            continue;
        };
        let Some(exe) = expand_known_folder(&raw) else {
            continue;
        };
        if !exe.is_file() {
            continue;
        }
        let Some(file_name) = exe.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let file_name = file_name.to_lowercase();
        // 지금 돌고 있지 않거나, 화면에 창이 떠 있으면 '숨김'이 아니다.
        if !running.contains(&file_name)
            || file_name == "downdock.exe"
            || file_name == "explorer.exe"
        {
            continue;
        }
        let full = exe.to_string_lossy().to_string();
        if visible.contains(&full.to_lowercase()) {
            continue;
        }
        if !seen.insert(full.to_lowercase()) {
            continue;
        }

        let tooltip = sub.get_value::<String, _>("InitialTooltip").unwrap_or_default();
        let name = if tooltip.trim().is_empty() {
            exe.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| file_name.clone())
        } else {
            tooltip
        };

        apps.push(TrayApp {
            id,
            name,
            icon: icon_data_url(&exe),
            exe: full,
        });
        if apps.len() >= MAX_TRAY_APPS {
            break;
        }
    }

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[tauri::command]
pub fn list_tray_apps() -> Result<Vec<TrayApp>, String> {
    Ok(collect_tray_apps())
}
