//! %APPDATA%\DownDock\config.json — 고정한 앱 목록과 작업 영역 점유 설정.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::apps::data_dir;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// 독에 고정한 바로 가기 경로 목록.
    pub pinned: Vec<String>,
    /// 하단 작업 영역을 비울지 여부. 릴리스 빌드에서만 기본 켜진다 —
    /// 디버그 중 죽어도 화면이 굳지 않게 하기 위해서다.
    pub reserve_work_area: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            pinned: Vec::new(),
            reserve_work_area: !cfg!(debug_assertions),
        }
    }
}

impl Config {
    fn file() -> PathBuf {
        data_dir().join("config.json")
    }

    pub fn load() -> Self {
        std::fs::read_to_string(Self::file())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
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
pub fn get_pinned() -> Result<Vec<String>, String> {
    Ok(Config::load().pinned)
}

#[tauri::command]
pub fn set_pinned(paths: Vec<String>) -> Result<(), String> {
    let mut config = Config::load();
    config.pinned = paths;
    config.save()
}
