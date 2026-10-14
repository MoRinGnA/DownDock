//! DownDock — 작업표시줄을 대체하는 하단 독.
//!
//! 창·작업 영역·커서 감지는 win.rs, 시작 메뉴 열거와 실행은 apps.rs,
//! 고정 목록은 config.rs가 맡는다. 이 파일은 그 셋을 이어 주는 배선만 한다.

mod apps;
mod config;
mod win;

use tauri::Manager;
use win::DOCK_RESERVE_LOGICAL;

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
        .invoke_handler(tauri::generate_handler![
            apps::list_apps,
            apps::launch_app,
            config::get_pinned,
            config::set_pinned,
            win::resize_dock,
            win::list_running_windows,
            win::focus_window
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("메인 창을 찾을 수 없습니다")?;

            win::decorate(&window)?;
            win::position_dock(&window)?;

            if config::Config::load().reserve_work_area {
                if let Some(monitor) = window.current_monitor().ok().flatten() {
                    let scale = monitor.scale_factor();
                    win::reserve_work_area((DOCK_RESERVE_LOGICAL * scale) as i32);
                }
            }

            win::start_topmost_keeper(app.handle().clone());
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

    app.run(|_handle, event| {
        if let tauri::RunEvent::Exit = event {
            win::restore_work_area();
        }
    });
}
