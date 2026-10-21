//! 작업표시줄 ^ 안의 숨겨진 프로그램(트레이 전용 앱) 목록.
//!
//! Windows는 트레이 아이콘을 공개 API로 열거하지 않는다. 그래서 Windows 11이
//! 아이콘마다 남기는 HKCU\Control Panel\NotifyIconSettings 기록을 읽는다. 다만 이
//! 기록은 "지금 살아 있는 아이콘"이 아니라 지난 흔적까지 남는 장부이므로 두 단계로
//! 거른다.
//!
//! 1) 적힌 실행 파일이 지금 그 경로에서 돌고 있는가 — 이름이 아니라 전체 경로로 본다.
//! 2) 그 프로세스의 창이 화면에 떠 있지는 않은가(그러면 '숨김'이 아니다).
//!
//! 이름으로 맞추면 예전 설치 폴더나 다른 빌드(Debug/Release)의 항목이 걸러지지 않아
//! 같은 프로그램이 두 줄로 뜨고, 지워진 앱의 항목도 살아남는다. 경로로 맞추면 그런
//! 유령 항목이 사라진다.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use winreg::enums::HKEY_CURRENT_USER;
use winreg::RegKey;

use crate::apps::{icon_data_url, is_png, png_data_url};
use crate::win::{process_exe, visible_exe_paths};

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

/// 경로 비교용 정규화. 레지스트리와 프로세스 API가 대소문자·구분자를 다르게 적어도
/// 같은 프로그램이면 같은 값이 되도록 만든다.
fn normalize(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim()
        .to_lowercase()
}

/// 레지스트리는 Program Files 같은 경로를 KNOWNFOLDERID GUID로 적어 둔다.
/// 아는 폴더만 풀고, 나머지는 그대로 둔다(절대 경로는 바로 쓸 수 있다).
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
        "{6D809377-6AF0-444B-8957-A3773F02200E}" => {
            PathBuf::from(std::env::var_os("ProgramFiles")?)
        }
        // FOLDERID_ProgramFilesX86
        "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}" => {
            PathBuf::from(std::env::var_os("ProgramFiles(x86)")?)
        }
        // FOLDERID_Windows
        "{F38BF404-1D43-42F2-9305-67DE0B28FC23}" => {
            PathBuf::from(std::env::var_os("SystemRoot")?)
        }
        // FOLDERID_System — 작업 관리자처럼 System32에 사는 트레이 아이콘.
        "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}" => {
            PathBuf::from(std::env::var_os("SystemRoot")?).join("System32")
        }
        _ => return None,
    };
    Some(base.join(rest))
}

/// 레지스트리에 적힌 후보 하나. 아직 "지금 실행 중"인지는 확인하지 않았다.
struct Candidate {
    id: String,
    exe: PathBuf,
    tooltip: String,
    /// 아이콘 스냅샷(PNG). 실행 파일에서 아이콘을 못 뽑을 때 쓴다.
    snapshot: Option<Vec<u8>>,
}

/// 지워진 앱의 항목은 레지스트리에 남지만 파일이 없다. 그런 항목은 여기서 버린다.
fn candidates(key: &RegKey) -> Vec<Candidate> {
    let mut list = Vec::new();
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
        list.push(Candidate {
            id,
            tooltip: sub.get_value::<String, _>("InitialTooltip").unwrap_or_default(),
            snapshot: snapshot_bytes(&sub),
            exe,
        });
    }
    list
}

fn snapshot_bytes(sub: &RegKey) -> Option<Vec<u8>> {
    let bytes = sub.get_raw_value("IconSnapshot").ok()?.bytes;
    // 빌드에 따라 형식이 다를 수 있다. PNG일 때만 그대로 쓴다.
    if is_png(&bytes) && bytes.len() > 8 {
        Some(bytes)
    } else {
        None
    }
}

/// 후보 이름에 해당하는 프로세스의 실행 파일 전체 경로만 골라 온다.
/// 프로세스마다 OpenProcess를 부르면 느리므로, 파일 이름이 후보에 있는 것만 연다.
fn running_paths(names: &HashSet<String>) -> HashSet<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let mut paths = HashSet::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return paths;
        };
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snapshot, &mut entry).is_ok();
        while ok {
            let name = String::from_utf16_lossy(&entry.szExeFile)
                .trim_end_matches('\0')
                .to_lowercase();
            if names.contains(&name) {
                if let Some(path) = process_exe(entry.th32ProcessID) {
                    paths.insert(normalize(&path));
                }
            }
            ok = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
    }
    paths
}

/// 툴팁은 아이콘이 등록되던 순간의 문장이라 "Steam - 로그아웃 됨"처럼 상태가 굳어 있다.
/// 프로그램 이름까지만 쓰고, 그게 비면 실행 파일 이름으로 대신한다.
fn display_name(tooltip: &str, exe: &Path) -> String {
    let cleaned = tooltip.split_whitespace().collect::<Vec<_>>().join(" ");
    let head = cleaned.split(" - ").next().unwrap_or("").trim();
    if !head.is_empty() {
        return head.to_string();
    }
    exe.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "프로그램".into())
}

/// 화면에 창이 없고 트레이에만 남아 있는 실행 중 프로그램.
pub fn collect_tray_apps() -> Vec<TrayApp> {
    let ours = std::env::current_exe().ok().map(|p| normalize(&p));

    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Control Panel\NotifyIconSettings")
    else {
        return Vec::new();
    };
    let candidates = candidates(&key);
    if candidates.is_empty() {
        return Vec::new();
    }

    let names: HashSet<String> = candidates
        .iter()
        .filter_map(|c| c.exe.file_name().map(|n| n.to_string_lossy().to_lowercase()))
        .collect();
    let running = running_paths(&names);
    let visible = visible_exe_paths();

    let mut apps: Vec<TrayApp> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for candidate in candidates {
        let path = normalize(&candidate.exe);
        if ours.as_deref() == Some(path.as_str()) {
            continue;
        }
        // 탐색기는 화면 안내(숨김 아이콘, 입력기)라 프로그램 목록에 넣지 않는다.
        let file_name = candidate
            .exe
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if file_name == "explorer.exe" {
            continue;
        }
        // 핵심: 같은 이름이 아니라 같은 경로에서 돌고 있어야 지금 살아 있는 아이콘이다.
        if !running.contains(&path) || visible.contains(&path) {
            continue;
        }
        if !seen.insert(path) {
            continue;
        }

        apps.push(TrayApp {
            id: candidate.id,
            name: display_name(&candidate.tooltip, &candidate.exe),
            // 실행 파일 아이콘이 없으면 레지스트리가 보관한 스냅샷을 쓴다.
            icon: icon_data_url(&candidate.exe)
                .or_else(|| candidate.snapshot.as_deref().map(png_data_url)),
            exe: candidate.exe.to_string_lossy().into_owned(),
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

#[cfg(test)]
mod tests {
    use super::*;

    // 툴팁은 아이콘이 등록된 순간의 문장이라 " - 상태" 꼬리가 함께 굳어 있다.
    #[test]
    fn tooltip_keeps_only_the_program_name() {
        let exe = Path::new(r"C:\Program Files (x86)\Steam\steam.exe");
        assert_eq!(display_name("Steam - 로그아웃 됨", exe), "Steam");
        assert_eq!(display_name("  KakaoTalk  ", exe), "KakaoTalk");
        // 툴팁이 비면 실행 파일 이름으로 대신한다.
        assert_eq!(display_name("", exe), "steam");
        assert_eq!(display_name("   ", Path::new(r"C:\a\b\App.exe")), "App");
    }

    #[test]
    fn known_folder_guids_expand() {
        let program_files = expand_known_folder(
            r"{6D809377-6AF0-444B-8957-A3773F02200E}\Kakao\KakaoTalk\KakaoTalk.exe",
        )
        .expect("Program Files 경로를 풀지 못했습니다");
        assert!(program_files.is_absolute());
        assert!(program_files.ends_with(r"Kakao\KakaoTalk\KakaoTalk.exe"));

        // FOLDERID_System은 System32까지 붙여야 한다.
        let taskmgr = expand_known_folder(r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\Taskmgr.exe")
            .expect("System32 경로를 풀지 못했습니다");
        assert!(
            taskmgr.ends_with(r"System32\Taskmgr.exe"),
            "{}",
            taskmgr.display()
        );

        // 절대 경로는 손대지 않는다.
        let plain = expand_known_folder(r"C:\tomcat11\bin\Tomcat11w.exe").unwrap();
        assert_eq!(plain, PathBuf::from(r"C:\tomcat11\bin\Tomcat11w.exe"));
    }

    #[test]
    fn paths_ignore_case_and_separator() {
        assert_eq!(
            normalize(Path::new(r"C:\Program Files/Steam\Steam.exe")),
            r"c:\program files\steam\steam.exe"
        );
        assert_eq!(normalize(Path::new(r" C:\App\A.exe ")), r"c:\app\a.exe");
    }

    // 실제 레지스트리와 실행 중인 프로세스가 있어야 하는 검사라 기본 실행에서는 뺀다.
    // `cargo test --lib -- --ignored tray_list`로 직접 확인한다.
    #[test]
    #[ignore]
    fn tray_list_has_no_duplicates_and_points_at_real_files() {
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey(r"Control Panel\NotifyIconSettings")
            .expect("NotifyIconSettings를 읽지 못했습니다");
        println!("레지스트리 항목 = {}", candidates(&key).len());

        let apps = collect_tray_apps();
        let mut seen = HashSet::new();
        for app in &apps {
            assert!(seen.insert(app.exe.to_lowercase()), "중복된 경로: {}", app.exe);
            assert!(Path::new(&app.exe).is_file(), "없는 파일: {}", app.exe);
            println!(
                "[{}] {} | icon={}",
                app.name,
                app.exe,
                app.icon.as_ref().map(|i| i.len()).unwrap_or(0)
            );
        }
    }
}
