//! 语音房间会话 —— Rust 原生音频栈。
//!
//! 为什么不用 WebView 里的 JS SDK:
//! Tauri 在 Linux 上用 WebKitGTK 渲染,而 WebKitGTK **没有实现 RTCPeerConnection**
//! (实测 `typeof RTCPeerConnection === 'undefined'`,即使 enable-webrtc=true、
//! 页面处于安全上下文也一样)。所以 WebView 只能画界面,音频必须走 Rust。
//!
//! 这里用官方 livekit Rust SDK:
//!   * `PlatformAudio` 打开 libwebrtc 的 ADM(Audio Device Module),
//!     麦克风采集与扬声器播放都由它负责,AEC/AGC/NS 也是现成的;
//!   * `PlatformAudio::new()` 内部会 `set_adm_playout_enabled(true)`,
//!     所以远端音频**自动**从扬声器出来,不需要逐条 track 挂 sink;
//!   * 推流:把 ADM 的 source 包成 LocalAudioTrack 再 publish_track。
//!
//! 线程模型:
//! SDK 是 async 的,我们单独起一个多线程 tokio runtime,所有 Tauri 命令都是
//! **同步**函数,内部用 `rt.block_on`。这样不会和 Tauri 自己的 runtime 打架。

use std::sync::Mutex;

use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::{Room, RoomOptions};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// 前端传进来的连接参数(secret 已在 lib.rs 里换成 token,这里只收 token)。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinInput {
    pub url: String,
    pub token: String,
    pub identity: String,
    pub display_name: String,
    pub echo_cancellation: bool,
    pub noise_suppression: bool,
    pub auto_gain_control: bool,
    /// 为空表示用系统默认设备
    #[serde(default)]
    pub mic_device_id: String,
    #[serde(default)]
    pub speaker_device_id: String,
}

/// 界面上一个参与者要显示的东西。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantView {
    pub identity: String,
    pub name: String,
    pub is_local: bool,
    pub speaking: bool,
    /// 这个人现在是不是没在推麦克风(静音)
    pub mic_muted: bool,
}

/// 全量状态快照。参与者数量很少,每次变化直接推全量,
/// 前端不用维护增量合并逻辑,少一类 bug。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub connection: String,
    pub room: String,
    pub identity: String,
    pub participants: Vec<ParticipantView>,
    pub mic_enabled: bool,
    pub deafened: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicesResult {
    pub mics: Vec<DeviceView>,
    pub speakers: Vec<DeviceView>,
}

/// 一次会话的全部资源。断开时整体丢弃。
struct Session {
    room: Room,
    audio: PlatformAudio,
    /// 麦克风那条 track 的发布句柄,静音/取消静音用
    mic_publication: Option<LocalTrackPublication>,
    mic_enabled: bool,
    deafened: bool,
    event_task: tokio::task::JoinHandle<()>,
}

impl Drop for Session {
    fn drop(&mut self) {
        // 先停事件循环,再让 room / audio 自然析构
        self.event_task.abort();
    }
}

pub struct VoiceState {
    rt: tokio::runtime::Runtime,
    session: Mutex<Option<Session>>,
}

impl VoiceState {
    pub fn new() -> Result<Self, String> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("minvoice-voice")
            .build()
            .map_err(|e| format!("创建语音 runtime 失败: {e}"))?;
        Ok(Self {
            rt,
            session: Mutex::new(None),
        })
    }

    /// 进入本 runtime 的上下文。
    ///
    /// 必须有这一步的原因:Tauri 的**同步**命令是在 GTK 主线程上执行的,而
    /// livekit SDK 内部有些回调(例如 add_publication 注册的 on_muted)会直接
    /// `tokio::spawn`。主线程没有 tokio reactor,于是 panic:
    ///   "there is no reactor running, must be called from the context of a Tokio 1.x runtime"
    /// 更糟的是这个 panic 发生在 GTK 的 FFI 回调里,无法 unwind,直接 abort 整个进程。
    /// 所以凡是可能踏进 SDK 的地方,都先用这个 guard 把上下文铺好。
    fn enter(&self) -> tokio::runtime::EnterGuard<'_> {
        self.rt.enter()
    }

    fn snapshot_locked(session: &Session) -> Snapshot {
        let room = &session.room;
        let local = room.local_participant();

        let mut participants = vec![ParticipantView {
            identity: local.identity().to_string(),
            name: display_name(&local.name(), &local.identity().to_string()),
            is_local: true,
            speaking: local.is_speaking(),
            mic_muted: !session.mic_enabled,
        }];

        for (identity, p) in room.remote_participants() {
            // 对方只要有任意一条没静音的音频轨,就算"在说话"
            let has_live_mic = p
                .track_publications()
                .values()
                .any(|pub_| pub_.kind() == TrackKind::Audio && !pub_.is_muted());
            let id = identity.to_string();
            participants.push(ParticipantView {
                name: display_name(&p.name(), &id),
                identity: id,
                is_local: false,
                speaking: p.is_speaking(),
                mic_muted: !has_live_mic,
            });
        }

        // 本地排最前,其余按名字稳定排序,避免每次刷新顺序乱跳
        participants[1..].sort_by(|a, b| a.name.cmp(&b.name));

        Snapshot {
            connection: connection_label(room.connection_state()),
            room: room.name(),
            identity: local.identity().to_string(),
            participants,
            mic_enabled: session.mic_enabled,
            deafened: session.deafened,
        }
    }

    fn emit_snapshot(app: &AppHandle) {
        let state = app.state::<VoiceState>();
        let guard = state.session.lock().unwrap();
        if let Some(session) = guard.as_ref() {
            let snap = Self::snapshot_locked(session);
            drop(guard);
            let _ = app.emit("voice://snapshot", snap);
        }
    }

    // ---------------------------------------------------------------- 命令

    pub fn join(&self, app: AppHandle, input: JoinInput) -> Result<(), String> {
        // 见 enter() 的注释:整段都在 SDK 里出出进进
        println!("[cmd] join");
        let _rt = self.enter();

        self.leave()?;

        // 连之前先落一行日志:排查连不上时,至少知道参数对不对
        println!(
            "[voice] 正在连接 {} — identity={} 昵称={}",
            input.url,
            input.identity,
            if input.display_name.trim().is_empty() {
                "(未填)"
            } else {
                input.display_name.trim()
            }
        );

        // 1) 连房间
        let (room, mut events) = self
            .rt
            .block_on(async {
                // RoomOptions 是 #[non_exhaustive],不能直接写字面量。
                // 默认值已经是我们想要的(auto_subscribe = true)。
                Room::connect(&input.url, &input.token, RoomOptions::default()).await
            })
            .map_err(|e| format!("连接 LiveKit 失败: {e}"))?;

        // 2) 打开平台音频设备(ADM):采集 + 播放都在这里
        let audio = PlatformAudio::new()
            .map_err(|e| format!("打开音频设备失败: {e}(检查系统是否有可用麦克风/扬声器)"))?;

        audio
            .configure_audio_processing(AudioProcessingOptions {
                echo_cancellation: input.echo_cancellation,
                noise_suppression: input.noise_suppression,
                auto_gain_control: input.auto_gain_control,
                prefer_hardware_processing: true,
            })
            .map_err(|e| format!("配置音频处理失败: {e}"))?;

        if !input.mic_device_id.is_empty() {
            if let Some(dev) = audio
                .recording_devices()
                .find(|d| d.id.as_str() == input.mic_device_id)
            {
                let _ = audio.set_recording_device(&dev.id);
            }
        }
        if !input.speaker_device_id.is_empty() {
            if let Some(dev) = audio
                .playout_devices()
                .find(|d| d.id.as_str() == input.speaker_device_id)
            {
                let _ = audio.set_playout_device(&dev.id);
            }
        }

        // ADM 的采集要显式启动。不启动的话轨道照样发布成功,但推上去全是静音,
        // 而且不会有任何报错 —— 所以这里必须打日志,不然没法排查。
        audio
            .start_recording()
            .map_err(|e| format!("启动麦克风采集失败: {e}"))?;
        println!("[voice] ADM 采集已启动");

        // 3) 把麦克风作为一条音频轨推上去
        let track = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
        let publish_options = TrackPublishOptions {
            source: TrackSource::Microphone,
            // SDK 默认把流名写成 "camera",对麦克风来说不合适
            stream: "microphone".to_string(),
            // dtx:不说话时几乎不发包,省流量
            dtx: true,
            red: true,
            ..Default::default()
        };
        let publication = self
            .rt
            .block_on(
                room.local_participant()
                    .publish_track(livekit::prelude::LocalTrack::Audio(track), publish_options),
            )
            .map_err(|e| format!("发布麦克风失败: {e}"))?;

        // 4) 事件循环 → 推给前端
        // Room 不是 Clone,所以事件任务不持有它;需要状态时通过 AppHandle 拿。
        let app_for_task = app.clone();
        let event_task = self.rt.spawn(async move {
            while let Some(event) = events.recv().await {
                handle_event(&app_for_task, event);
            }
            let _ = app_for_task.emit("voice://closed", ());
        });

        {
            let mut guard = self.session.lock().unwrap();
            *guard = Some(Session {
                room,
                audio,
                mic_publication: Some(publication),
                mic_enabled: true,
                deafened: false,
                event_task,
            });
        }

        Self::emit_snapshot(&app);
        Ok(())
    }

    pub fn leave(&self) -> Result<(), String> {
        // 见 enter() 的注释:这些调用可能让 SDK 内部 tokio::spawn
        println!("[cmd] leave");
        let _rt = self.enter();
        let taken = {
            let mut guard = self.session.lock().unwrap();
            guard.take()
        };
        if let Some(session) = taken {
            session.event_task.abort();
            // 先关房间,让服务端立刻知道我们走了(Room 不可 Clone,直接借用)
            let _ = self.rt.block_on(session.room.close());
            drop(session);
        }
        Ok(())
    }

    /// 静音 / 取消静音。走 track 的 mute,不重新推流,切换是瞬时的。
    pub fn set_mic(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        // 见 enter() 的注释:这些调用可能让 SDK 内部 tokio::spawn
        println!("[cmd] set_mic");
        let _rt = self.enter();
        {
            let mut guard = self.session.lock().unwrap();
            let session = guard.as_mut().ok_or("还没进入房间")?;
            if session.mic_enabled == enabled {
                return Ok(());
            }
            match session.mic_publication.as_ref() {
                Some(pub_) if enabled => pub_.unmute(),
                Some(pub_) => pub_.mute(),
                None => return Err("麦克风没有发布成功,无法切换".into()),
            }
            session.mic_enabled = enabled;
        }
        Self::emit_snapshot(app);
        Ok(())
    }

    /// 闭麦:把远端所有音频轨退订,扬声器就彻底安静了。
    /// SDK 没有提供全局播放音量,退订是最干净的等效手段。
    pub fn set_deafened(&self, app: &AppHandle, deafened: bool) -> Result<(), String> {
        // 见 enter() 的注释:这些调用可能让 SDK 内部 tokio::spawn
        println!("[cmd] set_deafened");
        let _rt = self.enter();
        {
            let mut guard = self.session.lock().unwrap();
            let session = guard.as_mut().ok_or("还没进入房间")?;
            if session.deafened == deafened {
                return Ok(());
            }
            for p in session.room.remote_participants().values() {
                for pub_ in p.track_publications().values() {
                    if pub_.kind() == TrackKind::Audio {
                        pub_.set_subscribed(!deafened);
                    }
                }
            }
            session.deafened = deafened;
        }
        Self::emit_snapshot(app);
        Ok(())
    }

    pub fn send_chat(&self, text: String) -> Result<(), String> {
        // 见 enter() 的注释:这些调用可能让 SDK 内部 tokio::spawn
        println!("[cmd] send_chat");
        let _rt = self.enter();
        let guard = self.session.lock().unwrap();
        let session = guard.as_ref().ok_or("还没进入房间")?;
        self.rt
            .block_on(
                session
                    .room
                    .local_participant()
                    .send_chat_message(text, None, None),
            )
            .map(|_| ())
            .map_err(|e| format!("发送消息失败: {e}"))
    }

    pub fn devices(&self) -> DevicesResult {
        // 见 enter() 的注释:这些调用可能让 SDK 内部 tokio::spawn
        println!("[cmd] devices");
        let _rt = self.enter();
        let Ok(audio) = PlatformAudio::new() else {
            return DevicesResult {
                mics: vec![],
                speakers: vec![],
            };
        };
        let mics = audio
            .recording_devices()
            .enumerate()
            .map(|(i, d)| DeviceView {
                id: d.id.as_str().to_string(),
                name: d.name.clone(),
                is_default: i == 0,
            })
            .collect();
        let speakers = audio
            .playout_devices()
            .enumerate()
            .map(|(i, d)| DeviceView {
                id: d.id.as_str().to_string(),
                name: d.name.clone(),
                is_default: i == 0,
            })
            .collect();
        let result = DevicesResult { mics, speakers };
        drop(audio); // 只是枚举,别占着 ADM
        result
    }

    /// 切换设备。房间已经开着的话走 switch_*(热切换),否则只记下来。
    pub fn set_device(&self, kind: String, id: String) -> Result<(), String> {
        // 见 enter() 的注释:这些调用可能让 SDK 内部 tokio::spawn
        println!("[cmd] set_device");
        let _rt = self.enter();
        let guard = self.session.lock().unwrap();
        let Some(session) = guard.as_ref() else {
            return Ok(()); // 还没进房间,下次 join 会带上
        };
        match kind.as_str() {
            "mic" => {
                let dev = session
                    .audio
                    .recording_devices()
                    .find(|d| id.is_empty() || d.id.as_str() == id)
                    .ok_or("找不到这个麦克风")?;
                session
                    .audio
                    .switch_recording_device(&dev.id)
                    .map_err(|e| format!("切换麦克风失败: {e}"))
            }
            "speaker" => {
                let dev = session
                    .audio
                    .playout_devices()
                    .find(|d| id.is_empty() || d.id.as_str() == id)
                    .ok_or("找不到这个扬声器")?;
                session
                    .audio
                    .switch_playout_device(&dev.id)
                    .map_err(|e| format!("切换扬声器失败: {e}"))
            }
            other => Err(format!("未知设备类型 {other}")),
        }
    }

    pub fn snapshot(&self) -> Option<Snapshot> {
        // 见 enter() 的注释:这些调用可能让 SDK 内部 tokio::spawn
        println!("[cmd] snapshot");
        let _rt = self.enter();
        let guard = self.session.lock().unwrap();
        guard.as_ref().map(Self::snapshot_locked)
    }
}

impl Drop for VoiceState {
    fn drop(&mut self) {
        let _ = self.leave();
    }
}

/// 服务端没给 name 时退回 identity,别在界面上显示空白
fn display_name(name: &str, identity: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        identity.to_string()
    } else {
        trimmed.to_string()
    }
}

fn connection_label(state: ConnectionState) -> String {
    // SDK 只有这三个状态;界面上的"正在连接"由前端自己先置上。
    match state {
        ConnectionState::Connected => "connected",
        ConnectionState::Reconnecting => "reconnecting",
        ConnectionState::Disconnected => "disconnected",
    }
    .to_string()
}

fn handle_event(app: &AppHandle, event: RoomEvent) {
    // A newly published track must respect the existing listening preference too.
    if matches!(
        &event,
        RoomEvent::TrackPublished { .. } | RoomEvent::TrackSubscribed { .. }
    ) {
        let state = app.state::<VoiceState>();
        let guard = state.session.lock().unwrap();
        if let Some(session) = guard.as_ref() {
            if session.deafened {
                for participant in session.room.remote_participants().values() {
                    for publication in participant.track_publications().values() {
                        if publication.kind() == TrackKind::Audio && publication.is_subscribed() {
                            publication.set_subscribed(false);
                        }
                    }
                }
            }
        }
    }
    match event {
        RoomEvent::ChatMessage {
            message,
            participant,
        } => {
            let who = participant
                .as_ref()
                .map(|p| display_name(&p.name(), &p.identity().to_string()))
                .unwrap_or_else(|| "(系统)".into());
            let _ = app.emit(
                "voice://chat",
                serde_json::json!({
                    "id": message.id,
                    "from": who,
                    "text": message.message,
                    "timestamp": message.timestamp,
                }),
            );
        }
        RoomEvent::Reconnecting => {
            let _ = app.emit("voice://notice", "网络抖动,正在重连…");
        }
        RoomEvent::Reconnected => {
            let _ = app.emit("voice://notice", "已重新连接");
        }
        RoomEvent::Disconnected { reason } => {
            let _ = app.emit("voice://notice", format!("连接已断开({reason:?})"));
        }
        RoomEvent::TrackSubscriptionFailed { error, .. } => {
            let _ = app.emit("voice://notice", format!("订阅对端音频失败: {error:?}"));
        }
        _ => {}
    }

    // 任何事件都可能改变"谁在说话/谁静音/连接状态",直接推一次全量快照。
    let state = app.state::<VoiceState>();
    let guard = state.session.lock().unwrap();
    if let Some(session) = guard.as_ref() {
        let snap = VoiceState::snapshot_locked(session);
        drop(guard);
        let _ = app.emit("voice://snapshot", snap);
    } else {
        drop(guard);
    }
}
