use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};
use url::Url;

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

const SPOTIFY_ACCOUNTS_ORIGIN: &str = "https://accounts.spotify.com";
const SPOTIFY_API_ORIGIN: &str = "https://api.spotify.com/v1";
const SPOTIFY_REDIRECT_REGISTRATION_URI: &str = "http://127.0.0.1/callback";
const SESSION_FILE_NAME: &str = "spotify-session.json";
const PAGE_LIMIT: usize = 50;
const MAX_LIBRARY_ITEMS: usize = 1_000;
const OAUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_CALLBACK_CONNECTIONS: usize = 12;

fn coded_error(code: &str, message: impl AsRef<str>) -> String {
    format!("[{code}] {}", message.as_ref())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSession {
    client_id: String,
    access_token: String,
    refresh_token: String,
    token_type: String,
    scope: String,
    expires_at: u64,
}

#[derive(Clone)]
enum PendingOAuthState {
    Waiting,
    Authorized(RawUser),
    Expired,
    Cancelled,
    Failed(String),
}

#[derive(Clone)]
struct PendingOAuth {
    generation: u64,
    state: PendingOAuthState,
}

#[derive(Default)]
struct OAuthRegistry {
    generation: u64,
    active_key: Option<String>,
    flows: HashMap<String, PendingOAuth>,
}

#[derive(Clone)]
pub struct SpotifyState {
    client: Client,
    session: Arc<Mutex<Option<PersistedSession>>>,
    session_write_lock: Arc<Mutex<()>>,
    refresh_lock: Arc<tokio::sync::Mutex<()>>,
    oauth: Arc<Mutex<OAuthRegistry>>,
    session_file: PathBuf,
}

impl SpotifyState {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .map_err(|error| {
                coded_error(
                    "SPOTIFY_CLIENT_INIT_FAILED",
                    format!("无法初始化 Spotify 网络客户端：{error}"),
                )
            })?;
        let session_file = app_data_dir.join(SESSION_FILE_NAME);
        let session = read_persisted_session(&session_file)?;
        Ok(Self {
            client,
            session: Arc::new(Mutex::new(session)),
            session_write_lock: Arc::new(Mutex::new(())),
            refresh_lock: Arc::new(tokio::sync::Mutex::new(())),
            oauth: Arc::new(Mutex::new(OAuthRegistry::default())),
            session_file,
        })
    }

    fn current_session(&self) -> Result<Option<PersistedSession>, String> {
        self.session
            .lock()
            .map(|session| session.clone())
            .map_err(|_| {
                coded_error(
                    "SPOTIFY_SESSION_UNAVAILABLE",
                    "Spotify 登录会话暂时不可用。",
                )
            })
    }

    fn save_session(&self, session: PersistedSession) -> Result<(), String> {
        let _write_guard = self.session_write_lock.lock().map_err(|_| {
            coded_error(
                "SPOTIFY_SESSION_UNAVAILABLE",
                "Spotify 登录状态写入暂时不可用。",
            )
        })?;
        write_persisted_session(&self.session_file, &session)?;
        *self.session.lock().map_err(|_| {
            coded_error(
                "SPOTIFY_SESSION_UNAVAILABLE",
                "Spotify 登录会话暂时不可用。",
            )
        })? = Some(session);
        Ok(())
    }

    fn clear_session(&self) -> Result<(), String> {
        let _write_guard = self.session_write_lock.lock().map_err(|_| {
            coded_error(
                "SPOTIFY_SESSION_UNAVAILABLE",
                "Spotify 登录状态写入暂时不可用。",
            )
        })?;
        let delete_result = delete_persisted_session(&self.session_file);
        *self.session.lock().map_err(|_| {
            coded_error(
                "SPOTIFY_SESSION_UNAVAILABLE",
                "Spotify 登录会话暂时不可用。",
            )
        })? = None;
        delete_result
    }

    fn invalidate_oauth(&self) -> Result<(), String> {
        let mut oauth = self.oauth.lock().map_err(|_| {
            coded_error(
                "SPOTIFY_SESSION_UNAVAILABLE",
                "Spotify 授权会话暂时不可用。",
            )
        })?;
        oauth.generation = oauth.generation.wrapping_add(1);
        oauth.active_key = None;
        for flow in oauth.flows.values_mut() {
            if matches!(flow.state, PendingOAuthState::Waiting) {
                flow.state = PendingOAuthState::Cancelled;
            }
        }
        Ok(())
    }

    fn register_oauth(&self, key: String) -> Result<u64, String> {
        let mut oauth = self.oauth.lock().map_err(|_| {
            coded_error(
                "SPOTIFY_SESSION_UNAVAILABLE",
                "Spotify 授权会话暂时不可用。",
            )
        })?;
        oauth.generation = oauth.generation.wrapping_add(1);
        let generation = oauth.generation;
        for flow in oauth.flows.values_mut() {
            if matches!(flow.state, PendingOAuthState::Waiting) {
                flow.state = PendingOAuthState::Cancelled;
            }
        }
        if oauth.flows.len() >= 8 {
            oauth
                .flows
                .retain(|_, flow| matches!(flow.state, PendingOAuthState::Waiting));
        }
        oauth.active_key = Some(key.clone());
        oauth.flows.insert(
            key,
            PendingOAuth {
                generation,
                state: PendingOAuthState::Waiting,
            },
        );
        Ok(generation)
    }

    fn oauth_is_current(&self, key: &str, generation: u64) -> bool {
        self.oauth.lock().is_ok_and(|oauth| {
            oauth.generation == generation
                && oauth.active_key.as_deref() == Some(key)
                && oauth
                    .flows
                    .get(key)
                    .is_some_and(|flow| flow.generation == generation)
        })
    }

    fn update_oauth_state(&self, key: &str, generation: u64, next: PendingOAuthState) {
        if let Ok(mut oauth) = self.oauth.lock() {
            if oauth.generation != generation || oauth.active_key.as_deref() != Some(key) {
                return;
            }
            if let Some(flow) = oauth.flows.get_mut(key) {
                if flow.generation == generation {
                    flow.state = next;
                }
            }
        }
    }

    fn take_oauth_status(&self, key: &str) -> Result<OAuthStatusPayload, String> {
        let mut oauth = self.oauth.lock().map_err(|_| {
            coded_error(
                "SPOTIFY_SESSION_UNAVAILABLE",
                "Spotify 授权会话暂时不可用。",
            )
        })?;
        let flow_state = oauth
            .flows
            .get(key)
            .map(|flow| flow.state.clone())
            .ok_or_else(|| {
                coded_error(
                    "SPOTIFY_OAUTH_EXPIRED",
                    "Spotify 授权会话不存在或已经过期。",
                )
            })?;
        let terminal = !matches!(&flow_state, PendingOAuthState::Waiting);
        let payload = match flow_state {
            PendingOAuthState::Waiting => OAuthStatusPayload {
                state: "waiting".to_owned(),
                message: "正在等待 Spotify 浏览器授权".to_owned(),
                profile: None,
            },
            PendingOAuthState::Authorized(profile) => OAuthStatusPayload {
                state: "authorized".to_owned(),
                message: "Spotify 已连接".to_owned(),
                profile: Some(profile),
            },
            PendingOAuthState::Expired => OAuthStatusPayload {
                state: "expired".to_owned(),
                message: "Spotify 授权已过期，请重新连接".to_owned(),
                profile: None,
            },
            PendingOAuthState::Cancelled => OAuthStatusPayload {
                state: "error".to_owned(),
                message: coded_error(
                    "SPOTIFY_OAUTH_CANCELLED",
                    "这次 Spotify 授权已经被取消或替换。",
                ),
                profile: None,
            },
            PendingOAuthState::Failed(error) => OAuthStatusPayload {
                state: "error".to_owned(),
                message: error,
                profile: None,
            },
        };
        if terminal {
            oauth.flows.remove(key);
            if oauth.active_key.as_deref() == Some(key) {
                oauth.active_key = None;
            }
        }
        Ok(payload)
    }

    fn save_oauth_session(
        &self,
        key: &str,
        generation: u64,
        session: PersistedSession,
    ) -> Result<(), String> {
        let oauth = self.oauth.lock().map_err(|_| {
            coded_error(
                "SPOTIFY_SESSION_UNAVAILABLE",
                "Spotify 授权会话暂时不可用。",
            )
        })?;
        let is_current = oauth.generation == generation
            && oauth.active_key.as_deref() == Some(key)
            && oauth.flows.get(key).is_some_and(|flow| {
                flow.generation == generation && matches!(flow.state, PendingOAuthState::Waiting)
            });
        if !is_current {
            return Err(coded_error(
                "SPOTIFY_OAUTH_CANCELLED",
                "这次 Spotify 授权已经被取消或替换。",
            ));
        }
        self.save_session(session)
    }

    async fn request_token(
        &self,
        parameters: Vec<(String, String)>,
    ) -> Result<TokenResponse, String> {
        let response = self
            .client
            .post(format!("{SPOTIFY_ACCOUNTS_ORIGIN}/api/token"))
            .form(&parameters)
            .send()
            .await
            .map_err(|error| {
                coded_error(
                    "SPOTIFY_NETWORK_FAILED",
                    format!("无法连接 Spotify 授权服务：{error}"),
                )
            })?;
        let status = response.status();
        let body = response.text().await.map_err(|error| {
            coded_error(
                "SPOTIFY_RESPONSE_INVALID",
                format!("无法读取 Spotify 授权响应：{error}"),
            )
        })?;
        if !status.is_success() {
            let detail = token_error_detail(&body);
            let code = if body.contains("invalid_grant") {
                "SPOTIFY_RECONNECT_REQUIRED"
            } else {
                "SPOTIFY_AUTH_FAILED"
            };
            return Err(coded_error(
                code,
                format!("Spotify 授权失败（HTTP {}）：{detail}", status.as_u16()),
            ));
        }
        serde_json::from_str(&body).map_err(|error| {
            coded_error(
                "SPOTIFY_RESPONSE_INVALID",
                format!("Spotify 返回了无法识别的授权数据：{error}"),
            )
        })
    }

    async fn exchange_authorization_code(
        &self,
        client_id: &str,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<PersistedSession, String> {
        let token = self
            .request_token(vec![
                ("client_id".to_owned(), client_id.to_owned()),
                ("grant_type".to_owned(), "authorization_code".to_owned()),
                ("code".to_owned(), code.to_owned()),
                ("redirect_uri".to_owned(), redirect_uri.to_owned()),
                ("code_verifier".to_owned(), verifier.to_owned()),
            ])
            .await?;
        let refresh_token = token.refresh_token.ok_or_else(|| {
            coded_error(
                "SPOTIFY_REFRESH_TOKEN_MISSING",
                "Spotify 授权成功，但没有返回可恢复的登录凭据。",
            )
        })?;
        Ok(PersistedSession {
            client_id: client_id.to_owned(),
            access_token: token.access_token,
            refresh_token,
            token_type: token.token_type,
            scope: token.scope.unwrap_or_default(),
            expires_at: now_millis().saturating_add(token.expires_in.saturating_mul(1_000)),
        })
    }

    async fn refresh_session(
        &self,
        session: &PersistedSession,
    ) -> Result<PersistedSession, String> {
        let token = self
            .request_token(vec![
                ("client_id".to_owned(), session.client_id.clone()),
                ("grant_type".to_owned(), "refresh_token".to_owned()),
                ("refresh_token".to_owned(), session.refresh_token.clone()),
            ])
            .await?;
        Ok(PersistedSession {
            client_id: session.client_id.clone(),
            access_token: token.access_token,
            refresh_token: token
                .refresh_token
                .unwrap_or_else(|| session.refresh_token.clone()),
            token_type: token.token_type,
            scope: token.scope.unwrap_or_else(|| session.scope.clone()),
            expires_at: now_millis().saturating_add(token.expires_in.saturating_mul(1_000)),
        })
    }

    async fn access_token(&self, force_refresh: bool) -> Result<String, String> {
        let current = self.current_session()?.ok_or_else(|| {
            coded_error(
                "SPOTIFY_AUTH_REQUIRED",
                "Spotify 尚未连接，请先完成官方授权。",
            )
        })?;
        let needs_refresh = force_refresh
            || current.access_token.is_empty()
            || current.expires_at <= now_millis().saturating_add(60_000);
        if !needs_refresh {
            return Ok(current.access_token);
        }
        let _refresh_guard = self.refresh_lock.lock().await;
        let session = self.current_session()?.ok_or_else(|| {
            coded_error(
                "SPOTIFY_AUTH_REQUIRED",
                "Spotify 尚未连接，请先完成官方授权。",
            )
        })?;
        if session.access_token != current.access_token
            && !session.access_token.is_empty()
            && session.expires_at > now_millis().saturating_add(60_000)
        {
            return Ok(session.access_token);
        }
        if !force_refresh
            && !session.access_token.is_empty()
            && session.expires_at > now_millis().saturating_add(60_000)
        {
            return Ok(session.access_token);
        }
        let refreshed = match self.refresh_session(&session).await {
            Ok(refreshed) => refreshed,
            Err(error) => {
                if error.contains("[SPOTIFY_RECONNECT_REQUIRED]") {
                    let _ = self.clear_session();
                }
                return Err(error);
            }
        };
        let token = refreshed.access_token.clone();
        self.save_session(refreshed)?;
        Ok(token)
    }

    async fn api_get_url(&self, url: Url) -> Result<Value, String> {
        let mut token = self.access_token(false).await?;
        for attempt in 0..2 {
            let response = self
                .client
                .get(url.clone())
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|error| {
                    coded_error(
                        "SPOTIFY_NETWORK_FAILED",
                        format!("无法连接 Spotify：{error}"),
                    )
                })?;
            let status = response.status();
            if status == StatusCode::UNAUTHORIZED && attempt == 0 {
                token = self.access_token(true).await?;
                continue;
            }
            let retry_after = response
                .headers()
                .get("retry-after")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            let body = response.text().await.map_err(|error| {
                coded_error(
                    "SPOTIFY_RESPONSE_INVALID",
                    format!("无法读取 Spotify 响应：{error}"),
                )
            })?;
            if status.is_success() {
                return serde_json::from_str(&body).map_err(|error| {
                    coded_error(
                        "SPOTIFY_RESPONSE_INVALID",
                        format!("Spotify 返回了无法识别的数据：{error}"),
                    )
                });
            }
            let detail = api_error_detail(&body);
            let code = match status {
                StatusCode::UNAUTHORIZED => "SPOTIFY_RECONNECT_REQUIRED",
                StatusCode::FORBIDDEN => "SPOTIFY_ACCESS_RESTRICTED",
                StatusCode::TOO_MANY_REQUESTS => "SPOTIFY_RATE_LIMITED",
                StatusCode::NOT_FOUND => "SPOTIFY_NOT_FOUND",
                _ => "SPOTIFY_API_FAILED",
            };
            let retry = retry_after
                .map(|seconds| format!("，请在 {seconds} 秒后重试"))
                .unwrap_or_default();
            return Err(coded_error(
                code,
                format!(
                    "Spotify 请求失败（HTTP {}）：{detail}{retry}",
                    status.as_u16()
                ),
            ));
        }
        Err(coded_error(
            "SPOTIFY_RECONNECT_REQUIRED",
            "Spotify 登录已经失效，请重新连接。",
        ))
    }

    async fn api_get(&self, path: &str) -> Result<Value, String> {
        let url = Url::parse(&format!("{SPOTIFY_API_ORIGIN}{path}")).map_err(|error| {
            coded_error(
                "SPOTIFY_REQUEST_INVALID",
                format!("无法创建 Spotify 请求：{error}"),
            )
        })?;
        self.api_get_url(url).await
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    expires_in: u64,
    refresh_token: Option<String>,
    scope: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawUser {
    id: String,
    nickname: String,
    avatar_url: Option<String>,
    /** Legacy profile id is only used to compare playlist ownership. */
    #[serde(skip)]
    legacy_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RawArtist {
    id: Option<String>,
    name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTrack {
    id: String,
    title: String,
    artist: String,
    artists: Vec<RawArtist>,
    album: String,
    album_id: Option<String>,
    release_info: Option<String>,
    duration_ms: u64,
    cover_image: Option<String>,
    cover_label: String,
    external_uri: Option<String>,
    external_url: Option<String>,
    is_playable: Option<bool>,
    is_local: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawPlaylist {
    id: String,
    number: String,
    title: String,
    subtitle: Option<String>,
    creator: String,
    description: String,
    cover_image: Option<String>,
    track_count: usize,
    track_ids: Vec<String>,
    is_liked_songs: bool,
    external_url: Option<String>,
    is_partial: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAlbum {
    id: String,
    title: String,
    artist: String,
    artist_id: Option<String>,
    cover_image: Option<String>,
    release_date: Option<String>,
    track_count: usize,
    track_ids: Vec<String>,
    external_url: Option<String>,
    is_partial: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartPayload {
    key: String,
    authorization_url: String,
    redirect_uri: String,
    registration_redirect_uri: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStatusPayload {
    state: String,
    message: String,
    profile: Option<RawUser>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRestorePayload {
    connected: bool,
    message: String,
    user: Option<RawUser>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLibraryPayload {
    profile: RawUser,
    playlists: Vec<RawPlaylist>,
    albums: Vec<RawAlbum>,
    liked_track_ids: Vec<String>,
    tracks: Vec<RawTrack>,
    truncated: bool,
}

struct PagedItems {
    items: Vec<Value>,
    total: usize,
    truncated: bool,
}

fn read_persisted_session(path: &Path) -> Result<Option<PersistedSession>, String> {
    match fs::read_to_string(path) {
        Ok(content) => match serde_json::from_str::<PersistedSession>(&content) {
            Ok(session)
                if !session.client_id.trim().is_empty()
                    && !session.access_token.trim().is_empty()
                    && !session.refresh_token.trim().is_empty() =>
            {
                Ok(Some(session))
            }
            Ok(_) => {
                quarantine_persisted_session(path, "会话缺少必要字段");
                Ok(None)
            }
            Err(error) => {
                quarantine_persisted_session(path, &format!("JSON 无法解析：{error}"));
                Ok(None)
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => {
            quarantine_persisted_session(path, &format!("文件不可读：{error}"));
            Ok(None)
        }
    }
}

fn quarantine_persisted_session(path: &Path, reason: &str) {
    eprintln!("Spotify session quarantined: {reason}");
    if !path.exists() {
        return;
    }
    let quarantine_path = path.with_file_name(format!(
        "{SESSION_FILE_NAME}.quarantine-{}-{}",
        now_millis(),
        random_urlsafe(6)
    ));
    let _ = fs::rename(path, quarantine_path);
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
    let backup_path = path.with_file_name(format!(
        "{SESSION_FILE_NAME}.replace-{}-{}",
        std::process::id(),
        random_urlsafe(6)
    ));
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
    let parent = path.parent().ok_or_else(|| {
        coded_error(
            "SPOTIFY_SESSION_WRITE_FAILED",
            "无法确定 Spotify 登录状态的保存目录。",
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        coded_error(
            "SPOTIFY_SESSION_WRITE_FAILED",
            format!("无法创建 Spotify 登录状态目录：{error}"),
        )
    })?;
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|error| {
        coded_error(
            "SPOTIFY_SESSION_WRITE_FAILED",
            format!("无法保护 Spotify 登录状态目录：{error}"),
        )
    })?;

    let temporary_path = path.with_file_name(format!(
        "{SESSION_FILE_NAME}.pending-{}-{}",
        std::process::id(),
        random_urlsafe(8)
    ));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let write_result = (|| -> Result<(), String> {
        let content = serde_json::to_vec(session).map_err(|error| {
            coded_error(
                "SPOTIFY_SESSION_WRITE_FAILED",
                format!("无法整理 Spotify 登录状态：{error}"),
            )
        })?;
        let mut file = options.open(&temporary_path).map_err(|error| {
            coded_error(
                "SPOTIFY_SESSION_WRITE_FAILED",
                format!("无法创建 Spotify 登录状态文件：{error}"),
            )
        })?;
        file.write_all(&content).map_err(|error| {
            coded_error(
                "SPOTIFY_SESSION_WRITE_FAILED",
                format!("无法保存 Spotify 登录状态：{error}"),
            )
        })?;
        file.sync_all().map_err(|error| {
            coded_error(
                "SPOTIFY_SESSION_WRITE_FAILED",
                format!("无法完成 Spotify 登录状态保存：{error}"),
            )
        })?;
        replace_session_file(&temporary_path, path).map_err(|error| {
            coded_error(
                "SPOTIFY_SESSION_WRITE_FAILED",
                format!("无法更新 Spotify 登录状态：{error}"),
            )
        })?;
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|error| {
            coded_error(
                "SPOTIFY_SESSION_WRITE_FAILED",
                format!("无法保护 Spotify 登录状态文件：{error}"),
            )
        })?;
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
        Err(error) => Err(coded_error(
            "SPOTIFY_SESSION_DELETE_FAILED",
            format!("无法清除本机 Spotify 登录状态：{error}"),
        )),
    }
}

fn token_error_detail(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error_description")
                .and_then(Value::as_str)
                .or_else(|| value.get("error").and_then(Value::as_str))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "未知授权错误".to_owned())
}

fn api_error_detail(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("error").and_then(Value::as_str))
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "未知接口错误".to_owned())
}

fn random_urlsafe(byte_count: usize) -> String {
    let mut bytes = vec![0_u8; byte_count];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn validate_client_id(client_id: &str) -> Result<String, String> {
    let value = client_id.trim();
    if value.is_empty() {
        return Err(coded_error(
            "SPOTIFY_CLIENT_ID_MISSING",
            format!(
                "Spotify 尚未配置 Client ID。请在 Spotify Developer Dashboard 登记 {SPOTIFY_REDIRECT_REGISTRATION_URI}，并在听境设置中填写公开 Client ID。"
            ),
        ));
    }
    if value.len() < 16
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(coded_error(
            "SPOTIFY_CLIENT_ID_INVALID",
            "Spotify Client ID 格式无效。Client ID 只能包含英文字母和数字。",
        ));
    }
    Ok(value.to_owned())
}

fn build_authorization_url(
    client_id: &str,
    redirect_uri: &str,
    oauth_state: &str,
    challenge: &str,
) -> Result<String, String> {
    let mut url = Url::parse(&format!("{SPOTIFY_ACCOUNTS_ORIGIN}/authorize")).map_err(|error| {
        coded_error(
            "SPOTIFY_AUTH_URL_INVALID",
            format!("无法创建 Spotify 授权地址：{error}"),
        )
    })?;
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect_uri)
        .append_pair(
            "scope",
            "user-read-private playlist-read-private playlist-read-collaborative user-library-read",
        )
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", challenge)
        .append_pair("state", oauth_state);
    Ok(url.into())
}

fn open_system_target(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("/usr/bin/open");
        command.arg(target);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", target]);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(target);
        command
    };

    command.spawn().map(|_| ()).map_err(|error| {
        coded_error(
            "SPOTIFY_OPEN_FAILED",
            format!("无法使用系统浏览器打开 Spotify：{error}"),
        )
    })
}

async fn write_browser_response(stream: &mut tokio::net::TcpStream, success: bool) {
    let (title, body) = if success {
        (
            "Spotify connected",
            "Spotify 已连接。现在可以关闭此页面并返回听境。<br><span lang=\"en\">Spotify is connected. You can close this page and return to Tingjing.</span>",
        )
    } else {
        (
            "Spotify connection failed",
            "Spotify 授权没有完成。请返回听境重试。<br><span lang=\"en\">Spotify authorization did not complete. Return to Tingjing and try again.</span>",
        )
    };
    let html = format!(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>{title}</title><body style=\"font-family:system-ui;padding:48px;background:#111;color:#f5f5f5\"><h1>{title}</h1><p>{body}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

enum OAuthCallback {
    Code(tokio::net::TcpStream, String),
    Denied(tokio::net::TcpStream, String),
}

async fn receive_oauth_callback(
    listener: &TcpListener,
    expected_state: &str,
) -> Result<OAuthCallback, String> {
    match timeout(OAUTH_TIMEOUT, async {
        for _ in 0..MAX_CALLBACK_CONNECTIONS {
            let (mut stream, _) = listener.accept().await.map_err(|error| {
                coded_error(
                    "SPOTIFY_CALLBACK_FAILED",
                    format!("无法接收 Spotify 授权回调：{error}"),
                )
            })?;
            let mut buffer = vec![0_u8; 16 * 1_024];
            let read = match timeout(Duration::from_secs(10), stream.read(&mut buffer)).await {
                Ok(Ok(read)) if read > 0 => read,
                _ => {
                    write_browser_response(&mut stream, false).await;
                    continue;
                }
            };
            let request = String::from_utf8_lossy(&buffer[..read]);
            let target = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1));
            let callback =
                target.and_then(|target| Url::parse(&format!("http://127.0.0.1{target}")).ok());
            let Some(callback) = callback else {
                write_browser_response(&mut stream, false).await;
                continue;
            };
            if callback.path() != "/callback" {
                write_browser_response(&mut stream, false).await;
                continue;
            }
            let parameters = callback.query_pairs().collect::<HashMap<_, _>>();
            if parameters.get("state").map(|value| value.as_ref()) != Some(expected_state) {
                write_browser_response(&mut stream, false).await;
                continue;
            }
            if let Some(error) = parameters.get("error") {
                return Ok(OAuthCallback::Denied(stream, error.to_string()));
            }
            if let Some(code) = parameters.get("code") {
                return Ok(OAuthCallback::Code(stream, code.to_string()));
            }
            write_browser_response(&mut stream, false).await;
        }
        Err(coded_error(
            "SPOTIFY_CALLBACK_LIMIT_REACHED",
            "Spotify 授权回调收到过多无效连接，请重新连接。",
        ))
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(coded_error(
            "SPOTIFY_OAUTH_EXPIRED",
            "Spotify 授权等待超时，请重新连接。",
        )),
    }
}

async fn complete_oauth(
    state: SpotifyState,
    listener: TcpListener,
    key: String,
    generation: u64,
    client_id: String,
    expected_state: String,
    verifier: String,
    redirect_uri: String,
) {
    let callback = receive_oauth_callback(&listener, &expected_state).await;
    let (mut stream, code) = match callback {
        Ok(OAuthCallback::Code(stream, code)) => (stream, code),
        Ok(OAuthCallback::Denied(mut stream, error)) => {
            write_browser_response(&mut stream, false).await;
            state.update_oauth_state(
                &key,
                generation,
                PendingOAuthState::Failed(coded_error(
                    "SPOTIFY_AUTH_DENIED",
                    format!("Spotify 未授权本次连接：{error}"),
                )),
            );
            return;
        }
        Err(error) => {
            let next = if error.contains("[SPOTIFY_OAUTH_EXPIRED]") {
                PendingOAuthState::Expired
            } else {
                PendingOAuthState::Failed(error)
            };
            state.update_oauth_state(&key, generation, next);
            return;
        }
    };

    if !state.oauth_is_current(&key, generation) {
        write_browser_response(&mut stream, false).await;
        return;
    }

    match state
        .exchange_authorization_code(&client_id, &code, &verifier, &redirect_uri)
        .await
    {
        Ok(session) => {
            let access_token = session.access_token.clone();
            let profile = fetch_profile_with_token(&state.client, &access_token).await;
            match profile {
                Ok(profile) => {
                    if let Err(error) = state.save_oauth_session(&key, generation, session) {
                        write_browser_response(&mut stream, false).await;
                        state.update_oauth_state(
                            &key,
                            generation,
                            PendingOAuthState::Failed(error),
                        );
                        return;
                    }
                    write_browser_response(&mut stream, true).await;
                    state.update_oauth_state(
                        &key,
                        generation,
                        PendingOAuthState::Authorized(profile),
                    );
                }
                Err(error) => {
                    write_browser_response(&mut stream, false).await;
                    state.update_oauth_state(&key, generation, PendingOAuthState::Failed(error));
                }
            }
        }
        Err(error) => {
            write_browser_response(&mut stream, false).await;
            state.update_oauth_state(&key, generation, PendingOAuthState::Failed(error));
        }
    }
}

async fn fetch_profile_with_token(client: &Client, token: &str) -> Result<RawUser, String> {
    let response = client
        .get(format!("{SPOTIFY_API_ORIGIN}/me"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| {
            coded_error(
                "SPOTIFY_NETWORK_FAILED",
                format!("无法读取 Spotify 用户信息：{error}"),
            )
        })?;
    let status = response.status();
    let body = response.text().await.map_err(|error| {
        coded_error(
            "SPOTIFY_RESPONSE_INVALID",
            format!("无法读取 Spotify 用户响应：{error}"),
        )
    })?;
    if !status.is_success() {
        return Err(coded_error(
            "SPOTIFY_PROFILE_FAILED",
            format!(
                "Spotify 用户信息读取失败（HTTP {}）：{}",
                status.as_u16(),
                api_error_detail(&body)
            ),
        ));
    }
    let value: Value = serde_json::from_str(&body).map_err(|error| {
        coded_error(
            "SPOTIFY_RESPONSE_INVALID",
            format!("Spotify 返回了无法识别的用户信息：{error}"),
        )
    })?;
    map_user(&value)
}

fn map_user(value: &Value) -> Result<RawUser, String> {
    let legacy_id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let id = value
        .get("account_id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .map(str::trim)
        .map(str::to_owned)
        .unwrap_or_else(|| legacy_id.clone());
    if id.is_empty() {
        return Err(coded_error(
            "SPOTIFY_PROFILE_INVALID",
            "Spotify 用户信息缺少账号 ID。",
        ));
    }
    let nickname = value
        .get("display_name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&id)
        .to_owned();
    Ok(RawUser {
        id,
        nickname,
        avatar_url: best_image(value.get("images")),
        legacy_id,
    })
}

fn best_image(images: Option<&Value>) -> Option<String> {
    images
        .and_then(Value::as_array)
        .and_then(|images| {
            images
                .iter()
                .filter_map(|image| {
                    let url = image.get("url")?.as_str()?.trim();
                    if url.is_empty() {
                        return None;
                    }
                    let width = image.get("width").and_then(Value::as_u64).unwrap_or(0);
                    Some((width, url.to_owned()))
                })
                .max_by_key(|(width, _)| *width)
        })
        .map(|(_, url)| url)
}

fn spotify_external_url(value: &Value) -> Option<String> {
    value
        .pointer("/external_urls/spotify")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

fn map_artists(value: Option<&Value>) -> Vec<RawArtist> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|artist| {
            let name = artist.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(RawArtist {
                id: artist.get("id").and_then(Value::as_str).map(str::to_owned),
                name: name.to_owned(),
            })
        })
        .collect()
}

fn map_track(value: &Value, album_context: Option<&Value>) -> Option<RawTrack> {
    if value.get("type").and_then(Value::as_str) == Some("episode") {
        return None;
    }
    let external_uri = value
        .get("uri")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| external_uri.clone())?;
    let album = value.get("album").or(album_context);
    let artists = map_artists(value.get("artists"));
    let artist = if artists.is_empty() {
        "Unknown artist".to_owned()
    } else {
        artists
            .iter()
            .map(|artist| artist.name.as_str())
            .collect::<Vec<_>>()
            .join(" / ")
    };
    Some(RawTrack {
        id,
        title: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled track")
            .to_owned(),
        artist,
        artists,
        album: album
            .and_then(|album| album.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("Unknown album")
            .to_owned(),
        album_id: album
            .and_then(|album| album.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        release_info: album
            .and_then(|album| album.get("release_date"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        duration_ms: value
            .get("duration_ms")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cover_image: album.and_then(|album| best_image(album.get("images"))),
        cover_label: "Spotify original album artwork".to_owned(),
        external_uri,
        external_url: spotify_external_url(value),
        is_playable: value.get("is_playable").and_then(Value::as_bool),
        is_local: value
            .get("is_local")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn track_from_page_item(value: &Value) -> Option<&Value> {
    value
        .get("item")
        .or_else(|| value.get("track"))
        .or(Some(value))
}

fn collection_total(value: &Value) -> usize {
    value
        .pointer("/items/total")
        .or_else(|| value.pointer("/tracks/total"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize
}

fn map_playlist(value: &Value, index: usize, owner_profile_id: &str) -> Option<RawPlaylist> {
    let id = value.get("id")?.as_str()?.to_owned();
    let owner_id = value.pointer("/owner/id").and_then(Value::as_str);
    let collaborative = value
        .get("collaborative")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(RawPlaylist {
        id,
        number: format!("{:03}", index + 2),
        title: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled playlist")
            .to_owned(),
        subtitle: None,
        creator: value
            .pointer("/owner/display_name")
            .and_then(Value::as_str)
            .or(owner_id)
            .unwrap_or("Spotify")
            .to_owned(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        cover_image: best_image(value.get("images")),
        track_count: collection_total(value),
        track_ids: Vec::new(),
        is_liked_songs: false,
        external_url: spotify_external_url(value),
        is_partial: owner_id.is_some_and(|owner| owner != owner_profile_id) && !collaborative,
    })
}

fn map_album(value: &Value) -> Option<RawAlbum> {
    let id = value.get("id")?.as_str()?.to_owned();
    let artists = map_artists(value.get("artists"));
    let track_ids = value
        .pointer("/tracks/items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|track| track.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect::<Vec<_>>();
    let track_count = value
        .pointer("/tracks/total")
        .and_then(Value::as_u64)
        .or_else(|| value.get("total_tracks").and_then(Value::as_u64))
        .unwrap_or(track_ids.len() as u64) as usize;
    Some(RawAlbum {
        id,
        title: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Untitled album")
            .to_owned(),
        artist: artists
            .iter()
            .map(|artist| artist.name.as_str())
            .collect::<Vec<_>>()
            .join(" / "),
        artist_id: artists.first().and_then(|artist| artist.id.clone()),
        cover_image: best_image(value.get("images")),
        release_date: value
            .get("release_date")
            .and_then(Value::as_str)
            .map(str::to_owned),
        track_count,
        is_partial: track_ids.len() < track_count,
        track_ids,
        external_url: spotify_external_url(value),
    })
}

async fn fetch_paged_items(
    state: &SpotifyState,
    path: &str,
    maximum: usize,
) -> Result<PagedItems, String> {
    let mut items = Vec::new();
    let mut total = 0;
    let mut has_more = true;
    while items.len() < maximum && has_more {
        let mut url = Url::parse(&format!("{SPOTIFY_API_ORIGIN}{path}")).map_err(|error| {
            coded_error(
                "SPOTIFY_REQUEST_INVALID",
                format!("无法创建 Spotify 分页请求：{error}"),
            )
        })?;
        url.query_pairs_mut()
            .append_pair("limit", &PAGE_LIMIT.to_string())
            .append_pair("offset", &items.len().to_string());
        let page = state.api_get_url(url).await?;
        total = page
            .get("total")
            .and_then(Value::as_u64)
            .unwrap_or(total as u64) as usize;
        let page_items = page
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if page_items.is_empty() {
            break;
        }
        let remaining = maximum.saturating_sub(items.len());
        items.extend(page_items.iter().take(remaining).cloned());
        has_more = page.get("next").is_some_and(|value| !value.is_null());
    }
    Ok(PagedItems {
        truncated: total > items.len() || has_more,
        items,
        total,
    })
}

fn add_unique_track(
    tracks: &mut Vec<RawTrack>,
    known_ids: &mut HashSet<String>,
    track: RawTrack,
) -> bool {
    if known_ids.contains(&track.id) {
        return false;
    }
    if tracks.len() >= MAX_LIBRARY_ITEMS {
        return true;
    }
    known_ids.insert(track.id.clone());
    tracks.push(track);
    false
}

fn validate_collection_id(collection_id: &str) -> Result<&str, String> {
    let value = collection_id.trim();
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        return Err(coded_error(
            "SPOTIFY_COLLECTION_ID_INVALID",
            "Spotify 收藏 ID 格式无效。",
        ));
    }
    Ok(value)
}

fn valid_spotify_entity(kind: &str, id: &str) -> bool {
    matches!(kind, "track" | "album" | "playlist")
        && !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn validated_spotify_uri(value: &str) -> Option<String> {
    let mut parts = value.split(':');
    let scheme = parts.next()?;
    let kind = parts.next()?;
    let id = parts.next()?;
    if parts.next().is_some() || scheme != "spotify" || !valid_spotify_entity(kind, id) {
        return None;
    }
    Some(format!("spotify:{kind}:{id}"))
}

fn validated_spotify_url(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    if url.scheme() != "https"
        || url.host_str() != Some("open.spotify.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        return None;
    }
    let segments = url.path_segments()?.collect::<Vec<_>>();
    if segments.len() != 2 || !valid_spotify_entity(segments[0], segments[1]) {
        return None;
    }
    Some(url.to_string())
}

#[tauri::command]
pub async fn spotify_begin_oauth(
    state: tauri::State<'_, SpotifyState>,
    client_id: String,
) -> Result<OAuthStartPayload, String> {
    let client_id = validate_client_id(&client_id)?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|error| {
        coded_error(
            "SPOTIFY_LOOPBACK_UNAVAILABLE",
            format!("无法启动 Spotify 本机授权回调：{error}"),
        )
    })?;
    let address = listener.local_addr().map_err(|error| {
        coded_error(
            "SPOTIFY_LOOPBACK_UNAVAILABLE",
            format!("无法读取 Spotify 本机授权端口：{error}"),
        )
    })?;
    let redirect_uri = format!("http://127.0.0.1:{}/callback", address.port());
    let verifier = random_urlsafe(64);
    let oauth_state = random_urlsafe(32);
    let key = random_urlsafe(18);
    let authorization_url = build_authorization_url(
        &client_id,
        &redirect_uri,
        &oauth_state,
        &pkce_challenge(&verifier),
    )?;
    let generation = state.register_oauth(key.clone())?;
    if let Err(error) = open_system_target(&authorization_url) {
        state.update_oauth_state(&key, generation, PendingOAuthState::Failed(error.clone()));
        return Err(error);
    }
    let owned_state = state.inner().clone();
    let task_key = key.clone();
    let task_redirect_uri = redirect_uri.clone();
    tokio::spawn(async move {
        complete_oauth(
            owned_state,
            listener,
            task_key,
            generation,
            client_id,
            oauth_state,
            verifier,
            task_redirect_uri,
        )
        .await;
    });
    Ok(OAuthStartPayload {
        key,
        authorization_url,
        redirect_uri,
        registration_redirect_uri: SPOTIFY_REDIRECT_REGISTRATION_URI.to_owned(),
    })
}

#[tauri::command]
pub async fn spotify_check_oauth(
    state: tauri::State<'_, SpotifyState>,
    key: String,
) -> Result<OAuthStatusPayload, String> {
    state.take_oauth_status(&key)
}

#[tauri::command]
pub async fn spotify_restore_session(
    state: tauri::State<'_, SpotifyState>,
) -> Result<SessionRestorePayload, String> {
    if state.current_session()?.is_none() {
        return Ok(SessionRestorePayload {
            connected: false,
            message: "Spotify 尚未连接".to_owned(),
            user: None,
        });
    }
    match state.api_get("/me").await {
        Ok(profile) => Ok(SessionRestorePayload {
            connected: true,
            message: "Spotify 登录状态可用".to_owned(),
            user: Some(map_user(&profile)?),
        }),
        Err(error) if error.contains("[SPOTIFY_RECONNECT_REQUIRED]") => {
            let _ = state.clear_session();
            Ok(SessionRestorePayload {
                connected: false,
                message: "Spotify 登录已经失效，请重新连接".to_owned(),
                user: None,
            })
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn spotify_sync_library(
    state: tauri::State<'_, SpotifyState>,
) -> Result<RawLibraryPayload, String> {
    let (profile_value, playlist_page, liked_page, album_page) = tokio::try_join!(
        state.api_get("/me"),
        fetch_paged_items(&state, "/me/playlists", MAX_LIBRARY_ITEMS),
        fetch_paged_items(&state, "/me/tracks", MAX_LIBRARY_ITEMS),
        fetch_paged_items(&state, "/me/albums", MAX_LIBRARY_ITEMS),
    )?;
    let profile = map_user(&profile_value)?;
    let mut tracks = Vec::new();
    let mut known_track_ids = HashSet::new();
    let mut track_catalog_truncated = false;
    let mut liked_track_ids = Vec::new();
    for saved in &liked_page.items {
        let Some(track_value) = track_from_page_item(saved) else {
            continue;
        };
        let Some(track) = map_track(track_value, None) else {
            continue;
        };
        liked_track_ids.push(track.id.clone());
        track_catalog_truncated |= add_unique_track(&mut tracks, &mut known_track_ids, track);
    }

    let mut albums = Vec::new();
    for saved in &album_page.items {
        let Some(album_value) = saved.get("album") else {
            continue;
        };
        if let Some(album_tracks) = album_value
            .pointer("/tracks/items")
            .and_then(Value::as_array)
        {
            for track_value in album_tracks {
                if let Some(track) = map_track(track_value, Some(album_value)) {
                    track_catalog_truncated |=
                        add_unique_track(&mut tracks, &mut known_track_ids, track);
                }
            }
        }
        if let Some(album) = map_album(album_value) {
            albums.push(album);
        }
    }

    let mut playlists = Vec::new();
    playlists.push(RawPlaylist {
        id: "spotify:liked".to_owned(),
        number: "001".to_owned(),
        title: "Liked Songs".to_owned(),
        subtitle: None,
        creator: profile.nickname.clone(),
        description: String::new(),
        cover_image: tracks.first().and_then(|track| track.cover_image.clone()),
        track_count: liked_page.total,
        track_ids: liked_track_ids.clone(),
        is_liked_songs: true,
        external_url: Some("https://open.spotify.com/collection/tracks".to_owned()),
        is_partial: liked_page.truncated,
    });
    for (index, value) in playlist_page.items.iter().enumerate() {
        if let Some(playlist) = map_playlist(value, index, &profile.legacy_id) {
            playlists.push(playlist);
        }
    }

    Ok(RawLibraryPayload {
        profile,
        playlists,
        albums,
        liked_track_ids,
        tracks,
        truncated: playlist_page.truncated
            || liked_page.truncated
            || album_page.truncated
            || track_catalog_truncated,
    })
}

#[tauri::command]
pub async fn spotify_get_collection_tracks(
    state: tauri::State<'_, SpotifyState>,
    collection_kind: String,
    collection_id: String,
) -> Result<Vec<RawTrack>, String> {
    if collection_kind == "playlist" && collection_id == "spotify:liked" {
        let page = fetch_paged_items(&state, "/me/tracks", MAX_LIBRARY_ITEMS).await?;
        return Ok(page
            .items
            .iter()
            .filter_map(track_from_page_item)
            .filter_map(|track| map_track(track, None))
            .collect());
    }
    let id = validate_collection_id(&collection_id)?;
    match collection_kind.as_str() {
        "playlist" => {
            let page =
                fetch_paged_items(&state, &format!("/playlists/{id}/items"), MAX_LIBRARY_ITEMS)
                    .await?;
            Ok(page
                .items
                .iter()
                .filter_map(track_from_page_item)
                .filter_map(|track| map_track(track, None))
                .collect())
        }
        "album" => {
            let album = state.api_get(&format!("/albums/{id}")).await?;
            let page =
                fetch_paged_items(&state, &format!("/albums/{id}/tracks"), MAX_LIBRARY_ITEMS)
                    .await?;
            Ok(page
                .items
                .iter()
                .filter_map(|track| map_track(track, Some(&album)))
                .collect())
        }
        _ => Err(coded_error(
            "SPOTIFY_COLLECTION_KIND_INVALID",
            "Spotify 只支持读取歌单或专辑曲目。",
        )),
    }
}

#[tauri::command]
pub fn spotify_open_external(
    external_uri: Option<String>,
    external_url: Option<String>,
) -> Result<(), String> {
    let uri = external_uri.and_then(|value| validated_spotify_uri(&value));
    if let Some(uri) = uri {
        return open_system_target(&uri);
    }
    let url = external_url
        .and_then(|value| validated_spotify_url(&value))
        .ok_or_else(|| {
            coded_error(
                "SPOTIFY_EXTERNAL_TARGET_INVALID",
                "Spotify 官方播放链接无效。",
            )
        })?;
    open_system_target(&url)
}

#[tauri::command]
pub async fn spotify_logout(state: tauri::State<'_, SpotifyState>) -> Result<(), String> {
    state.invalidate_oauth()?;
    state.clear_session()
}

#[cfg(test)]
mod tests {
    use super::{
        build_authorization_url, map_playlist, map_track, map_user, pkce_challenge,
        read_persisted_session, receive_oauth_callback, validate_client_id, validated_spotify_uri,
        validated_spotify_url, write_browser_response, OAuthCallback, PendingOAuthState,
        PersistedSession, RawUser, SpotifyState, SESSION_FILE_NAME,
        SPOTIFY_REDIRECT_REGISTRATION_URI,
    };
    use serde_json::json;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{Arc, Barrier},
    };
    use tokio::{io::AsyncWriteExt, net::TcpStream};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "tingjing-spotify-{label}-{}-{}",
                std::process::id(),
                super::random_urlsafe(8)
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sample_session(access_token: &str) -> PersistedSession {
        PersistedSession {
            client_id: "0123456789abcdef0123456789abcdef".to_owned(),
            access_token: access_token.to_owned(),
            refresh_token: format!("refresh-{access_token}"),
            token_type: "Bearer".to_owned(),
            scope: "user-library-read".to_owned(),
            expires_at: super::now_millis().saturating_add(60_000),
        }
    }

    #[test]
    fn pkce_challenge_matches_rfc_7636_example() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorization_uses_dynamic_loopback_port_and_callback_path() {
        let url = build_authorization_url(
            "0123456789abcdef0123456789abcdef",
            "http://127.0.0.1:49152/callback",
            "oauth-state",
            "challenge",
        )
        .expect("authorization url");
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback"));
        assert_eq!(
            SPOTIFY_REDIRECT_REGISTRATION_URI,
            "http://127.0.0.1/callback"
        );
    }

    #[test]
    fn client_id_errors_are_stable_and_include_registration_uri() {
        let error = validate_client_id("").expect_err("missing id must fail");
        assert!(error.starts_with("[SPOTIFY_CLIENT_ID_MISSING]"));
        assert!(error.contains(SPOTIFY_REDIRECT_REGISTRATION_URI));
    }

    #[test]
    fn spotify_track_keeps_official_external_identity_without_audio_url() {
        let value = json!({
            "id": "track-id",
            "name": "Track",
            "uri": "spotify:track:track-id",
            "external_urls": { "spotify": "https://open.spotify.com/track/track-id" },
            "duration_ms": 123000,
            "artists": [{ "id": "artist-id", "name": "Artist" }],
            "album": {
                "id": "album-id",
                "name": "Album",
                "release_date": "2026-01-01",
                "images": [{ "url": "https://i.scdn.co/image/original", "width": 640 }]
            }
        });
        let track = map_track(&value, None).expect("track should map");
        assert_eq!(
            track.external_uri.as_deref(),
            Some("spotify:track:track-id")
        );
        assert_eq!(
            track.external_url.as_deref(),
            Some("https://open.spotify.com/track/track-id")
        );
        assert_eq!(
            track.cover_image.as_deref(),
            Some("https://i.scdn.co/image/original")
        );
    }

    #[test]
    fn corrupt_session_is_quarantined_without_blocking_state_startup() {
        let directory = TestDirectory::new("corrupt-session");
        let session_path = directory.path().join(SESSION_FILE_NAME);
        fs::write(&session_path, b"{not-json").expect("write corrupt session");

        let state = SpotifyState::new(directory.path().to_owned()).expect("state must start");
        assert!(state.current_session().expect("session lock").is_none());
        assert!(!session_path.exists());
        assert!(fs::read_dir(directory.path())
            .expect("read quarantine directory")
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("spotify-session.json.quarantine-")));
    }

    #[test]
    fn unreadable_session_shape_is_quarantined_without_blocking_state_startup() {
        let directory = TestDirectory::new("unreadable-session");
        let session_path = directory.path().join(SESSION_FILE_NAME);
        fs::create_dir(&session_path).expect("create invalid session directory");

        let state = SpotifyState::new(directory.path().to_owned()).expect("state must start");
        assert!(state.current_session().expect("session lock").is_none());
        assert!(!session_path.exists());
    }

    #[test]
    fn new_oauth_generation_and_logout_invalidate_old_callback_writes() {
        let directory = TestDirectory::new("oauth-generation");
        let state = SpotifyState::new(directory.path().to_owned()).expect("state");
        let old_generation = state.register_oauth("old".to_owned()).expect("old flow");
        let current_generation = state
            .register_oauth("current".to_owned())
            .expect("new flow");

        let old_error = state
            .save_oauth_session("old", old_generation, sample_session("old"))
            .expect_err("old callback must not save");
        assert!(old_error.starts_with("[SPOTIFY_OAUTH_CANCELLED]"));
        assert!(state.current_session().expect("session lock").is_none());

        state.invalidate_oauth().expect("logout invalidation");
        let logout_error = state
            .save_oauth_session("current", current_generation, sample_session("current"))
            .expect_err("logout must invalidate current callback");
        assert!(logout_error.starts_with("[SPOTIFY_OAUTH_CANCELLED]"));
        assert!(state.current_session().expect("session lock").is_none());
    }

    #[test]
    fn terminal_oauth_status_is_consumed_once() {
        let directory = TestDirectory::new("oauth-consume");
        let state = SpotifyState::new(directory.path().to_owned()).expect("state");
        let generation = state.register_oauth("flow".to_owned()).expect("flow");
        state.update_oauth_state(
            "flow",
            generation,
            PendingOAuthState::Authorized(RawUser {
                id: "stable-account".to_owned(),
                nickname: "Listener".to_owned(),
                avatar_url: None,
                legacy_id: "legacy-profile".to_owned(),
            }),
        );

        let first = state.take_oauth_status("flow").expect("terminal result");
        assert_eq!(first.state, "authorized");
        assert_eq!(first.profile.expect("profile").id, "stable-account");
        let second = state
            .take_oauth_status("flow")
            .expect_err("terminal result must be consumed");
        assert!(second.starts_with("[SPOTIFY_OAUTH_EXPIRED]"));
    }

    #[test]
    fn account_id_is_frontend_identity_while_legacy_id_owns_playlists() {
        let profile = map_user(&json!({
            "account_id": "stable-account-id",
            "id": "legacy-profile-id",
            "display_name": "Listener"
        }))
        .expect("profile");
        assert_eq!(profile.id, "stable-account-id");
        assert_eq!(profile.legacy_id, "legacy-profile-id");

        let playlist = map_playlist(
            &json!({
                "id": "playlistid012345678901",
                "name": "Owned",
                "owner": { "id": "legacy-profile-id", "display_name": "Listener" },
                "tracks": { "total": 4 },
                "collaborative": false
            }),
            0,
            &profile.legacy_id,
        )
        .expect("playlist");
        assert!(!playlist.is_partial);

        let fallback = map_user(&json!({ "id": "legacy-only" })).expect("fallback profile");
        assert_eq!(fallback.id, "legacy-only");
    }

    #[test]
    fn concurrent_session_writes_remain_valid_and_leave_no_pending_file() {
        let directory = TestDirectory::new("session-write");
        let state = SpotifyState::new(directory.path().to_owned()).expect("state");
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for token in ["alpha", "beta"] {
            let state = state.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                state.save_session(sample_session(token))
            }));
        }
        barrier.wait();
        for thread in threads {
            thread
                .join()
                .expect("writer thread")
                .expect("session write");
        }

        let persisted = read_persisted_session(&directory.path().join(SESSION_FILE_NAME))
            .expect("read persisted session")
            .expect("persisted session");
        assert!(matches!(persisted.access_token.as_str(), "alpha" | "beta"));
        assert!(!fs::read_dir(directory.path())
            .expect("read session directory")
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().contains(".pending-")));
    }

    #[tokio::test]
    async fn callback_ignores_bounded_invalid_connection_before_valid_code() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("listener");
        let address = listener.local_addr().expect("listener address");
        let receiver =
            tokio::spawn(async move { receive_oauth_callback(&listener, "expected-state").await });

        let mut invalid = TcpStream::connect(address)
            .await
            .expect("invalid connection");
        invalid
            .write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .expect("invalid request");
        drop(invalid);

        let mut valid = TcpStream::connect(address).await.expect("valid connection");
        valid
            .write_all(
                b"GET /callback?state=expected-state&code=authorization-code HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .await
            .expect("valid request");
        drop(valid);

        match receiver.await.expect("receiver task").expect("callback") {
            OAuthCallback::Code(mut stream, code) => {
                assert_eq!(code, "authorization-code");
                write_browser_response(&mut stream, true).await;
            }
            OAuthCallback::Denied(_, error) => panic!("unexpected denial: {error}"),
        }
    }

    #[test]
    fn external_targets_require_exact_spotify_uri_or_url() {
        let id = "4uLU6hMCjMI75M1A2tKUQC";
        assert_eq!(
            validated_spotify_uri(&format!("spotify:track:{id}")),
            Some(format!("spotify:track:{id}"))
        );
        assert_eq!(
            validated_spotify_url(&format!("https://open.spotify.com/track/{id}")),
            Some(format!("https://open.spotify.com/track/{id}"))
        );
        for invalid in [
            format!("spotify:track:{id}:extra"),
            format!("spotify:episode:{id}"),
            format!("SPOTIFY:track:{id}"),
        ] {
            assert!(validated_spotify_uri(&invalid).is_none(), "{invalid}");
        }
        for invalid in [
            format!("https://open.spotify.com.evil.example/track/{id}"),
            format!("https://open.spotify.com/track/{id}?si=tracking"),
            format!("https://open.spotify.com/intl-zh/track/{id}"),
            format!("http://open.spotify.com/track/{id}"),
        ] {
            assert!(validated_spotify_url(&invalid).is_none(), "{invalid}");
        }
    }
}
