//! System-tray icon with a menu: Open BEV, toggle listening, Privacy mode, Quit.
//! Emits events the frontend listens to rather than acting directly, so the UI
//! stays the single source of truth for assistant state.

use crate::error::BevResult;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

pub fn build(app: &tauri::AppHandle) -> BevResult<()> {
    let open = MenuItem::with_id(app, "open", "Open BEV", true, None::<&str>).unwrap();
    let listen = MenuItem::with_id(app, "toggle_listen", "Toggle Listening", true, None::<&str>).unwrap();
    let privacy = MenuItem::with_id(app, "privacy", "Privacy Mode (mic off)", true, None::<&str>).unwrap();
    let sep = PredefinedMenuItem::separator(app).unwrap();
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).unwrap();
    let menu = Menu::with_items(app, &[&open, &listen, &privacy, &sep, &quit]).unwrap();

    TrayIconBuilder::with_id("bev-tray")
        .tooltip("BEV")
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    // A minimised (not hidden) window needs restoring too.
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "toggle_listen" => {
                let _ = app.emit("tray://toggle-listen", ());
            }
            "privacy" => {
                let _ = app.emit("tray://privacy-mode", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    // A minimised (not hidden) window needs restoring too.
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}
