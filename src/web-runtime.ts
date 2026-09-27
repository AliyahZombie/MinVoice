import { Room, RoomEvent, Track, RemoteAudioTrack, ConnectionState, type Participant } from 'livekit-client';
import { mintToken } from './web-token';

interface Settings {
  url: string; apiKey: string; apiSecret?: string; identity: string; displayName: string;
  room: string; ttl: string; micDeviceId: string; speakerDeviceId: string;
  echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean; autoJoin: boolean;
}
const SETTINGS_KEY = 'minvoice:web:settings';
const VOLUMES_KEY = 'minvoice:web:volumes';
const events = new EventTarget();
let room: Room | null = null;
let sessionSettings: Settings | null = null;
let deafened = false;
let audioContext: AudioContext | null = null;
const audioElements = new Set<HTMLMediaElement>();

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
}
function loadSettings(): Settings {
  const defaults: Settings = { url: '', apiKey: '', identity: `web-${crypto.randomUUID().slice(0, 8)}`, displayName: '', room: 'voice-1', ttl: '6h', micDeviceId: '', speakerDeviceId: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true, autoJoin: false };
  const stored = read<Partial<Settings>>(SETTINGS_KEY, {});
  const settings = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Settings)[]) {
    if (typeof stored[key] === typeof defaults[key]) Object.assign(settings, { [key]: stored[key] });
  }
  return settings;
}
let settings = loadSettings();
const secretKey = (value: Settings) => `minvoice:web:secret:${JSON.stringify([value.url, value.apiKey])}`;
const secret = (value: Settings) => sessionStorage.getItem(secretKey(value)) || '';
const volumes = read<Record<string, number>>(VOLUMES_KEY, {});
const volumeKey = (identity: string) => JSON.stringify([sessionSettings?.url || settings.url, identity]);
const volume = (identity: string) => { const value = volumes[volumeKey(identity)]; return Number.isFinite(value) ? Math.max(0, Math.min(200, value)) : 100; };
const emit = (name: string, payload?: unknown) => events.dispatchEvent(new CustomEvent(name, { detail: payload }));

export function listen<T>(event: string, handler: (event: { payload: T }) => void) {
  const callback = (value: Event) => handler({ payload: (value as CustomEvent<T>).detail });
  events.addEventListener(event, callback);
  return () => events.removeEventListener(event, callback);
}
function snapshot() {
  if (!room || room.state === ConnectionState.Disconnected) return null;
  const participant = (p: Participant) => ({ identity: p.identity, name: p.name || p.identity, isLocal: p.isLocal, speaking: p.isSpeaking, micMuted: !p.isMicrophoneEnabled, volume: p.isLocal ? 100 : volume(p.identity) });
  return { connection: room.state, room: sessionSettings?.room || room.name, identity: room.localParticipant.identity, participants: [participant(room.localParticipant), ...Array.from(room.remoteParticipants.values(), participant)], micEnabled: room.localParticipant.isMicrophoneEnabled, deafened };
}
const update = () => emit('voice://snapshot', snapshot());
function applyVolumes() {
  room?.remoteParticipants.forEach(p => p.audioTrackPublications.forEach(publication => {
    if (publication.track instanceof RemoteAudioTrack) publication.track.setVolume(deafened ? 0 : volume(p.identity) / 100);
  }));
}
function cleanupAudio() {
  for (const element of audioElements) { element.pause(); element.srcObject = null; element.remove(); }
  audioElements.clear();
  void audioContext?.close().catch(() => {}); audioContext = null;
}
async function leave() {
  const previous = room; room = null;
  try { await previous?.disconnect(); } finally { cleanupAudio(); sessionSettings = null; deafened = false; update(); }
}
function validate(value: Settings) {
  let url: URL;
  try { url = new URL(value.url); } catch { throw new Error('请输入完整的 wss:// 服务器地址。'); }
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && location.protocol === 'http:')) {
    throw new Error('网页版需要 wss:// 安全连接；仅本地 HTTP 开发时可用 ws://localhost。');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务器地址不能包含用户名、密码或查询参数。');
  if (!value.apiKey.trim() || !value.identity.trim() || !value.room.trim()) throw new Error('请填写 API Key、参与者 ID 和房间。');
}
async function join(input: Settings) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('请通过 HTTPS 打开，并使用支持麦克风的浏览器。');
  if (!navigator.onLine) throw new Error('当前离线：联网后才能加入语音房间。');
  validate(input);
  await leave();
  const token = await mintToken({ ...input, apiSecret: secret(input) });
  sessionSettings = { ...input }; deafened = false;
  audioContext = new AudioContext();
  void audioContext.resume().catch(() => {});
  const current = new Room({
    webAudioMix: { audioContext },
    audioCaptureDefaults: { deviceId: input.micDeviceId || undefined, echoCancellation: input.echoCancellation, noiseSuppression: input.noiseSuppression, autoGainControl: input.autoGainControl },
  });
  room = current;
  current.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
    if (track.kind !== Track.Kind.Audio || !(track instanceof RemoteAudioTrack)) return;
    track.setVolume(deafened ? 0 : volume(participant.identity) / 100);
    const element = track.attach(); element.hidden = true; document.body.append(element); audioElements.add(element);
    update();
  });
  current.on(RoomEvent.TrackUnsubscribed, track => {
    for (const element of track.detach()) { audioElements.delete(element); element.remove(); }
    update();
  });
  for (const event of [RoomEvent.ConnectionStateChanged, RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.ActiveSpeakersChanged, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished, RoomEvent.LocalTrackUnpublished, RoomEvent.ParticipantNameChanged]) current.on(event, update);
  current.on(RoomEvent.ChatMessage, (message, participant) => {
    if (participant?.isLocal) return; // The shared UI already echoes outgoing messages.
    emit('voice://chat', { id: message.id, from: participant?.name || participant?.identity || '系统', text: message.message, timestamp: message.timestamp });
  });
  current.on(RoomEvent.Reconnecting, () => emit('voice://notice', '网络波动，正在重连…'));
  current.on(RoomEvent.Reconnected, () => { applyVolumes(); emit('voice://notice', '已重新连接'); });
  current.on(RoomEvent.AudioPlaybackStatusChanged, () => {
    if (!current.canPlaybackAudio) emit('voice://notice', '浏览器暂停了声音，请点击页面恢复播放。');
  });
  current.on(RoomEvent.Disconnected, reason => {
    if (room !== current) return;
    room = null; cleanupAudio(); sessionSettings = null; deafened = false;
    update(); emit('voice://notice', `已断开连接（${reason ?? '连接关闭'}），可重新加入。`); emit('voice://closed');
  });
  try {
    await current.connect(input.url, token);
    try { await current.startAudio(); }
    catch { emit('voice://notice', '已加入房间，请点击页面允许浏览器播放声音。'); }
    if (input.speakerDeviceId) {
      try { await current.switchActiveDevice('audiooutput', input.speakerDeviceId); }
      catch { emit('voice://notice', '无法使用上次的输出设备，已使用系统默认设备。'); }
    }
    try { await current.localParticipant.setMicrophoneEnabled(true); }
    catch { emit('voice://notice', '已加入收听，但麦克风未开启。请允许麦克风权限或在设备设置中选择可用麦克风，再点击开启。'); }
    update();
  } catch (error) { await leave(); throw error; }
}
document.addEventListener('pointerdown', () => {
  if (room && !room.canPlaybackAudio) void room.startAudio().catch(() => {});
  if (audioContext?.state === 'suspended') void audioContext.resume().catch(() => {});
});

async function command(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'load_settings': return { settings: { ...settings }, hasSecret: !!secret(settings), prefilledFrom: null };
    case 'save_settings': {
      const next = { ...(args.settings as Settings) }; validate(next);
      const apiSecret = next.apiSecret?.trim(); delete next.apiSecret;
      if (apiSecret) sessionStorage.setItem(secretKey(next), apiSecret);
      if (!secret(next)) throw new Error('请为此服务器填写 API Secret，密钥仅保留在当前标签页会话中。');
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); settings = next; return;
    }
    case 'voice_snapshot': return snapshot();
    case 'voice_join': return join(args.input as Settings);
    case 'voice_leave': return leave();
    case 'voice_devices': {
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error('浏览器不支持读取音频设备，请使用 HTTPS。');
      const devices = await navigator.mediaDevices.enumerateDevices();
      const list = (kind: MediaDeviceKind) => devices.filter(d => d.kind === kind).map((d, index) => ({ id: d.deviceId, name: d.label || `${kind === 'audioinput' ? '麦克风' : '扬声器'} ${index + 1}（授权后显示名称）`, isDefault: d.deviceId === 'default' }));
      return { mics: list('audioinput'), speakers: list('audiooutput') };
    }
    case 'voice_set_device': {
      const kind = args.kind === 'mic' ? 'audioinput' : 'audiooutput';
      const id = String(args.id || 'default');
      if (kind === 'audiooutput' && !('setSinkId' in AudioContext.prototype)) throw new Error('此浏览器不支持切换输出设备，请在系统设置中选择耳机或扬声器。');
      if (room && !await room.switchActiveDevice(kind, id)) throw new Error('设备切换失败，请检查设备连接。');
      return;
    }
    case 'voice_set_mic': {
      if (!room) throw new Error('尚未加入房间。');
      await room.localParticipant.setMicrophoneEnabled(Boolean(args.enabled)); update(); return;
    }
    case 'voice_set_deafened': {
      if (!room) throw new Error('尚未加入房间。');
      deafened = Boolean(args.deafened); applyVolumes(); update(); return;
    }
    case 'voice_set_participant_volume': {
      const percent = Number(args.volume);
      if (!room || !Number.isFinite(percent) || percent < 0 || percent > 200) throw new Error('音量应为 0–200%。');
      volumes[volumeKey(String(args.identity))] = percent;
      localStorage.setItem(VOLUMES_KEY, JSON.stringify(volumes)); applyVolumes(); update(); return;
    }
    case 'voice_send_chat': {
      if (!room) throw new Error('尚未加入房间。');
      const text = String(args.text).trim();
      if (!text || text.length > 2000) throw new Error('消息长度应为 1–2000 字。');
      await room.localParticipant.sendChatMessage(text); return;
    }
    default: throw new Error(`不支持的操作：${name}`);
  }
}
export async function invoke<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return await command(name, args) as T;
}
