# MinVoice 交接文档

> **2026-09-24 修复更新**：远程服务已通过新增 `7443` TLS 信令端口恢复
> （原 443 因备案拦截不可用，根因见第 10 节）。
> 两个不同网络出口验证 HTTPS 200、无效 token 401；`livekit/check.sh` 10 项通过。
> 真实 Tauri 桌面端发布麦克风，Chrome 订阅端 40 秒内音频累计从 16,265 B 增长至
> 113,275 B，ICE/DTLS connected，UDP/srflx，RTT 33–63 ms。尚未人工试听。
> 客户端与部署/检查脚本均已同步到新端口 7443。
> 服务器原配置已在改动前备份；续期脚本新增 EXIT 恢复 Caddy，避免续期报错留下服务停止。
> HTTP-01 公网验证及
> 自动续期能否成功尚未实测，现证书到期日为 2026-12-22。
> 下文第 10 节为修复前的排障记录。


> **2026-09-26 Windows 适配更新**：代码已入 git 仓库（MIT 开源，远程 `AliyahZombie/MinVoice`）。
> 新增 `.github/workflows/windows.yml`：windows-latest 上构建 NSIS/MSI 安装器与便携版 exe，
> 推 `v*` tag 自动创建 Release。Windows 构建**不需要** clang/cmake —— libwebrtc 用官方
> win-x64 预编译库，C++ 桥接层由 MSVC 编译。`tauri.conf.json` 增加 Windows 打包配置
> （NSIS 安装器带简体中文/English 语言选择）。Rust 代码无功能改动（`store.rs` 测试数据已脱敏）。
> 适配细节与真机验证清单见 **[docs/WINDOWS.md](WINDOWS.md)**。


写给接手的人。读完这份 + `docs/DECISIONS.md`,应该能独立改代码、跑测试、
定位线上问题。**第 7 节(五个坑)和第 10 节(服务器故障)是最要紧的两节。**

- 最后更新:2026-09-26
- 代码位置:`/home/aliyah/tmp/MinVoice`(git 仓库;开源:github.com/AliyahZombie/MinVoice)
- 技术栈:Tauri v2 + 原生 Rust 音频栈 + LiveKit

---

## 1. 一句话说清这是什么

一个多人语音聊天桌面客户端。用户在界面上填 **LiveKit 服务器地址 + API Key +
API Secret**,点进房间就能说话。

和常见做法的两个关键差异:

1. **Access Token 在本机签发**,不请求远程鉴权服务。API Secret 只在 Rust 进程里
   用,永远不进前端 JS。
2. **音频链路完全在 Rust 里**(livekit Rust SDK + libwebrtc 的 ADM),
   WebView 只负责画界面。

第 2 点是**被迫**的,原因见下节 —— 这是理解整个代码结构的前提。

---

## 2. 为什么音频不放前端(最重要的架构约束)

最自然的写法是「Tauri 壳 + 前端 `livekit-client`」。**这条路在 Linux 上走不通:**

> Tauri 在 Linux 用 WebKitGTK 渲染,而 **WebKitGTK 没有实现 `RTCPeerConnection`**。

实测结论:

- `typeof RTCPeerConnection === 'undefined'`,即使显式打开
  `set_enable_webrtc(true)` + `set_enable_media_stream(true)`、页面跑在安全上下文
  `http://127.0.0.1` 上也一样。
- `getUserMedia` 是**好的**(麦克风能拿到),但拿不到连接对象,发不出去。
- 外部佐证:[wry#85](https://github.com/tauri-apps/wry/issues/85)、
  [tauri#8426](https://github.com/orgs/tauri-apps/discussions/8426)。

所以选了 **B 方案:纯 Rust 音频栈**。代价是构建要编 libwebrtc(慢、需要 clang),
收益是不依赖 WebView 的 WebRTC 实现,Windows/macOS 上同一套代码也能跑。

> 如果将来要换回前端 SDK:Windows(WebView2)和 macOS(WKWebView)其实有
> WebRTC,可以只在 Linux 走 Rust 路径。但当前没这么做,保持单一实现。

---

## 3. 代码地图

```
src/                        前端 —— 只画界面,不碰音频、不发网络请求
  main.ts          617 行    收表单 → invoke → 按快照重画
  styles.css       659 行
index.html         198 行
src-tauri/src/
  lib.rs           277 行    Tauri 命令、配置读写、URL 规整、token 签发入口
  voice.rs         528 行    ★ 语音会话核心:连接/采集/播放/事件推送
  token.rs         289 行    本地签发 HS256 JWT(含 RFC 7515 标准向量测试)
  store.rs         210 行    配置持久化(目录 0700 / 文件 0600)
  main.rs            6 行    入口
docs/
  DECISIONS.md               技术决定与踩坑的详细版(本文件是索引,那是正文)
  HANDOVER.md                本文件
livekit/                     自建 SFU 的部署资料 + e2e 测试工具
```

**`voice.rs` 是全部复杂度所在**,其他文件都是薄壳。

---

## 4. 对外接口

### 4.1 Tauri 命令(`lib.rs` 注册)

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `load_settings` / `save_settings` | 读写配置 | 文件 0600 |
| `mint_token` | 只签发 token | 调试用,主流程不走它 |
| `voice_join` | 进房间 | **内部先本地签 token**,前端传的是 URL/Key/Secret/房间/身份 |
| `voice_leave` | 出房间 | 幂等 |
| `voice_set_mic` | 静音开关 | |
| `voice_set_deafened` | 闭麦开关 | |
| `voice_send_chat` | 发文字消息 | |
| `voice_devices` | 枚举设备 | |
| `voice_set_device` | 切换输入/输出设备 | |
| `voice_snapshot` | 拉当前状态 | 界面重载后恢复用 |

### 4.2 Rust → 前端事件

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `voice://snapshot` | `Snapshot` | **全量状态**,每次 `RoomEvent` 都推一遍 |
| `voice://chat` | `{identity, name, text, at}` | 收到远端文字消息 |
| `voice://notice` | 字符串 | 提示/重连/断开 |
| `voice://closed` | — | 会话结束 |

**状态同步刻意用全量快照,不用增量事件。** 参与者数量少,全量重画的开销可忽略,
但少了一整类「增量合并写错导致界面与实际不一致」的 bug。别改成增量,除非有实测
的性能问题。

### 4.3 前端状态

界面上的东西**全部**来自 `Snapshot`:

```rust
Snapshot { connection, room, identity, participants[], micEnabled, deafened }
```

前端不做任何本地状态推测 —— 唯一例外是聊天消息的乐观显示。

---

## 5. 关键实现细节

### 5.1 token 本地签发(`token.rs`)

- HS256 JWT,claims 用 **camelCase**(`video.roomJoin` 等),`kind: "standard"`。
- `parse_ttl` 支持 `6h` / `30m` / `7d` / 纯秒数,空字符串默认 21600。
- 有 RFC 7515 标准向量的已知答案测试,改签名逻辑前先跑它。

### 5.2 麦克风采集(`voice.rs::join`)

顺序**不能变**:

```
PlatformAudio::new()                    // 内部会 set_adm_playout_enabled(true)
  → configure_audio_processing(...)     // AEC / 降噪 / 自动增益
  → (可选) switch_recording_device(...)
  → start_recording()                   // ★ 必须显式调用
  → create_audio_track("microphone", audio.rtc_source())
  → publish_track(..., TrackSource::Microphone, dtx, red)
```

**`start_recording()` 是必须的。** ADM 采集不调用它,轨道照样发布成功、
不报任何错,但发出去的是**纯静音**。这个坑排查起来很痛苦(一切"看起来正常")。

### 5.3 扬声器播放

`PlatformAudio::new()` 内部会 `runtime.set_adm_playout_enabled(true)`,
**远端音频自动播到扬声器**,不需要逐轨挂 sink。所以代码里没有播放部分 ——
不是漏了。

### 5.4 静音 / 闭麦

- **静音**:对本地 `LocalTrackPublication` 调 `mute()` / `unmute()`。
- **闭麦**:对**所有远端音频轨道**调 `RemoteTrackPublication::set_subscribed(!deafened)`。

SDK **没有**全局播放音量、也没有逐人音量 —— 所以「单独调小某个人」做不到,
闭麦是目前唯一的替代。前端 CSS 里残留的 `.volume` 类是无用的,可以删。

### 5.5 URL 规整

`normalize_url()`:裸主机名/`https` → `wss://`,`http` → `ws://`,去掉尾部 `/`。
用户随便填个域名也能连。

---

## 6. 依赖版本(不要随手升级)

```toml
tauri = { version = "2", features = [] }
tokio = { version = "1", features = ["rt-multi-thread","macros","sync","time"] }
livekit             = { version = "=0.9.1", features = ["rustls-tls-native-roots"] }
livekit-signaling   = "=0.1.2"
livekit-data-stream = "=0.1.5"
```

**三个等号是故意的**,原因见第 7.1 节。另外:

- `rustls-tls-native-roots` **必须保留** —— `native` 特性不含 TLS,去掉它 `wss://`
  直接连不上。
- `lto = true, codegen-units = 1, panic = "abort", strip = true` 在 release profile
  里,别关(debug 二进制 375 MB,libwebrtc 静态链进去了)。

---

## 7. 五个坑(改代码前必读)

### 7.1 升级 livekit 会直接编不过 —— prost 版本错配

`livekit 0.9.2` 会拉 `livekit-signaling 0.1.3`(**prost 0.14**),而
`livekit-protocol` 至今只用 **prost 0.12**,两边生成的 protobuf 类型不实现对方的
`Message` trait,报 5 个 `E0599`(`no method named encode_to_vec` 之类)。

`0.9.1` 的约束是 `^0.1.2`,允许把 signaling 锁回 `0.1.2`;`0.9.2` 的 `^0.1.3` 不行。
所以 **`=0.9.1` + `=0.1.2` + `=0.1.5` 三个锁必须同时存在**。

升级前先确认上游是否已统一 prost 版本。

### 7.2 同步命令跑在 GTK 主线程 —— 会把整个进程 abort

**最阴的一个坑。** 症状:连上房间、音频正常,**过一会儿窗口自己没了**,退出码 0。

```
thread 'main' panicked at livekit-0.9.1/src/room/participant/mod.rs:459:21:
there is no reactor running, must be called from the context of a Tokio 1.x runtime
thread caused non-unwinding panic. aborting.
```

原因:SDK 的 `add_publication()` 会注册 `on_muted` 回调,回调体里直接
`tokio::spawn`。而 Tauri 的**同步**命令在 GTK 主线程执行,主线程没有 tokio reactor。
panic 发生在 GTK 的 FFI 回调里无法 unwind → **直接 abort 整个进程**。

修法:**每个进 SDK 的入口第一行先铺好 runtime 上下文**:

```rust
fn enter(&self) -> tokio::runtime::EnterGuard<'_> { self.rt.enter() }

pub fn set_mic(&self, ...) -> Result<(), String> {
    let _rt = self.enter();   // 别忘了
    ...
}
```

`voice.rs` 里 **`join` / `leave` / `set_mic` / `set_deafened` / `send_chat` /
`devices` / `set_device` / `snapshot` 每个方法都有这一行**。新加方法务必照做。

> 教训:接任何自带异步运行时的原生库,先问「它会不会从我的线程回调里 spawn?」
> 如果是,从非 runtime 线程调用它就是定时炸弹,而且炸的是整个进程。

### 7.3 `Room` 不是 `Clone`,选项结构体是 `#[non_exhaustive]`

- `Room` 不能克隆 → 事件任务里不要捕获它,`leave` 里借 `session.room`。
- `RoomOptions` 等不能用结构体字面量构造,用 `..Default::default()`。
- `ConnectionState` 只有 `Disconnected | Connected | Reconnecting`,**没有
  `Connecting`**。
- `TrackPublishOptions` 在 `livekit::options::TrackPublishOptions`。

### 7.4 ADM 采集要显式 `start_recording()`

见 5.1。忘了它 = 静音发布,且无任何报错。

### 7.5 构建环境

`webrtc-sys` 需要 **clang(不是 gcc)** 和 cmake:

```bash
sudo apt-get install -y clang cmake libclang-dev \
  libwebkit2gtk-4.1-dev libasound2-dev
```

缺了会报 `clang++ is required to build webrtc-sys on Linux`。

---

## 8. 构建与运行

```bash
pnpm install
pnpm tauri dev                              # 开发
pnpm tauri build --debug --no-bundle        # 快速出二进制
./src-tauri/target/debug/minvoice
pnpm tauri build                            # 正式打包
```

### 配置路径

**`~/.config/com.aliyah.minvoice/settings.json`**(Tauri 的 identifier,不是产品名),
目录 0700、文件 0600。

> 踩过的坑:一开始写到了 `~/.config/minvoice/`,程序读不到,白折腾。
> 里面存着 API Secret,别同步到任何地方。

开发期如果该文件不存在,程序会尝试从 `livekit/credentials.env` 预填服务器凭据
(不存在则静默跳过)。

### 日志

关键状态打到 **stdout**,前缀 `[cmd]` / `[voice]` / `[ui]`。
排查音频问题**首先看它** —— 音频失败大多是静默的。

---

## 9. 验证现状

### 已验证(有证据)

| 项 | 证据 |
| --- | --- |
| token 本地签发 | `cargo test` 9/9,含 RFC 7515 标准向量 |
| 连接 + 推麦克风 | 服务端日志:`type=AUDIO source=MICROPHONE stream=microphone` |
| 对端真收到音频 | Chrome 订阅端累计 **100+ KB RTP**,`subscribed.kind=audio` |
| 文字聊天送达 | 订阅端 `chatReceived: {"from":"minvoice-rust"}` |
| 静音/闭麦/切设备 | 命令路径跑通,无 panic |
| 界面渲染 | 截图确认:房间名/已连接/人数/参与者卡片与角标 |
| 稳定性 | 修复 7.2 后连续运行 75s+ 无崩溃 |
| 构建 | `tsc --noEmit` 0 错,`cargo test` 全过,`tauri build --no-bundle` 成功 |

### 未验证(交接时要知道)

- **「真的能听见声音」没有直接验证** —— 开发环境没有音频输出设备,
  字节数是间接证据。**请在有声卡的机器上实测一次。**
- **闭麦是否真的让音量归零** —— 用的是 SDK 的 `set_subscribed(false)`,
  机制正确,但「音量确实为 0」没法在当前环境测量。
- **运行时只在 Linux 验证过**;Windows 已有完整构建链路(CI 出安装包、可本机打包,
  见 docs/WINDOWS.md),但未在 Windows 真机运行验证;macOS 未测。
- **多对多(3 人以上)未测**,只测了 1 对 1。

### 怎么复现端到端测试

远程 SFU 当前不可用(见第 10 节),所以本地起一个:

```bash
cd livekit/e2e
./local-server.sh 7880          # 起本地 LiveKit,密钥复用 ../credentials.env
node server.mjs 8099            # 起测试页服务
```

然后用 Chrome 当订阅端(`../gen-token.mjs` 签 token):

```bash
TOKEN=$(node ../gen-token.mjs --room minvoice-e2e --identity chrome-sub --json \
        | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
google-chrome --headless=new --disable-gpu \
  "http://127.0.0.1:8099/index.html?url=ws%3A%2F%2F127.0.0.1%3A7880&token=${TOKEN}&role=subscribe"
```

再起 MinVoice,把服务器地址填 `ws://127.0.0.1:7880`。结果看
`livekit/e2e/results/subscribe.json`:

- `subscribed.kind == "audio"` 且 `media.receiverStats.bytesReceived` 持续增长
- `chatReceived` 里有从 `minvoice-rust` 发来的消息

---

## 10. 排障记录:远程服务器连不上(已定位)

### 结论(已证实)

**根因:国内云厂商对未备案域名的 SNI 拦截。**

域名没有 ICP 备案,云厂商在**边缘设备**上检查 TLS ClientHello 里的 **SNI**,
命中未备案域名就直接把连接掐掉 —— 包**根本进不了这台机器**。
80 / 443 这两个端口受此策略管辖,其他端口不受影响。

**服务器本身完全健康,不是 livekit、caddy 或代码的问题。**
域名当时的 DNS 记录是**直连源站 IP**(未挂 CDN 代理,即所谓“灰云”),
没有代理层可以吸收这种边缘拦截,所以策略直接生效。

### 决定性证据:SNI 对照实验

同一 IP、同一端口(:443),**只换 SNI**,同时在服务器上 tcpdump:

| SNI | 到达服务器的包数 | 其中 RST |
| --- | --- | --- |
| 未备案域名(真实站点) | **0** | 0 |
| 已备案的对照域名 | **10** | 4 |

未备案那个:TCP 三次握手看着能完成,但**服务器一个包都没收到**,
客户端侧却收到中途注入的 RST(seq 1413,典型伪造 RST)。
已备案那个:包正常到达 caddy,caddy 因为「没有该域名的证书」回了
`tlsv1 alert internal error` —— 这反过来证明**链路本身是通的,只有未备案域名被拦**。

### 完整证据链

| 检查项 | 结果 |
| --- | --- |
| SSH 登录源站 | ✅ 正常,uptime **150 天** |
| 容器状态 | ✅ `livekit-caddy`(13h)、`livekit-server`(16h)都在跑 |
| caddy 本机 `127.0.0.1:443` 握手 | ✅ 成功,有效 Let's Encrypt 证书(9/23–12/22) |
| 权威 DNS(`1.1.1.1` DoH) | ✅ 域名解析正确,指向源站公网 IP |
| 云平台元数据 | ✅ `public-ipv4` 与实际公网 IP 一致,EIP 绑定正确 |
| 源站本机监听 | ✅ caddy `*:443`,livekit `127.0.0.1:7880` + `*:7881` |
| 海外节点 → 443 | ❌ TCP 可连,TLS 被 reset |
| 海外节点 → 非标 SSH 端口 / 7881 | ✅ 通(不受备案策略管辖) |
| 海外节点 → 80 | ❌ 不通(同受管辖) |
| **SNI 对照实验** | ❌/✅ 见上表 —— **根因确认** |

### 修复方案(优先级从高到低)

**方案 1:换端口绕过(最快,当天可上线)**

备案策略只管 80/443。把 caddy 挪到别的端口即可:

```caddyfile
https://voice.example.com:7443 {
    tls /etc/letsencrypt/live/voice.example.com/fullchain.pem \
        /etc/letsencrypt/live/voice.example.com/privkey.pem
    encode zstd gzip
    reverse_proxy 127.0.0.1:7880
}
```

然后在**云平台安全组放行 7443**(UDP 也要),客户端地址填
`wss://<你的域名>:7443`。

- MinVoice 的 `normalize_url()` 已经支持带端口,不用改代码。
- ⚠️ 端口别选 8443/8080 之类,有些云厂商把这些也纳入管辖,**7443 这种高位端口更稳**。
- ⚠️ 媒体流用的 UDP 端口段也要一起在安全组放行。

**方案 2:正经备案**

在云平台提交 ICP 备案,拿号后 80/443 自动放行。周期通常 1–3 周,需要域名实名
+ 国内服务器。这是唯一"干净"的长期方案。

**方案 3:换到海外服务器**

换到海外服务器:不受备案限制,443 直接可用。
代价是**国内访问延迟高**,语音体验会明显变差。

**方案 4:Cloudflare 橙云 + 非 443 源站端口**

把 DNS 记录改成**代理模式**(橙云),由 Cloudflare 终结 TLS;
回源走 Cloudflare 支持的 HTTPS 源站端口(8443 / 2096 / 2087 / 2083 / 2053),
源站侧避开 443,就不会触发备案检查。

- Cloudflare 免费版能代理 WSS(WebSocket 信令),信令这条路可行。
- ❌ **但 LiveKit 的媒体流走 UDP,免费版 Cloudflare 不代理 UDP**,
  TURN/UDP 的媒体转发需要另外解决(Or an Enterprise Spectrum)。
- 所以橙云能救信令,救不了媒体,单独用不完整。

### 修好之后

按第 9 节末尾的流程重跑端到端验证,确认三件事:
`bytesReceived` 持续增长、`chatReceived` 收到消息、界面人数正确。

### 排查时用到的命令(可复用)

```bash
# 权威解析(绕开本地 DNS 污染)
curl -sS -H 'accept: application/dns-json' \
  'https://1.1.1.1/dns-query?name=<你的域名>&type=A'


# 服务器上抓包,同时从别处连接 —— 判断包有没有到
ssh -F .sshcfg/config <主机别名> 'timeout 18 tcpdump -i any -n -c 30 "tcp port 443"'
```

---

## 11. 环境注意事项(在这台开发机上)

- **本机 DNS 被污染**:该域名在本机解析出一个**错误的 IP**(与权威解析不一致)。
  测服务器时**用 DoH 或 `--resolve` 指定真实 IP**,
  否则结论会被带偏 —— 我一开始就被这个误导了。
- **本机挂了代理**:`HTTP(S)_PROXY=http://127.0.0.1:3067`。
  测连通性时加 `--noproxy '*'` 排除干扰。
- **GUI 自动化**:只有在 `GDK_BACKEND=x11` 启动下 `xdotool` 才好用;
  但注意 `--window` 参数走 XSendEvent,WebKit 不认,得用 XTEST(不带 `--window`)。
  Wayland 下窗口会被 WM 挪位置,**先激活窗口再读坐标**,顺序反了会点空。
  另外 `pkill -f <模式>` 会匹配到你自己的命令行 —— 用 `pkill -x` 或括号技巧
  `[l]ivekit`。
- 后台起服务记得用 `nohup ... &`,并且**收尾时确认端口真的关了**
  (`curl` 或 `ss`),`kill` 未必一次就停。

---

## 12. 遗留 TODO

- [ ] 在有声卡的机器上实测「能否听见声音」和「闭麦是否静音」
- [ ] 修好 443 后重跑端到端验证(见第 10 节)
- [ ] 3 人以上多对多测试
- [ ] Windows 真机运行验证（构建链路已就绪：CI + 本机打包，见 docs/WINDOWS.md 第 5 节）
- [ ] macOS 构建与运行验证
- [ ] 删掉 `styles.css` 里无用的 `.volume` 类
- [ ] `livekit-client` 已从 `package.json` 移除,确认 `pnpm-lock.yaml` 里也干净
- [ ] 调试用的 `[cmd]` 日志比较吵,可以考虑加个日志级别开关
