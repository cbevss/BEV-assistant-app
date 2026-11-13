//! BEV native backend.
//!
//! Exposes an allowlisted set of Tauri commands the AI tool layer can invoke.
//! Every command validates its arguments and fails closed: a broken input
//! returns an `Err`, never a fabricated success.

mod audio;
mod apps;
mod db;
mod error;
mod overlay;
mod secrets;
mod sysmon;
mod system;
mod tray;
mod windows_mgmt;

use tauri::Manager;

pub use error::BevError;

/// Shared, lazily-initialised system probe guarded for cross-thread use.
pub struct AppState {
    pub sys: std::sync::Mutex<sysinfo::System>,
    pub db: std::sync::Mutex<rusqlite::Connection>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("BEV")
                .args(["--minimized"])
                .build(),
        )
        .plugin(tauri_plugin_log::Builder::new().build())
        .setup(|app| {
            // Initialise the on-disk SQLite store next to the app config dir.
            let db_path = app
                .path()
                .app_data_dir()
                .expect("no app data dir")
                .join("bev.db");
            std::fs::create_dir_all(db_path.parent().unwrap()).ok();
            let conn = db::open(&db_path)?;

            let mut sys = sysinfo::System::new_all();
            sys.refresh_all();

            app.manage(AppState {
                sys: std::sync::Mutex::new(sys),
                db: std::sync::Mutex::new(conn),
            });

            tray::build(app.handle())?;
            overlay::ensure_overlay(app.handle()).ok();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // System monitoring
            sysmon::get_system_stats,
            sysmon::get_running_apps,
            // Audio
            audio::get_volume,
            audio::set_volume,
            audio::set_muted,
            audio::is_muted,
            // Application control
            apps::launch_app,
            apps::close_app,
            apps::list_processes,
            // Window management
            windows_mgmt::focus_window,
            windows_mgmt::list_windows,
            // Overlay control
            overlay::show_overlay,
            overlay::hide_overlay,
            overlay::set_overlay_clickthrough,
            overlay::set_overlay_position,
            overlay::place_overlay,
            // Secrets
            secrets::store_secret,
            secrets::get_secret,
            secrets::delete_secret,
            // Memory / db
            db::memory_list,
            db::memory_upsert,
            db::memory_delete,
            db::log_action,
            db::action_log_list,
            db::action_log_clear,
            // System actions
            system::lock_pc,
            system::power_action,
            system::take_screenshot,
            system::delete_temp_file,
            system::open_settings_page,
            system::list_monitors,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BEV");
}
