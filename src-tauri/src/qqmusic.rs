use crate::qqmusic_mobile_login::{
    create_mobile_qr, watch_mobile_qr, MobileCredential, MobileLoginOutcome, MobileQrEvent,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::{
    header::{HeaderMap, HeaderValue, CONTENT_TYPE, COOKIE, REFERER, USER_AGENT},
    Client,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const SESSION_FILE_NAME: &str = "qqmusic-session.json";
const MAX_LIBRARY_TRACKS: usize = 1_000;
const USER_AGENT_VALUE: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
static SESSION_FILE_WRITE_LOCK: Mutex<()> = Mutex::new(());
static SESSION_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSession {
    music_id: String,
    music_key: String,
    login_type: i64,
    cookie: String,
}

#[derive(Clone)]
struct PendingQr {
    key: String,
    state: PendingQrState,
}

#[derive(Clone)]
enum PendingQrState {
    Waiting,
    Scanned,
    Authorized(Value),
    Expired,
    Refused,
    Failed(String),
}

#[derive(Default)]
struct Session {
    authenticated: PersistedSession,
    pending_qr: Option<PendingQr>,
}

#[derive(Clone)]
pub struct QqMusicState {
    client: Client,
    session: Arc<Mutex<Session>>,
    session_file: PathBuf,
}

impl QqMusicState {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|error| format!("无法初始化 QQ 音乐网络客户端：{error}"))?;
        let session_file = app_data_dir.join(SESSION_FILE_NAME);
        let authenticated = read_persisted_session(&session_file)?;

        Ok(Self {
            client,
            session: Arc::new(Mutex::new(Session {
                authenticated,
                pending_qr: None,
            })),
            session_file,
        })
    }

    fn authenticated_session(&self) -> Result<PersistedSession, String> {
        let session = self
            .session
            .lock()
            .map_err(|_| "QQ 音乐登录会话暂时不可用".to_owned())?;
        if session.authenticated.music_id.is_empty() || session.authenticated.music_key.is_empty() {
            return Err("QQ 音乐尚未登录，请先扫码".to_owned());
        }
        Ok(session.authenticated.clone())
    }

    fn update_pending_qr(&self, key: &str, next_state: PendingQrState) -> Result<(), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "QQ 音乐二维码会话暂时不可用".to_owned())?;
        let Some(pending) = session.pending_qr.as_mut() else {
            return Ok(());
        };
        if pending.key == key {
            pending.state = next_state;
        }
        Ok(())
    }

    fn save_mobile_qr_session(
        &self,
        key: &str,
        authenticated: PersistedSession,
        profile: Value,
    ) -> Result<(), String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "QQ 音乐登录会话暂时不可用".to_owned())?;
        let is_current_qr = session
            .pending_qr
            .as_ref()
            .is_some_and(|pending| pending.key == key);
        if !is_current_qr {
            return Ok(());
        }
        write_persisted_session(&self.session_file, &authenticated)?;
        session.authenticated = authenticated;
        if let Some(pending) = session.pending_qr.as_mut() {
            pending.state = PendingQrState::Authorized(profile);
        }
        Ok(())
    }

    fn complete_mobile_qr_authorization(
        &self,
        key: &str,
        credential: MobileCredential,
    ) -> Result<(), String> {
        let authenticated = PersistedSession {
            music_id: credential.music_id,
            music_key: credential.music_key,
            login_type: credential.login_type,
            cookie: credential.cookie,
        };
        let fallback_profile = normalize_profile(&Value::Null, &authenticated.music_id);
        self.save_mobile_qr_session(key, authenticated, fallback_profile)
    }

    fn clear_session(&self) -> Result<(), String> {
        {
            let mut session = self
                .session
                .lock()
                .map_err(|_| "QQ 音乐登录会话暂时不可用".to_owned())?;
            session.authenticated = PersistedSession::default();
            session.pending_qr = None;
        }
        delete_persisted_session(&self.session_file)
    }
}

fn read_persisted_session(path: &Path) -> Result<PersistedSession, String> {
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content)
            .map_err(|error| format!("无法读取本机保存的 QQ 音乐登录状态：{error}")),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(PersistedSession::default()),
        Err(error) => Err(format!("无法读取本机保存的 QQ 音乐登录状态：{error}")),
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

fn write_persisted_session(path: &Path, session: &PersistedSession) -> Result<(), String> {
    let _write_guard = SESSION_FILE_WRITE_LOCK
        .lock()
        .map_err(|_| "QQ 音乐登录状态保存暂时不可用".to_owned())?;
    let parent = path
        .parent()
        .ok_or_else(|| "无法确定 QQ 音乐登录状态的保存目录".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建 QQ 音乐登录状态目录：{error}"))?;

    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("无法保护 QQ 音乐登录状态目录：{error}"))?;

    let temporary_path = session_sidecar_path(path, "pending");
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);

    #[cfg(unix)]
    options.mode(0o600);

    let write_result = (|| -> Result<(), String> {
        let content = serde_json::to_vec(session)
            .map_err(|error| format!("无法整理 QQ 音乐登录状态：{error}"))?;
        let mut file = options
            .open(&temporary_path)
            .map_err(|error| format!("无法创建 QQ 音乐登录状态文件：{error}"))?;
        file.write_all(&content)
            .map_err(|error| format!("无法保存 QQ 音乐登录状态：{error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法完成 QQ 音乐登录状态保存：{error}"))?;
        replace_session_file(&temporary_path, path)
            .map_err(|error| format!("无法更新 QQ 音乐登录状态：{error}"))?;

        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("无法保护 QQ 音乐登录状态文件：{error}"))?;

        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

fn delete_persisted_session(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("无法清除本机 QQ 音乐登录状态：{error}")),
    }
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
    radios: Vec<Value>,
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

fn qr_status_payload(pending: &PendingQr) -> Result<QrStatusPayload, String> {
    match &pending.state {
        PendingQrState::Waiting => Ok(QrStatusPayload {
            code: 801,
            message: "请使用 QQ 音乐 App 扫描二维码".to_owned(),
            profile: None,
        }),
        PendingQrState::Scanned => Ok(QrStatusPayload {
            code: 802,
            message: "已扫码，请在 QQ 音乐 App 中确认登录".to_owned(),
            profile: None,
        }),
        PendingQrState::Authorized(profile) => Ok(QrStatusPayload {
            code: 803,
            message: "QQ 音乐授权成功".to_owned(),
            profile: Some(profile.clone()),
        }),
        PendingQrState::Expired | PendingQrState::Refused => {
            let refused = matches!(&pending.state, PendingQrState::Refused);
            Ok(QrStatusPayload {
                code: 800,
                message: if refused {
                    "本次 QQ 音乐登录已取消".to_owned()
                } else {
                    "二维码已过期".to_owned()
                },
                profile: None,
            })
        }
        PendingQrState::Failed(message) => Err(message.clone()),
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn qq_sign(data: &str) -> String {
    let digest = format!("{:X}", md5::compute(data));
    let bytes = digest.as_bytes();
    let head_positions = [21, 4, 9, 26, 16, 20, 27, 30];
    let tail_positions = [18, 11, 3, 2, 1, 7, 6, 25];
    let head = head_positions
        .iter()
        .map(|position| bytes[*position] as char)
        .collect::<String>();
    let tail = tail_positions
        .iter()
        .map(|position| bytes[*position] as char)
        .collect::<String>();
    let mask = [
        212u8, 45, 80, 68, 195, 163, 163, 203, 157, 220, 254, 91, 204, 79, 104, 6,
    ];
    let middle = digest
        .as_bytes()
        .chunks_exact(2)
        .enumerate()
        .map(|(index, pair)| {
            let value = u8::from_str_radix(std::str::from_utf8(pair).unwrap_or("00"), 16)
                .unwrap_or_default();
            value ^ mask[index]
        })
        .collect::<Vec<_>>();

    format!("zzb{head}{}{tail}", BASE64.encode(middle))
        .to_lowercase()
        .replace(['/', '+', '='], "")
}

fn default_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_VALUE));
    headers.insert(REFERER, HeaderValue::from_static("https://y.qq.com/"));
    headers
}

fn parse_json_body(body: &str) -> Result<Value, String> {
    let trimmed = body.trim();
    if let Ok(value) = serde_json::from_str(trimmed) {
        return Ok(value);
    }
    let start = trimmed
        .find('{')
        .ok_or_else(|| "QQ 音乐返回了无法识别的数据".to_owned())?;
    let end = trimmed
        .rfind('}')
        .ok_or_else(|| "QQ 音乐返回了无法识别的数据".to_owned())?;
    serde_json::from_str(&trimmed[start..=end])
        .map_err(|error| format!("QQ 音乐返回数据解析失败：{error}"))
}

fn scalar_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_owned)
        .or_else(|| value.as_i64().map(|number| number.to_string()))
        .or_else(|| value.as_u64().map(|number| number.to_string()))
}

fn first_string(value: &Value, pointers: &[&str]) -> String {
    pointers
        .iter()
        .filter_map(|pointer| value.pointer(pointer))
        .find_map(scalar_string)
        .unwrap_or_default()
}

fn first_u64(value: &Value, pointers: &[&str]) -> u64 {
    pointers
        .iter()
        .filter_map(|pointer| value.pointer(pointer))
        .find_map(|candidate| {
            candidate.as_u64().or_else(|| {
                candidate
                    .as_i64()
                    .and_then(|number| u64::try_from(number).ok())
            })
        })
        .unwrap_or_default()
}

fn first_array(value: &Value, pointers: &[&str]) -> Vec<Value> {
    pointers
        .iter()
        .filter_map(|pointer| value.pointer(pointer))
        .find_map(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn normalized_music_id(value: &str) -> String {
    value.trim().trim_start_matches('o').to_owned()
}

async fn qq_get_json(
    state: &QqMusicState,
    url: &str,
    query: Vec<(String, String)>,
    cookie: &str,
    referer: &str,
) -> Result<Value, String> {
    let response = state
        .client
        .get(url)
        .headers(default_headers())
        .header(REFERER, referer)
        .header(COOKIE, cookie)
        .query(&query)
        .send()
        .await
        .map_err(|error| format!("无法连接 QQ 音乐：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("无法读取 QQ 音乐响应：{error}"))?;
    if !status.is_success() {
        return Err(format!("QQ 音乐请求失败（HTTP {}）", status.as_u16()));
    }
    parse_json_body(&body)
}

async fn musicu_call(
    state: &QqMusicState,
    session: &PersistedSession,
    module: &str,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let request_key = format!("{module}.{method}");
    let login_type = if session.login_type > 0 {
        session.login_type
    } else {
        2
    };
    let mut root = Map::new();
    root.insert(
        "comm".to_owned(),
        json!({
            "ct": "11",
            "tmeAppID": "qqmusic",
            "format": "json",
            "inCharset": "utf-8",
            "outCharset": "utf-8",
            "cv": 13020508,
            "v": 13020508,
            "authst": session.music_key,
            "qq": session.music_id,
            "tmeLoginType": login_type.to_string(),
        }),
    );
    root.insert(
        request_key.clone(),
        json!({
            "module": module,
            "method": method,
            "param": params,
        }),
    );
    let payload = Value::Object(root);
    let serialized = serde_json::to_string(&payload)
        .map_err(|error| format!("无法整理 QQ 音乐请求：{error}"))?;
    let sign = qq_sign(&serialized);
    let response = state
        .client
        .post("https://u.y.qq.com/cgi-bin/musics.fcg")
        .headers(default_headers())
        .header(CONTENT_TYPE, "application/json")
        .header(COOKIE, &session.cookie)
        .query(&[("sign", sign)])
        .body(serialized)
        .send()
        .await
        .map_err(|error| format!("无法连接 QQ 音乐数据服务：{error}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("无法读取 QQ 音乐数据服务响应：{error}"))?;
    if !status.is_success() {
        return Err(format!(
            "QQ 音乐数据服务请求失败（HTTP {}）",
            status.as_u16()
        ));
    }
    let response = parse_json_body(&body)?;
    let result = response
        .get(&request_key)
        .cloned()
        .ok_or_else(|| "QQ 音乐没有返回请求结果".to_owned())?;
    let code = result.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code != 0 {
        let message = first_string(&result, &["/msg", "/message"]);
        return Err(if message.is_empty() {
            format!("QQ 音乐请求失败（code {code}）")
        } else {
            format!("QQ 音乐请求失败（code {code}）：{message}")
        });
    }
    Ok(result)
}

async fn fetch_profile_payload(
    state: &QqMusicState,
    session: &PersistedSession,
) -> Result<Value, String> {
    let user_id = normalized_music_id(&session.music_id);
    let query = vec![
        ("_".to_owned(), now_millis().to_string()),
        ("cv".to_owned(), "4747474".to_owned()),
        ("ct".to_owned(), "24".to_owned()),
        ("format".to_owned(), "json".to_owned()),
        ("inCharset".to_owned(), "utf-8".to_owned()),
        ("outCharset".to_owned(), "utf-8".to_owned()),
        ("notice".to_owned(), "0".to_owned()),
        ("platform".to_owned(), "yqq.json".to_owned()),
        ("needNewCode".to_owned(), "0".to_owned()),
        ("uin".to_owned(), user_id.clone()),
        ("g_tk_new_20200303".to_owned(), "0".to_owned()),
        ("g_tk".to_owned(), "0".to_owned()),
        ("cid".to_owned(), "205360838".to_owned()),
        ("userid".to_owned(), user_id.clone()),
        ("reqfrom".to_owned(), "1".to_owned()),
        ("reqtype".to_owned(), "0".to_owned()),
        ("hostUin".to_owned(), "0".to_owned()),
        ("loginUin".to_owned(), user_id.clone()),
    ];
    let payload = qq_get_json(
        state,
        "https://c6.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg",
        query,
        &session.cookie,
        &format!("https://y.qq.com/portal/profile.html?uin={user_id}"),
    )
    .await?;
    let code = payload.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code != 0 {
        return Err(format!("QQ 音乐登录状态已失效（code {code}），请重新扫码"));
    }
    Ok(payload)
}

fn normalize_profile(payload: &Value, music_id: &str) -> Value {
    let id = normalized_music_id(music_id);
    let nickname = first_string(
        payload,
        &[
            "/data/creator/nick",
            "/data/creator/nickname",
            "/data/creator/name",
            "/data/nick",
            "/data/nickname",
            "/creator/nick",
        ],
    );
    let upstream_avatar = first_string(
        payload,
        &[
            "/data/creator/headpic",
            "/data/creator/avatar",
            "/data/headpic",
            "/data/avatar",
        ],
    );
    let avatar_url = if upstream_avatar.is_empty() {
        format!("https://q.qlogo.cn/headimg_dl?dst_uin={id}&spec=640")
    } else {
        upstream_avatar.replace("http://", "https://")
    };

    json!({
        "id": id,
        "nickname": if nickname.is_empty() { "QQ 音乐用户" } else { &nickname },
        "avatarUrl": avatar_url,
    })
}

fn playlist_id(entry: &Value) -> String {
    first_string(
        entry,
        &["/dissid", "/dissId", "/tid", "/id", "/dirid", "/content_id"],
    )
}

fn playlist_title(entry: &Value) -> String {
    first_string(
        entry,
        &["/dissname", "/dissName", "/title", "/name", "/dirname"],
    )
}

fn normalize_playlist(
    entry: &Value,
    index: usize,
    creator: &str,
    is_liked: bool,
    track_ids: Vec<String>,
    fallback_cover: Option<String>,
) -> Option<Value> {
    let id = playlist_id(entry);
    if id.is_empty() {
        return None;
    }
    let title = playlist_title(entry);
    let cover = first_string(
        entry,
        &["/logo", "/picurl", "/picUrl", "/cover", "/cover_url_big"],
    );
    let description = first_string(entry, &["/desc", "/description", "/dissdesc"]);
    let count = first_u64(
        entry,
        &["/songnum", "/songNum", "/song_cnt", "/num0", "/trackCount"],
    )
    .max(track_ids.len() as u64);

    Some(json!({
        "id": id,
        "number": format!("{:03}", index + 1),
        "title": if title.is_empty() { "未命名歌单" } else { &title },
        "creator": creator,
        "description": description,
        "coverImage": if cover.is_empty() { fallback_cover } else { Some(cover.replace("http://", "https://")) },
        "trackCount": count,
        "trackIds": track_ids,
        "isLikedSongs": is_liked,
    }))
}

fn normalize_track(track: &Value) -> Option<Value> {
    let id = first_string(track, &["/mid", "/songmid", "/songMid"]);
    if id.is_empty() {
        return None;
    }
    let title = first_string(track, &["/title", "/name", "/songname"]);
    let translated_title = first_string(track, &["/subtitle", "/subTitle", "/trans_name"]);
    let album_id = first_string(
        track,
        &["/album/mid", "/album/pmid", "/albummid", "/albumMid"],
    );
    let album = first_string(
        track,
        &["/album/title", "/album/name", "/albumname", "/albumName"],
    );
    let singer_values = first_array(track, &["/singer", "/singers"]);
    let artists = singer_values
        .iter()
        .filter_map(|artist| {
            let name = first_string(artist, &["/name", "/title"]);
            if name.is_empty() {
                None
            } else {
                Some(json!({
                    "id": first_string(artist, &["/mid", "/id"]),
                    "name": name,
                }))
            }
        })
        .collect::<Vec<_>>();
    let artist = artists
        .iter()
        .filter_map(|artist| artist.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" / ");
    let interval = first_u64(track, &["/interval", "/duration"]);
    let duration_ms = if interval > 10_000 {
        interval
    } else {
        interval.max(1) * 1_000
    };
    let release_info = first_string(track, &["/time_public", "/publishDate"]);
    let cover_image = if album_id.is_empty() {
        None
    } else {
        Some(format!(
            "https://y.qq.com/music/photo_new/T002R500x500M000{album_id}.jpg"
        ))
    };

    Some(json!({
        "id": id,
        "title": if title.is_empty() { "未命名歌曲" } else { &title },
        "translatedTitle": if translated_title.is_empty() { None::<String> } else { Some(translated_title) },
        "artist": if artist.is_empty() { "未知艺人" } else { &artist },
        "artists": artists,
        "album": if album.is_empty() { "未知专辑" } else { &album },
        "albumId": if album_id.is_empty() { None::<String> } else { Some(album_id) },
        "releaseInfo": if release_info.is_empty() { None::<String> } else { Some(release_info) },
        "durationMs": duration_ms.max(1_000),
        "coverImage": cover_image,
        "coverLabel": "QQ 音乐原始专辑封面",
    }))
}

async fn fetch_playlist_detail(
    state: &QqMusicState,
    session: &PersistedSession,
    id: &str,
) -> Result<Value, String> {
    let user_id = normalized_music_id(&session.music_id);
    qq_get_json(
        state,
        "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg",
        vec![
            ("disstid".to_owned(), id.to_owned()),
            ("type".to_owned(), "1".to_owned()),
            ("json".to_owned(), "1".to_owned()),
            ("utf8".to_owned(), "1".to_owned()),
            ("onlysong".to_owned(), "0".to_owned()),
            ("new_format".to_owned(), "1".to_owned()),
            ("format".to_owned(), "json".to_owned()),
            ("loginUin".to_owned(), user_id),
            ("hostUin".to_owned(), "0".to_owned()),
        ],
        &session.cookie,
        "https://y.qq.com/",
    )
    .await
}

fn playlist_detail_root(payload: &Value) -> &Value {
    payload
        .pointer("/cdlist/0")
        .or_else(|| payload.pointer("/data/cdlist/0"))
        .or_else(|| payload.pointer("/data"))
        .unwrap_or(payload)
}

fn tracks_from_playlist_payload(payload: &Value) -> Vec<Value> {
    let root = playlist_detail_root(payload);
    first_array(root, &["/songlist", "/songList", "/tracks"])
}

fn radio_tracks_from_payload(payload: &Value) -> Vec<Value> {
    first_array(
        payload,
        &[
            "/songlist/data/track_list",
            "/songlist/data/trackList",
            "/songlist/data/songlist",
            "/songlist/data/songList",
            "/songlist/data/list",
            "/songlist/data/tracks",
            "/data/track_list",
            "/data/trackList",
            "/data/songlist",
            "/data/songList",
            "/data/list",
            "/data/tracks",
        ],
    )
    .into_iter()
    .map(|entry| {
        entry
            .get("track")
            .or_else(|| entry.get("songInfo"))
            .or_else(|| entry.get("songinfo"))
            .or_else(|| entry.get("song"))
            .cloned()
            .unwrap_or(entry)
    })
    .collect()
}

async fn fetch_personal_radio_tracks(
    state: &QqMusicState,
    session: &PersistedSession,
) -> Result<Vec<Value>, String> {
    let login_type = if session.login_type > 0 {
        session.login_type
    } else {
        2
    };
    let request = json!({
        "songlist": {
            "module": "mb_track_radio_svr",
            "method": "get_radio_track",
            "param": {
                "id": 99,
                "firstplay": 1,
                "num": 30,
            },
        },
        "comm": {
            "ct": 24,
            "cv": 0,
            "format": "json",
            "uin": normalized_music_id(&session.music_id),
            "authst": session.music_key,
            "tmeLoginType": login_type.to_string(),
        },
    });
    let serialized = serde_json::to_string(&request)
        .map_err(|error| format!("无法整理 QQ 音乐个性推荐请求：{error}"))?;
    let payload = qq_get_json(
        state,
        "https://u.y.qq.com/cgi-bin/musicu.fcg",
        vec![
            ("g_tk".to_owned(), "5381".to_owned()),
            ("format".to_owned(), "json".to_owned()),
            ("inCharset".to_owned(), "utf8".to_owned()),
            ("outCharset".to_owned(), "utf-8".to_owned()),
            ("data".to_owned(), serialized),
        ],
        &session.cookie,
        "https://y.qq.com/",
    )
    .await?;
    let songlist = payload
        .get("songlist")
        .ok_or_else(|| "QQ 音乐没有返回个性推荐结果".to_owned())?;
    let code = songlist.get("code").and_then(Value::as_i64).unwrap_or(0);
    if code != 0 {
        let message = first_string(songlist, &["/msg", "/message"]);
        return Err(if message.is_empty() {
            format!("QQ 音乐个性推荐暂时不可用（code {code}）")
        } else {
            format!("QQ 音乐个性推荐暂时不可用（code {code}）：{message}")
        });
    }
    let tracks = radio_tracks_from_payload(&payload);
    if tracks.is_empty() {
        return Err("QQ 音乐本次没有返回个性推荐歌曲".to_owned());
    }
    Ok(tracks)
}

async fn fetch_collected_albums(state: &QqMusicState, session: &PersistedSession) -> Vec<Value> {
    let user_id = normalized_music_id(&session.music_id);
    let payload = qq_get_json(
        state,
        "https://c6.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg",
        vec![
            ("ct".to_owned(), "20".to_owned()),
            ("cid".to_owned(), "205360956".to_owned()),
            ("userid".to_owned(), user_id.clone()),
            ("reqtype".to_owned(), "2".to_owned()),
            ("sin".to_owned(), "0".to_owned()),
            ("ein".to_owned(), "999".to_owned()),
            ("format".to_owned(), "json".to_owned()),
            ("g_tk".to_owned(), "5381".to_owned()),
        ],
        &session.cookie,
        &format!("https://y.qq.com/portal/profile.html?uin={user_id}"),
    )
    .await;
    let Ok(payload) = payload else {
        return Vec::new();
    };
    let entries = first_array(
        &payload,
        &[
            "/data/albumlist",
            "/data/albumList",
            "/data/list",
            "/albumlist",
            "/albumList",
            "/list",
        ],
    );
    entries
        .into_iter()
        .filter_map(|album| {
            let id = first_string(&album, &["/albummid", "/albumMid", "/mid", "/album/mid"]);
            if id.is_empty() {
                return None;
            }
            let title = first_string(&album, &["/albumname", "/albumName", "/name", "/title"]);
            let artist = first_string(
                &album,
                &["/singername", "/singerName", "/artist", "/singer/name"],
            );
            let cover = first_string(&album, &["/picurl", "/picUrl", "/cover"]);
            Some(json!({
                "id": id,
                "title": if title.is_empty() { "未命名专辑" } else { &title },
                "artist": if artist.is_empty() { "未知艺人" } else { &artist },
                "coverImage": if cover.is_empty() {
                    format!("https://y.qq.com/music/photo_new/T002R500x500M000{id}.jpg")
                } else {
                    cover.replace("http://", "https://")
                },
                "releaseDate": first_string(&album, &["/pubtime", "/publishDate"]),
                "trackCount": first_u64(&album, &["/songnum", "/songCount", "/total"]),
                "trackIds": Vec::<String>::new(),
            }))
        })
        .collect()
}

async fn fetch_album_tracks(
    state: &QqMusicState,
    session: &PersistedSession,
    album_id: &str,
) -> Result<Vec<Value>, String> {
    let response = musicu_call(
        state,
        session,
        "music.musichallAlbum.AlbumSongList",
        "GetAlbumSongList",
        json!({
            "albumMid": album_id,
            "albumID": 0,
            "begin": 0,
            "num": MAX_LIBRARY_TRACKS,
            "order": 2,
        }),
    )
    .await?;
    Ok(first_array(
        &response,
        &[
            "/data/songList",
            "/data/songlist",
            "/data/songs",
            "/songList",
            "/songlist",
        ],
    ))
}

fn svg_for_png(png: &[u8]) -> String {
    let encoded = BASE64.encode(png);
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 320 320\">\
         <rect width=\"320\" height=\"320\" fill=\"#f4f4f2\"/>\
         <image href=\"data:image/png;base64,{encoded}\" x=\"0\" y=\"0\" width=\"320\" height=\"320\" \
         preserveAspectRatio=\"xMidYMid meet\"/></svg>"
    )
}

#[tauri::command]
pub async fn qq_create_qr(state: tauri::State<'_, QqMusicState>) -> Result<QrLoginPayload, String> {
    let mobile_qr = create_mobile_qr(&state.client).await?;
    let key = format!("{}:{}", mobile_qr.id, now_millis());
    {
        let mut session = state
            .session
            .lock()
            .map_err(|_| "QQ 音乐二维码会话暂时不可用".to_owned())?;
        session.pending_qr = Some(PendingQr {
            key: key.clone(),
            state: PendingQrState::Waiting,
        });
    }
    let watcher_state = state.inner().clone();
    let watcher_key = key.clone();
    let qrcode_id = mobile_qr.id.clone();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let watcher_task = tauri::async_runtime::spawn(async move {
        let mut retry_count = 0u64;
        let mut ready_tx = Some(ready_tx);
        let watched =
            loop {
                let client_id = format!(
                    "{}{:04}",
                    now_millis(),
                    (now_millis() + u128::from(retry_count)) % 10_000
                );
                let result =
                    watch_mobile_qr(&watcher_state.client, &qrcode_id, &client_id, |event| {
                        match event {
                            MobileQrEvent::Ready => {
                                if let Some(sender) = ready_tx.take() {
                                    let _ = sender.send(Ok(()));
                                }
                            }
                            MobileQrEvent::Scanned => {
                                let _ = watcher_state
                                    .update_pending_qr(&watcher_key, PendingQrState::Scanned);
                            }
                        }
                    })
                    .await;
                match result {
                    Err(_) if retry_count < 5 => {
                        retry_count += 1;
                        tokio::time::sleep(Duration::from_millis(1_500 * retry_count)).await;
                    }
                    _ => break result,
                }
            };
        if let Some(sender) = ready_tx.take() {
            let error = match &watched {
                Err(error) => error.clone(),
                Ok(MobileLoginOutcome::Failed(error)) => error.clone(),
                Ok(MobileLoginOutcome::Refused) => "本次 QQ 音乐登录已取消".to_owned(),
                Ok(MobileLoginOutcome::Expired) => "QQ 音乐二维码已过期".to_owned(),
                Ok(MobileLoginOutcome::Authorized(_)) => "QQ 音乐扫码会话未完成订阅准备".to_owned(),
            };
            let _ = sender.send(Err(error));
        }
        match watched {
            Ok(MobileLoginOutcome::Authorized(credential)) => {
                // Authorization is complete as soon as the durable credential is
                // available. Profile enrichment is optional and happens again in
                // library sync; waiting for it here left the QR UI in "scanned"
                // for up to the HTTP timeout even though the phone had succeeded.
                if let Err(error) =
                    watcher_state.complete_mobile_qr_authorization(&watcher_key, credential)
                {
                    let _ = watcher_state.update_pending_qr(
                        &watcher_key,
                        PendingQrState::Failed(format!(
                            "QQ 音乐已授权，但无法保存登录状态：{error}"
                        )),
                    );
                }
            }
            Ok(MobileLoginOutcome::Refused) => {
                let _ = watcher_state.update_pending_qr(&watcher_key, PendingQrState::Refused);
            }
            Ok(MobileLoginOutcome::Expired) => {
                let _ = watcher_state.update_pending_qr(&watcher_key, PendingQrState::Expired);
            }
            Ok(MobileLoginOutcome::Failed(error)) => {
                let _ =
                    watcher_state.update_pending_qr(&watcher_key, PendingQrState::Failed(error));
            }
            Err(error) => {
                let _ =
                    watcher_state.update_pending_qr(&watcher_key, PendingQrState::Failed(error));
            }
        }
    });
    match tokio::time::timeout(Duration::from_secs(30), ready_rx).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(error))) => {
            watcher_task.abort();
            return Err(error);
        }
        Ok(Err(_)) => {
            watcher_task.abort();
            return Err("QQ 音乐扫码准备任务意外结束，请重试".to_owned());
        }
        Err(_) => {
            watcher_task.abort();
            return Err("QQ 音乐扫码状态订阅准备超时，请检查网络后重试".to_owned());
        }
    }
    Ok(QrLoginPayload {
        key,
        qr_url: "https://y.qq.com/".to_owned(),
        qr_svg: svg_for_png(&mobile_qr.png),
    })
}

#[tauri::command]
pub async fn qq_check_qr(
    key: String,
    state: tauri::State<'_, QqMusicState>,
) -> Result<QrStatusPayload, String> {
    let pending = {
        let session = state
            .session
            .lock()
            .map_err(|_| "QQ 音乐二维码会话暂时不可用".to_owned())?;
        let pending = session
            .pending_qr
            .clone()
            .ok_or_else(|| "二维码会话不存在，请刷新二维码".to_owned())?;
        if pending.key != key {
            return Err("二维码会话不匹配，请刷新二维码".to_owned());
        }
        pending
    };
    // Keep terminal states replayable. If the native 803 response reaches the
    // app but the IPC reply is lost, the next poll must observe 803 again rather
    // than turning a completed login into "二维码会话不存在".
    qr_status_payload(&pending)
}

#[tauri::command]
pub async fn qq_restore_session(
    state: tauri::State<'_, QqMusicState>,
) -> Result<SessionRestorePayload, String> {
    let authenticated = {
        let session = state
            .session
            .lock()
            .map_err(|_| "QQ 音乐登录会话暂时不可用".to_owned())?;
        session.authenticated.clone()
    };
    if authenticated.music_id.is_empty() || authenticated.music_key.is_empty() {
        return Ok(SessionRestorePayload {
            connected: false,
            message: String::new(),
            profile: None,
        });
    }
    match fetch_profile_payload(&state, &authenticated).await {
        Ok(payload) => Ok(SessionRestorePayload {
            connected: true,
            message: "已恢复 QQ 音乐登录".to_owned(),
            profile: Some(normalize_profile(&payload, &authenticated.music_id)),
        }),
        Err(error) if error.contains("已失效") => {
            state.clear_session()?;
            Ok(SessionRestorePayload {
                connected: false,
                message: "本机保存的 QQ 音乐授权已失效，请重新扫码".to_owned(),
                profile: None,
            })
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn qq_sync_library(
    state: tauri::State<'_, QqMusicState>,
) -> Result<RawLibraryPayload, String> {
    let authenticated = state.authenticated_session()?;
    let profile_payload = fetch_profile_payload(&state, &authenticated).await?;
    let profile = normalize_profile(&profile_payload, &authenticated.music_id);
    let nickname = profile
        .get("nickname")
        .and_then(Value::as_str)
        .unwrap_or("QQ 音乐用户")
        .to_owned();
    // The personalized station is optional provider data: a temporary QQ
    // recommendation failure must not make the user's real library unusable.
    let personal_radio_tracks = fetch_personal_radio_tracks(&state, &authenticated)
        .await
        .unwrap_or_default();
    let mut playlist_entries = first_array(
        &profile_payload,
        &[
            "/data/mydiss/list",
            "/data/createdDissList",
            "/data/createdList",
            "/data/playlists",
            "/mydiss/list",
            "/createdDissList",
            "/playlists",
        ],
    );
    let liked_entries = first_array(&profile_payload, &["/data/mymusic", "/mymusic"]);
    playlist_entries.extend(liked_entries.iter().cloned());

    let mut seen_playlists = HashSet::new();
    playlist_entries.retain(|entry| {
        let id = playlist_id(entry);
        !id.is_empty() && seen_playlists.insert(id)
    });

    let mut playlists = Vec::new();
    let mut liked_track_ids = Vec::new();
    let mut ordered_track_ids = Vec::new();
    let mut track_map = HashMap::<String, Value>::new();
    let mut radio_track_ids = Vec::new();
    let mut radio_cover = None;
    let mut seen_radio_track_ids = HashSet::new();

    for raw_track in personal_radio_tracks {
        let Some(track) = normalize_track(&raw_track) else {
            continue;
        };
        let Some(track_id) = track.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !seen_radio_track_ids.insert(track_id.to_owned()) {
            continue;
        }
        radio_cover.get_or_insert_with(|| {
            track
                .get("coverImage")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        });
        radio_track_ids.push(track_id.to_owned());
        if track_map.len() < MAX_LIBRARY_TRACKS && !track_map.contains_key(track_id) {
            ordered_track_ids.push(track_id.to_owned());
            track_map.insert(track_id.to_owned(), track);
        }
    }

    for entry in playlist_entries {
        let id = playlist_id(&entry);
        let title = playlist_title(&entry);
        let item_type = first_u64(&entry, &["/type"]);
        let is_liked =
            title.contains("喜欢") || title.to_ascii_lowercase().contains("like") || item_type == 1;
        let detail = fetch_playlist_detail(&state, &authenticated, &id)
            .await
            .ok();
        let detail_root = detail.as_ref().map(playlist_detail_root);
        let raw_tracks = detail
            .as_ref()
            .map(tracks_from_playlist_payload)
            .unwrap_or_default();
        let mut track_ids = Vec::new();
        let mut fallback_cover = None;
        for raw_track in raw_tracks {
            if let Some(track) = normalize_track(&raw_track) {
                let Some(track_id) = track.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if fallback_cover.is_none() {
                    fallback_cover = track
                        .get("coverImage")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
                track_ids.push(track_id.to_owned());
                if track_map.len() < MAX_LIBRARY_TRACKS && !track_map.contains_key(track_id) {
                    ordered_track_ids.push(track_id.to_owned());
                    track_map.insert(track_id.to_owned(), track);
                }
            }
        }
        if is_liked {
            liked_track_ids = track_ids.clone();
        }
        let metadata = detail_root.unwrap_or(&entry);
        if let Some(playlist) = normalize_playlist(
            metadata,
            playlists.len(),
            &nickname,
            is_liked,
            track_ids,
            fallback_cover,
        ) {
            playlists.push(playlist);
        }
    }

    let tracks = ordered_track_ids
        .iter()
        .filter_map(|id| track_map.remove(id))
        .collect::<Vec<_>>();
    let albums = fetch_collected_albums(&state, &authenticated).await;
    let radios = if radio_track_ids.is_empty() {
        Vec::new()
    } else {
        vec![json!({
            "id": "qq-personal-radio",
            "number": "001",
            "title": "个性电台",
            "subtitle": "QQ 音乐为你推荐",
            "creator": nickname,
            "coverImage": radio_cover.filter(|cover| !cover.is_empty()),
            "trackCount": radio_track_ids.len(),
            "trackIds": radio_track_ids,
        })]
    };

    Ok(RawLibraryPayload {
        profile,
        playlists,
        radios,
        albums,
        liked_track_ids,
        tracks,
        truncated: ordered_track_ids.len() >= MAX_LIBRARY_TRACKS,
    })
}

#[tauri::command]
pub async fn qq_get_collection_tracks(
    collection_kind: String,
    collection_id: String,
    state: tauri::State<'_, QqMusicState>,
) -> Result<Vec<Value>, String> {
    if collection_id.is_empty()
        || !collection_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("QQ 音乐收藏 ID 无效".to_owned());
    }
    let authenticated = state.authenticated_session()?;
    let raw_tracks = match collection_kind.as_str() {
        "playlist" => {
            let payload = fetch_playlist_detail(&state, &authenticated, &collection_id).await?;
            tracks_from_playlist_payload(&payload)
        }
        "album" => fetch_album_tracks(&state, &authenticated, &collection_id).await?,
        _ => return Err("不支持的 QQ 音乐收藏类型".to_owned()),
    };
    Ok(raw_tracks
        .iter()
        .filter_map(normalize_track)
        .take(MAX_LIBRARY_TRACKS)
        .collect())
}

fn decode_lyric(value: &str) -> String {
    if value.is_empty() || value.contains('[') {
        return value.to_owned();
    }
    BASE64
        .decode(value)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_else(|| value.to_owned())
}

fn lyric_field_string(value: &Value, pointers: &[&str]) -> String {
    const NESTED_KEYS: [&str; 5] = ["lyric", "content", "value", "text", "data"];

    pointers
        .iter()
        .filter_map(|pointer| value.pointer(pointer))
        .find_map(|candidate| {
            candidate
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    candidate.as_object().and_then(|object| {
                        NESTED_KEYS
                            .iter()
                            .filter_map(|key| object.get(*key))
                            .find_map(|nested| {
                                nested
                                    .as_str()
                                    .filter(|text| !text.trim().is_empty())
                                    .map(str::to_owned)
                            })
                    })
                })
        })
        .unwrap_or_default()
}

fn normalized_qq_lyrics_payload(
    legacy: Option<&Value>,
    musicu: Option<&Value>,
) -> RawLyricsPayload {
    let legacy_original = legacy
        .map(|value| lyric_field_string(value, &["/lyric", "/data/lyric"]))
        .unwrap_or_default();
    let legacy_translation = legacy
        .map(|value| {
            lyric_field_string(
                value,
                &["/trans", "/translation", "/data/trans", "/data/translation"],
            )
        })
        .unwrap_or_default();
    let musicu_original = musicu
        .map(|value| {
            lyric_field_string(
                value,
                &[
                    "/data/lrc",
                    "/data/original",
                    "/data/originalLyric",
                    "/data/original_lyric",
                    "/data/lyric",
                    "/lyric",
                ],
            )
        })
        .unwrap_or_default();
    let qrc_word_synced = musicu
        .map(|value| {
            lyric_field_string(
                value,
                &[
                    "/data/qrc",
                    "/qrc",
                    "/data/qrcLyric",
                    "/qrcLyric",
                    "/data/qrc_lyric",
                    "/qrc_lyric",
                ],
            )
        })
        .unwrap_or_default();
    let generic_word_synced = musicu
        .map(|value| {
            lyric_field_string(
                value,
                &[
                    "/data/wordSynced",
                    "/wordSynced",
                    "/data/word_synced",
                    "/word_synced",
                    "/data/lyric",
                    "/lyric",
                ],
            )
        })
        .unwrap_or_default();
    let (word_synced, word_synced_source) = if qrc_word_synced.is_empty() {
        (generic_word_synced, "provider")
    } else {
        (qrc_word_synced, "qrc")
    };
    let word_synced_source = if word_synced.is_empty() {
        "lrc"
    } else {
        word_synced_source
    }
    .to_owned();
    let musicu_translation = musicu
        .map(|value| {
            lyric_field_string(
                value,
                &[
                    "/data/trans",
                    "/data/translation",
                    "/data/transLyric",
                    "/data/trans_lyric",
                    "/data/translatedLyric",
                    "/data/translated_lyric",
                ],
            )
        })
        .unwrap_or_default();

    RawLyricsPayload {
        original: if legacy_original.is_empty() {
            decode_lyric(&musicu_original)
        } else {
            decode_lyric(&legacy_original)
        },
        translation: if musicu_translation.is_empty() {
            decode_lyric(&legacy_translation)
        } else {
            musicu_translation
        },
        word_synced,
        word_synced_source,
    }
}

#[cfg(debug_assertions)]
fn lyric_payload_kind(value: &str) -> &'static str {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "empty"
    } else if trimmed.starts_with('<') {
        "xml"
    } else if trimmed.starts_with('[') {
        "timed-text"
    } else if trimmed.len() >= 16
        && trimmed.len() % 2 == 0
        && trimmed
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        "hex"
    } else {
        "encoded-or-text"
    }
}

#[cfg(debug_assertions)]
fn trace_qq_lyric_shape(response: &Value) {
    if std::env::var("AURAL_QQ_LYRIC_TRACE").as_deref() != Ok("1") {
        return;
    }

    let Some(data) = response.get("data") else {
        eprintln!("[qq-lyrics] musicu data=missing");
        return;
    };
    let Some(fields) = data.as_object() else {
        eprintln!("[qq-lyrics] musicu data_type=non-object");
        return;
    };

    let mut summaries = fields
        .iter()
        .map(|(key, value)| {
            let shape = match value {
                Value::String(text) => format!(
                    "string(len={},kind={})",
                    text.len(),
                    lyric_payload_kind(text)
                ),
                Value::Array(items) => format!("array(len={})", items.len()),
                Value::Object(items) => format!("object(keys={})", items.len()),
                Value::Null => "null".to_owned(),
                Value::Bool(_) => "bool".to_owned(),
                Value::Number(_) => "number".to_owned(),
            };
            format!("{key}:{shape}")
        })
        .collect::<Vec<_>>();
    summaries.sort();
    eprintln!("[qq-lyrics] musicu fields={}", summaries.join(","));
}

#[cfg(debug_assertions)]
fn trace_qq_lyric_failure() {
    if std::env::var("AURAL_QQ_LYRIC_TRACE").as_deref() == Ok("1") {
        eprintln!("[qq-lyrics] musicu status=error");
    }
}

#[tauri::command]
pub async fn qq_get_lyrics(
    track_id: String,
    state: tauri::State<'_, QqMusicState>,
) -> Result<RawLyricsPayload, String> {
    if track_id.is_empty()
        || !track_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("QQ 音乐歌曲 ID 无效".to_owned());
    }
    let authenticated = state.authenticated_session()?;
    let user_id = normalized_music_id(&authenticated.music_id);
    let legacy_request = qq_get_json(
        &state,
        "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
        vec![
            ("songmid".to_owned(), track_id.clone()),
            ("format".to_owned(), "json".to_owned()),
            ("outCharset".to_owned(), "utf-8".to_owned()),
            ("nobase64".to_owned(), "1".to_owned()),
            ("loginUin".to_owned(), user_id),
            ("platform".to_owned(), "yqq.json".to_owned()),
            ("needNewCode".to_owned(), "0".to_owned()),
        ],
        &authenticated.cookie,
        "https://y.qq.com/portal/player.html",
    );
    let musicu_request = musicu_call(
        &state,
        &authenticated,
        "music.musichallSong.PlayLyricInfo",
        "GetPlayLyricInfo",
        json!({
            "crypt": 1,
            "lrc_t": 0,
            "qrc": 1,
            "qrc_t": 0,
            "roma": 0,
            "roma_t": 0,
            "trans": 1,
            "trans_t": 0,
            "needSingingAnnotations": false,
            "type": 1,
            "songMid": track_id,
            "ct": 11,
            "cv": 13020508,
        }),
    );
    let (legacy_lyrics_result, musicu_lyrics_result) = tokio::join!(legacy_request, musicu_request);
    #[cfg(debug_assertions)]
    match musicu_lyrics_result.as_ref() {
        Ok(response) => trace_qq_lyric_shape(response),
        Err(_) => trace_qq_lyric_failure(),
    }
    let lyrics = normalized_qq_lyrics_payload(
        legacy_lyrics_result.as_ref().ok(),
        musicu_lyrics_result.as_ref().ok(),
    );
    if lyrics.original.is_empty() && lyrics.word_synced.is_empty() {
        return Err("QQ 音乐没有返回这首歌的歌词".to_owned());
    }
    Ok(lyrics)
}

async fn fetch_audio_source(
    state: &QqMusicState,
    authenticated: &PersistedSession,
    track_id: &str,
) -> Result<RawAudioSourcePayload, String> {
    for (prefix, extension, bitrate) in [
        ("M800", "mp3", 320_000u64),
        ("M500", "mp3", 128_000u64),
        ("C400", "m4a", 96_000u64),
    ] {
        let filename = format!("{prefix}OvO{track_id}QwQ.{extension}");
        let response = musicu_call(
            state,
            authenticated,
            "music.vkey.GetVkey",
            "UrlGetVkey",
            json!({
                "filename": [filename],
                "guid": format!("tingjing{}", now_millis()),
                "songmid": [track_id],
                "songtype": [0],
            }),
        )
        .await;
        let Ok(response) = response else {
            continue;
        };
        let path = first_string(
            &response,
            &["/data/midurlinfo/0/wifiurl", "/data/midurlinfo/0/purl"],
        );
        if path.is_empty() {
            continue;
        }
        let domain = first_array(&response, &["/data/sip"])
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .find(|value| value.starts_with("https://"))
            .unwrap_or_else(|| "https://isure.stream.qqmusic.qq.com/".to_owned());
        let url = format!(
            "{}{}",
            domain.trim_end_matches('/'),
            if path.starts_with('/') {
                path
            } else {
                format!("/{path}")
            }
        );
        return Ok(RawAudioSourcePayload {
            track_id: track_id.to_owned(),
            url,
            format: Some(extension.to_owned()),
            level: Some(if bitrate >= 320_000 {
                "320k".to_owned()
            } else {
                "standard".to_owned()
            }),
            bitrate: Some(bitrate),
            size: None,
            expires_in_seconds: Some(600),
            is_free_trial: false,
        });
    }

    Err(
        "QQ 音乐没有返回可播放音频；当前账号可能没有播放权限、歌曲受地区限制，或会员音质不可用"
            .to_owned(),
    )
}

#[tauri::command]
pub async fn qq_get_audio_source(
    track_id: String,
    state: tauri::State<'_, QqMusicState>,
) -> Result<RawAudioSourcePayload, String> {
    if track_id.is_empty()
        || !track_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err("QQ 音乐歌曲 ID 无效".to_owned());
    }
    let authenticated = state.authenticated_session()?;
    fetch_audio_source(&state, &authenticated, &track_id).await
}

#[tauri::command]
pub async fn qq_logout(state: tauri::State<'_, QqMusicState>) -> Result<(), String> {
    state.clear_session()
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_track, normalized_qq_lyrics_payload, qq_sign, qr_status_payload,
        radio_tracks_from_payload, read_persisted_session, write_persisted_session,
        MobileCredential, PendingQr, PendingQrState, PersistedSession, QqMusicState,
    };
    use serde_json::{json, Value};
    use std::fs;

    #[test]
    fn qq_sign_has_expected_shape() {
        let sign = qq_sign("{\"comm\":{\"ct\":\"11\"}}");
        assert!(sign.starts_with("zzb"));
        assert!(sign.len() > 20);
        assert!(!sign.contains(['/', '+', '=']));
    }

    #[test]
    fn mobile_authorization_becomes_terminal_without_waiting_for_profile_fetch() {
        let directory = std::env::temp_dir().join(format!(
            "tingjing-qq-auth-test-{}-{}",
            std::process::id(),
            super::now_millis()
        ));
        fs::create_dir_all(&directory).expect("test directory should exist");
        let state = QqMusicState::new(directory.clone()).expect("QQ state should initialize");
        {
            let mut session = state.session.lock().expect("session should be available");
            session.pending_qr = Some(PendingQr {
                key: "qr-key".to_owned(),
                state: PendingQrState::Scanned,
            });
        }

        state
            .complete_mobile_qr_authorization(
                "qr-key",
                MobileCredential {
                    music_id: "123456".to_owned(),
                    music_key: "music-key".to_owned(),
                    login_type: 2,
                    cookie: "qqmusic_uin=123456; qqmusic_key=music-key".to_owned(),
                },
            )
            .expect("authorization should commit synchronously");

        {
            let session = state.session.lock().expect("session should be available");
            assert_eq!(session.authenticated.music_id, "123456");
            let pending = session
                .pending_qr
                .as_ref()
                .expect("QR should remain pollable");
            match &pending.state {
                PendingQrState::Authorized(profile) => {
                    assert_eq!(profile.get("id").and_then(Value::as_str), Some("123456"));
                }
                _ => panic!("mobile authorization did not reach its terminal state"),
            }
        }

        fs::remove_dir_all(directory).expect("test directory should be removable");
    }

    #[test]
    fn authorized_qr_status_is_replayable_after_an_ipc_delivery_loss() {
        let pending = PendingQr {
            key: "qr-key".to_owned(),
            state: PendingQrState::Authorized(json!({
                "id": "123456",
                "nickname": "QQ 音乐用户",
                "avatarUrl": "https://example.invalid/avatar"
            })),
        };

        let first = qr_status_payload(&pending).expect("first poll should return success");
        let replay = qr_status_payload(&pending).expect("terminal success should replay");
        assert_eq!(first.code, 803);
        assert_eq!(replay.code, 803);
        assert_eq!(first.profile, replay.profile);
    }

    #[test]
    fn persisted_session_can_be_replaced_atomically() {
        let directory = std::env::temp_dir().join(format!(
            "tingjing-qq-session-replace-test-{}-{}",
            std::process::id(),
            super::now_millis()
        ));
        let session_file = directory.join(super::SESSION_FILE_NAME);
        let first = PersistedSession {
            music_id: "first-user".to_owned(),
            music_key: "first-key".to_owned(),
            login_type: 2,
            cookie: "qqmusic_uin=first-user".to_owned(),
        };
        let second = PersistedSession {
            music_id: "second-user".to_owned(),
            music_key: "second-key".to_owned(),
            login_type: 2,
            cookie: "qqmusic_uin=second-user".to_owned(),
        };

        write_persisted_session(&session_file, &first)
            .expect("the first session should be written");
        write_persisted_session(&session_file, &second)
            .expect("an existing session should be replaced atomically");

        let restored =
            read_persisted_session(&session_file).expect("the replaced session should load");
        assert_eq!(restored.music_id, second.music_id);
        assert_eq!(restored.music_key, second.music_key);
        assert_eq!(restored.cookie, second.cookie);

        fs::remove_dir_all(directory).expect("test directory should be removable");
    }

    #[test]
    fn qq_tracks_are_normalized_into_the_shared_model() {
        let track = normalize_track(&json!({
            "mid": "003rJSwm3TechU",
            "title": "测试歌曲",
            "interval": 180,
            "singer": [{ "mid": "artist-mid", "name": "测试艺人" }],
            "album": { "mid": "album-mid", "title": "测试专辑" }
        }))
        .expect("track should normalize");

        assert_eq!(
            track.get("id").and_then(|value| value.as_str()),
            Some("003rJSwm3TechU")
        );
        assert_eq!(
            track.get("durationMs").and_then(|value| value.as_u64()),
            Some(180_000)
        );
    }

    #[test]
    fn personal_radio_tracks_accept_direct_and_wrapped_song_shapes() {
        let payload = json!({
            "songlist": {
                "data": {
                    "track_list": [
                        { "mid": "direct-mid", "title": "直接歌曲" },
                        { "track": { "mid": "wrapped-mid", "title": "嵌套歌曲" } }
                    ]
                }
            }
        });
        let tracks = radio_tracks_from_payload(&payload);
        assert_eq!(tracks.len(), 2);
        assert_eq!(
            tracks[0].get("mid").and_then(Value::as_str),
            Some("direct-mid")
        );
        assert_eq!(
            tracks[1].get("mid").and_then(Value::as_str),
            Some("wrapped-mid")
        );
    }

    #[test]
    fn musicu_translation_has_priority_and_qrc_accepts_nested_content() {
        let legacy = json!({
            "lyric": "[00:01.00]original",
            "trans": "[00:01.00]legacy translation"
        });
        let musicu = json!({
            "data": {
                "qrc": { "content": "[1000,500]原(1000,250)文(1250,250)" },
                "trans": "[00:01.00]musicu translation"
            }
        });

        let payload = normalized_qq_lyrics_payload(Some(&legacy), Some(&musicu));
        assert_eq!(payload.original, "[00:01.00]original");
        assert_eq!(payload.translation, "[00:01.00]musicu translation");
        assert_eq!(payload.word_synced, "[1000,500]原(1000,250)文(1250,250)");
        assert_eq!(payload.word_synced_source, "qrc");
    }

    #[test]
    fn musicu_word_timing_fields_have_priority_over_plain_lyric() {
        for (field, expected) in [
            ("qrc", "[1000,500]Q(1000,500)"),
            ("qrcLyric", "[1000,500]C(1000,500)"),
            ("qrc_lyric", "[1000,500]R(1000,500)"),
            ("wordSynced", "[1000,500]W(1000,500)"),
        ] {
            let mut data = serde_json::Map::new();
            data.insert("lyric".to_owned(), json!("[00:01.00]plain line lyric"));
            data.insert(field.to_owned(), json!(expected));
            let musicu = json!({ "data": Value::Object(data) });

            let payload = normalized_qq_lyrics_payload(None, Some(&musicu));
            assert_eq!(payload.word_synced, expected, "field {field}");
            assert_eq!(
                payload.word_synced_source,
                if field.starts_with("qrc") {
                    "qrc"
                } else {
                    "provider"
                },
                "field {field}"
            );
        }
    }

    #[test]
    fn musicu_word_timing_field_order_is_deterministic_and_skips_empty_values() {
        let musicu = json!({
            "data": {
                "qrc": "",
                "qrcLyric": "[1000,500]Q(1000,500)",
                "qrc_lyric": "[1000,500]R(1000,500)",
                "wordSynced": "[1000,500]W(1000,500)",
                "lyric": "[00:01.00]plain line lyric"
            }
        });

        let payload = normalized_qq_lyrics_payload(None, Some(&musicu));
        assert_eq!(payload.word_synced, "[1000,500]Q(1000,500)");
        assert_eq!(payload.word_synced_source, "qrc");
    }

    #[test]
    fn musicu_word_timing_priority_is_stable_across_nested_and_top_level_fields() {
        let musicu = json!({
            "qrc": "[1000,500]Q(1000,500)",
            "data": {
                "wordSynced": "[1000,500]W(1000,500)",
                "lyric": "[00:01.00]plain line lyric"
            }
        });

        let payload = normalized_qq_lyrics_payload(None, Some(&musicu));
        assert_eq!(payload.word_synced, "[1000,500]Q(1000,500)");
        assert_eq!(payload.word_synced_source, "qrc");
    }

    #[test]
    fn musicu_plain_lyric_is_only_the_last_word_timing_fallback() {
        let musicu = json!({
            "data": {
                "lyric": "[00:01.00]plain fallback"
            }
        });

        let payload = normalized_qq_lyrics_payload(None, Some(&musicu));
        assert_eq!(payload.original, "[00:01.00]plain fallback");
        assert_eq!(payload.word_synced, "[00:01.00]plain fallback");
        assert_eq!(payload.word_synced_source, "provider");
    }

    #[test]
    fn legacy_lyrics_remain_available_when_musicu_is_unavailable() {
        let legacy = json!({
            "lyric": "[00:01.00]complete line",
            "translation": "[00:01.00]完整翻译"
        });

        let payload = normalized_qq_lyrics_payload(Some(&legacy), None);
        assert_eq!(payload.original, "[00:01.00]complete line");
        assert_eq!(payload.translation, "[00:01.00]完整翻译");
        assert!(payload.word_synced.is_empty());
        assert_eq!(payload.word_synced_source, "lrc");
    }

    #[test]
    fn musicu_lrc_can_supply_original_when_legacy_is_unavailable() {
        let musicu = json!({
            "data": {
                "lrc": { "lyric": "[00:01.00]musicu original" },
                "transLyric": { "value": "[00:01.00]Musicu 翻译" }
            }
        });

        let payload = normalized_qq_lyrics_payload(None, Some(&musicu));
        assert_eq!(payload.original, "[00:01.00]musicu original");
        assert_eq!(payload.translation, "[00:01.00]Musicu 翻译");
    }
}
