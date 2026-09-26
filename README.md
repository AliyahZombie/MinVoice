# MinVoice

[![windows-build](https://github.com/AliyahZombie/MinVoice/actions/workflows/windows.yml/badge.svg)](https://github.com/AliyahZombie/MinVoice/actions/workflows/windows.yml)

极简多人语音聊天客户端:填服务器地址 + API Secret 就能进房间说话,
**Access Token 在本机签发**,不依赖任何远程鉴权服务。

纯 Tauri(Linux 上是 GTK + WebKitGTK,Windows 上是 WebView2),但**音频链路完全在 Rust 里**,
不在 WebView 里跑 —— 原因见下方"为什么音频不在前端"。

---

## 它长什么样

- **设置页**:服务器地址、API Key、API Secret、房间、昵称、参与者 ID;
  高级里可选 token 有效期、回声消除/降噪/自动增益、输入输出设备、是否启动即进房间。
- **房间页**:顶部是连接状态/房间名/人数/通话时长;左侧参与者卡片(说话时描边高亮,
  静音/未开麦有角标);每位远端参与者有 **0–200% 本地音量滑块**，支持静音和恢复原声;
  文字聊天;底部是麦克风、扬声器(闭麦)、设备选择、离开。

逐人音量只影响你听到的声音，按服务器地址与参与者 ID 保存在本机，
重连、重新开麦和下次进入同一服务器会自动恢复。实现与验证见 [docs/VOLUME.md](docs/VOLUME.md)。

键盘操作:聊天框 `Enter` 发送、`Shift+Enter` 换行;音频设备菜单可用 `Esc` 关闭。

---

## 跑起来

```bash
pnpm install
pnpm tauri dev            # 开发
pnpm tauri build          # 打包(产物在 src-tauri/target/release/)
```

只想快速验证(不打包,直接出可执行文件):

```bash
pnpm tauri build --debug --no-bundle
./src-tauri/target/debug/minvoice
```

依赖(桌面通用):Node 22.12+/pnpm 11、Rust stable。

Linux 额外需要系统库,编译 C++ 桥接层还需要 **clang**(不是 gcc):

```bash
sudo apt-get install -y clang cmake libclang-dev libwebkit2gtk-4.1-dev libasound2-dev
```

Windows 打包不需要 clang/cmake(libwebrtc 用官方预编译库),
前置依赖与产物说明见 **[docs/WINDOWS.md](docs/WINDOWS.md)**。

### 配置存在哪

`~/.config/com.aliyah.minvoice/settings.json`,目录 `0700`、文件 `0600`。
注意目录名是 Tauri 的 **identifier**(`com.aliyah.minvoice`),不是产品名。

里面存着 API Secret —— **别把 `~/.config/com.aliyah.minvoice` 同步到任何地方**。
Secret 只在 Rust 进程中读取,前端 JS 拿不到它(前端只说"给我签个 token")。

开发期如果这个文件还不存在,程序会尝试从 `livekit/credentials.env` 预填服务器
凭据,方便本机调试;该文件不存在时静默跳过。

---

## 构建与发布（CI）

Windows 安装包由 GitHub Actions 构建（[`.github/workflows/windows.yml`](.github/workflows/windows.yml)）:

- Actions 页面手动触发 `windows-build`,或推送 `v*` tag(自动创建 Release 并附安装包)
- 产物:NSIS 安装器(简体中文/English)、MSI、便携版 exe、`SHA256SUMS.txt`
- 依赖、产物位置与真机验证清单见 **[docs/WINDOWS.md](docs/WINDOWS.md)**

---

## 为什么音频不在前端(重要)

最自然的写法是 Tauri 壳 + 前端 `livekit-client`。**这条路在 Linux 上走不通**:
Tauri 在 Linux 用 WebKitGTK 渲染,而 WebKitGTK 没有实现 `RTCPeerConnection`。

实测:在 WebKitGTK 里 `typeof RTCPeerConnection === 'undefined'`,
即使显式 `set_enable_webrtc(true)`、`set_enable_media_stream(true)`,
并且页面跑在安全上下文 `http://127.0.0.1` 上也一样。`getUserMedia` 是好的,
所以麦克风能拿到,但没法建连接。外部佐证见
[wry#85](https://github.com/tauri-apps/wry/issues/85) 与
[tauri#8426](https://github.com/orgs/tauri-apps/discussions/8426)。

所以 MinVoice 的做法是:**WebView 只画界面**,音频用官方 `livekit` Rust SDK,
麦克风采集与扬声器播放交给 libwebrtc 的 ADM(Audio Device Module),
AEC/降噪/自动增益也是它自带的。

完整的取舍过程、以及三个版本坑(prost 版本错配、TLS 特性、tokio runtime panic)
都记在 **[docs/DECISIONS.md](docs/DECISIONS.md)** —— 那几个坑都很隐蔽,
改依赖或升级 SDK 之前建议先读一遍。

---

## 代码结构

```
src/                     前端:只负责界面,不碰音频
  main.ts                收集表单 → invoke → 按快照重画
  styles.css
index.html
src-tauri/src/
  lib.rs                 Tauri 命令、配置读写、token 签发入口
  token.rs               本地签发 HS256 JWT(带 RFC 7515 标准向量测试)
  store.rs               配置持久化(0600)
  voice.rs               ★ 语音会话:连接、ADM 采集/播放、事件推送
docs/DECISIONS.md        关键技术决定与踩坑记录
docs/WINDOWS.md          Windows 构建、适配点与真机验证清单
livekit/                 自建 LiveKit SFU 的部署资料与 e2e 测试工具
.github/workflows/       CI：Windows 构建（windows-latest）
```

前端与 Rust 的接口:

| 命令 | 作用 |
| --- | --- |
| `load_settings` / `save_settings` | 读写配置 |
| `mint_token` | 只签发 token(调试用) |
| `voice_join` / `voice_leave` | 进/出房间(join 内部先本地签 token) |
| `voice_set_mic` / `voice_set_deafened` | 静音 / 闭麦 |
| `voice_set_participant_volume` | 调整并记住某位参与者的本地播放音量 |
| `voice_send_chat` | 发文字消息 |
| `voice_devices` / `voice_set_device` | 枚举 / 切换设备 |
| `voice_snapshot` | 拉当前状态(界面重载后恢复用) |

Rust → 前端的事件:`voice://snapshot`(全量状态)、`voice://chat`、
`voice://notice`(提示/重连/断开)、`voice://closed`。

状态同步刻意用**全量快照**而不是增量事件:参与者数量少,全量重画的开销可忽略,
但少了一整类"增量合并写错导致界面与实际不一致"的 bug。

---

## 自测

单元测试(token 签发、配置持久化):

```bash
cd src-tauri && cargo test
```

端到端验证用的工具在 `livekit/e2e/`(一个跑在 Chrome 里的订阅端,
统计真实收到的字节数)。典型流程:

```bash
# 1) 起本地 LiveKit(远程服务器不在线时也能测;密钥自动复用 credentials.env)
cd livekit/e2e && ./local-server.sh 7880

# 2) 起测试页服务
node server.mjs 8099

# 3) 用 Chrome 当订阅端(token 用 ../gen-token.mjs 生成)
TOKEN=$(node ../gen-token.mjs --room minvoice-e2e --identity chrome-sub --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
google-chrome --headless=new --disable-gpu \
  "http://127.0.0.1:8099/index.html?url=ws%3A%2F%2F127.0.0.1%3A7880&token=${TOKEN}&role=subscribe"

# 4) 起 MinVoice,界面上把服务器地址填 ws://127.0.0.1:7880
./src-tauri/target/debug/minvoice

# 5) 看结果:livekit/e2e/results/subscribe.json
#    subscribed.kind == "audio" 且 media.receiverStats.bytesReceived 持续增长
#    chatReceived 里有从 minvoice-rust 发来的消息
```

MinVoice 会把关键状态打到 stdout(`[cmd]` / `[voice]` / `[ui]` 前缀)。
排查音频问题时这是最直接的出口 —— 音频失败大多是静默的。

---

## 已知限制

- **运行时只在 Linux 实机验证过**。Windows 已具备完整构建链路(CI 出安装包、
  可本机打包),适配点与真机验证清单见 **[docs/WINDOWS.md](docs/WINDOWS.md)**;
  macOS 未做任何验证。
- 超过 100% 的逐人音量是本地增益，原始声音过大时可能失真。
- **无备案域名在国内云厂商会被 SNI 拦截**：80/443 被按 TLS SNI 拦截,
  可通过非 443 端口(如 `7443`)绕过。完整证据链与修复方案见 **[docs/HANDOVER.md](docs/HANDOVER.md)**。
- 打包体积大(debug 375 MB):libwebrtc 是静态链接进去的,release 开 LTO
  会小很多,但依然是这个量级。

---

## 交接

接手的人请看 **[docs/HANDOVER.md](docs/HANDOVER.md)**:代码地图、接口清单、
五个必踩的坑、验证现状(哪些测过 / 哪些没测)、以及服务器故障的完整定位过程。

---

## 许可证

[MIT](LICENSE)
