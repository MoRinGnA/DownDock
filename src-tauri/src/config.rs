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

#[cfg(test)]
mod tests {
    use super::*;

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
