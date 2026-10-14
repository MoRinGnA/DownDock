//! 시작 메뉴의 바로 가기 목록을 읽고 아이콘을 추출해 실행하는 명령 모음.

use std::collections::HashSet;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;
use windows_icons::IconSize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub icon: Option<String>,
}

/// 설정·아이콘 캐시가 사는 폴더. 프런트엔드는 이 경로를 알 필요가 없다.
pub fn data_dir() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("DownDock")
}

fn hash_id(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn start_menu_dirs() -> Vec<PathBuf> {
    // 셸 API(SHCreateItemFromParsingName 등)는 경로 안의 '/'를 거부한다(E_INVALIDARG).
    // 구분자는 백슬래시로만 만들어야 파일 탐색 API와 셸 API가 같은 경로를 본다.
    const REL: &str = r"Microsoft\Windows\Start Menu\Programs";
    let mut dirs = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        dirs.push(PathBuf::from(appdata).join(REL));
    }
    if let Ok(program_data) = std::env::var("ProgramData") {
        dirs.push(PathBuf::from(program_data).join(REL));
    }
    dirs
}

const MAX_APPS: usize = 240;

/// 시작 메뉴의 .lnk를 모은다. 같은 이름의 바로 가기는 첫 것만 남긴다.
#[tauri::command]
pub fn list_apps() -> Result<Vec<AppEntry>, String> {
    let mut entries: Vec<AppEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for dir in start_menu_dirs() {
        collect_lnk(&dir, &mut entries, &mut seen);
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(entries)
}

fn collect_lnk(dir: &Path, entries: &mut Vec<AppEntry>, seen: &mut HashSet<String>) {
    if entries.len() >= MAX_APPS {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    for item in read_dir.flatten() {
        let path = item.path();
        if path.is_dir() {
            collect_lnk(&path, entries, seen);
            continue;
        }
        let is_lnk = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("lnk"));
        if !is_lnk {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !seen.insert(name.to_lowercase()) {
            continue;
        }
        entries.push(AppEntry {
            id: hash_id(&path),
            name: name.to_string(),
            path: path.to_string_lossy().into_owned(),
            icon: icon_data_url(&path),
        });
        if entries.len() >= MAX_APPS {
            return;
        }
    }
}

/// 아이콘을 PNG 데이터 URL로. 한 번 추출한 아이콘은 파일 캐시에서 다시 읽는다.
/// .lnk뿐 아니라 UWP(스토어 앱) 바로 가기도 이 크레이트가 처리한다.
pub fn icon_data_url(path: &Path) -> Option<String> {
    let cache_dir = data_dir().join("icons");
    let cache = cache_dir.join(format!("{}.png", hash_id(path)));

    let bytes = match std::fs::read(&cache) {
        Ok(bytes) => bytes,
        Err(_) => {
            let image =
                windows_icons::get_icon_by_path_with_size(path, IconSize::Large).ok()?;
            let _ = std::fs::create_dir_all(&cache_dir);
            image.save(&cache).ok()?;
            std::fs::read(&cache).ok()?
        }
    };

    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 바로 가기를 기본 프로그램으로 연다. 셸이 해석하므로 .lnk도 exe도 같은 경로로 돈다.
#[tauri::command]
pub fn launch_app(path: String) -> Result<(), String> {
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::{PCWSTR, w};

    let wide: Vec<u16> = std::ffi::OsStr::new(&path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let result = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        if result.0 as isize <= 32 {
            return Err(format!("실행에 실패했습니다: {path}"));
        }
    }
    Ok(())
}
