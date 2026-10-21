//! %APPDATA%\DownDock\config.json — 고정 목록·테마·단축키 설정.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::apps::data_dir;

pub const DEFAULT_SHORTCUT: &str = "Ctrl+Alt+D";
const THEMES: [&str; 4] = ["system", "light", "dark", "auto"];
const SHAPES: [&str; 2] = ["round", "facet"];
const SIDES: [&str; 2] = ["left", "right"];
const VERTICALS: [&str; 3] = ["top", "center", "bottom"];

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// 독에 고정한 바로 가기 경로 목록.
    pub pinned: Vec<String>,
    /// "system" | "light" | "dark" | "auto"(배경 밝기에 따라)
    pub theme: String,
    /// 실행기 패널을 여닫는 전역 단축키. 예: "Ctrl+Alt+D"
    pub shortcut: String,
    /// 표면 모양. "round"(둥근 유리) | "facet"(모서리를 깎은 각진 유리)
    pub shape: String,
    /// 독이 붙는 화면 가장자리. "left" | "right"
    pub side: String,
    /// 화면에서 독이 놓이는 세로 위치. "top" | "center" | "bottom"
    pub vertical: String,
    /// 접힌 레일의 세로 길이(px). 창이 많으면 이 값보다 길어진다.
    pub rail_height: u32,
    /// 로그온할 때 자동으로 띄울지. 실제 등록은 OS가 들고 있으므로, 이 값은
    /// 마지막으로 성공한 설정을 기억하는 용도다(시작할 때 한 번 맞춘다).
    pub autostart: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            pinned: Vec::new(),
            theme: "system".into(),
            shortcut: DEFAULT_SHORTCUT.into(),
            shape: "round".into(),
            // 오른쪽은 창 스크롤바를 가린다. 기본은 왼쪽 가장자리.
            side: "left".into(),
            // 기본은 화면 아래에 붙인다.
            vertical: "bottom".into(),
            rail_height: 340,
            // 처음 실행에 로그온 등록을 몰래 넣지 않는다. 설정에서 켜게 한다.
            autostart: false,
        }
    }
}

impl Config {
    fn file() -> PathBuf {
        data_dir().join("config.json")
    }

    /// 파일이 없으면 기본값. 파일이 있는데 읽거나 파싱할 수 없으면 에러를 돌려준다.
    /// 조용히 기본값으로 바꾸면 다음 저장이 손상된 설정을 빈 목록으로 덮어쓴다.
    pub fn load() -> Result<Self, String> {
        match std::fs::read_to_string(Self::file()) {
            Ok(raw) => serde_json::from_str(&raw)
                .map_err(|e| format!("config.json을 읽을 수 없습니다: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::file();
        let dir = path.parent().ok_or("설정 폴더를 찾을 수 없습니다")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(&path, json).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn get_config() -> Result<Config, String> {
    Config::load()
}

#[tauri::command]
pub fn get_pinned() -> Result<Vec<String>, String> {
    Ok(Config::load()?.pinned)
}

#[tauri::command]
pub fn set_pinned(paths: Vec<String>) -> Result<(), String> {
    let mut config = Config::load()?;
    config.pinned = paths;
    config.save()
}

#[tauri::command]
pub fn set_theme(theme: String) -> Result<(), String> {
    if !THEMES.contains(&theme.as_str()) {
        return Err(format!("알 수 없는 테마입니다: {theme}"));
    }
    let mut config = Config::load()?;
    config.theme = theme;
    config.save()
}

#[tauri::command]
pub fn set_shape(shape: String) -> Result<(), String> {
    if !SHAPES.contains(&shape.as_str()) {
        return Err(format!("알 수 없는 모양입니다: {shape}"));
    }
    let mut config = Config::load()?;
    config.shape = shape;
    config.save()
}

#[tauri::command]
pub fn set_side(side: String) -> Result<(), String> {
    if !SIDES.contains(&side.as_str()) {
        return Err(format!("알 수 없는 위치입니다: {side}"));
    }
    let mut config = Config::load()?;
    config.side = side;
    config.save()
}

#[tauri::command]
pub fn set_vertical(vertical: String) -> Result<(), String> {
    if !VERTICALS.contains(&vertical.as_str()) {
        return Err(format!("알 수 없는 세로 위치입니다: {vertical}"));
    }
    let mut config = Config::load()?;
    config.vertical = vertical;
    config.save()
}

// 레일 높이는 화면 높이에 맞춰 UI가 범위를 좁힌다. 여기서는 저장 파일이
// 이상해도 독이 화면을 벗어나지 않도록 같은 범위로 한 번 더 막는다.
const RAIL_HEIGHT_MIN: u32 = 260;
const RAIL_HEIGHT_MAX: u32 = 760;

#[tauri::command]
pub fn set_rail_height(height: u32) -> Result<(), String> {
    if !(RAIL_HEIGHT_MIN..=RAIL_HEIGHT_MAX).contains(&height) {
        return Err(format!("독 높이는 {RAIL_HEIGHT_MIN}~{RAIL_HEIGHT_MAX}px 사이여야 합니다."));
    }
    let mut config = Config::load()?;
    config.rail_height = height;
    config.save()
}

/// 저장된 값과 OS의 로그온 등록을 맞춘다. 레지스트리에서 지워졌거나 새 PC로
/// 옮겨 왔어도, 설정이 켜져 있으면 다시 등록한다. 실패해도 독은 떠야 하므로 조용히 넘긴다.
pub fn sync_autostart(app: &tauri::AppHandle) {
    use tauri_plugin_autostart::ManagerExt;

    let Ok(config) = Config::load() else {
        return;
    };
    let manager = app.autolaunch();
    if config.autostart {
        // 이미 등록돼 있어도 다시 쓴다 — 디버그/릴리스 빌드처럼 실행 파일 경로가
        // 바뀌었을 때 예전 경로를 가리키는 등록이 남지 않게 한다.
        let _ = manager.enable();
    } else if matches!(manager.is_enabled(), Ok(true)) {
        let _ = manager.disable();
    }
}

/// OS에 실제로 등록돼 있는지. 설정 파일과 어긋날 수 있어 UI는 이 값을 보여 준다.
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;

    app.autolaunch()
        .is_enabled()
        .map_err(|e| format!("자동 시작 상태를 읽지 못했습니다: {e}"))
}

/// 로그온 자동 시작을 켜고 끈다. OS 등록이 성공한 뒤에 설정을 바꾼다 —
/// 반대로 하면 화면에는 켜짐으로 보이는데 실제로는 안 뜨는 상태가 된다.
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app.autolaunch();
    if enabled {
        manager
            .enable()
            .map_err(|e| format!("자동 시작을 켜지 못했습니다: {e}"))?;
    } else {
        manager
            .disable()
            .map_err(|e| format!("자동 시작을 끄지 못했습니다: {e}"))?;
    }

    let mut config = Config::load()?;
    config.autostart = enabled;
    config.save()?;

    manager
        .is_enabled()
        .map_err(|e| format!("자동 시작 상태를 확인하지 못했습니다: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // 예전 설정 파일에는 autostart가 없다. 없으면 꺼진 상태로 읽어야 한다.
    #[test]
    fn old_config_without_autostart_still_loads() {
        let config: Config = serde_json::from_str(r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(config.theme, "dark");
        assert!(!config.autostart);
        assert_eq!(config.shortcut, DEFAULT_SHORTCUT);
    }

    // 실제 설정을 건드리지 않도록 임시 APPDATA로 저장·재로딩을 확인한다.
    #[test]
    fn rail_height_roundtrip() {
        let dir = std::env::temp_dir().join(format!("downdock-config-{}", std::process::id()));
        std::env::set_var("APPDATA", &dir);
        assert!(set_rail_height(RAIL_HEIGHT_MIN - 1).is_err());
        set_rail_height(520).unwrap();
        assert_eq!(Config::load().unwrap().rail_height, 520);
        assert!(set_rail_height(RAIL_HEIGHT_MAX + 1).is_err());
        assert!(set_vertical("middle".to_string()).is_err());
        set_vertical("top".to_string()).unwrap();
        assert_eq!(Config::load().unwrap().vertical, "top");
        std::fs::remove_dir_all(&dir).ok();
    }
}
