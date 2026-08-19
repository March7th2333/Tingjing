use netease_music::{LoginQrCheckParams, NeteaseMusicClient};
use qrcode::{render::svg, QrCode};
use reqwest::{
    header::{HeaderMap, HeaderValue, COOKIE, REFERER, SET_COOKIE, USER_AGENT},
    Client, Response,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const MUSIC_ORIGIN: &str = "https://music.163.com";
const SESSION_FILE_NAME: &str = "netease-session";
const MAX_LIBRARY_TRACKS: usize = 1_000;
const SONG_DETAIL_BATCH_SIZE: usize = 250;
const USER_AGENT_VALUE: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
static SESSION_FILE_WRITE_LOCK: Mutex<()> = Mutex::new(());
static SESSION_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
struct Session {
    cookie: String,
    pending_qr_key: Option<String>,
    authorized_qr_key: Option<String>,
}

pub struct NeteaseState {
    client: Client,
    qr_client: Mutex<NeteaseMusicClient>,
    session: Mutex<Session>,
    session_file: PathBuf,
}

impl NeteaseState {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|error| format!("无法初始化网易云网络客户端：{error}"))?;
        let qr_client = build_qr_client()?;
        let session_file = app_data_dir.join(SESSION_FILE_NAME);
        let cookie = read_persisted_cookie(&session_file)?;

        Ok(Self {
            client,
            qr_client: Mutex::new(qr_client),
            session: Mutex::new(Session {
                cookie,
                pending_qr_key: None,
                authorized_qr_key: None,
            }),
            session_file,
        })
    }

    fn persist_cookie(&self, cookie: &str) -> Result<(), String> {
        write_persisted_cookie(&self.session_file, cookie)
    }

    fn clear_persisted_cookie(&self) -> Result<(), String> {
        delete_persisted_cookie(&self.session_file)
    }

    fn merge_authenticated_cookies(&self, cookies: &[String]) -> Result<String, String> {
        let cookie = {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "登录会话暂时不可用".to_owned())?;
            session.cookie = merge_cookie(&session.cookie, cookies);
            session.cookie.clone()
        };

        if cookie.is_empty() {
            return Err("网易云授权成功，但没有返回登录凭据".to_owned());
        }

        self.persist_cookie(&cookie)?;
        Ok(cookie)
    }

    fn complete_qr_authorization(&self, key: &str, cookies: &[String]) -> Result<String, String> {
        let cookie = merge_cookie("", cookies);
        if !cookie
            .split(';')
            .map(str::trim)
            .any(|pair| pair.starts_with("MUSIC_U=") || pair.starts_with("MUSIC_A="))
        {
            return Err("网易云授权成功，但没有返回可用的登录凭据".to_owned());
        }

        let mut session = self
            .session
            .lock()
            .map_err(|_| "登录会话暂时不可用".to_owned())?;
        if session.pending_qr_key.as_deref() != Some(key) {
            return Err("二维码会话已更新，请使用最新二维码".to_owned());
        }

        // Persist while the session lock still owns this QR generation. This
        // prevents a late response from an older QR check from overwriting a
        // newer login attempt between validation and commit.
        self.persist_cookie(&cookie)?;
        session.cookie = cookie.clone();
        session.pending_qr_key = None;
        session.authorized_qr_key = Some(key.to_owned());
        Ok(cookie)
    }

    fn qr_authorization_is_replay(&self, key: &str) -> Result<bool, String> {
        let session = self
            .session
            .lock()
            .map_err(|_| "登录会话暂时不可用".to_owned())?;

        if session.authorized_qr_key.as_deref() == Some(key) {
            return Ok(true);
        }
        if session.pending_qr_key.as_deref() != Some(key) {
            return Err("二维码会话不匹配，请刷新二维码".to_owned());
        }
        Ok(false)
    }

    fn clear_session(&self) -> Result<(), String> {
        {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "登录会话暂时不可用".to_owned())?;
            session.cookie.clear();
            session.pending_qr_key = None;
            session.authorized_qr_key = None;
        }
        self.clear_persisted_cookie()
    }
}

fn read_persisted_cookie(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(cookie) => Ok(cookie),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("无法读取本机保存的网易云登录状态：{error}")),
    }
}

fn session_sidecar_path(path: &Path, role: &str) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(SESSION_FILE_NAME);
    let sequence = SESSION_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(
        "{file_name}.{role}-{}-{sequence}",
        std::process::id()
    ))
}

#[cfg(not(windows))]
fn replace_session_file(temporary_path: &Path, path: &Path) -> std::io::Result<()> {
    fs::rename(temporary_path, path)
}

#[cfg(windows)]
fn replace_session_file(temporary_path: &Path, path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return fs::rename(temporary_path, path);
    }

    let backup_path = session_sidecar_path(path, "replace");
    fs::rename(path, &backup_path)?;
    match fs::rename(temporary_path, path) {
        Ok(()) => {
            let _ = fs::remove_file(backup_path);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(backup_path, path);
            Err(error)
        }
    }
}

fn write_persisted_cookie(path: &Path, cookie: &str) -> Result<(), String> {
    let _write_guard = SESSION_FILE_WRITE_LOCK
        .lock()
        .map_err(|_| "网易云登录状态保存暂时不可用".to_owned())?;
    let parent = path
        .parent()
        .ok_or_else(|| "无法确定网易云登录状态的保存目录".to_owned())?;

    fs::create_dir_all(parent).map_err(|error| format!("无法创建网易云登录状态目录：{error}"))?;

    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("无法保护网易云登录状态目录：{error}"))?;

    let temporary_path = session_sidecar_path(path, "pending");
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);

    #[cfg(unix)]
    options.mode(0o600);

    let write_result = (|| -> Result<(), String> {
        let mut file = options
            .open(&temporary_path)
            .map_err(|error| format!("无法创建网易云登录状态文件：{error}"))?;
        file.write_all(cookie.as_bytes())
            .map_err(|error| format!("无法保存网易云登录状态：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法完成网易云登录状态保存：{error}"))?;
        replace_session_file(&temporary_path, path)
            .map_err(|error| format!("无法更新网易云登录状态：{error}"))?;

        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("无法保护网易云登录状态文件：{error}"))?;

        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }

    write_result
}

fn delete_persisted_cookie(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清除本机网易云登录状态：{error}")),
    }
}

fn build_qr_client() -> Result<NeteaseMusicClient, String> {
    NeteaseMusicClient::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|error| format!("无法初始化网易云桌面登录客户端：{error}"))
}

fn netease_client_cookie_pairs(client: &NeteaseMusicClient) -> Vec<String> {
    client
        .cookies()
        .into_iter()
        .filter(|cookie| !cookie.name.trim().is_empty())
        .map(|cookie| format!("{}={}", cookie.name.trim(), cookie.value.trim()))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginPayload {
    key: String,
    qr_url: String,
    qr_svg: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrStatusPayload {
    code: i64,
    message: String,
    profile: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestorePayload {
    connected: bool,
    message: String,
    profile: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLibraryPayload {
    profile: Value,
    playlists: Vec<Value>,
    albums: Vec<Value>,
    liked_track_ids: Vec<String>,
    tracks: Vec<Value>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLyricsPayload {
    original: String,
    translation: String,
    word_synced: String,
    word_synced_source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAudioSourcePayload {
    track_id: String,
    url: String,
    format: Option<String>,
    level: Option<String>,
    bitrate: Option<u64>,
    size: Option<u64>,
    expires_in_seconds: Option<u64>,
    is_free_trial: bool,
}

fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    headers.insert(REFERER, HeaderValue::from_static("https://music.163.com/"));
    headers
}

fn cookie_pairs(response: &Response) -> Vec<String> {
    response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn merge_cookie(current: &str, incoming: &[String]) -> String {
    let mut order = Vec::<String>::new();
    let mut values = HashMap::<String, String>::new();

    for pair in current
        .split(';')
        .map(str::trim)
        .filter(|pair| !pair.is_empty())
        .chain(incoming.iter().map(String::as_str))
    {
        let Some((name, value)) = pair.split_once('=') else {
            continue;
        };
        let name = name.trim().to_owned();

        if !values.contains_key(&name) {
            order.push(name.clone());
        }
        values.insert(name, value.trim().to_owned());
    }

    order
        .into_iter()
        .filter_map(|name| values.get(&name).map(|value| format!("{name}={value}")))
        .collect::<Vec<_>>()
        .join("; ")
}

fn cookie_pairs_from_string(value: &str) -> Vec<String> {
    const COOKIE_ATTRIBUTES: [&str; 7] = [
        "domain", "expires", "httponly", "max-age", "path", "samesite", "secure",
    ];

    value
        .split(';')
        .map(str::trim)
        .filter(|pair| !pair.is_empty())
        .filter_map(|pair| {
            let (name, value) = pair.split_once('=')?;
            let name = name.trim();
            if COOKIE_ATTRIBUTES
                .iter()
                .any(|attribute| name.eq_ignore_ascii_case(attribute))
            {
                return None;
            }
            Some(format!("{name}={}", value.trim()))
        })
        .collect()
}

async fn post_form(
    state: &NeteaseState,
    path: &str,
    form: Vec<(String, String)>,
    cookie: &str,
) -> Result<(Value, Vec<String>), String> {
    let url = format!("{MUSIC_ORIGIN}{path}");
    let mut request = state
        .client
        .post(url)
        .headers(default_headers())
        .form(&form);

    if !cookie.is_empty() {
        request = request.header(COOKIE, cookie);
    }

    let response = request
        .send()
        .await
        .map_err(|error| format!("无法连接网易云音乐：{error}"))?;
    let status = response.status();
    let cookies = cookie_pairs(&response);
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("网易云返回了无法解析的数据：{error}"))?;

    if !status.is_success() {
        return Err(format!("网易云请求失败（HTTP {status}）"));
    }

    Ok((body, cookies))
}

fn response_code(body: &Value) -> i64 {
    body.get("code").and_then(Value::as_i64).unwrap_or(0)
}

fn response_message(body: &Value, fallback: &str) -> String {
    body.get("message")
        .or_else(|| body.get("msg"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_owned()
}

fn authenticated_cookie(state: &NeteaseState) -> Result<String, String> {
    let session = state
        .session
        .lock()
        .map_err(|_| "登录会话暂时不可用".to_owned())?;

    if session.cookie.is_empty() {
        return Err("尚未完成网易云扫码授权".to_owned());
    }

    Ok(session.cookie.clone())
}

fn cookie_value(cookie: &str, target: &str) -> String {
    cookie
        .split(';')
        .map(str::trim)
        .find_map(|pair| {
            let (name, value) = pair.split_once('=')?;
            name.eq_ignore_ascii_case(target)
                .then(|| value.trim().to_owned())
        })
        .unwrap_or_default()
}

fn audio_source_from_body(
    track_id: &str,
    body: &Value,
) -> Result<Option<RawAudioSourcePayload>, String> {
    if response_code(body) != 200 {
        return Err(response_message(body, "无法获取歌曲播放地址"));
    }

    let Some(source) = body
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
    else {
        return Ok(None);
    };
    let Some(url) = source
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
    else {
        return Ok(None);
    };

    Ok(Some(RawAudioSourcePayload {
        track_id: track_id.to_owned(),
        url: url.to_owned(),
        format: source
            .get("type")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        level: source
            .get("level")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        bitrate: source.get("br").and_then(Value::as_u64),
        size: source.get("size").and_then(Value::as_u64),
        expires_in_seconds: source.get("expi").and_then(Value::as_u64),
        is_free_trial: source
            .get("freeTrialInfo")
            .is_some_and(|value| !value.is_null()),
    }))
}

async fn account_profile(state: &NeteaseState, cookie: &str) -> Result<Value, String> {
    let (body, cookies) = post_form(state, "/api/w/nuser/account/get", Vec::new(), cookie).await?;
    let code = response_code(&body);

    if code == 301 {
        state.clear_session()?;
        return Err("网易云授权已失效，请重新扫码".to_owned());
    }

    if code != 200 {
        return Err(response_message(&body, "无法读取网易云用户资料"));
    }

    let profile = body
        .get("profile")
        .filter(|profile| !profile.is_null())
        .cloned()
        .ok_or_else(|| "网易云授权已失效，请重新扫码".to_owned())?;

    if !cookies.is_empty() {
        state.merge_authenticated_cookies(&cookies)?;
    }

    Ok(profile)
}

fn value_id(value: &Value) -> Option<String> {
    value.get("id").and_then(scalar_id)
}

fn profile_id(profile: &Value) -> Option<String> {
    profile
        .get("userId")
        .and_then(scalar_id)
        .or_else(|| value_id(profile))
}

fn scalar_id(id: &Value) -> Option<String> {
    id.as_str()
        .map(ToOwned::to_owned)
        .or_else(|| id.as_i64().map(|number| number.to_string()))
        .or_else(|| id.as_u64().map(|number| number.to_string()))
}

fn ids_from_track_ids(value: &Value) -> Vec<String> {
    value
        .get("trackIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|track| {
            track
                .get("id")
                .and_then(scalar_id)
                .or_else(|| scalar_id(track))
        })
        .collect()
}

fn insert_track_ids(item: &mut Value, track_ids: Vec<String>) {
    if let Some(object) = item.as_object_mut() {
        object.insert(
            "trackIds".to_owned(),
            Value::Array(track_ids.into_iter().map(Value::String).collect()),
        );
    }
}

async fn fetch_playlist_tracks(
    state: &NeteaseState,
    cookie: &str,
    playlist: &mut Value,
) -> Result<Vec<String>, String> {
    let existing_ids = ids_from_track_ids(playlist);
    if !existing_ids.is_empty() {
        return Ok(existing_ids);
    }

    let Some(id) = value_id(playlist) else {
        return Ok(Vec::new());
    };
    let (body, _) = post_form(
        state,
        "/api/v6/playlist/detail",
        vec![
            ("id".to_owned(), id),
            ("n".to_owned(), MAX_LIBRARY_TRACKS.to_string()),
            ("s".to_owned(), "0".to_owned()),
        ],
        cookie,
    )
    .await?;

    if response_code(&body) != 200 {
        return Ok(Vec::new());
    }

    let track_ids = body
        .get("playlist")
        .map(ids_from_track_ids)
        .unwrap_or_default();
    insert_track_ids(playlist, track_ids.clone());
    Ok(track_ids)
}

async fn fetch_album_tracks(
    state: &NeteaseState,
    cookie: &str,
    album: &mut Value,
) -> Result<(Vec<String>, Vec<Value>), String> {
    let Some(id) = value_id(album) else {
        return Ok((Vec::new(), Vec::new()));
    };
    let (body, _) = post_form(state, &format!("/api/v1/album/{id}"), Vec::new(), cookie).await?;

    if response_code(&body) != 200 {
        return Ok((Vec::new(), Vec::new()));
    }

    let songs = body
        .get("songs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let track_ids = songs.iter().filter_map(value_id).collect::<Vec<_>>();
    insert_track_ids(album, track_ids.clone());
    Ok((track_ids, songs))
}

fn push_unique(
    ids: impl IntoIterator<Item = String>,
    ordered: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    for id in ids {
        if ordered.len() >= MAX_LIBRARY_TRACKS {
            return;
        }
        if seen.insert(id.clone()) {
            ordered.push(id);
        }
    }
}

async fn fetch_song_details(
    state: &NeteaseState,
    cookie: &str,
    ids: &[String],
) -> Result<Vec<Value>, String> {
    let mut tracks = Vec::with_capacity(ids.len());

    for batch in ids.chunks(SONG_DETAIL_BATCH_SIZE) {
        let compact = batch
            .iter()
            .map(|id| format!("{{\"id\":{id}}}"))
            .collect::<Vec<_>>()
            .join(",");
        let (body, _) = post_form(
            state,
            "/api/v3/song/detail",
            vec![("c".to_owned(), format!("[{compact}]"))],
            cookie,
        )
        .await?;

        if response_code(&body) != 200 {
            return Err(response_message(&body, "无法读取歌曲详情"));
        }

        tracks.extend(
            body.get("songs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        );
    }

    Ok(tracks)
}

#[tauri::command]
pub async fn netease_restore_session(
    state: tauri::State<'_, NeteaseState>,
) -> Result<SessionRestorePayload, String> {
    let cookie = {
        let session = state
            .session
            .lock()
            .map_err(|_| "登录会话暂时不可用".to_owned())?;
        session.cookie.clone()
    };

    if cookie.is_empty() {
        return Ok(SessionRestorePayload {
            connected: false,
            message: String::new(),
            profile: None,
        });
    }

    let (body, cookies) =
        post_form(&state, "/api/w/nuser/account/get", Vec::new(), &cookie).await?;
    let code = response_code(&body);

    if code == 301 || (code == 200 && body.get("profile").is_none_or(|profile| profile.is_null())) {
        state.clear_session()?;
        return Ok(SessionRestorePayload {
            connected: false,
            message: "本机保存的网易云授权已失效，请重新扫码".to_owned(),
            profile: None,
        });
    }

    if code != 200 {
        return Err(format!(
            "无法验证已保存的网易云登录（code {code}）：{}",
            response_message(&body, "网易云返回了未知状态")
        ));
    }

    if !cookies.is_empty() {
        state.merge_authenticated_cookies(&cookies)?;
    }

    Ok(SessionRestorePayload {
        connected: true,
        message: "已恢复网易云登录".to_owned(),
        profile: body.get("profile").cloned(),
    })
}

#[tauri::command]
pub async fn netease_create_qr(
    state: tauri::State<'_, NeteaseState>,
) -> Result<QrLoginPayload, String> {
    let qr_client = build_qr_client()?;
    let request_client = qr_client.clone();
    let (response, qr_url) =
        tauri::async_runtime::spawn_blocking(move || request_client.login_qr_key())
            .await
            .map_err(|error| format!("网易云二维码任务异常：{error}"))?
            .map_err(|error| format!("无法创建网易云登录二维码：{error}"))?;
    let code = response
        .code
        .unwrap_or_else(|| response_code(&response.body));

    if code != 200 {
        return Err(format!(
            "无法创建网易云登录二维码（code {code}）：{}",
            response_message(&response.body, "网易云返回了未知状态")
        ));
    }

    let key = response
        .body
        .get("unikey")
        .or_else(|| response.body.pointer("/data/unikey"))
        .and_then(Value::as_str)
        .ok_or_else(|| "网易云未返回二维码密钥".to_owned())?
        .to_owned();
    let qr_code =
        QrCode::new(qr_url.as_bytes()).map_err(|error| format!("无法生成登录二维码：{error}"))?;
    let qr_svg = qr_code
        .render::<svg::Color>()
        .min_dimensions(320, 320)
        .dark_color(svg::Color("#111111"))
        .light_color(svg::Color("#f4f4f2"))
        .build();

    {
        let mut client = state
            .qr_client
            .lock()
            .map_err(|_| "二维码会话暂时不可用".to_owned())?;
        *client = qr_client;
    }
    {
        let mut session = state
            .session
            .lock()
            .map_err(|_| "登录会话暂时不可用".to_owned())?;
        session.pending_qr_key = Some(key.clone());
        session.authorized_qr_key = None;
    }

    Ok(QrLoginPayload {
        key,
        qr_url,
        qr_svg,
    })
}

#[tauri::command]
pub async fn netease_check_qr(
    key: String,
    state: tauri::State<'_, NeteaseState>,
) -> Result<QrStatusPayload, String> {
    if state.qr_authorization_is_replay(&key)? {
        return Ok(QrStatusPayload {
            code: 803,
            message: "授权成功".to_owned(),
            profile: None,
        });
    }
    let qr_client = state
        .qr_client
        .lock()
        .map_err(|_| "二维码会话暂时不可用".to_owned())?
        .clone();
    let request_client = qr_client.clone();
    let request_key = key.clone();
    let response = tauri::async_runtime::spawn_blocking(move || {
        request_client.login_qr_check(LoginQrCheckParams {
            unikey: request_key,
        })
    })
    .await
    .map_err(|error| format!("网易云扫码状态任务异常：{error}"))?
    .map_err(|error| format!("无法检查网易云扫码状态：{error}"))?;
    let body = response.body;
    let mut cookies = netease_client_cookie_pairs(&qr_client);
    if let Some(cookie) = body.get("cookie").and_then(Value::as_str) {
        cookies.extend(cookie_pairs_from_string(cookie));
        for pair in cookie_pairs_from_string(cookie) {
            if let Some((name, value)) = pair.split_once('=') {
                qr_client.set_cookie(name, value);
            }
        }
    }
    cookies.extend(netease_client_cookie_pairs(&qr_client));
    let code = response.code.unwrap_or_else(|| response_code(&body));
    let message = response_message(
        &body,
        match code {
            800 => "二维码已过期",
            801 => "等待扫码",
            802 => "已扫码，请在手机上确认",
            803 => "授权成功",
            _ => "正在等待网易云确认",
        },
    );

    if code == 803 {
        state.complete_qr_authorization(&key, &cookies)?;
    } else if code == 800 {
        let mut session = state
            .session
            .lock()
            .map_err(|_| "登录会话暂时不可用".to_owned())?;
        session.pending_qr_key = None;
    }

    Ok(QrStatusPayload {
        code,
        message,
        // Authorization is the terminal QR state. User-profile hydration is
        // deliberately left to `netease_sync_library`, so a slow or transient
        // profile request cannot hide a successful phone confirmation.
        profile: None,
    })
}

#[tauri::command]
pub async fn netease_sync_library(
    state: tauri::State<'_, NeteaseState>,
) -> Result<RawLibraryPayload, String> {
    let cookie = authenticated_cookie(&state)?;
    let profile = account_profile(&state, &cookie).await?;
    let user_id = profile_id(&profile).ok_or_else(|| "用户资料缺少 ID".to_owned())?;

    let (playlist_body, _) = post_form(
        &state,
        "/api/user/playlist",
        vec![
            ("uid".to_owned(), user_id.clone()),
            ("limit".to_owned(), "1000".to_owned()),
            ("offset".to_owned(), "0".to_owned()),
            ("includeVideo".to_owned(), "true".to_owned()),
        ],
        &cookie,
    )
    .await?;
    if response_code(&playlist_body) != 200 {
        return Err(response_message(&playlist_body, "无法读取用户歌单"));
    }
    let mut playlists = playlist_body
        .get("playlist")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let (liked_body, _) = post_form(
        &state,
        "/api/song/like/get",
        vec![("uid".to_owned(), user_id)],
        &cookie,
    )
    .await?;
    if response_code(&liked_body) == 301 {
        return Err("网易云没有授予收藏歌曲读取权限，请重新扫码授权".to_owned());
    }
    if response_code(&liked_body) != 200 {
        return Err(response_message(&liked_body, "无法读取收藏歌曲"));
    }
    let liked_track_ids = liked_body
        .get("ids")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|id| {
            id.as_i64()
                .map(|value| value.to_string())
                .or_else(|| id.as_u64().map(|value| value.to_string()))
        })
        .collect::<Vec<_>>();

    if let Some(liked_playlist) = playlists.iter_mut().find(|playlist| {
        playlist
            .get("specialType")
            .and_then(Value::as_i64)
            .is_some_and(|special_type| special_type == 5)
    }) {
        insert_track_ids(liked_playlist, liked_track_ids.clone());
    }

    let (album_body, _) = post_form(
        &state,
        "/api/album/sublist",
        vec![
            ("limit".to_owned(), "1000".to_owned()),
            ("offset".to_owned(), "0".to_owned()),
            ("total".to_owned(), "true".to_owned()),
        ],
        &cookie,
    )
    .await?;
    if response_code(&album_body) == 301 {
        return Err("网易云没有授予收藏专辑读取权限，请重新扫码授权".to_owned());
    }
    if response_code(&album_body) != 200 {
        return Err(response_message(&album_body, "无法读取收藏专辑"));
    }
    let albums = album_body
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut ordered_ids = Vec::new();
    let mut seen_ids = HashSet::new();
    push_unique(
        liked_track_ids.iter().cloned(),
        &mut ordered_ids,
        &mut seen_ids,
    );

    for playlist in &mut playlists {
        if ordered_ids.len() >= MAX_LIBRARY_TRACKS {
            break;
        }
        let ids = fetch_playlist_tracks(&state, &cookie, playlist).await?;
        push_unique(ids, &mut ordered_ids, &mut seen_ids);
    }

    let tracks = fetch_song_details(&state, &cookie, &ordered_ids).await?;

    Ok(RawLibraryPayload {
        profile,
        playlists,
        albums,
        liked_track_ids,
        tracks,
        truncated: ordered_ids.len() >= MAX_LIBRARY_TRACKS,
    })
}

#[tauri::command]
pub async fn netease_get_collection_tracks(
    collection_kind: String,
    collection_id: String,
    state: tauri::State<'_, NeteaseState>,
) -> Result<Vec<Value>, String> {
    if !collection_id
        .chars()
        .all(|character| character.is_ascii_digit())
    {
        return Err("收藏 ID 无效".to_owned());
    }

    let cookie = authenticated_cookie(&state)?;
    let ids = match collection_kind.as_str() {
        "playlist" => {
            let mut playlist = json!({ "id": collection_id });
            fetch_playlist_tracks(&state, &cookie, &mut playlist).await?
        }
        "album" => {
            let mut album = json!({ "id": collection_id });
            let (ids, _) = fetch_album_tracks(&state, &cookie, &mut album).await?;
            ids
        }
        _ => return Err("不支持的收藏类型".to_owned()),
    };
    let limited_ids = ids.into_iter().take(MAX_LIBRARY_TRACKS).collect::<Vec<_>>();
    fetch_song_details(&state, &cookie, &limited_ids).await
}

#[tauri::command]
pub async fn netease_get_lyrics(
    track_id: String,
    state: tauri::State<'_, NeteaseState>,
) -> Result<RawLyricsPayload, String> {
    if !track_id.chars().all(|character| character.is_ascii_digit()) {
        return Err("歌曲 ID 无效".to_owned());
    }
    let cookie = authenticated_cookie(&state)?;
    let lyric_client = build_qr_client()?;
    for pair in cookie_pairs_from_string(&cookie) {
        if let Some((name, value)) = pair.split_once('=') {
            lyric_client.set_cookie(name, value);
        }
    }
    lyric_client.apply_request_strategy();
    let lyric_track_id = track_id.clone();
    let current_lyrics = tauri::async_runtime::spawn_blocking(move || {
        lyric_client.call_eapi(
            "https://music.163.com/api/song/lyric/v1",
            json!({
                "id": lyric_track_id,
                "cp": false,
                "tv": 0,
                "lv": 0,
                "rv": 0,
                "kv": 0,
                "yv": 0,
                "ytv": 0,
                "yrv": 0,
            }),
        )
    })
    .await;
    let body = match current_lyrics {
        Ok(Ok(response)) if response.code == Some(200) => response.body,
        _ => {
            let (legacy_body, _) = post_form(
                &state,
                "/api/song/lyric",
                vec![
                    ("id".to_owned(), track_id),
                    ("tv".to_owned(), "-1".to_owned()),
                    ("lv".to_owned(), "-1".to_owned()),
                    ("rv".to_owned(), "-1".to_owned()),
                    ("kv".to_owned(), "-1".to_owned()),
                    ("yv".to_owned(), "-1".to_owned()),
                    ("_nmclfl".to_owned(), "1".to_owned()),
                ],
                &cookie,
            )
            .await?;
            legacy_body
        }
    };
    if response_code(&body) != 200 {
        return Err(response_message(&body, "无法读取歌词"));
    }

    let (word_synced, word_synced_source) = select_word_synced_lyrics(&body);
    Ok(RawLyricsPayload {
        original: body
            .pointer("/lrc/lyric")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        translation: body
            .pointer("/tlyric/lyric")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        word_synced,
        word_synced_source,
    })
}

fn select_word_synced_lyrics(body: &Value) -> (String, String) {
    for (pointer, source) in [("/yrc/lyric", "yrc"), ("/klyric/lyric", "krc")] {
        if let Some(value) = body
            .pointer(pointer)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            return (value.to_owned(), source.to_owned());
        }
    }

    (String::new(), "lrc".to_owned())
}

async fn fetch_audio_source(
    state: &NeteaseState,
    track_id: &str,
) -> Result<RawAudioSourcePayload, String> {
    if track_id.is_empty() || !track_id.chars().all(|character| character.is_ascii_digit()) {
        return Err("歌曲 ID 无效".to_owned());
    }

    let cookie = authenticated_cookie(state)?;
    let playback_cookie = merge_cookie(&cookie, &["os=pc".to_owned(), "appver=9.1.75".to_owned()]);
    let csrf_token = cookie_value(&playback_cookie, "__csrf");

    for bitrate in ["320000", "128000"] {
        let (body, cookies) = post_form(
            state,
            "/api/song/enhance/player/url",
            vec![
                ("ids".to_owned(), format!("[\"{track_id}\"]")),
                ("br".to_owned(), bitrate.to_owned()),
                ("csrf_token".to_owned(), csrf_token.clone()),
            ],
            &playback_cookie,
        )
        .await?;

        if !cookies.is_empty() {
            state.merge_authenticated_cookies(&cookies)?;
        }

        if let Some(source) = audio_source_from_body(track_id, &body)? {
            return Ok(source);
        }
    }

    Err(
        "网易云没有返回可播放音频；当前账号可能没有该歌曲的播放权限，或歌曲在当前地区不可用"
            .to_owned(),
    )
}

#[tauri::command]
pub async fn netease_get_audio_source(
    track_id: String,
    state: tauri::State<'_, NeteaseState>,
) -> Result<RawAudioSourcePayload, String> {
    fetch_audio_source(&state, &track_id).await
}

#[tauri::command]
pub async fn netease_logout(state: tauri::State<'_, NeteaseState>) -> Result<(), String> {
    let cookie = authenticated_cookie(&state).unwrap_or_default();
    let _ = post_form(&state, "/api/logout", Vec::new(), &cookie).await;
    state.clear_session()
}

#[cfg(test)]
mod tests {
    use super::{
        account_profile, audio_source_from_body, authenticated_cookie, cookie_pairs_from_string,
        cookie_value, delete_persisted_cookie, fetch_audio_source, ids_from_track_ids,
        insert_track_ids, merge_cookie, post_form, profile_id, push_unique, read_persisted_cookie,
        response_code, select_word_synced_lyrics, write_persisted_cookie, NeteaseState,
        SESSION_FILE_NAME,
    };
    use serde_json::{json, Value};
    use std::{
        collections::HashSet,
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn cookies_are_replaced_by_name_without_copying_attributes() {
        let merged = merge_cookie(
            "NMTID=old; MUSIC_U=session",
            &["NMTID=new".to_owned(), "__csrf=token".to_owned()],
        );

        assert_eq!(merged, "NMTID=new; MUSIC_U=session; __csrf=token");
    }

    #[test]
    fn cookie_values_are_read_without_exposing_other_pairs() {
        assert_eq!(
            cookie_value("MUSIC_U=session; __csrf=csrf-token; os=pc", "__csrf"),
            "csrf-token"
        );
        assert_eq!(cookie_value("MUSIC_U=session", "__csrf"), "");
    }

    #[test]
    fn completed_qr_authorization_is_persisted_and_replayable() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should follow Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "tingjing-netease-qr-replay-test-{}-{unique}",
            std::process::id()
        ));
        let state = NeteaseState::new(directory.clone())
            .expect("the test QR state should be constructible");
        {
            let mut session = state.session.lock().expect("session lock");
            session.pending_qr_key = Some("qr-key".to_owned());
        }

        assert!(!state
            .qr_authorization_is_replay("qr-key")
            .expect("the pending QR key should match"));
        state
            .complete_qr_authorization(
                "qr-key",
                &[
                    "MUSIC_U=authorized-session".to_owned(),
                    "__csrf=csrf-token".to_owned(),
                ],
            )
            .expect("authorization should commit without loading a profile");

        assert!(state
            .qr_authorization_is_replay("qr-key")
            .expect("the completed QR key should remain replayable"));
        assert_eq!(
            authenticated_cookie(&state).expect("the committed session should be authenticated"),
            "MUSIC_U=authorized-session; __csrf=csrf-token"
        );
        assert_eq!(
            read_persisted_cookie(&directory.join(SESSION_FILE_NAME))
                .expect("the QR credential should be persisted"),
            "MUSIC_U=authorized-session; __csrf=csrf-token"
        );

        state
            .clear_session()
            .expect("the test session should clear");
        fs::remove_dir(&directory).expect("test directory should be empty");
    }

    #[test]
    fn stale_qr_authorization_cannot_replace_the_latest_session() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should follow Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "tingjing-netease-stale-qr-test-{}-{unique}",
            std::process::id()
        ));
        let state = NeteaseState::new(directory.clone())
            .expect("the test QR state should be constructible");
        {
            let mut session = state.session.lock().expect("session lock");
            session.pending_qr_key = Some("latest-key".to_owned());
        }

        let error = state
            .complete_qr_authorization("stale-key", &["MUSIC_U=stale-session".to_owned()])
            .expect_err("a stale QR result must not overwrite the active attempt");

        assert!(error.contains("二维码会话已更新"));
        assert!(authenticated_cookie(&state).is_err());
        assert!(!directory.join(SESSION_FILE_NAME).exists());
    }

    #[test]
    fn audio_source_payload_requires_a_real_http_url() {
        let source = audio_source_from_body(
            "42",
            &json!({
                "code": 200,
                "data": [{
                    "url": "https://example.invalid/audio.mp3",
                    "type": "mp3",
                    "level": "exhigh",
                    "br": 320000,
                    "size": 1234,
                    "expi": 1200,
                    "freeTrialInfo": null
                }]
            }),
        )
        .expect("payload should parse")
        .expect("audio source should exist");

        assert_eq!(source.track_id, "42");
        assert_eq!(source.format.as_deref(), Some("mp3"));
        assert_eq!(source.bitrate, Some(320000));
        assert!(!source.is_free_trial);
        assert!(
            audio_source_from_body("42", &json!({ "code": 200, "data": [{ "url": null }] }))
                .expect("missing URLs are a valid unavailable response")
                .is_none()
        );
    }

    #[test]
    fn word_synced_lyrics_prefer_non_empty_yrc() {
        let (lyrics, source) = select_word_synced_lyrics(&json!({
            "yrc": { "lyric": "[1000,500](1000,250,0)逐(1250,250,0)字" },
            "klyric": { "lyric": "[00:01.00,500]逐字" },
            "lrc": { "lyric": "[00:01.00]逐字" }
        }));

        assert_eq!(lyrics, "[1000,500](1000,250,0)逐(1250,250,0)字");
        assert_eq!(source, "yrc");
    }

    #[test]
    fn word_synced_lyrics_use_krc_when_yrc_is_empty() {
        let (lyrics, source) = select_word_synced_lyrics(&json!({
            "yrc": { "lyric": "   " },
            "klyric": { "lyric": "[00:01.00,500]逐字" },
            "lrc": { "lyric": "[00:01.00]逐字" }
        }));

        assert_eq!(lyrics, "[00:01.00,500]逐字");
        assert_eq!(source, "krc");
    }

    #[test]
    fn word_synced_lyrics_report_lrc_when_word_timing_is_unavailable() {
        let (lyrics, source) = select_word_synced_lyrics(&json!({
            "yrc": { "lyric": "" },
            "klyric": { "lyric": "\n" },
            "lrc": { "lyric": "[00:01.00]整行歌词" }
        }));

        assert!(lyrics.is_empty());
        assert_eq!(source, "lrc");
    }

    #[test]
    #[ignore = "requires an explicit local app-data directory and a live 网易云 session"]
    fn live_session_returns_a_loadable_audio_source() {
        let app_data_dir = std::env::var("TINGJING_TEST_APP_DATA")
            .expect("set TINGJING_TEST_APP_DATA to the private Tauri app-data directory");
        let state = NeteaseState::new(app_data_dir.into())
            .expect("the persisted 网易云 session should load");

        tauri::async_runtime::block_on(async {
            let cookie = authenticated_cookie(&state)
                .expect("the live test requires an authenticated session");
            let profile = account_profile(&state, &cookie)
                .await
                .expect("the authenticated profile should load");
            let user_id = profile_id(&profile).expect("the profile should contain a user ID");
            let (liked_body, _) = post_form(
                &state,
                "/api/song/like/get",
                vec![("uid".to_owned(), user_id)],
                &cookie,
            )
            .await
            .expect("liked tracks should load");
            assert_eq!(response_code(&liked_body), 200);
            let track_id = liked_body
                .get("ids")
                .and_then(Value::as_array)
                .and_then(|ids| ids.first())
                .and_then(super::scalar_id)
                .expect("the live account should have at least one liked track");
            let source = fetch_audio_source(&state, &track_id)
                .await
                .expect("the first liked track should return a playback source");

            assert!(
                source.url.starts_with("http://") || source.url.starts_with("https://"),
                "the source should be an HTTP media URL"
            );
            let mut media_response = state
                .client
                .get(&source.url)
                .headers(super::default_headers())
                .header(reqwest::header::RANGE, "bytes=0-1023")
                .send()
                .await
                .expect("the returned media URL should accept a byte-range request");
            assert!(
                media_response.status().is_success(),
                "the returned media URL should respond successfully"
            );
            let media_bytes = media_response
                .chunk()
                .await
                .expect("the media response should be readable")
                .expect("the media response should contain bytes");
            assert!(
                !media_bytes.is_empty(),
                "the returned media URL should contain audio bytes"
            );
            eprintln!(
                "LIVE_AUDIO_OK track_id={} format={} bitrate={} sampled_bytes={}",
                source.track_id,
                source.format.as_deref().unwrap_or("unknown"),
                source.bitrate.unwrap_or_default(),
                media_bytes.len()
            );
        });
    }

    #[test]
    fn response_cookie_string_drops_transport_attributes() {
        let cookies = cookie_pairs_from_string(
            "MUSIC_U=token; Path=/; HttpOnly; __csrf=csrf; Max-Age=3600; SameSite=Lax",
        );

        assert_eq!(cookies, vec!["MUSIC_U=token", "__csrf=csrf"]);
    }

    #[test]
    fn track_ids_round_trip_as_strings() {
        let mut playlist = json!({ "id": 42 });
        insert_track_ids(&mut playlist, vec!["100".to_owned(), "200".to_owned()]);

        assert_eq!(
            ids_from_track_ids(&playlist),
            vec!["100".to_owned(), "200".to_owned()],
        );
    }

    #[test]
    fn unique_track_collection_preserves_order() {
        let mut ordered = Vec::new();
        let mut seen = HashSet::new();
        push_unique(
            vec!["2".to_owned(), "1".to_owned(), "2".to_owned()],
            &mut ordered,
            &mut seen,
        );

        assert_eq!(ordered, vec!["2".to_owned(), "1".to_owned()]);
    }

    #[test]
    fn profile_id_supports_netease_user_id() {
        assert_eq!(profile_id(&json!({ "userId": 42 })), Some("42".to_owned()));
        assert_eq!(profile_id(&json!({ "id": "7" })), Some("7".to_owned()));
    }

    #[test]
    fn persisted_session_survives_reload_and_can_be_cleared() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should follow Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "tingjing-session-test-{}-{unique}",
            std::process::id()
        ));
        let session_file = directory.join("netease-session");
        let cookie = "MUSIC_U=persisted-session; __csrf=csrf-token";

        write_persisted_cookie(&session_file, cookie)
            .expect("session should be written to the private app directory");
        assert_eq!(
            read_persisted_cookie(&session_file).expect("session should be readable after restart"),
            cookie
        );

        let refreshed_cookie = "MUSIC_U=refreshed-session; __csrf=next-token";
        write_persisted_cookie(&session_file, refreshed_cookie)
            .expect("an existing session should be replaced atomically");
        assert_eq!(
            read_persisted_cookie(&session_file)
                .expect("the refreshed session should be readable after restart"),
            refreshed_cookie
        );

        #[cfg(unix)]
        {
            let directory_mode = fs::metadata(&directory)
                .expect("session directory should exist")
                .permissions()
                .mode()
                & 0o777;
            let file_mode = fs::metadata(&session_file)
                .expect("session file should exist")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(directory_mode, 0o700);
            assert_eq!(file_mode, 0o600);
        }

        delete_persisted_cookie(&session_file).expect("logout should clear the persisted session");
        assert_eq!(
            read_persisted_cookie(&session_file).expect("missing session should be accepted"),
            ""
        );
        fs::remove_dir(&directory).expect("test directory should be empty");
    }
}
