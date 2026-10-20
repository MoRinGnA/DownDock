//! DownDock — Windows 작업표시줄과 공존하는 오른쪽 세로 Dock.
//!
//! 창 배치와 실행 중인 창 감지는 win.rs, 시작 메뉴 열거와 실행은 apps.rs,
//! 고정 목록은 config.rs, 접힌 레일의 시스템 정보는 status.rs가 맡는다.
//! 이 파일은 그것들을 이어 주는 배선만 한다.

mod apps;
mod backdrop;
mod config;
mod power;
mod shortcut;
mod status;
mod tray;
mod win;

use tauri::Manager;

fn tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let quit = MenuItem::with_id(app, "quit", "DownDock 종료", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quit])?;
    let mut builder = TrayIconBuilder::with_id("downdock-tray")
        .tooltip("DownDock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if event.id() == "quit" {
                app.exit(0);
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn run() {
    win::enable_per_monitor_dpi();

    let app = tauri::Builder::default()
        .plugin(shortcut::plugin())
        .manage(backdrop::Backdrop::new())
        .invoke_handler(tauri::generate_handler![
            apps::list_apps,
            apps::launch_app,
            config::get_config,
            config::get_pinned,
            config::set_pinned,
            config::set_shape,
            config::set_side,
            config::set_vertical,
            config::set_rail_height,
            config::set_theme,
            power::power_action,
            shortcut::set_shortcut,
            status::system_status,
            win::resize_dock,
            win::list_running_windows,
            tray::list_tray_apps,
            win::focus_window,
            win::capture_backdrop,
            win::capture_window,
            backdrop::set_backdrop_region,
            backdrop::backdrop_frame,
            backdrop::backdrop_alive
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("메인 창을 찾을 수 없습니다")?;

            win::decorate(&window)?;
            win::exclude_from_capture(&window)?;
            // 저장된 가장자리·세로 위치에서 시작한다. 설정이 깨졌으면 기본값으로 둔다.
            let (side, vertical) = config::Config::load()
                .map(|c| (c.side, c.vertical))
                .unwrap_or_else(|_| ("left".into(), "bottom".into()));
            win::position_dock(&window, &side, &vertical, 0.0)?;

            win::start_window_monitor(app.handle().clone());
            status::start_watch(app.handle().clone());
            app.state::<backdrop::Backdrop>().start();
            shortcut::register_saved(app.handle());
            tray(app)?;
            window.show()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 독은 종료되지 않는다 — 트레이 메뉴로만 끈다.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("DownDock를 시작할 수 없습니다");

    app.run(|_handle, _event| {});
}


