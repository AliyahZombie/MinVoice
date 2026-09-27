# MinVoice PWA

## 使用

- 入口： https://voice.aliyahzombie.top
- 在设置中填写已有的 LiveKit WSS 地址、API Key、API Secret；无需前端和 SFU 同域。
- 首次加入会请求麦克风权限。拒绝时仍可加入收听，授权后点击麦克风重试。
- 支持文字聊天、逐人 0–200% 音量、静音、停止收听与设备切换。
- 不支持输出设备切换的浏览器需在系统设置中选择输出设备。
- 浏览器菜单可安装 PWA；iOS Safari 使用“分享 → 添加到主屏幕”。
- 离线只缓存应用界面，不缓存语音、聊天记录、服务器响应或凭据。
- 手机后台、锁屏与自动播放限制由系统和浏览器决定，PWA 不保证锁屏持续通话。

API Secret 由用户自行填写，仅存在 sessionStorage，用 Web Crypto 签发房间 JWT。
密钥不写入 localStorage，不上传前端网站，不嵌入构建文件。刷新当前标签页可保留，
关闭会话后通常清除，但浏览器的“恢复会话”可能恢复 sessionStorage。
网页版不能提供桌面 Rust 进程的密钥隔离；请仅在可信设备和可信网站上填写密钥。

## 发布

```bash
pnpm install --frozen-lockfile
pnpm deploy:pwa
```

脚本固定使用 SSH 别名 us2，站点域名固定为 voice.aliyahzombie.top。
仅上传 dist 静态资源。保留独立 releases 目录，原子切换 current 软链接，
备份 Nginx 配置，校验配置通过后平滑 reload；源站检查失败会自动恢复旧配置和发布版本。
不修改 DNS、sing-box 或机器上已有的 443 监听服务。

公网 HTTPS 复用已有 Cloudflare 入口，沿用当前 Cloudflare 到 NPM 的 HTTP 回源方式。
此域名依赖 Cloudflare 代理，不能直接关闭代理改成 DNS-only 而期待同样的 HTTPS 入口。

服务器路径：

- 静态发布：/srv/us1-migrate/NPM/data/minvoice/releases/
- 当前版本：/srv/us1-migrate/NPM/data/minvoice/current
- 配置备份：/srv/us1-migrate/NPM/data/minvoice/backups/
- 站点配置：/srv/us1-migrate/NPM/data/nginx/custom/minvoice.conf
- 引入位置：/srv/us1-migrate/NPM/data/nginx/custom/http.conf
- Web 服务：现有 nginx-proxy-manager 容器

回滚静态文件：在服务器将 current 软链接原子切换到上一 releases 子目录；
备份中的 previous-release 记录该次发布前的目标。静态文件切换不需要重启容器。
回滚 Nginx 配置时仅恢复本次修改，运行 nginx -t 后再 nginx -s reload，避免覆盖后续其他站点的修改。
已经打开的 PWA 可以继续使用缓存版本；发现版本更新后，离开房间再点击页面“更新”。

## 验证

```bash
pnpm build
pnpm test:web
# 加载本机受保护的 LiveKit 凭据，运行真实双浏览器语音检查：
set -a; source livekit/credentials.env; set +a
pnpm test:web
# 在部署的域名上运行相同检查：
E2E_BASE_URL=https://voice.aliyahzombie.top pnpm test:web
```

默认使用 /usr/bin/google-chrome；其他位置可通过 CHROME_BIN 设置。
测试验证 JWT 的独立 HMAC 签名、安装清单、离线打开、会话密钥、移动端宽度、
双向音频实际接收字节、聊天、静音、音量记忆和离开后的 PeerConnection 释放。
没有 LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET 时，仅跳过真实 SFU 测试。
