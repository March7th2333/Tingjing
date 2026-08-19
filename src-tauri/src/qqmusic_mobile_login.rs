use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::{SinkExt, StreamExt};
use reqwest::{
    header::{HeaderMap, HeaderValue, CONTENT_TYPE, REFERER, USER_AGENT},
    Client, Url,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    time::Duration,
};
use tokio::time::{interval, timeout};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::ORIGIN, HeaderValue as WsHeaderValue},
        Message,
    },
};

const ANDROID_VERSION: i64 = 14_090_008;
const MQTT_URL: &str = "wss://mu.y.qq.com/ws/handshake";
const MAX_MQTT_SERVER_MIGRATIONS: usize = 2;
const MAX_MQTT_GATEWAY_REASSIGNMENTS: usize = 8;
const QR_TIMEOUT_SECONDS: u64 = 15 * 60;
// The production QQ Music MQTT bridge currently accepts SUBSCRIBE but does not
// consistently emit an MQTT v5 SUBACK. Waiting for SUBACK as a hard prerequisite
// prevents the QR from ever reaching the phone. Keep a short window for an
// explicit accept/reject, then continue in compatibility mode while retaining
// the same socket and any PUBLISH packets that arrived during the window.
const SUBACK_COMPATIBILITY_GRACE: Duration = Duration::from_millis(750);
const CREDENTIAL_RETRY_DELAYS: [Duration; 4] = [
    Duration::from_millis(250),
    Duration::from_millis(700),
    Duration::from_millis(1_500),
    Duration::from_millis(2_500),
];

pub struct MobileQr {
    pub id: String,
    pub png: Vec<u8>,
}

pub struct MobileCredential {
    pub music_id: String,
    pub music_key: String,
    pub login_type: i64,
    pub cookie: String,
}

pub enum MobileLoginOutcome {
    Authorized(MobileCredential),
    Refused,
    Expired,
    Failed(String),
}

pub enum MobileQrEvent {
    Ready,
    Scanned,
}

#[derive(Debug, PartialEq, Eq)]
enum SubscriptionReadiness {
    Acknowledged,
    CompatibilityGrace,
}

async fn wait_for_suback_with_compatibility_grace<F>(
    wait_for_suback: F,
    grace: Duration,
) -> Result<SubscriptionReadiness, String>
where
    F: Future<Output = Result<(), String>>,
{
    match timeout(grace, wait_for_suback).await {
        Ok(result) => {
            result?;
            Ok(SubscriptionReadiness::Acknowledged)
        }
        Err(_) => Ok(SubscriptionReadiness::CompatibilityGrace),
    }
}

fn request_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("QQMusic 14090008(android 15)"),
    );
    headers.insert(REFERER, HeaderValue::from_static("https://y.qq.com/"));
    headers
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

fn cookie_string(cookies: &BTreeMap<String, String>) -> String {
    cookies
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

pub async fn create_mobile_qr(client: &Client) -> Result<MobileQr, String> {
    let payload = json!({
        "comm": {
            "ct": 23,
            "cv": 0,
            "tmeAppID": "qqmusic",
        },
        "req": {
            "module": "music.login.LoginServer",
            "method": "CreateQRCode",
            "param": {
                "tmeAppID": "qqmusic",
                "ct": 11,
                "cv": ANDROID_VERSION,
            },
        },
    });
    let response = client
        .post("https://u.y.qq.com/cgi-bin/musicu.fcg")
        .headers(request_headers())
        .header(CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("无法创建 QQ 音乐 App 登录二维码：{error}"))?;
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("QQ 音乐二维码响应解析失败：{error}"))?;
    let code = body
        .pointer("/req/code")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if code != 0 {
        return Err(format!("QQ 音乐二维码创建失败（code {code}）"));
    }
    let data = body
        .pointer("/req/data")
        .ok_or_else(|| "QQ 音乐没有返回二维码数据".to_owned())?;
    let id = first_string(data, &["/qrcodeID"]);
    let qrcode = first_string(data, &["/qrcode"]);
    if id.is_empty() || qrcode.is_empty() {
        return Err("QQ 音乐没有返回有效的 App 二维码".to_owned());
    }
    let encoded = qrcode.rsplit(',').next().unwrap_or(&qrcode);
    let png = BASE64
        .decode(encoded)
        .map_err(|error| format!("QQ 音乐二维码图像无效：{error}"))?;
    Ok(MobileQr { id, png })
}

fn variable_integer(mut value: usize) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(4);
    loop {
        let mut byte = (value % 128) as u8;
        value /= 128;
        if value > 0 {
            byte |= 0x80;
        }
        encoded.push(byte);
        if value == 0 {
            return encoded;
        }
    }
}

fn push_utf8(target: &mut Vec<u8>, value: &str) {
    let bytes = value.as_bytes();
    target.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    target.extend_from_slice(bytes);
}

fn push_user_property(target: &mut Vec<u8>, name: &str, value: &str) {
    target.push(0x26);
    push_utf8(target, name);
    push_utf8(target, value);
}

fn frame(header: u8, body: Vec<u8>) -> Vec<u8> {
    let mut packet = Vec::with_capacity(body.len() + 5);
    packet.push(header);
    packet.extend(variable_integer(body.len()));
    packet.extend(body);
    packet
}

fn connect_packet(client_id: &str, qrcode_id: &str) -> Vec<u8> {
    let mut properties = Vec::new();
    properties.push(0x15);
    push_utf8(&mut properties, "pass");
    for (name, value) in [
        ("tmeAppID", "qqmusic"),
        ("business", "management"),
        ("hashTag", qrcode_id),
        ("clientTag", "management.user"),
        ("userID", qrcode_id),
    ] {
        push_user_property(&mut properties, name, value);
    }

    let mut body = Vec::new();
    push_utf8(&mut body, "MQTT");
    body.push(0x05);
    body.push(0x02);
    body.extend_from_slice(&45u16.to_be_bytes());
    body.extend(variable_integer(properties.len()));
    body.extend(properties);
    push_utf8(&mut body, client_id);
    frame(0x10, body)
}

fn subscribe_packet(packet_id: u16, qrcode_id: &str) -> Vec<u8> {
    let mut properties = Vec::new();
    push_user_property(&mut properties, "authorization", "tmelogin");
    push_user_property(&mut properties, "pubsub", "unicast");

    let mut body = Vec::new();
    body.extend_from_slice(&packet_id.to_be_bytes());
    body.extend(variable_integer(properties.len()));
    body.extend(properties);
    push_utf8(&mut body, &format!("management.qrcode_login/{qrcode_id}"));
    body.push(0);
    frame(0x82, body)
}

fn decode_variable_integer(bytes: &[u8], cursor: &mut usize) -> Result<usize, String> {
    let mut multiplier = 1usize;
    let mut value = 0usize;
    for _ in 0..4 {
        let byte = *bytes
            .get(*cursor)
            .ok_or_else(|| "MQTT 数据不完整".to_owned())?;
        *cursor += 1;
        value += usize::from(byte & 0x7f) * multiplier;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        multiplier *= 128;
    }
    Err("MQTT 变长整数无效".to_owned())
}

fn read_utf8(bytes: &[u8], cursor: &mut usize) -> Result<String, String> {
    let length_bytes = bytes
        .get(*cursor..*cursor + 2)
        .ok_or_else(|| "MQTT 字符串长度缺失".to_owned())?;
    *cursor += 2;
    let length = u16::from_be_bytes([length_bytes[0], length_bytes[1]]) as usize;
    let value = bytes
        .get(*cursor..*cursor + length)
        .ok_or_else(|| "MQTT 字符串数据不完整".to_owned())?;
    *cursor += length;
    std::str::from_utf8(value)
        .map(str::to_owned)
        .map_err(|error| format!("MQTT 字符串编码无效：{error}"))
}

fn skip_bytes(bytes: &[u8], cursor: &mut usize, length: usize) -> Result<(), String> {
    bytes
        .get(*cursor..*cursor + length)
        .ok_or_else(|| "MQTT 属性数据不完整".to_owned())?;
    *cursor += length;
    Ok(())
}

fn skip_binary(bytes: &[u8], cursor: &mut usize) -> Result<(), String> {
    let length_bytes = bytes
        .get(*cursor..*cursor + 2)
        .ok_or_else(|| "MQTT 二进制属性长度缺失".to_owned())?;
    *cursor += 2;
    let length = u16::from_be_bytes([length_bytes[0], length_bytes[1]]) as usize;
    skip_bytes(bytes, cursor, length)
}

fn publish_event(frame: &[u8], header: u8) -> Result<(Option<String>, Value), String> {
    let mut cursor = 0usize;
    let _topic = read_utf8(frame, &mut cursor)?;
    let qos = (header >> 1) & 0x03;
    if qos > 0 {
        skip_bytes(frame, &mut cursor, 2)?;
    }
    let property_length = decode_variable_integer(frame, &mut cursor)?;
    let properties_end = cursor
        .checked_add(property_length)
        .filter(|end| *end <= frame.len())
        .ok_or_else(|| "MQTT 属性长度无效".to_owned())?;
    let mut event_type = None;

    while cursor < properties_end {
        let property_id = frame[cursor];
        cursor += 1;
        match property_id {
            0x01 | 0x17 | 0x19 | 0x24 | 0x25 | 0x28 | 0x29 | 0x2a => {
                skip_bytes(frame, &mut cursor, 1)?;
            }
            0x13 | 0x21 | 0x22 | 0x23 => skip_bytes(frame, &mut cursor, 2)?,
            0x02 | 0x11 | 0x18 | 0x27 => skip_bytes(frame, &mut cursor, 4)?,
            0x0b => {
                let _ = decode_variable_integer(frame, &mut cursor)?;
            }
            0x03 | 0x08 | 0x12 | 0x15 | 0x1a | 0x1c | 0x1f => {
                let _ = read_utf8(frame, &mut cursor)?;
            }
            0x09 | 0x16 => skip_binary(frame, &mut cursor)?,
            0x26 => {
                let name = read_utf8(frame, &mut cursor)?;
                let value = read_utf8(frame, &mut cursor)?;
                if name == "type" {
                    event_type = Some(value);
                }
            }
            _ => return Err(format!("MQTT 返回了未知属性 0x{property_id:02x}")),
        }
    }

    let payload = frame
        .get(properties_end..)
        .ok_or_else(|| "MQTT 消息缺少正文".to_owned())?;
    let payload = if payload.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(payload)
            .map_err(|error| format!("QQ 音乐扫码事件解析失败：{error}"))?
    };
    Ok((event_type, payload))
}

fn frames(bytes: &[u8]) -> Result<Vec<(u8, &[u8])>, String> {
    let mut cursor = 0usize;
    let mut result = Vec::new();
    while cursor < bytes.len() {
        let header = bytes[cursor];
        cursor += 1;
        let remaining = decode_variable_integer(bytes, &mut cursor)?;
        let end = cursor
            .checked_add(remaining)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "MQTT 报文长度无效".to_owned())?;
        result.push((header, &bytes[cursor..end]));
        cursor = end;
    }
    Ok(result)
}

fn suback_accepted(frame: &[u8]) -> Result<bool, String> {
    let mut cursor = 0usize;
    skip_bytes(frame, &mut cursor, 2)?;
    let property_length = decode_variable_integer(frame, &mut cursor)?;
    skip_bytes(frame, &mut cursor, property_length)?;
    let reason_codes = frame
        .get(cursor..)
        .ok_or_else(|| "QQ 音乐扫码订阅确认不完整".to_owned())?;
    if reason_codes.is_empty() {
        return Err("QQ 音乐扫码订阅没有返回状态".to_owned());
    }
    Ok(reason_codes.iter().all(|reason| *reason < 0x80))
}

#[derive(Debug, PartialEq, Eq)]
struct ConnackInfo {
    reason_code: u8,
    server_reference: Option<String>,
}

fn connack_info(frame: &[u8]) -> Result<ConnackInfo, String> {
    // MQTT v5 CONNACK variable header: acknowledge flags, reason code,
    // properties length, properties. Only Server Reference is retained; no QR
    // id, cookie, token, or account id is present in this packet.
    let reason_code = frame
        .get(1)
        .copied()
        .ok_or_else(|| "QQ 音乐扫码服务连接确认不完整".to_owned())?;
    let mut cursor = 2usize;
    let property_length = decode_variable_integer(frame, &mut cursor)?;
    let properties_end = cursor
        .checked_add(property_length)
        .filter(|end| *end <= frame.len())
        .ok_or_else(|| "QQ 音乐扫码服务连接属性长度无效".to_owned())?;
    let mut server_reference = None;

    while cursor < properties_end {
        let property_id = frame[cursor];
        cursor += 1;
        match property_id {
            0x11 | 0x27 => skip_bytes(frame, &mut cursor, 4)?,
            0x13 | 0x21 | 0x22 => skip_bytes(frame, &mut cursor, 2)?,
            0x24 | 0x25 | 0x28 | 0x29 | 0x2a => skip_bytes(frame, &mut cursor, 1)?,
            0x12 | 0x15 | 0x1a | 0x1f => {
                let _ = read_utf8(frame, &mut cursor)?;
            }
            0x16 => skip_binary(frame, &mut cursor)?,
            0x1c => server_reference = Some(read_utf8(frame, &mut cursor)?),
            0x26 => {
                let _ = read_utf8(frame, &mut cursor)?;
                let _ = read_utf8(frame, &mut cursor)?;
            }
            _ => {
                return Err(format!(
                    "QQ 音乐扫码服务返回了未知连接属性 0x{property_id:02x}"
                ))
            }
        }
    }

    Ok(ConnackInfo {
        reason_code,
        server_reference,
    })
}

fn connack_reason_label(reason: u8) -> &'static str {
    match reason {
        0x00 => "success",
        0x80 => "unspecified error",
        0x81 => "malformed packet",
        0x82 => "protocol error",
        0x83 => "implementation specific error",
        0x84 => "unsupported protocol version",
        0x85 => "client identifier not valid",
        0x86 => "bad user name or password",
        0x87 => "not authorized",
        0x88 => "server unavailable",
        0x89 => "server busy",
        0x8a => "banned",
        0x8c => "bad authentication method",
        0x90 => "topic name invalid",
        0x95 => "packet too large",
        0x97 => "quota exceeded",
        0x99 => "payload format invalid",
        0x9c => "use another server",
        0x9d => "server moved",
        _ => "unknown reason",
    }
}

fn validated_mqtt_redirect(reference: &str) -> Result<String, String> {
    let safe_hint = || {
        let trimmed = reference.trim();
        let is_safe_shape = trimmed.len() <= 256
            && trimmed
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || ".:/_-".contains(character));
        if is_safe_shape {
            trimmed.to_owned()
        } else {
            format!("<已隐藏，长度 {}>", trimmed.len())
        }
    };
    let trimmed = reference.trim();
    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("wss://{trimmed}")
    };
    let mut url = Url::parse(&candidate)
        .map_err(|_| format!("QQ 音乐扫码服务返回了无效的迁移地址（{}）", safe_hint()))?;
    if url.scheme() != "wss" {
        return Err("QQ 音乐扫码服务迁移地址不是安全的 WSS 连接".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("QQ 音乐扫码服务迁移地址包含不允许的身份信息".to_owned());
    }
    let host = url
        .host_str()
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "QQ 音乐扫码服务迁移地址缺少主机".to_owned())?;
    if host != "y.qq.com" && !host.ends_with(".y.qq.com") {
        return Err("QQ 音乐扫码服务迁移地址不是 QQ 音乐官方域名".to_owned());
    }
    if url.port_or_known_default() != Some(443) {
        return Err("QQ 音乐扫码服务迁移地址使用了不允许的端口".to_owned());
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

struct MqttRedirectPolicy {
    visited: BTreeSet<String>,
    migrations: usize,
}

impl MqttRedirectPolicy {
    fn new(initial_endpoint: &str) -> Self {
        Self {
            visited: BTreeSet::from([initial_endpoint.to_owned()]),
            migrations: 0,
        }
    }

    fn follow(&mut self, connack: &ConnackInfo) -> Result<String, String> {
        if !matches!(connack.reason_code, 0x9c | 0x9d) {
            return Err(format!(
                "QQ 音乐扫码服务拒绝了连接（CONNACK 0x{:02x}: {}）",
                connack.reason_code,
                connack_reason_label(connack.reason_code)
            ));
        }
        let reference = connack.server_reference.as_deref().ok_or_else(|| {
            format!(
                "QQ 音乐扫码服务要求迁移（CONNACK 0x{:02x}），但没有返回 Server Reference",
                connack.reason_code
            )
        })?;
        let endpoint = validated_mqtt_redirect(reference)?;
        if self.visited.contains(&endpoint) {
            return Err("QQ 音乐扫码服务返回了循环迁移地址".to_owned());
        }
        if self.migrations >= MAX_MQTT_SERVER_MIGRATIONS {
            return Err("QQ 音乐扫码服务迁移次数超过安全上限".to_owned());
        }
        self.migrations += 1;
        self.visited.insert(endpoint.clone());
        Ok(endpoint)
    }
}

fn cookie_value(payload: &Value, name: &str) -> String {
    payload
        .pointer(&format!("/cookies/{name}/value"))
        .and_then(scalar_string)
        .unwrap_or_default()
}

async fn exchange_credential(
    client: &Client,
    qrcode_id: &str,
    mqtt_payload: &Value,
) -> Result<MobileCredential, String> {
    let music_id = cookie_value(mqtt_payload, "qqmusic_uin");
    let token = cookie_value(mqtt_payload, "qqmusic_key");
    if music_id.is_empty() || token.is_empty() {
        return Err("QQ 音乐扫码成功，但没有返回账号凭据".to_owned());
    }
    let numeric_music_id = music_id
        .parse::<u64>()
        .map(Value::from)
        .unwrap_or_else(|_| Value::String(music_id.clone()));
    let payload = json!({
        "comm": {
            "ct": 11,
            "cv": ANDROID_VERSION,
            "v": ANDROID_VERSION,
            "tmeAppID": "qqmusic",
            "tmeLoginType": 6,
            "chid": "10003505",
        },
        "req": {
            "module": "music.login.LoginServer",
            "method": "Login",
            "param": {
                "musicid": numeric_music_id,
                "qrCodeID": qrcode_id,
                "token": token,
            },
        },
    });
    let response = client
        .post("https://u.y.qq.com/cgi-bin/musicu.fcg")
        .headers(request_headers())
        .header(CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("无法完成 QQ 音乐 App 授权：{error}"))?;
    let body = response
        .json::<Value>()
        .await
        .map_err(|error| format!("QQ 音乐 App 登录响应解析失败：{error}"))?;
    let code = body
        .pointer("/req/code")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if code != 0 {
        return Err(format!("QQ 音乐登录凭据交换失败（code {code}）"));
    }
    let data = body
        .pointer("/req/data")
        .ok_or_else(|| "QQ 音乐登录没有返回账号凭据".to_owned())?;
    let music_id = first_string(data, &["/musicid", "/str_musicid", "/uin"]);
    let music_key = first_string(data, &["/musickey", "/musicKey"]);
    if music_id.is_empty() || music_key.is_empty() {
        return Err("QQ 音乐登录成功，但没有返回可用的 musicid / musickey".to_owned());
    }
    let mut login_type = data
        .get("loginType")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    if login_type <= 0 {
        login_type = if music_key.starts_with("W_X") { 1 } else { 2 };
    }

    let mut cookies = BTreeMap::new();
    if let Some(returned_cookies) = mqtt_payload.get("cookies").and_then(Value::as_object) {
        for (name, cookie) in returned_cookies {
            if let Some(value) = cookie.get("value").and_then(scalar_string) {
                if !value.is_empty() {
                    cookies.insert(name.clone(), value);
                }
            }
        }
    }
    cookies.insert("uin".to_owned(), music_id.clone());
    cookies.insert("qqmusic_uin".to_owned(), music_id.clone());
    cookies.insert("qqmusic_key".to_owned(), music_key.clone());
    cookies.insert("qm_keyst".to_owned(), music_key.clone());
    cookies.insert("tmeLoginType".to_owned(), login_type.to_string());

    Ok(MobileCredential {
        music_id,
        music_key,
        login_type,
        cookie: cookie_string(&cookies),
    })
}

async fn retry_with_delays<T, F, Fut>(delays: &[Duration], mut operation: F) -> Result<T, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, String>>,
{
    let mut last_error = None;
    for attempt in 0..=delays.len() {
        match operation().await {
            Ok(value) => return Ok(value),
            Err(error) => last_error = Some(error),
        }
        if let Some(delay) = delays.get(attempt) {
            tokio::time::sleep(*delay).await;
        }
    }
    Err(last_error.unwrap_or_else(|| "QQ 音乐登录凭据交换失败".to_owned()))
}

async fn exchange_credential_resilient(
    client: &Client,
    qrcode_id: &str,
    mqtt_payload: &Value,
) -> Result<MobileCredential, String> {
    retry_with_delays(&CREDENTIAL_RETRY_DELAYS, || {
        exchange_credential(client, qrcode_id, mqtt_payload)
    })
    .await
}

async fn resolve_publish_event(
    client: &Client,
    qrcode_id: &str,
    event_type: Option<String>,
    payload: Value,
    on_event: &mut impl FnMut(MobileQrEvent),
) -> Option<MobileLoginOutcome> {
    match event_type.as_deref() {
        Some("scanned") => {
            on_event(MobileQrEvent::Scanned);
            None
        }
        Some("canceled") => Some(MobileLoginOutcome::Refused),
        Some("timeout") => Some(MobileLoginOutcome::Expired),
        Some("loginFailed") => Some(MobileLoginOutcome::Failed(format!(
            "QQ 音乐 App 登录失败：{payload}"
        ))),
        Some("cookies") => {
            // The phone has already committed the login at this point. Preserve
            // this one-shot payload and retry only the credential exchange;
            // reconnecting MQTT cannot be relied upon to replay it.
            on_event(MobileQrEvent::Scanned);
            Some(
                match exchange_credential_resilient(client, qrcode_id, &payload).await {
                    Ok(credential) => MobileLoginOutcome::Authorized(credential),
                    Err(error) => MobileLoginOutcome::Failed(format!(
                        "QQ 音乐已在手机端确认，但登录凭据交换失败：{error}"
                    )),
                },
            )
        }
        _ => None,
    }
}

pub async fn watch_mobile_qr(
    client: &Client,
    qrcode_id: &str,
    client_id: &str,
    mut on_event: impl FnMut(MobileQrEvent),
) -> Result<MobileLoginOutcome, String> {
    let mut endpoint = MQTT_URL.to_owned();
    let mut redirect_policy = MqttRedirectPolicy::new(&endpoint);
    let mut gateway_reassignments = 0usize;
    let mut socket = loop {
        let mut request = endpoint
            .as_str()
            .into_client_request()
            .map_err(|error| format!("无法创建 QQ 音乐实时登录连接：{error}"))?;
        let headers = request.headers_mut();
        headers.insert(ORIGIN, WsHeaderValue::from_static("https://y.qq.com"));
        headers.insert("Referer", WsHeaderValue::from_static("https://y.qq.com/"));
        headers.insert(
            "User-Agent",
            WsHeaderValue::from_static(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
            ),
        );
        headers.insert("Sec-WebSocket-Protocol", WsHeaderValue::from_static("mqtt"));

        let (mut candidate, _) = timeout(Duration::from_secs(12), connect_async(request))
            .await
            .map_err(|_| "连接 QQ 音乐扫码服务超时".to_owned())?
            .map_err(|error| format!("无法连接 QQ 音乐扫码服务：{error}"))?;
        // A server migration changes only the transport endpoint. Reuse the
        // exact QR identity and MQTT client identity so the phone and desktop
        // remain attached to the same login session.
        candidate
            .send(Message::Binary(connect_packet(client_id, qrcode_id).into()))
            .await
            .map_err(|error| format!("无法启动 QQ 音乐扫码会话：{error}"))?;

        let connack = timeout(Duration::from_secs(12), candidate.next())
            .await
            .map_err(|_| "QQ 音乐扫码服务连接确认超时".to_owned())?
            .ok_or_else(|| "QQ 音乐扫码服务已断开".to_owned())?
            .map_err(|error| format!("QQ 音乐扫码服务连接失败：{error}"))?;
        let Message::Binary(connack) = connack else {
            return Err("QQ 音乐扫码服务没有返回连接确认".to_owned());
        };
        let connack_frames = frames(&connack)?;
        let connack_frame = connack_frames
            .iter()
            .find(|(header, _)| header >> 4 == 2)
            .map(|(_, frame)| *frame)
            .ok_or_else(|| "QQ 音乐扫码服务没有返回有效的连接确认".to_owned())?;
        let connack = connack_info(connack_frame)?;
        if connack.reason_code == 0 {
            break candidate;
        }
        let official_redirect = connack
            .server_reference
            .as_deref()
            .and_then(|reference| validated_mqtt_redirect(reference).ok());
        match official_redirect {
            Some(_) => endpoint = redirect_policy.follow(&connack)?,
            None if matches!(connack.reason_code, 0x9c | 0x9d)
                && gateway_reassignments < MAX_MQTT_GATEWAY_REASSIGNMENTS =>
            {
                // Some gateway nodes return an internal raw-MQTT address such
                // as an IP:port in Server Reference. Never follow that address:
                // it is neither authenticated WSS nor an allow-listed QQ Music
                // hostname. Re-open only the original official WSS gateway and
                // keep the same QR/client identity so it can assign a publicly
                // reachable broker without widening the SSRF boundary.
                gateway_reassignments += 1;
                endpoint = MQTT_URL.to_owned();
                tokio::time::sleep(Duration::from_millis(120)).await;
            }
            None => {
                return match redirect_policy.follow(&connack) {
                    Err(error) => Err(error),
                    Ok(_) => Err("QQ 音乐扫码服务迁移状态不一致".to_owned()),
                }
            }
        }
    };

    socket
        .send(Message::Binary(subscribe_packet(1, qrcode_id).into()))
        .await
        .map_err(|error| format!("无法订阅 QQ 音乐扫码状态：{error}"))?;

    // Prefer an accepted SUBACK, but do not make it mandatory: QQ Music's
    // production bridge can omit it even though the subscription is active.
    // The socket is already listening before this grace window begins, so fast
    // scan/cookie events are buffered and cannot be lost while the QR becomes
    // visible. An explicit rejection remains terminal.
    let mut early_events = Vec::new();
    let wait_for_suback = async {
        loop {
            let message = socket
                .next()
                .await
                .ok_or_else(|| "QQ 音乐扫码状态连接已断开".to_owned())?
                .map_err(|error| format!("无法读取 QQ 音乐扫码状态：{error}"))?;
            match message {
                Message::Binary(bytes) => {
                    for (header, frame) in frames(&bytes)? {
                        match header >> 4 {
                            9 => {
                                if suback_accepted(frame)? {
                                    return Ok::<(), String>(());
                                }
                                return Err("QQ 音乐扫码服务拒绝了状态订阅".to_owned());
                            }
                            3 => early_events.push(publish_event(frame, header)?),
                            _ => {}
                        }
                    }
                }
                Message::Ping(payload) => {
                    socket
                        .send(Message::Pong(payload))
                        .await
                        .map_err(|error| format!("无法保持 QQ 音乐扫码连接：{error}"))?;
                }
                Message::Close(_) => {
                    return Err("QQ 音乐扫码状态连接已关闭".to_owned());
                }
                _ => {}
            }
        }
    };
    let _subscription_readiness =
        wait_for_suback_with_compatibility_grace(wait_for_suback, SUBACK_COMPATIBILITY_GRACE)
            .await?;
    on_event(MobileQrEvent::Ready);

    for (event_type, payload) in early_events {
        if let Some(outcome) =
            resolve_publish_event(client, qrcode_id, event_type, payload, &mut on_event).await
        {
            return Ok(outcome);
        }
    }

    let mut ping_timer = interval(Duration::from_secs(20));
    ping_timer.tick().await;
    let listen = async {
        loop {
            tokio::select! {
                message = socket.next() => {
                    let message = message
                        .ok_or_else(|| "QQ 音乐扫码状态连接已断开".to_owned())?
                        .map_err(|error| format!("无法读取 QQ 音乐扫码状态：{error}"))?;
                    match message {
                        Message::Binary(bytes) => {
                            for (header, frame) in frames(&bytes)? {
                                match header >> 4 {
                                    3 => {
                                        let (event_type, payload) = publish_event(frame, header)?;
                                        if let Some(outcome) = resolve_publish_event(
                                            client,
                                            qrcode_id,
                                            event_type,
                                            payload,
                                            &mut on_event,
                                        )
                                        .await
                                        {
                                            return Ok(outcome);
                                        }
                                    }
                                    // A late SUBACK is still authoritative. An
                                    // explicit rejection must not be hidden by
                                    // compatibility mode.
                                    9 if !suback_accepted(frame)? => {
                                        return Err(
                                            "QQ 音乐扫码服务拒绝了状态订阅".to_owned()
                                        );
                                    }
                                    _ => {}
                                }
                            }
                        }
                        Message::Ping(payload) => {
                            socket
                                .send(Message::Pong(payload))
                                .await
                                .map_err(|error| format!("无法保持 QQ 音乐扫码连接：{error}"))?;
                        }
                        Message::Close(_) => {
                            return Err("QQ 音乐扫码状态连接已关闭".to_owned());
                        }
                        _ => {}
                    }
                }
                _ = ping_timer.tick() => {
                    socket
                        .send(Message::Binary(vec![0xc0, 0x00].into()))
                        .await
                        .map_err(|error| format!("无法保持 QQ 音乐扫码连接：{error}"))?;
                }
            }
        }
    };

    match timeout(Duration::from_secs(QR_TIMEOUT_SECONDS), listen).await {
        Ok(result) => result,
        Err(_) => Ok(MobileLoginOutcome::Expired),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        connack_info, connack_reason_label, connect_packet, create_mobile_qr, frame, frames,
        publish_event, push_user_property, push_utf8, retry_with_delays, suback_accepted,
        subscribe_packet, validated_mqtt_redirect, variable_integer,
        wait_for_suback_with_compatibility_grace, watch_mobile_qr, ConnackInfo, MobileLoginOutcome,
        MobileQrEvent, MqttRedirectPolicy, SubscriptionReadiness, MQTT_URL,
    };
    use serde_json::json;
    use std::{
        future::pending,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tokio::time::timeout;

    #[test]
    fn mqtt_variable_integer_round_trips_packet_boundaries() {
        assert_eq!(variable_integer(0), vec![0]);
        assert_eq!(variable_integer(127), vec![127]);
        assert_eq!(variable_integer(128), vec![128, 1]);
        assert_eq!(variable_integer(16_384), vec![128, 128, 1]);
    }

    #[test]
    fn mobile_login_packets_are_valid_mqtt_frames() {
        let connect = connect_packet("1234567890123", "qr-id");
        let subscribe = subscribe_packet(1, "qr-id");
        assert_eq!(frames(&connect).unwrap()[0].0, 0x10);
        assert_eq!(frames(&subscribe).unwrap()[0].0, 0x82);
    }

    #[test]
    fn qr_is_ready_only_after_an_accepted_suback() {
        assert!(suback_accepted(&[0, 1, 0, 0]).unwrap());
        assert!(!suback_accepted(&[0, 1, 0, 0x80]).unwrap());
        assert!(suback_accepted(&[0, 1, 0]).is_err());
    }

    #[test]
    fn connack_rejection_reports_the_exact_safe_reason_code_and_server_reference() {
        assert_eq!(
            connack_info(&[0, 0, 0]).unwrap(),
            ConnackInfo {
                reason_code: 0,
                server_reference: None
            }
        );

        let mut properties = Vec::new();
        properties.push(0x1c);
        push_utf8(&mut properties, "wss://mu-gz.y.qq.com/ws/handshake");
        let mut moved = vec![0, 0x9d];
        moved.extend(variable_integer(properties.len()));
        moved.extend(properties);
        let parsed = connack_info(&moved).unwrap();
        assert_eq!(parsed.reason_code, 0x9d);
        assert_eq!(
            parsed.server_reference.as_deref(),
            Some("wss://mu-gz.y.qq.com/ws/handshake")
        );
        assert_eq!(connack_reason_label(0x85), "client identifier not valid");
        assert_eq!(connack_reason_label(0x87), "not authorized");
        assert_eq!(connack_reason_label(0x9c), "use another server");
        assert_eq!(connack_reason_label(0x9d), "server moved");
        assert!(connack_info(&[0]).is_err());
    }

    #[test]
    fn qq_mqtt_redirect_accepts_9c_and_9d_only_for_official_wss_endpoints() {
        for (reason_code, endpoint) in [
            (0x9c, "wss://mu-a.y.qq.com/ws/handshake"),
            (0x9d, "wss://mu-b.y.qq.com/ws/handshake"),
        ] {
            let mut policy = MqttRedirectPolicy::new(MQTT_URL);
            let redirected = policy
                .follow(&ConnackInfo {
                    reason_code,
                    server_reference: Some(endpoint.to_owned()),
                })
                .unwrap();
            assert_eq!(redirected, endpoint);
        }

        assert!(validated_mqtt_redirect("ws://mu-a.y.qq.com/ws/handshake").is_err());
        assert_eq!(
            validated_mqtt_redirect("mu-a.y.qq.com:443/ws/handshake").unwrap(),
            "wss://mu-a.y.qq.com/ws/handshake"
        );
        assert!(validated_mqtt_redirect("wss://y.qq.com.evil.invalid/ws/handshake").is_err());
        assert!(validated_mqtt_redirect("wss://user@mu-a.y.qq.com/ws/handshake").is_err());
        assert!(validated_mqtt_redirect("wss://mu-a.y.qq.com:8443/ws/handshake").is_err());
    }

    #[test]
    fn qq_mqtt_redirect_rejects_missing_reference_cycles_and_excessive_hops() {
        let mut missing = MqttRedirectPolicy::new(MQTT_URL);
        assert!(missing
            .follow(&ConnackInfo {
                reason_code: 0x9d,
                server_reference: None,
            })
            .unwrap_err()
            .contains("Server Reference"));

        let mut cycle = MqttRedirectPolicy::new(MQTT_URL);
        let first = "wss://mu-a.y.qq.com/ws/handshake";
        cycle
            .follow(&ConnackInfo {
                reason_code: 0x9d,
                server_reference: Some(first.to_owned()),
            })
            .unwrap();
        assert!(cycle
            .follow(&ConnackInfo {
                reason_code: 0x9c,
                server_reference: Some(MQTT_URL.to_owned()),
            })
            .unwrap_err()
            .contains("循环"));

        let mut limited = MqttRedirectPolicy::new(MQTT_URL);
        for endpoint in [
            "wss://mu-a.y.qq.com/ws/handshake",
            "wss://mu-b.y.qq.com/ws/handshake",
        ] {
            limited
                .follow(&ConnackInfo {
                    reason_code: 0x9d,
                    server_reference: Some(endpoint.to_owned()),
                })
                .unwrap();
        }
        assert!(limited
            .follow(&ConnackInfo {
                reason_code: 0x9d,
                server_reference: Some("wss://mu-c.y.qq.com/ws/handshake".to_owned()),
            })
            .unwrap_err()
            .contains("安全上限"));
    }

    #[tokio::test]
    async fn missing_suback_uses_compatibility_grace_and_later_cookies_remain_parseable() {
        let readiness = wait_for_suback_with_compatibility_grace(
            pending::<Result<(), String>>(),
            Duration::from_millis(1),
        )
        .await
        .expect("missing SUBACK should enter compatibility mode");
        assert_eq!(readiness, SubscriptionReadiness::CompatibilityGrace);

        // A PUBLISH arriving after Ready must still follow the normal cookies
        // path; compatibility mode must neither consume nor discard it.
        let payload = json!({
            "cookies": {
                "qqmusic_uin": { "value": "123456" },
                "qqmusic_key": { "value": "one-shot-token" }
            }
        });
        let mut properties = Vec::new();
        push_user_property(&mut properties, "type", "cookies");
        let mut body = Vec::new();
        push_utf8(&mut body, "management.qrcode_login/test-id");
        body.extend(variable_integer(properties.len()));
        body.extend(properties);
        body.extend(serde_json::to_vec(&payload).unwrap());
        let packet = frame(0x30, body);
        let parsed_frames = frames(&packet).unwrap();
        let (header, body) = parsed_frames[0];
        let (event_type, parsed_payload) = publish_event(body, header).unwrap();

        assert_eq!(event_type.as_deref(), Some("cookies"));
        assert_eq!(parsed_payload, payload);
    }

    #[tokio::test]
    async fn explicit_suback_rejection_is_not_hidden_by_compatibility_grace() {
        let result = wait_for_suback_with_compatibility_grace(
            async { Err("QQ 音乐扫码服务拒绝了状态订阅".to_owned()) },
            Duration::from_secs(1),
        )
        .await;

        assert_eq!(result.unwrap_err(), "QQ 音乐扫码服务拒绝了状态订阅");
    }

    #[tokio::test]
    async fn one_shot_credential_exchange_retries_without_reconnecting_mqtt() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let operation_attempts = attempts.clone();
        let result = retry_with_delays(&[Duration::ZERO, Duration::ZERO], move || {
            let operation_attempts = operation_attempts.clone();
            async move {
                let attempt = operation_attempts.fetch_add(1, Ordering::SeqCst);
                if attempt < 2 {
                    Err(format!("temporary failure {attempt}"))
                } else {
                    Ok("authorized")
                }
            }
        })
        .await;

        assert_eq!(result.unwrap(), "authorized");
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    #[ignore = "requires the live QQ Music QR and MQTT services"]
    async fn live_mobile_qr_stays_connected_while_waiting_for_scan() {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap();
        let qr = create_mobile_qr(&client).await.unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let client_id = format!("{now}{:04}", now % 10_000);
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let mut ready_tx = Some(ready_tx);
        let waiting = watch_mobile_qr(&client, &qr.id, &client_id, move |event| {
            if matches!(event, MobileQrEvent::Ready) {
                if let Some(sender) = ready_tx.take() {
                    let _ = sender.send(());
                }
            }
        });
        tokio::pin!(waiting);
        tokio::pin!(ready_rx);

        tokio::select! {
            result = &mut waiting => match result {
                Err(error) => panic!("QQ Music watcher failed before Ready: {error}"),
                Ok(_) => panic!("fresh QR unexpectedly reached a terminal state before Ready"),
            },
            ready = &mut ready_rx => {
                ready.expect("QQ Music watcher dropped the Ready signal");
            },
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                panic!("QQ Music watcher did not emit Ready within five seconds");
            }
        }

        let waiting = timeout(Duration::from_secs(3), &mut waiting).await;
        match waiting {
            Err(_) => {}
            Ok(Err(error)) => panic!("QQ Music watcher failed before scan: {error}"),
            Ok(Ok(MobileLoginOutcome::Authorized(_))) => {
                panic!("fresh QR was unexpectedly authorized")
            }
            Ok(Ok(MobileLoginOutcome::Refused)) => {
                panic!("fresh QR was unexpectedly refused")
            }
            Ok(Ok(MobileLoginOutcome::Expired)) => {
                panic!("fresh QR was unexpectedly expired")
            }
            Ok(Ok(MobileLoginOutcome::Failed(error))) => {
                panic!("fresh QR unexpectedly failed: {error}")
            }
        }
    }
}
