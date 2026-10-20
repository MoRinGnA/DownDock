//! 전역 단축키: 어디서 누르든 실행기 패널을 여닫는다.
//!
//! 키 등록은 여기서만 한다. 누르면 `launcher:toggle` 이벤트를 프런트엔드에 보낸다.

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::config::{Config, DEFAULT_SHORTCUT};

pub const TOGGLE_EVENT: &str = "launcher:toggle";

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let _ = app.emit(TOGGLE_EVENT, ());
            }
        })
        .build()
}

/// 저장된 단축키를 등록한다. 다른 프로그램이 쓰고 있어도 독은 떠야 하므로 실패는 로그만 남긴다.
pub fn register_saved<R: Runtime>(app: &AppHandle<R>) {
    let combo = Config::load()
        .map(|c| c.shortcut)
        .unwrap_or_else(|_| DEFAULT_SHORTCUT.into());
    if let Err(e) = app.global_shortcut().register(combo.as_str()) {
        eprintln!("단축키 등록 실패 ({combo}): {e}");
    }
}

/// 단축키를 바꾼다. 새 키 등록에 실패하면 이전 키를 되살리고 에러를 돌려준다.
#[tauri::command]
pub fn set_shortcut(app: AppHandle, combo: String) -> Result<(), String> {
    let shortcut: Shortcut = combo
        .parse()
        .map_err(|_| format!("지원하지 않는 단축키입니다: {combo}"))?;
    let mut config = Config::load()?;
    let previous = config.shortcut.clone();

    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    if let Err(e) = gs.register(shortcut) {
        let _ = gs.register(previous.as_str());
        return Err(format!("이 단축키는 쓸 수 없습니다. 다른 프로그램이 쓰는 중일 수 있습니다 ({e})"));
    }
    // 등록 호출이 성공해도 실제로 걸리지 않은 경우가 있다(이미 다른 앱이 잡고 있는 등).
    // 저장 전에 확인해서, 설정에만 반영되고 동작하지 않는 상태를 만들지 않는다.
    if !gs.is_registered(shortcut) {
        let _ = gs.unregister_all();
        let _ = gs.register(previous.as_str());
        return Err(format!("{combo} 를 등록하지 못했습니다. 다른 단축키를 시도해 주세요."));
    }

    config.shortcut = combo;
    config.save()
}
