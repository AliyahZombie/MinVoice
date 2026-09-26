//! MinVoice —— Tauri 后端。
//!
//! 职责:
//!   * 存配置(服务器地址 / API Key / API Secret / 默认房间)
//!   * **本地签发** LiveKit Access Token(见 token.rs)
//!   * **Rust 原生语音会话**(见 voice.rs)—— 音频完全不走 WebView
//!
//! 为什么音频在 Rust:Linux 上 Tauri 用 WebKitGTK 渲染,而 WebKitGTK 没有实现
//! RTCPeerConnection,前端 livekit-client 那条路在这里走不通。实测证据与取舍
//! 见 docs/DECISIONS.md。

mod store;
mod token;
mod voice;
mod volume;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use store::Settings;
use token::{MintInput, MintResult};
use voice::{DevicesResult, Snapshot, VoiceState};

/// 前端启动时拉一次配置。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadResult {
    settings: serde_json::Value,
    has_secret: bool,
    config_path: String,
    /// 若本次是从 livekit/credentials.env 预填的,这里说明来源,UI 上给个提示
    prefilled_from: Option<String>,
}

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("找不到配置目录: {e}"))
}

/// 开发期便利:如果还没有配置文件,试着从仓库里的 livekit/credentials.env 预填。
/// 发布版里这个文件不存在,读不到就静默跳过。
fn try_prefill() -> Option<(Settings, String)> {
    // `tauri dev` 的工作目录是 src-tauri/,直接跑二进制时是项目根,两处都探一下。
    let candidates = [
        std::path::PathBuf::from("../livekit/credentials.env"),
        std::path::PathBuf::from("livekit/credentials.env"),
    ];
    for path in candidates {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let parsed = store::parse_env_file(&text);
            if !parsed.api_key.is_empty() && !parsed.api_secret.is_empty() {
                return Some((parsed, path.display().to_string()));
            }
        }
    }
    None
}

#[tauri::command]
fn load_settings(app: tauri::AppHandle) -> Result<LoadResult, String> {
    let dir = config_dir(&app)?;
    let path = store::settings_path(&dir);
    let existed = path.exists();

    let mut settings = store::load(&dir);
    let mut prefilled_from = None;

    // 只在"从没存过配置"时预填,避免覆盖用户已经改过的内容
    if !existed {
        if let Some((prefill, source)) = try_prefill() {
            let keep_identity = settings.identity.clone();
            let echo = settings.echo_cancellation;
            settings = prefill;
            // 预填的是密钥,本地偏好仍然用默认值
            settings.identity = keep_identity;
            settings.echo_cancellation = echo;
            prefilled_from = Some(source);
        }
    }

    Ok(LoadResult {
        has_secret: !settings.api_secret.is_empty(),
        settings: public_settings(&settings),
        config_path: path.display().to_string(),
        prefilled_from,
    })
}

fn public_settings(settings: &Settings) -> serde_json::Value {
    let mut value = serde_json::to_value(settings).expect("Settings can be serialized");
    value.as_object_mut().unwrap().remove("apiSecret");
    value
}

fn private_settings(app: &tauri::AppHandle) -> Result<Settings, String> {
    let dir = config_dir(app)?;
    if !store::settings_path(&dir).exists() {
        if let Some((settings, _)) = try_prefill() {
            return Ok(settings);
        }
    }
    Ok(store::load(&dir))
}

#[tauri::command]
fn save_settings(app: tauri::AppHandle, mut settings: Settings) -> Result<String, String> {
    let dir = config_dir(&app)?;
    if settings.api_secret.is_empty() {
        settings.api_secret = private_settings(&app)?.api_secret;
    }
    settings.url = normalize_url(&settings.url);
    token::parse_ttl(&settings.ttl)?;
    if settings.url.is_empty()
        || settings.api_key.trim().is_empty()
        || settings.api_secret.trim().is_empty()
    {
        return Err("服务器地址、API Key 和 API Secret 不能为空".into());
    }
    if settings.identity.trim().is_empty() || settings.room.trim().is_empty() {
        return Err("参与者 ID 和房间名不能为空".into());
    }
    store::save(&dir, &settings)?;
    Ok(store::settings_path(&dir).display().to_string())
}

/// 单独签发 token(预检/调试用)。Secret 只在这里出现,不回传前端。
#[tauri::command]
fn mint_token(input: MintInput) -> Result<MintResult, String> {
    let request = input.into_request()?;
    let ttl_seconds = request.ttl_seconds;
    let token = token::mint(&request)?;
    Ok(MintResult {
        token,
        room: request.room,
        identity: request.identity,
        expires_at: token::unix_now() + ttl_seconds,
        ttl_seconds,
    })
}

/// 连接房间的完整输入。secret 在这里被换成 token,之后就只带着 token 走。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectInput {
    url: String,
    api_key: String,
    room: String,
    identity: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    ttl: String,
    #[serde(default)]
    echo_cancellation: bool,
    #[serde(default)]
    noise_suppression: bool,
    #[serde(default)]
    auto_gain_control: bool,
    #[serde(default)]
    mic_device_id: String,
    #[serde(default)]
    speaker_device_id: String,
}

/// 用户可能直接粘 IP 或 http://,这里补成 wss://
fn normalize_url(raw: &str) -> String {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return String::new();
    }
    if url.starts_with("ws://") || url.starts_with("wss://") {
        return url.to_string();
    }
    if let Some(rest) = url.strip_prefix("https://") {
        return format!("wss://{rest}");
    }
    if let Some(rest) = url.strip_prefix("http://") {
        return format!("ws://{rest}");
    }
    format!("wss://{url}")
}

/// 一步到位:本地签发 token → 连房间 → 推麦克风 → 开始收事件。
#[tauri::command]
async fn voice_join(app: tauri::AppHandle, input: ConnectInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<VoiceState>();
        join_room(app.clone(), &state, input)
    })
    .await
    .map_err(|error| format!("连接任务失败: {error}"))?
}

fn join_room(app: tauri::AppHandle, state: &VoiceState, input: ConnectInput) -> Result<(), String> {
    let url = normalize_url(&input.url);
    if url.is_empty() {
        return Err("请填服务器地址".into());
    }

    let saved = private_settings(&app)?;
    let request = MintInput {
        api_key: input.api_key.clone(),
        api_secret: saved.api_secret,
        identity: input.identity.clone(),
        display_name: Some(input.display_name.clone()),
        room: input.room.clone(),
        ttl: input.ttl.clone(),
    }
    .into_request()?;
    let ttl_seconds = request.ttl_seconds;
    let token = token::mint(&request)?;

    println!(
        "[voice] token 本地签发完成: room={} identity={} ttl={}s",
        request.room, request.identity, ttl_seconds
    );

    state.join(
        app,
        voice::JoinInput {
            url,
            token,
            identity: input.identity,
            display_name: input.display_name,
            echo_cancellation: input.echo_cancellation,
            noise_suppression: input.noise_suppression,
            auto_gain_control: input.auto_gain_control,
            mic_device_id: input.mic_device_id,
            speaker_device_id: input.speaker_device_id,
        },
    )
}

#[tauri::command]
fn voice_leave(state: State<'_, VoiceState>) -> Result<(), String> {
    state.leave()
}

#[tauri::command]
fn voice_set_mic(
    app: tauri::AppHandle,
    state: State<'_, VoiceState>,
    enabled: bool,
) -> Result<(), String> {
    state.set_mic(&app, enabled)
}

#[tauri::command]
fn voice_set_deafened(
    app: tauri::AppHandle,
    state: State<'_, VoiceState>,
    deafened: bool,
) -> Result<(), String> {
    state.set_deafened(&app, deafened)
}

#[tauri::command]
fn voice_set_participant_volume(
    app: tauri::AppHandle,
    state: State<'_, VoiceState>,
    identity: String,
    volume: u16,
) -> Result<(), String> {
    state.set_participant_volume(&app, &identity, volume)
}

#[tauri::command]
fn voice_send_chat(state: State<'_, VoiceState>, text: String) -> Result<(), String> {
    state.send_chat(text)
}

#[tauri::command]
fn voice_devices(state: State<'_, VoiceState>) -> DevicesResult {
    state.devices()
}

#[tauri::command]
fn voice_set_device(state: State<'_, VoiceState>, kind: String, id: String) -> Result<(), String> {
    state.set_device(kind, id)
}

#[tauri::command]
fn voice_snapshot(state: State<'_, VoiceState>) -> Option<Snapshot> {
    state.snapshot()
}

/// 前端把关键状态打到 stdout,方便在终端里跟日志。
/// 音频问题大多在 Rust/WebRTC 侧静默失败,有个文本出口很省事。
#[tauri::command]
fn log_line(line: String) {
    println!("[ui] {line}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let voice_state = VoiceState::new().expect("初始化语音 runtime 失败");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(voice_state)
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            mint_token,
            voice_join,
            voice_leave,
            voice_set_mic,
            voice_set_deafened,
            voice_set_participant_volume,
            voice_send_chat,
            voice_devices,
            voice_set_device,
            voice_snapshot,
            log_line
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 退出前把房间关掉,别让服务端留着一个幽灵参与者
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<VoiceState>();
                let _ = state.leave();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_settings_never_contains_secret() {
        let mut settings = Settings::default();
        settings.api_secret = "private-test-secret".into();
        let public = public_settings(&settings);
        assert!(public.get("apiSecret").is_none());
        assert!(!public.to_string().contains("private-test-secret"));
        assert_eq!(public["room"], "voice-1");
    }

    #[test]
    fn normalizes_server_addresses_with_custom_ports() {
        assert_eq!(
            normalize_url(" host.example:7443/ "),
            "wss://host.example:7443"
        );
        assert_eq!(
            normalize_url("http://127.0.0.1:7880/"),
            "ws://127.0.0.1:7880"
        );
        assert_eq!(normalize_url("https://host.example"), "wss://host.example");
        assert_eq!(normalize_url("ws://localhost:7880"), "ws://localhost:7880");
        assert!(normalize_url(" ").is_empty());
    }
}
