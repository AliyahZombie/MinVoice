# 关键技术决定

这份文档记录 MinVoice 为什么长这样。几个决定看上去绕(尤其是"音频不用前端
SDK,而是在 Rust 里重写一遍"),但每一个都是被实测结果逼出来的。

---

## 1. 音频为什么在 Rust,而不是 WebView 里的 livekit-client

最初的做法是最自然的那个:Tauri 壳 + 前端 `livekit-client`。HTML/CSS 界面、
token 本地签发、麦克风权限都做完了,结果**连不上**。

### 现象

应用自检输出:

```
[ui] 自检: mediaDevices=有 · RTCPeerConnection=无 · 音频输入=1 · 采集 OK(Ryzen HD Audio Controller 模拟立体声)
```

`getUserMedia` 能拿到麦克风,但 `RTCPeerConnection` 是 `undefined`。

### 排查过程

Tauri 在 Linux 上用 **WebKitGTK** 渲染(wry 绑定),不是 Chromium。用 Python +
GTK/WebKit2 直接写了几个探针页面,绕开 Tauri 验证:

| 尝试 | 结果 |
| --- | --- |
| `settings.set_enable_webrtc(True)` | `typeof RTCPeerConnection === 'undefined'` |
| `set_enable_media_stream(True)` + `enable-webrtc` | 同上 |
| 通过 `WebView` 的 `get_settings()` 在建页面前就打开 | 同上 |
| 页面跑在安全上下文 `http://127.0.0.1` | 同上(排除"非安全上下文禁用"这一常见猜测) |
| 查 `get_all_features()` 找开关(共 486 项) | 只有 `RTCEncodedStreamsQuirk`、`GetUserMediaRequiresFocus`、`WebRTCAudioLatencyAdaptation`、`WebRTCMediaPipelineAdditionalLogging` 与 WebRTC 相关,没有可用开关 |

`libwebkit2gtk-4.1.so.0` 里确实有 `WebRTCProvider`、`WebRTCCodecs` 这些符号,
setter 也都存在,所以不是"库没编进去",而是**WebKitGTK 没把 RTCPeerConnection
暴露给网页**。WebKitGTK 官方至今把 WebRTC 列为未完成特性。

外部佐证:
- [wry issue #85](https://github.com/tauri-apps/wry/issues/85) —— 维护者明确说 Linux 上不支持 WebRTC,指向未来的 CEF 集成;
- [tauri discussion #8426](https://github.com/orgs/tauri-apps/discussions/8426)。

### 结论与取舍

三条路:

| 方案 | 评价 |
| --- | --- |
| A. Tauri 壳 + `google-chrome --app` 跑房间界面 | 能用,但客户端变成"壳 + 外部浏览器",不是纯 Tauri |
| B. **Rust 原生音频栈**(采用) | 纯 Tauri,CPU/内存最省,但要自己接 SDK |
| C. 继续用 livekit-client,只支持 Windows/macOS | Linux 上等于不可用,与需求冲突 |

选了 **B**。代价是音频链路的代码从"调 JS API"变成"自己管 runtime、设备、
推流、订阅",好处是彻底摆脱 WebView 的能力限制,而且 AEC/NS/AGC 由
libwebrtc 的 ADM 提供,效果比自己拼 cpal + Opus 好得多。

> 附带影响:`src-tauri/src/webkit_linux.rs`(给 WebKitGTK 打补丁开麦克风权限)
> 已经删掉了 —— WebView 不再需要麦克风,那些代码是死代码。

---

## 2. livekit Rust SDK 的版本必须锁死

`livekit = "0.9"` 直接装会**编译不过**。原因不是我们的代码,是官方发布的
crate 之间 protobuf 版本错配:

```
livekit 0.9.2
  └── livekit-signaling 0.1.3   →  prost 0.14
  └── livekit-protocol  0.7.13  →  prost 0.12
```

`livekit-protocol` 用 prost 0.12 生成 protobuf 类型,而 `livekit-signaling`
按 prost 0.14 的 `Message` trait 去调 `.encode_to_vec()` / `.decode()`。
两个 prost 大版本的类型 trait 不通用,于是报:

```
error[E0599]: no method named `encode_to_vec` found for struct `SignalRequest`
   --> livekit-signaling-0.1.3/src/signal_stream.rs:112:79
   = help: the trait `prost::Message` is implemented ... (prost-0.12.6)
```

查 crates.io sparse index 后确认:`livekit-protocol` **所有**已发布版本
(到 0.7.13)都只用 prost 0.12;`livekit-signaling` 从 0.1.3 起跳到 0.14。
即 0.1.3 是个坏版本。

**修复**:退回最后一个基于 prost 0.12 的组合,并在 `Cargo.toml` 里用 `=` 锁死
(用 `^` 会被 cargo 自动升到坏版本):

```toml
livekit = "=0.9.1"                  # 它的依赖是 signaling ^0.1.2,允许我们降级
livekit-signaling = "=0.1.2"
livekit-data-stream = "=0.1.5"      # 0.1.6 同样跳到 prost 0.14
```

`livekit 0.9.1` 的 `livekit-signaling = "^0.1.2"` 是这里的关键 —— 0.9.2 写的是
`^0.1.3`,已经被坏版本钉死了,降不下来。

---

## 3. 必须显式打开 TLS 特性

`livekit` 的默认特性是 `native`,但它**只带传输层,不带 TLS**:

```
native = ["livekit-signaling/native"]
native-tls = [...]            # 不默认开
rustls-tls-native-roots = [...]  # 不默认开
```

不显式打开,连 `wss://` 会失败。选了 `rustls-tls-native-roots`:纯 Rust 实现,
用系统根证书(Let's Encrypt 证书能正常校验),省掉 OpenSSL 链接。

---

## 4. iPhone 式的一点:ADM 采集必须显式 start

`PlatformAudio::new()` 会打开 ADM 并自动 `set_adm_playout_enabled(true)`,
所以**远端声音是自动从扬声器出来的**,不需要给每条远端轨道挂 sink —— 这一点
和 Web 端 SDK 的心智模型不同,值得记住。

但**采集**要显式 `start_recording()`。不调用的话:轨道能发布成功、服务端也
收得到、**没有任何报错**,只是推上去全是静音。这类"静默失败"最难查,所以
`voice.rs` 里那一步专门打了日志。

---

## 5. token 本地签发,但 Secret 不进 JS

需求是"本地分配 token",所以没有走官方推荐的"服务端签发"。实现在
`src-tauri/src/token.rs`,纯 `hmac` + `sha2` + `base64`,不引 SDK。

要点:
- 前端只通过 IPC 说"给我签一个",**API Secret 永远不进 JS 世界**(WebView 里
  任何注入/调试都能翻出内存字符串);
- 用 RFC 7515 Appendix A.1 的标准向量做回归测试,保证 base64url 无填充和
  HMAC-SHA256 的字节级行为正确;
- claim 用 camelCase(服务端解析的字段名),含 10 秒 `nbf` 余量防时钟偏移。

代价:Secret 存在本机,所以配置目录 `0700`、文件 `0600`。别把
`~/.config/minvoice` 同步到任何地方。

---

## 6. 前端只画界面

前端没有 WebRTC、没有音频、没有网络请求,只有:收集表单 → `invoke` →
按 Rust 推来的快照重画。状态同步用**全量快照**(`voice://snapshot`)而不是增量
事件:参与者数量很少,全量重画的开销可以忽略,但省掉了"增量合并写错导致
界面和实际不一致"这一整类 bug。

---

## 7. Tauri 同步命令跑在 GTK 主线程 —— 会直接把进程 abort 掉

这是本项目最难查的一个坑,单独记一节。

### 现象

应用连上房间、音频也正常流动,但**过一会儿整个进程无声无息地消失**,
退出码 0,像是被"正常关闭"了:

```
thread 'main' panicked at livekit-0.9.1/src/room/participant/mod.rs:459:21:
there is no reactor running, must be called from the context of a Tokio 1.x runtime
thread caused non-unwinding panic. aborting.
```

### 原因

`livekit` 的 `add_publication()` 会给每条轨道注册一个 `on_muted` 回调,回调体里
直接 `tokio::spawn` 去给服务端发 `MuteTrackRequest`。

而 Tauri 的**同步**命令(`fn`,不是 `async fn`)是在 **GTK 主线程**上执行的:

```
frame 19: webkit2gtk::...::register_uri_scheme::callback_func     ← 从 GTK 进 Rust
frame 20: ...std::rt::lang_start...
frame 37: g_main_context_iteration
frame 38: gtk_main_iteration_do
```

主线程没有 tokio reactor,`tokio::spawn` 于是 panic。更麻烦的是这个 panic 发生在
GTK 的 FFI 回调里,Rust 无法 unwind,**直接 abort 整个进程** —— 所以连正常的
panic 输出都差点被吞掉,只留下"进程没了"。

### 修复

凡是要踏进 SDK 的入口,先用 `Runtime::enter()` 把 tokio 上下文铺好:

```rust
fn enter(&self) -> tokio::runtime::EnterGuard<'_> {
    self.rt.enter()
}

pub fn set_mic(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
    let _rt = self.enter();   // 让 SDK 内部的 tokio::spawn 有 runtime 可用
    ...
}
```

`enter()` 只是设置线程本地的 runtime 句柄,不进入异步执行上下文,所以同一个
函数里继续用 `block_on` 也没问题。

### 教训

接入任何**自带异步运行时**的原生库时,先问一句:"这个库会不会从我的线程回调
里 spawn 任务?" 如果是,那么"从非 runtime 线程调用它"就是一颗定时炸弹 ——
而且炸的是整个进程,不是一次调用失败。
