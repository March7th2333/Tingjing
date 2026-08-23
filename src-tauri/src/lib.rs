mod netease;
mod qqmusic;
mod qqmusic_mobile_login;
mod spotify;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let netease_state =
                netease::NeteaseState::new(app_data_dir).map_err(std::io::Error::other)?;
            let qq_state = qqmusic::QqMusicState::new(app.path().app_data_dir()?)
                .map_err(std::io::Error::other)?;
            let spotify_state = spotify::SpotifyState::new(app.path().app_data_dir()?)
                .map_err(std::io::Error::other)?;
            app.manage(netease_state);
            app.manage(qq_state);
            app.manage(spotify_state);
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
            qqmusic::qq_restore_session,
            qqmusic::qq_create_qr,
            qqmusic::qq_check_qr,
            qqmusic::qq_sync_library,
            qqmusic::qq_get_collection_tracks,
            qqmusic::qq_get_lyrics,
            qqmusic::qq_get_audio_source,
            qqmusic::qq_logout,
            spotify::spotify_begin_oauth,
            spotify::spotify_check_oauth,
            spotify::spotify_restore_session,
            spotify::spotify_sync_library,
            spotify::spotify_get_collection_tracks,
            spotify::spotify_open_external,
            spotify::spotify_logout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Tauri application");
}
