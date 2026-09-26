# Windows 构建与适配说明

> 状态（2026-09-26）：**构建链路已就绪** —— GitHub Actions（windows-latest）
> 可以产出 NSIS/MSI 安装器与便携版 exe。**运行时尚未在 Windows 真机验证**，
> 验证清单一节列出了需要人工确认的项目。

---

## 1. 为什么 Windows 构建不难（和 Linux 的差别）

Windows 打包**不需要从源码编译 libwebrtc**，也不需要 clang/cmake：

- livekit 官方为各平台发布**预编译 libwebrtc 静态库**（tag `webrtc-89d790b`），
  win-x64 对应 `webrtc-win-x64-release.zip`；`webrtc-sys` 的构建脚本会自动下载
  （缓存在 `src-tauri/target/*/build/scratch-*/out/livekit_webrtc/`）。
- C++ 桥接层用 MSVC 编译（`/std:c++20 /EHsc`），链接一批标准 Windows 系统库
  （`ws2_32`、`secur32`、`d3d11`、`dxgi` 等）。
- 反而 Linux 上更麻烦：libwebrtc.a 用 Chromium 的 hermetic libc++ 编译，
  桥接层必须用 **clang++**（gcc 会因 `trivial_abi` 被静默忽略而破坏调用约定）。
  细节见 `webrtc-sys` 构建脚本里的注释。

**运行库必须一致**：官方 libwebrtc 使用 MSVC 静态运行库（`/MT`），
Rust 默认使用动态运行库（`/MD`），混用会在 `cargo test` 链接阶段出现
`LNK2038 RuntimeLibrary: MT_StaticRelease / MD_DynamicRelease` 和 `LNK2005`。
仓库根目录的 `.cargo/config.toml` 为 Windows MSVC 目标启用 `+crt-static`，
让 Rust 和 `cc` 编译的 C++ 桥接层统一使用静态运行库。
此设置同时覆盖本地开发、测试、debug 和 release；Linux/macOS 不受影响。
请从仓库根目录或 `src-tauri` 内运行构建，以便 Cargo 读取配置。

所以 Windows 的适配包括：**运行库配置、打包配置、CI 工作流、真机验证清单**。
Rust 代码本身没有平台分支需要新增（已有的跨平台处理见第 4 节）。

---

## 2. 本机构建（Windows 开发机）

前置要求：

| 依赖 | 说明 |
| --- | --- |
| Windows 10/11 x64 | 应用输出为 x64 |
| Visual Studio Build Tools 2022 | 需要 “使用 C++ 的桌面开发” 工作负载 + Windows SDK |
| Rust（stable，MSVC 工具链） | rustup 默认安装即是 |
| Node 22.12+ 与 pnpm 11 | CI 使用 Node 22、pnpm 11.20.0（lockfileVersion 9.0） |
| WebView2 Runtime | Win11 自带；Win10 一般随 Edge 已安装，安装器也会兜底 |

命令（与 Linux 相同）：

```powershell
pnpm install
pnpm tauri build                        # 正式打包：安装器 + MSI
pnpm tauri build --debug --no-bundle    # 快速验证：只出 exe（带控制台，方便看日志）
```

产物位置：

| 产物 | 路径 |
| --- | --- |
| NSIS 安装器（推荐） | `src-tauri/target/release/bundle/nsis/MinVoice_<版本>_x64-setup.exe` |
| MSI | `src-tauri/target/release/bundle/msi/MinVoice_<版本>_x64_en-US.msi` |
| 便携版 exe | `src-tauri/target/release/minvoice.exe` |

说明：

- NSIS 安装器带**简体中文/English 语言选择**；默认按当前用户安装（不需要管理员）。
- MSI 语言为默认的 en-US（如需中文可改 `tauri.conf.json` 的 `bundle.windows.wix`）。
- 首次构建较慢（下载 libwebrtc + 编译数百个 crate + LTO 链接），属正常现象；
  后续构建会复用缓存。

---

## 3. CI 构建（GitHub Actions）

工作流：`.github/workflows/windows.yml`，运行于 `windows-latest`。

| 触发方式 | 行为 |
| --- | --- |
| Actions 页面 → windows-build → Run workflow | 构建安装器并上传产物；勾选 `debug` 则只出调试版 exe（快得多） |
| 推送 `v*` tag | 构建 + 上传产物 + 自动创建 GitHub Release，附安装包与 `SHA256SUMS.txt` |
| 推送到 `main`（且改动构建相关路径） | 构建并上传产物（不创建 Release） |

在哪里拿产物：

- **产物（Artifacts）**：对应 workflow run 页面底部 “Artifacts” 区域，
  下载 `minvoice-windows-x64-release`（或 `-debug`）压缩包。
- **Release**：推 tag 后自动生成，安装包直接挂在附件里。

工作流里做了这几件事（按顺序）：

1. 检出代码；开启 Windows 长路径支持（libwebrtc 解压路径较深，保险步骤）
2. 安装 pnpm 11 / Node 22 / Rust stable（MSVC）；缓存 Rust 构建目录
3. `pnpm install --frozen-lockfile` → `pnpm build`（tsc + vite）→ `cargo test --locked`
4. `pnpm tauri build --ci -- --locked`（release：NSIS + MSI）或调试构建；锁定 Rust 依赖
5. 整理产物：安装器、MSI、便携版 exe、`SHA256SUMS.txt`
6. 上传 Artifacts；若为 `v*` tag 则创建 Release

首次运行大约需要数十分钟；缓存的 key 里包含已下载的 libwebrtc，后续会明显加快。

---

## 4. 代码里的跨平台适配点

| 位置 | 处理方式 |
| --- | --- |
| `.cargo/config.toml` | Windows MSVC 统一使用静态 CRT，避免 libwebrtc 与 Rust/C++ 桥接层的运行库链接冲突 |
| `src-tauri/src/store.rs` | 配置目录 0700 / 文件 0600 的权限收紧只在 Unix 生效（`#[cfg(unix)]`）；Windows 依赖用户目录 ACL。配置路径由 Tauri 决定：Windows 上是 `%APPDATA%\com.aliyah.minvoice\settings.json` |
| `src-tauri/src/main.rs` | release 构建带 `windows_subsystem = "windows"`，不会弹出控制台窗口 |
| `src-tauri/src/voice.rs` | 音频走 libwebrtc ADM：Linux 用 ALSA、Windows 用 WASAPI，同一套 Rust API；`enter()` 线程守卫在 Windows 同样必要（Tauri 同步命令跑在主线程，SDK 回调里 `tokio::spawn` 需要 runtime 上下文） |
| `src-tauri/tauri.conf.json` | `bundle.windows.nsis`：安装器带语言选择（简体中文/English）；WebView2 采用默认 downloadBootstrapper 策略 |
| `.gitattributes` | 仓库内统一 LF；`*.bat / *.cmd` 保留 CRLF |

---

## 5. 真机验证清单（待做）

拿到安装包后，在 Windows 上逐项确认（当前 **没有任何一项** 在 Windows 上实测过）：

1. [ ] 运行 NSIS 安装器（选简体中文）→ 正常启动、无控制台窗口
2. [ ] 设置页填入自建 LiveKit 服务器地址 + API Key/Secret → 加入房间
3. [ ] 麦克风采集：Windows 设置 → 隐私和安全性 → 麦克风 → 允许“桌面应用”
4. [ ] **能听见声音**（扬声器/耳机）—— 这是 Linux 上也只能用字节数间接验证、
       必须真人试听的一项
5. [ ] 静音 / 闭麦 / 切换输入输出设备
6. [ ] 重启应用：配置仍在（`%APPDATA%\com.aliyah.minvoice\settings.json`）
7. [ ] 防火墙弹窗（首次 UDP 出站）选择“允许”
8. [ ] 双人互通（Windows ↔ Linux），再测 3 人以上多对多

排查提示：

- release 版没有控制台。排查请用 `pnpm tauri build --debug --no-bundle`
  产出的 exe，stdout 里有 `[cmd]` / `[voice]` / `[ui]` 前缀日志。
- 没声音时依次检查：系统音量合成器里 MinVoice 是否被静音 →
  输出设备是否正确 → 设备是否被其它程序独占（声音设置 → 设备属性 → 高级）。
- 连不上时：先 `node livekit/gen-token.mjs` 手签一个 token 排除凭据问题，
  再看 `[voice]` 日志里的连接与断开原因。
