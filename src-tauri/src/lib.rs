mod netease;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let netease_state =
                netease::NeteaseState::new(app.path().app_data_dir()?)
                    .map_err(std::io::Error::other)?;
            app.manage(netease_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            netease::netease_restore_session,
            netease::netease_create_qr,
            netease::netease_check_qr,
            netease::netease_sync_library,
            netease::netease_get_collection_tracks,
            netease::netease_get_lyrics,
            netease::netease_get_audio_source,
            netease::netease_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Tauri application");
}
