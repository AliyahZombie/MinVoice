# 逐人本地音量

通话中，每位远端参与者卡片右上角都有音量滑块：0% 本地静音，100% 原声，
最高 200%；旁边的重置按钮恢复 100%。调整只影响自己的播放，不发送到服务端，
不改变对方的麦克风，也不影响房间里的其他听众。

按规范化的服务器地址与参与者 ID 保存到 Tauri 配置目录下的
`participant-volumes.json`，独立于服务器凭据。Windows 配置目录为
`%APPDATA%\com.aliyah.minvoice`，Linux 为 `~/.config/com.aliyah.minvoice`。
同一服务器的其他房间也沿用相同参与者的设置；不同服务器独立。
对方改变参与者 ID 后视为新用户，默认为 100%。

重连、重新订阅、对方重新发布音轨时会再次应用音量。全局停止收听仍通过退订
音轨实现，恢复收听后逐人音量不变。保存失败会恢复上次音量并显示错误。
超过 100% 是本地放大，可能让已经很响的输入失真。

## 原生播放链路

`voice_set_participant_volume` → 远端用户的所有音频轨 →
`RtcAudioTrack::set_playout_volume` → WebRTC signaling thread →
`AudioSourceInterface::SetVolume` → 原有混音器与 ADM 输出。

LiveKit 服务器无需修改。没有绕过原有的回声消除播放参考，也没有另建一套扬声器输出。
Rust SDK 的缺失接口由两份固定版本的本地依赖补齐；来源、许可证和修改文件列表见
[`src-tauri/vendor/README.md`](../src-tauri/vendor/README.md)。

前端按参与者 ID 保留卡片 DOM，频繁的说话状态快照不会销毁正在拖动的滑块。
请求节流并按用户串行发送，拖动期间保留最新目标值。

## 验证

2026-09-26 验证：本地 Rust 单元测试覆盖音量边界、不同服务器/用户隔离、
重复写入、重载与损坏数值回退；浏览器验证滑块焦点保留、快速连续调整、
重置、保存失败回退、重连禁用以及 560px 窗口布局。

真实音频测试在部署中的 LiveKit 上创建独立房间。两个 Rust 发布端分别发出
440 Hz 和 880 Hz 正弦波；接收端沿用 PlatformAudio/ADM 输出，录制 Linux
虚拟声卡 monitor 后，分别测量两个频率的振幅：

| A 设置 | B 设置 | A 实测比例 | B 实测比例 |
| --- | --- | --- | --- |
| 100% | 100% | 1.000 | 1.000 |
| 50% | 100% | 0.500 | 1.000 |
| 0% | 100% | 0.000 | 0.999 |
| 200% | 100% | 2.000 | 0.999 |
| 100% | 0% | 1.000 | 0.000 |
| 100% | 100% | 1.000 | 0.999 |

探针源码在 [`src-tauri/examples/volume_probe.rs`](../src-tauri/examples/volume_probe.rs)。
它只发布测试音，不采集麦克风；请使用独立测试房间，并选择虚拟播放设备录制。

```bash
CXX=clang++ cargo build --manifest-path src-tauri/Cargo.toml --example volume_probe --locked
export MINVOICE_TEST_CREDENTIALS="$PWD/livekit/credentials.env"
# 两个终端使用同一个独立房间名称：
src-tauri/target/debug/examples/volume_probe publish minvoice-volume-test-unique
src-tauri/target/debug/examples/volume_probe receive minvoice-volume-test-unique '<虚拟声卡名称>'
```

测试环境的 PulseAudio 设备 GUID 存在重复，SDK 选设备后仍可能输出到默认设备。
录音前需确认该探针进程的 sink input 已路由到测试虚拟声卡，可用
`pactl move-sink-input <探针的流ID> <测试虚拟声卡>` 显式指定。
不要改系统默认设备或移动其他应用的音频流。

Windows 使用同一原生绑定，由 Actions 验证 MSVC 编译和单元测试；
Windows 真人通话试听仍需按 [WINDOWS.md](WINDOWS.md) 的清单验收。
