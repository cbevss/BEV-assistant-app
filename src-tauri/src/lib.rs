//! BEV native backend.
//!
//! Exposes an allowlisted set of Tauri commands the AI tool layer can invoke.
//! Every command validates its arguments and fails closed: a broken input
//! returns an `Err`, never a fabricated success.

mod migrate;
mod audio;
mod integrations;
mod brain;
mod control;
mod diagnostics;
mod apps;
mod appengine;
mod db;
mod error;
mod files;
mod filemgr;
mod docs;
mod gpu;
mod hardware;
mod clipboard;
mod cleanup;
mod journal;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod kwin;
mod games;
mod overlay;
mod replay;
mod screen;
mod secrets;
mod attach;
mod startup;
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

/// Bring the main window to the front, restoring it if hidden or minimised.
pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything opens BEV's folders: carry them over from the old name.
    migrate::run();
    tauri::Builder::default()
        // Must be registered first: a second launch (Start menu, shortcut, or
        // autostart racing a manual start) focuses this instance and exits,
        // instead of running a duplicate tray icon, hotkey and microphone.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
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
            // Task journal; anything left "running" was cut off last time.
            journal::init(&conn)?;
            brain::init(&conn)?;
            docs::init(&conn)?;
            integrations::load_origins(app.handle());
            let cut_off = journal::mark_interrupted(&conn, journal::now_ms())?;
            if cut_off > 0 {
                log::info!("{cut_off} task(s) were interrupted last session");
            }

            // Empty to start: each stats command refreshes just what it reads,
            // so start-up doesn't pay for a full scan of every process and disk.
            let sys = sysinfo::System::new();

            app.manage(AppState {
                sys: std::sync::Mutex::new(sys),
                db: std::sync::Mutex::new(conn),
            });
            // Installed-app index: loads instantly, rescans in the background if stale.
            app.manage(appengine::start(db_path.parent().unwrap().to_path_buf()));

            tray::build(app.handle())?;
            overlay::ensure_overlay(app.handle()).ok();

            // The main window starts hidden (tauri.conf.json). Autostart passes
            // --minimized so BEV signs in quietly to the tray; any other launch
            // shows the window.
            let minimized = std::env::args().any(|a| a == "--minimized");
            if !minimized {
                show_main(app.handle());
            }
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
            audio::list_output_devices,
            audio::set_output_device,
            audio::list_app_audio,
            attach::read_image_attachment,
            attach::save_phone_file,
            startup::fast_start_enabled,
            startup::set_fast_start,
            audio::set_app_audio,
            // Application control
            audio::list_input_devices,
            audio::set_default_input_device,
            audio::set_input_device_level,
            appengine::apps_open,
            appengine::apps_close,
            appengine::apps_search,
            appengine::apps_refresh,
            appengine::apps_status,
            appengine::apps_list,
            journal::journal_start,
            journal::journal_step,
            journal::journal_finish,
            journal::journal_recent,
            journal::journal_take_interrupted,
            apps::list_processes,
            games::list_games,
            games::launch_game,
            files::open_path,
            filemgr::files_list,
            filemgr::files_find,
            filemgr::files_move,
            filemgr::files_mkdir,
            filemgr::files_trash,
            docs::docs_index,
            docs::docs_status,
            docs::docs_search,
            docs::docs_read,
            docs::docs_clear,
            gpu::gpu_stats,
            gpu::running_game,
            hardware::power_plans,
            hardware::set_power_plan,
            hardware::monitor_brightness,
            hardware::set_monitor_brightness,
            hardware::set_theme,
            hardware::media_key,
            hardware::set_wallpaper,
            hardware::empty_recycle_bin,
            clipboard::clipboard_read,
            clipboard::clipboard_write,
            clipboard::clipboard_image,
            cleanup::clean_temp,
            // Window management
            windows_mgmt::focus_window,
            windows_mgmt::window_placements,
            windows_mgmt::place_window,
            windows_mgmt::monitor_work_areas,
            windows_mgmt::idle_seconds,
            windows_mgmt::list_windows,
            // Overlay control
            overlay::show_overlay,
            overlay::hide_overlay,
            overlay::fullscreen_state,
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
            db::data_counts,
            db::memories_clear,
            db::notes_clear,
            db::activity_clear,
            // System actions
            system::lock_pc,
            system::power_action,
            system::take_screenshot,
            screen::capture_screen,
            replay::replay_configure,
            replay::replay_status,
            replay::replay_clip,
            screen::foreground_window,
            control::ui_read,
            control::ui_act,
            control::screen_ocr,
            control::input_keys,
            control::input_type,
            control::input_click,
            control::recorder::record_start,
            control::recorder::record_stop,
            control::recorder::record_status,
            control::input_scroll,
            control::input_hover,
            control::input_drag,
            control::point_info,
            control::input_target,
            diagnostics::diag_system,
            diagnostics::diag_network,
            diagnostics::diag_events,
            diagnostics::diag_devices,
            brain::conv_add,
            brain::conv_search,
            brain::conv_session,
            brain::conv_sessions,
            brain::conv_prune,
            brain::conv_clear,
            brain::notes_list,
            brain::note_get,
            brain::note_save,
            brain::note_delete,
            brain::notes_search,
            brain::set_embedding,
            brain::embeddings_list,
            integrations::integration_allow_origin,
            integrations::integration_forget_origin,
            integrations::integration_fetch,
            integrations::oauth_listen,
            integrations::oauth_wait,
            integrations::mcp_spawn,
            integrations::mcp_send,
            integrations::mcp_kill,
            integrations::web_fetch,
            system::delete_temp_file,
            system::open_settings_page,
            system::list_monitors,
        ])
        .run(tauri::generate_context!())
        .expect("error while running BEV");
}
