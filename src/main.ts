import './styles.css';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { icon } from './icons';

interface Settings {
  url: string; apiKey: string; apiSecret?: string; identity: string; displayName: string;
  room: string; ttl: string; micDeviceId: string; speakerDeviceId: string;
  echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean; autoJoin: boolean;
}
interface Participant { identity: string; name: string; isLocal: boolean; speaking: boolean; micMuted: boolean }
interface Snapshot { connection: string; room: string; identity: string; participants: Participant[]; micEnabled: boolean; deafened: boolean }
interface Device { id: string; name: string; isDefault: boolean }
interface Devices { mics: Device[]; speakers: Device[] }
interface LoadResult { settings: Settings; hasSecret: boolean; prefilledFrom: string | null }
interface Chat { id: string; from: string; text: string; timestamp: number; own?: boolean }
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const desktop = isTauri();
let settings: Settings = { url: '', apiKey: '', identity: '', displayName: '', room: 'voice-1', ttl: '6h', micDeviceId: '', speakerDeviceId: '', echoCancellation: true, noiseSuppression: true, autoGainControl: true, autoJoin: false };
let snapshot: Snapshot | null = null;
let hasSecret = false;
let busy = false;
let ready = false;
let messages: Chat[] = [];
let unread = 0;
let startedAt: number | null = null;
let devices: Devices = { mics: [], speakers: [] };
let toastTimer: ReturnType<typeof setTimeout>;

$('#app').innerHTML = `
  <main class="main">
    <header class="topbar"><div class="room-heading">${icon('headphones')}<h1 id="room-title">voice-1</h1><span id="participant-count">0 人在线</span></div><div class="top-actions"><span class="connection-badge" id="connection"><i></i>未连接</span><button class="icon-button" id="settings-open" title="设置" aria-label="设置">${icon('settings')}</button><button class="icon-button" id="chat-toggle" title="房间聊天" aria-label="打开聊天" aria-controls="chat-panel" aria-expanded="false">${icon('chat')}<span id="unread" hidden></span></button></div></header>
    <div id="notice" class="notice" role="alert" hidden><span></span><button class="icon-button" aria-label="关闭提示">${icon('close')}</button></div>
    <div class="room-layout">
      <section class="voice-space" aria-label="语音通话">
        <div class="stage" id="stage">
          <div id="welcome" class="welcome"><div class="welcome-icon">${icon('headphones')}</div><h2>加入语音</h2><p>和朋友进入同一个房间，开始聊天。</p>
            <form id="join-form" class="join-form"><label>房间名称<input id="join-room" name="room" required maxlength="128" value="voice-1" autocomplete="off" /></label><label>你的昵称<input id="join-name" name="displayName" maxlength="80" placeholder="希望大家怎么称呼你" autocomplete="nickname" /></label><button type="submit" class="primary" id="join-button">${icon('headphones')}<span>加入语音房间</span></button></form><div class="join-footnote">加入后将开启麦克风</div>
          </div>
          <div id="participants" class="participants" hidden></div>
        </div>
        <footer class="call-footer"><div class="dock-status"><strong id="dock-title">未连接</strong><small id="dock-subtitle">MinVoice</small></div><div class="audio-controls"><div class="audio-control-group"><button id="mic-toggle" class="control-button" disabled aria-label="关闭麦克风">${icon('mic')}<span>麦克风</span></button><button class="device-trigger" data-device="mic" aria-label="选择输入设备" aria-expanded="false" aria-controls="device-popover">${icon('chevron')}</button></div><div class="audio-control-group"><button id="deafen-toggle" class="control-button" disabled aria-label="停止收听">${icon('headphones')}<span>收听</span></button><button class="device-trigger" data-device="speaker" aria-label="选择输出设备" aria-expanded="false" aria-controls="device-popover">${icon('chevron')}</button></div><button id="audio-open" class="control-button" aria-label="音频设备设置" title="音频设备设置">${icon('settings')}<span>设备</span></button><button id="leave-button" class="leave-button" disabled aria-label="离开房间" title="离开房间">${icon('hangup')}<span>离开</span></button><div id="device-popover" class="device-popover" role="region" aria-label="切换音频设备" hidden><header><strong>音频设备</strong><button id="device-close" class="icon-button" aria-label="关闭设备菜单">${icon('close')}</button></header><label>输入设备<select id="quick-mic" aria-label="输入设备"><option value="">系统默认</option></select></label><label>输出设备<select id="quick-speaker" aria-label="输出设备"><option value="">系统默认</option></select></label><p id="quick-device-status" role="status">选择设备后立即切换</p><button id="quick-refresh" class="text-button">${icon('refresh')}刷新设备</button></div></div><span id="runtime-note" class="runtime-note">MinVoice</span></footer>
      </section>
      <aside class="chat-panel" id="chat-panel" aria-label="房间聊天" aria-hidden="true" inert><div class="chat-header"><h2>房间聊天 <span id="chat-count">0</span></h2><button class="icon-button" id="chat-close" aria-label="关闭聊天">${icon('close')}</button></div><div class="chat-stream" id="chat-stream" role="log" aria-live="polite" aria-label="聊天消息"><div class="chat-empty" id="chat-empty">${icon('chat')}<h3>还没有消息</h3><p>加入房间，打个招呼吧。</p></div></div><form class="chat-compose" id="chat-form"><label class="sr-only" for="chat-input">发送到房间</label><textarea id="chat-input" placeholder="加入房间后开始聊天…" rows="2" maxlength="2000" disabled></textarea><div><small>Enter 发送 · Shift + Enter 换行</small><button class="send-button" id="send-button" type="submit" aria-label="发送消息" disabled>${icon('send')}</button></div></form><div class="chat-footer">消息仅保留在本次会话中</div></aside>
    </div>
  </main>
  <dialog id="settings-dialog" aria-labelledby="settings-title"><form id="settings-form"><header class="dialog-header"><div><div class="eyebrow">MINVOICE</div><h2 id="settings-title">设置</h2></div><button type="button" class="icon-button" id="settings-close" aria-label="关闭设置">${icon('close')}</button></header><div class="settings-tabs" role="tablist" aria-label="设置分类"><button type="button" role="tab" aria-selected="true" aria-controls="tab-server" id="server-tab" data-tab="server">${icon('server')}服务器与身份</button><button type="button" role="tab" aria-selected="false" aria-controls="tab-audio" id="audio-tab" data-tab="audio">${icon('headphones')}音频与偏好</button></div>
    <div class="dialog-body"><p id="settings-error" class="form-error" role="alert" hidden></p><div id="tab-server" role="tabpanel" aria-labelledby="server-tab"><p class="section-description">连接你自己的 LiveKit 服务器，和朋友约好同一个房间。</p><label>服务器地址<input name="url" required placeholder="wss://voice.example.com:7443" autocomplete="off" /></label><div class="form-grid"><label>API Key<input name="apiKey" required autocomplete="off" placeholder="服务器的 API Key" /></label><label>API Secret<input name="apiSecret" type="password" autocomplete="new-password" placeholder="输入 API Secret" /></label></div><p class="field-help" id="secret-hint">凭据仅保存在这台设备上。</p><div class="form-rule"></div><div class="form-grid"><label>你的昵称<input name="displayName" maxlength="80" placeholder="希望大家怎么称呼你" /></label><label>参与者 ID<input name="identity" required maxlength="128" placeholder="你的唯一标识" /></label></div><p class="field-help">同一房间中，参与者 ID 需要各不相同。</p><div class="form-grid"><label>默认房间<input name="room" required maxlength="128" /></label><label>连接凭证有效期<input name="ttl" required placeholder="6h" pattern="[0-9]+[smhdSMHD]?" title="例如 30m、6h、7d 或秒数" /></label></div></div>
    <div id="tab-audio" role="tabpanel" aria-labelledby="audio-tab" hidden><div class="device-header"><p class="section-description">选择通话设备和音频处理。</p><button type="button" class="text-button" id="refresh-devices">${icon('refresh')}刷新设备</button></div><label>麦克风<select name="micDeviceId"><option value="">系统默认</option></select></label><label>扬声器 / 耳机<select name="speakerDeviceId"><option value="">系统默认</option></select></label><p id="device-hint" class="field-help">设备列表来自桌面客户端。</p><div class="form-rule"></div><label class="switch-row"><span><strong>回声消除</strong><small>使用扬声器时，减少声音回传</small></span><input type="checkbox" name="echoCancellation" role="switch" /></label><label class="switch-row"><span><strong>背景降噪</strong><small>减少键盘声与环境噪音</small></span><input type="checkbox" name="noiseSuppression" role="switch" /></label><label class="switch-row"><span><strong>自动增益</strong><small>自动调整，让你的声音保持清晰</small></span><input type="checkbox" name="autoGainControl" role="switch" /></label><div class="form-rule"></div><label class="switch-row"><span><strong>启动时自动加入</strong><small>打开 MinVoice，回到上次的房间</small></span><input type="checkbox" name="autoJoin" role="switch" /></label><p class="field-help">通话中保存后立即切换设备；声音处理在下次加入时生效。</p></div></div><footer class="dialog-footer"><span>${icon('shield')}保存在此设备</span><button type="button" class="secondary" id="settings-cancel">取消</button><button type="submit" class="primary" id="save-button">保存设置 ${icon('check')}</button></footer></form></dialog>
  <div class="toast" id="toast" role="status" hidden></div>`;

function toast(message: string) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}
function notice(message: unknown) { $('#notice span').textContent = String(message); $('#notice').hidden = false; }
function connected() { return snapshot?.connection === 'connected'; }
function active() { return snapshot !== null && snapshot.connection !== 'disconnected'; }
function updateProfile() {
  $('#room-title').textContent = snapshot?.room || settings.room;
}
function render() {
  const inRoom = active(); const live = connected();
  updateProfile();
  const status = busy ? '正在处理…' : live ? '已连接' : snapshot?.connection === 'reconnecting' ? '正在重连' : '未连接';
  $('#connection').innerHTML = `<i></i>${status}`;
  $('#connection').classList.toggle('is-live', live);
  $('#welcome').hidden = inRoom;
  $('#participants').hidden = !inRoom;
  $('#participant-count').textContent = `${inRoom ? snapshot!.participants.length : 0} 人在线`;
  if (inRoom) {
    $('#participants').innerHTML = snapshot!.participants.map(p => `<article data-tone="${tone(p.identity)}" class="participant ${p.speaking && !p.micMuted ? 'is-speaking' : ''}"><span class="participant-tag">${p.isLocal ? '你' : '在房间'}</span><div class="avatar" data-tone="${tone(p.identity)}">${escape(Array.from(p.name)[0] || '?')}</div><h3>${escape(p.name)}</h3><div class="participant-state">${icon(p.micMuted ? 'micOff' : 'mic')}<span>${p.micMuted ? '麦克风已关闭' : p.speaking ? '正在说话' : '正在聆听'}</span></div><div class="speaking-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div></article>`).join('');
  }
  $('#dock-title').textContent = live ? '语音已连接' : inRoom ? '正在重连…' : '未连接';
  if (!inRoom) $('#dock-subtitle').textContent = 'MinVoice';
  const mic = $('#mic-toggle') as HTMLButtonElement;
  const deaf = $('#deafen-toggle') as HTMLButtonElement;
  mic.disabled = deaf.disabled = !live || busy;
  mic.innerHTML = `${icon(snapshot?.micEnabled ? 'mic' : 'micOff')}<span>${snapshot?.micEnabled ? '麦克风' : '已静音'}</span>`;
  mic.setAttribute('aria-label', snapshot?.micEnabled ? '关闭麦克风' : '开启麦克风');
  mic.setAttribute('aria-pressed', String(Boolean(snapshot?.micEnabled)));
  mic.classList.toggle('is-off', inRoom && !snapshot?.micEnabled);
  deaf.innerHTML = `${icon(snapshot?.deafened ? 'soundOff' : 'headphones')}<span>${snapshot?.deafened ? '已停止' : '收听'}</span>`;
  deaf.setAttribute('aria-label', snapshot?.deafened ? '恢复收听' : '停止收听');
  deaf.setAttribute('aria-pressed', String(Boolean(snapshot?.deafened)));
  deaf.classList.toggle('is-off', Boolean(snapshot?.deafened));
  $<HTMLButtonElement>('#leave-button').disabled = !inRoom || busy;
  $<HTMLButtonElement>('#join-button').disabled = busy || !ready;
  $('#join-button span').textContent = busy ? '正在连接…' : '加入语音房间';
  $<HTMLTextAreaElement>('#chat-input').disabled = !live;
  $<HTMLTextAreaElement>('#chat-input').placeholder = live ? '说点什么…' : '加入房间后开始聊天…';
  $<HTMLButtonElement>('#send-button').disabled = !live || !$<HTMLTextAreaElement>('#chat-input').value.trim();
}
function tone(identity: string) { return [...identity].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4; }
function acceptSnapshot(value: Snapshot | null) {
  if (value && value.connection !== 'disconnected' && !active()) startedAt = Date.now();
  if (!value || value.connection === 'disconnected') startedAt = null;
  snapshot = value; render();
}
async function refreshSnapshot() { acceptSnapshot(await invoke<Snapshot | null>('voice_snapshot')); }
async function action(command: string, args?: Record<string, unknown>) {
  if (busy) return;
  busy = true; render();
  try { await invoke(command, args); await refreshSnapshot(); }
  catch (e) { notice(e); }
  finally { busy = false; render(); }
}
function setTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
  });
  $('#tab-server').hidden = tab !== 'server'; $('#tab-audio').hidden = tab !== 'audio';
}
const settingsForm = $<HTMLFormElement>('#settings-form');
const field = (name: string) => settingsForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
function populateDeviceSelect(name: string, list: Device[], selected: string) {
  const select = (name.startsWith('quick-') ? $(`#${name}`) : field(name)) as HTMLSelectElement;
  select.replaceChildren(new Option('系统默认', ''));
  list.forEach(device => select.add(new Option(device.name, device.id)));
  if (selected && !list.some(device => device.id === selected)) select.add(new Option('上次选择的设备（当前不可用）', selected));
  select.value = selected;
}
async function refreshDevices() {
  if (!desktop) return;
  $<HTMLButtonElement>('#refresh-devices').disabled = true;
  try {
    devices = await invoke<Devices>('voice_devices');
    populateDeviceSelect('micDeviceId', devices.mics, field('micDeviceId').value);
    populateDeviceSelect('speakerDeviceId', devices.speakers, field('speakerDeviceId').value);
    $('#device-hint').textContent = `检测到 ${devices.mics.length} 个输入、${devices.speakers.length} 个输出设备。`;
  } catch (e) { $('#device-hint').textContent = `无法读取设备：${String(e)}`; }
  finally { $<HTMLButtonElement>('#refresh-devices').disabled = false; }
}

let deviceSwitching = false;
let deviceMenuRequest = 0;
function closeDeviceMenu(restoreFocus = false) {
  deviceMenuRequest++;
  const trigger = document.querySelector<HTMLButtonElement>('.device-trigger[aria-expanded="true"]');
  $('#device-popover').hidden = true;
  document.querySelectorAll('.device-trigger').forEach(button => button.setAttribute('aria-expanded', 'false'));
  if (restoreFocus) trigger?.focus();
}
async function openDeviceMenu(trigger: HTMLButtonElement) {
  if (trigger.getAttribute('aria-expanded') === 'true') { closeDeviceMenu(); return; }
  document.querySelectorAll('.device-trigger').forEach(button => button.setAttribute('aria-expanded', String(button === trigger)));
  const wasHidden = $('#device-popover').hidden;
  $('#device-popover').hidden = false;
  if (wasHidden && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('#device-popover').animate([
      { opacity: 0, transform: 'translateX(-50%) translateY(10px) scale(.96)' },
      { opacity: 1, transform: 'translateX(-50%) translateY(0) scale(1)' },
    ], { duration: 320, easing: 'cubic-bezier(.16, 1, .3, 1)' });
  }
  const request = ++deviceMenuRequest;
  $('#quick-device-status').textContent = desktop ? '正在读取设备…' : '请在桌面客户端选择音频设备';
  $<HTMLSelectElement>('#quick-mic').disabled = true;
  $<HTMLSelectElement>('#quick-speaker').disabled = true;
  if (!desktop) return;
  try {
    const result = await invoke<Devices>('voice_devices');
    if (request !== deviceMenuRequest) return;
    devices = result;
    populateDeviceSelect('quick-mic', devices.mics, settings.micDeviceId);
    populateDeviceSelect('quick-speaker', devices.speakers, settings.speakerDeviceId);
    $('#quick-device-status').textContent = active() ? '选择后立即切换当前通话设备' : '选择后用于下一次通话';
    $<HTMLSelectElement>('#quick-mic').disabled = deviceSwitching;
    $<HTMLSelectElement>('#quick-speaker').disabled = deviceSwitching;
    $<HTMLSelectElement>(`#quick-${trigger.dataset.device}`).focus();
  } catch (error) {
    if (request === deviceMenuRequest) $('#quick-device-status').textContent = `读取设备失败：${String(error)}`;
  }
}
async function switchQuickDevice(kind: 'mic' | 'speaker') {
  if (deviceSwitching) return;
  const key = kind === 'mic' ? 'micDeviceId' : 'speakerDeviceId';
  const select = $<HTMLSelectElement>(`#quick-${kind}`);
  const previous = settings[key];
  const id = select.value;
  deviceSwitching = true;
  $<HTMLSelectElement>('#quick-mic').disabled = $<HTMLSelectElement>('#quick-speaker').disabled = true;
  $('#quick-device-status').textContent = '正在切换…';
  try {
    await invoke('voice_set_device', { kind, id });
    settings[key] = id;
    if (settings.url && settings.apiKey && hasSecret) {
      try { await invoke('save_settings', { settings }); }
      catch (error) { $('#quick-device-status').textContent = `设备已切换，但保存失败：${String(error)}`; return; }
    }
    $('#quick-device-status').textContent = `${kind === 'mic' ? '输入' : '输出'}设备已${active() ? '切换' : '选择'}：${select.selectedOptions[0].text}`;
  } catch (error) {
    select.value = previous;
    $('#quick-device-status').textContent = `切换失败：${String(error)}`;
  } finally {
    deviceSwitching = false;
    $<HTMLSelectElement>('#quick-mic').disabled = $<HTMLSelectElement>('#quick-speaker').disabled = false;
  }
}
document.querySelectorAll<HTMLButtonElement>('.device-trigger').forEach(button => button.addEventListener('click', () => void openDeviceMenu(button)));
$('#device-close').addEventListener('click', () => closeDeviceMenu(true));
$('#quick-mic').addEventListener('change', () => void switchQuickDevice('mic'));
$('#quick-speaker').addEventListener('change', () => void switchQuickDevice('speaker'));
$('#quick-refresh').addEventListener('click', () => {
  const trigger = document.querySelector<HTMLButtonElement>('.device-trigger[aria-expanded="true"]');
  if (trigger) { trigger.setAttribute('aria-expanded', 'false'); void openDeviceMenu(trigger); }
});
document.addEventListener('pointerdown', event => {
  if (event.target instanceof Node && !$('.audio-controls').contains(event.target)) closeDeviceMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#device-popover').hidden) { event.preventDefault(); closeDeviceMenu(true); }
});
function openSettings(tab = 'server') {
  closeDeviceMenu();
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'apiSecret') continue;
    const input = field(key); if (!input) continue;
    if (typeof value === 'boolean') (input as HTMLInputElement).checked = value; else input.value = value;
  }
  field('apiSecret').value = '';
  (field('apiSecret') as HTMLInputElement).placeholder = hasSecret ? '已保存 · 留空保持不变' : '输入 API Secret';
  $('#secret-hint').textContent = hasSecret ? '密钥已保存在本机，不会回传到界面。留空保留，输入新值替换。' : '凭据仅保存在这台设备上，保存后不再显示密钥。';
  populateDeviceSelect('micDeviceId', devices.mics, settings.micDeviceId);
  populateDeviceSelect('speakerDeviceId', devices.speakers, settings.speakerDeviceId);
  $('#settings-error').hidden = true;
  setTab(tab); $<HTMLDialogElement>('#settings-dialog').showModal();
  void refreshDevices();
}
function closeSettings() { field('apiSecret').value = ''; $<HTMLDialogElement>('#settings-dialog').close(); }
async function loadSettings() {
  const result = await invoke<LoadResult>('load_settings');
  settings = result.settings; hasSecret = result.hasSecret;
  $<HTMLInputElement>('#join-room').value = settings.room;
  $<HTMLInputElement>('#join-name').value = settings.displayName;
  updateProfile();
}
async function join() {
  if (busy) return;
  if (!desktop) { notice('当前是界面预览。请启动桌面客户端，连接服务器并使用语音。'); return; }
  if (!settings.url || !settings.apiKey || !hasSecret) { openSettings(); toast('先配置服务器，再加入房间'); return; }
  const room = $<HTMLInputElement>('#join-room').value.trim();
  if (!room) { $<HTMLInputElement>('#join-room').focus(); return; }
  settings = { ...settings, room, displayName: $<HTMLInputElement>('#join-name').value.trim() };
  busy = true; render(); $('#notice').hidden = true;
  try {
    await invoke('save_settings', { settings });
    await invoke('voice_join', { input: settings });
    messages = []; renderMessages(); await refreshSnapshot();
  } catch (e) { notice(e); }
  finally { busy = false; render(); }
}
function renderMessages() {
  const stream = $('#chat-stream');
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 90;
  stream.querySelectorAll('.message').forEach(node => node.remove());
  $('#chat-empty').hidden = messages.length > 0;
  messages.forEach(message => {
    const article = document.createElement('article'); article.className = `message${message.own ? ' own' : ''}`;
    const date = new Date(message.timestamp > 1e12 ? message.timestamp : message.timestamp * 1000);
    article.innerHTML = `<div class="message-meta"><strong>${escape(message.from)}</strong><time>${Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div><p>${escape(message.text)}</p>`;
    stream.append(article);
  });
  $('#chat-count').textContent = String(messages.length);
  if (atBottom) stream.scrollTop = stream.scrollHeight;
}
function appendMessage(message: Chat) {
  if (messages.some(item => item.id === message.id)) return;
  messages.push(message); if (messages.length > 500) messages.shift();
  renderMessages();
  if (!message.own && !$('#chat-panel').classList.contains('is-open') && true) {
    unread++; $('#unread').hidden = false; $('#unread').textContent = String(unread);
  }
}
let sending = false;
async function sendChat() {
  const input = $<HTMLTextAreaElement>('#chat-input'); const text = input.value.trim();
  if (!connected() || !text || sending) return;
  sending = true; $<HTMLButtonElement>('#send-button').disabled = true;
  try {
    await invoke('voice_send_chat', { text });
    appendMessage({ id: crypto.randomUUID(), from: settings.displayName || snapshot!.identity, text, timestamp: Date.now(), own: true });
    if (input.value.trim() === text) input.value = '';
    $('#chat-stream').scrollTop = $('#chat-stream').scrollHeight;
  } catch (e) { notice(e); }
  finally { sending = false; $<HTMLButtonElement>('#send-button').disabled = !connected() || !input.value.trim(); }
}
function toggleChat(open: boolean) {
  if (!open && $('#chat-panel').contains(document.activeElement)) $('#chat-toggle').focus();
  $('#chat-panel').inert = !open;
  $('#chat-panel').setAttribute('aria-hidden', String(!open));
  $('#chat-panel').classList.toggle('is-open', open); $('#chat-toggle').setAttribute('aria-expanded', String(open));
  if (open) { unread = 0; $('#unread').hidden = true; }
}
$('#join-form').addEventListener('submit', e => { e.preventDefault(); void join(); });
$('#mic-toggle').addEventListener('click', () => void action('voice_set_mic', { enabled: !snapshot?.micEnabled }));
$('#deafen-toggle').addEventListener('click', () => void action('voice_set_deafened', { deafened: !snapshot?.deafened }));
$('#leave-button').addEventListener('click', () => void action('voice_leave'));
['settings-open'].forEach(id => $(`#${id}`).addEventListener('click', () => openSettings()));
$('#audio-open').addEventListener('click', () => openSettings('audio'));
$('#settings-close').addEventListener('click', closeSettings); $('#settings-cancel').addEventListener('click', closeSettings);
$('#settings-dialog').addEventListener('close', () => { field('apiSecret').value = ''; });
$('#settings-dialog').addEventListener('cancel', e => { if ($<HTMLButtonElement>('#save-button').disabled) e.preventDefault(); });
$('#notice button').addEventListener('click', () => { $('#notice').hidden = true; });
$('#refresh-devices').addEventListener('click', () => void refreshDevices());
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
  button.addEventListener('click', () => setTab(button.dataset.tab!));
  button.addEventListener('keydown', e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const tab = button.dataset.tab === 'server' ? 'audio' : 'server'; setTab(tab); $(`#${tab}-tab`).focus(); } });
});
settingsForm.addEventListener('invalid', () => setTab('server'), true);
settingsForm.addEventListener('submit', async e => {
  e.preventDefault(); $('#settings-error').hidden = true;
  if (!desktop) { $('#settings-error').textContent = '浏览器仅供预览，请在桌面客户端保存设置。'; $('#settings-error').hidden = false; return; }
  const next = { ...settings };
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    if (key === 'apiSecret') continue;
    const input = field(key);
    Object.assign(next, { [key]: typeof settings[key] === 'boolean' ? (input as HTMLInputElement).checked : input.value.trim() });
  }
  next.apiSecret = field('apiSecret').value;
  if (!hasSecret && !next.apiSecret.trim()) { setTab('server'); $('#settings-error').textContent = '首次连接需要填写 API Secret。'; $('#settings-error').hidden = false; return; }
  $<HTMLButtonElement>('#save-button').disabled = true;
  $<HTMLButtonElement>('#settings-close').disabled = true; $<HTMLButtonElement>('#settings-cancel').disabled = true;
  try {
    await invoke('save_settings', { settings: next });
    field('apiSecret').value = ''; delete next.apiSecret;
    const old = settings;
    await loadSettings();
    if (active()) {
      if (old.micDeviceId !== settings.micDeviceId) await invoke('voice_set_device', { kind: 'mic', id: settings.micDeviceId });
      if (old.speakerDeviceId !== settings.speakerDeviceId) await invoke('voice_set_device', { kind: 'speaker', id: settings.speakerDeviceId });
    }
    closeSettings(); toast(active() ? '已保存。服务器、身份及声音处理将在下次加入时生效' : '设置已保存，可以开始对话了'); render();
  } catch (error) { $('#settings-error').textContent = `设置未全部应用：${String(error)}`; $('#settings-error').hidden = false; }
  finally { delete next.apiSecret; $<HTMLButtonElement>('#save-button').disabled = false; $<HTMLButtonElement>('#settings-close').disabled = false; $<HTMLButtonElement>('#settings-cancel').disabled = false; }
});
$('#chat-form').addEventListener('submit', e => { e.preventDefault(); void sendChat(); });
$('#chat-input').addEventListener('input', () => { $<HTMLButtonElement>('#send-button').disabled = !connected() || sending || !$<HTMLTextAreaElement>('#chat-input').value.trim(); });
$('#chat-input').addEventListener('keydown', e => { if (e instanceof KeyboardEvent && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void sendChat(); } });
$('#chat-toggle').addEventListener('click', () => toggleChat(!$('#chat-panel').classList.contains('is-open')));
$('#chat-close').addEventListener('click', () => toggleChat(false));
setInterval(() => {
  if (startedAt && active()) { const seconds = Math.floor((Date.now() - startedAt) / 1000); $('#dock-subtitle').textContent = `相伴 ${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`; }
}, 1000);
async function init() {
  render();
  if (!desktop) { ready = true; $('#runtime-note').textContent = '浏览器预览'; render(); return; }
  try {
    await listen<Snapshot>('voice://snapshot', event => acceptSnapshot(event.payload));
    await listen<Chat>('voice://chat', event => appendMessage(event.payload));
    await listen<string>('voice://notice', event => notice(event.payload));
    await listen('voice://closed', () => { void refreshSnapshot().catch(notice); });
    await loadSettings(); await refreshSnapshot(); ready = true; render();
    if (settings.autoJoin && hasSecret && settings.url && settings.apiKey && !active()) await join();
  } catch (e) { ready = true; notice(`初始化失败：${String(e)}`); render(); }
}
void init();
