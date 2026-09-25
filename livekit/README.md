# LiveKit 服务端（自建 SFU）

自建 LiveKit SFU(音视频房间服务器)的部署与运维资料。下面的域名/IP 均为示例占位,使用时替换成你自己的。
2026-09 部署,已通过真实浏览器端到端验证。

## 连接信息

| 项目 | 值 |
| --- | --- |
| 信令(浏览器/客户端) | `wss://voice.example.com:7443` |
| 信令(HTTP API) | `https://voice.example.com:7443` |
| API Key | 见 `credentials.env` 的 `LIVEKIT_API_KEY` |
| API Secret | 见 `credentials.env` 的 `LIVEKIT_API_SECRET` |
| 媒体端口 | UDP `50000-50200`(直连)、TCP `7881`(ICE/TCP 兜底) |
| 内置 TURN | UDP `3478`(兼作 STUN,服务端自动下发给客户端) |
| 服务版本 | livekit-server `1.13.7` |

**API Secret 等同root权限**:客户端 token 全由它签发,拿到即可进任意房间。
`credentials.env` / `credentials.json` 已设 `600`,别提交进 git、别下发到浏览器。

## 目录里有什么

| 文件 | 作用 |
| --- | --- |
| `credentials.env` | **密钥与环境变量**,给服务端 SDK `source` 用 |
| `credentials.json` | 同上,JSON 格式,给程序读 |
| `livekit-config.yaml` | 服务端配置快照(密钥已脱敏),排查用 |
| `deploy-remote.sh` | 部署脚本,在服务器上以 root 跑;幂等,重跑只重建容器 |
| `renew-cert.sh` | 证书续期(部署脚本会装到服务器的 `/etc/cron.d/`,不用手动跑) |
| `fetch-secrets.sh` | 把密钥/配置从服务器拉回本地 |
| `check.sh` | 体检:容器、证书、信令、鉴权、端口、续期通道 |
| `gen-token.mjs` | 签发客户端 / 管理员 token,零依赖纯 node |
| `e2e/` | 真实浏览器端到端自测(推流→订阅,校验收到的字节数) |

常用操作:

```bash
./fetch-secrets.sh          # 密钥有变时重新拉取
./check.sh                  # 随时体检
node gen-token.mjs --room voice-1 --identity alice --json   # 给前端发 token
```

## 服务端 SDK 怎么接

```bash
source credentials.env       # 得到 LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
```

```js
// Node 示例(需 npm i livekit-server-sdk)
import { AccessToken } from 'livekit-server-sdk';
const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
  identity: 'alice', ttl: '6h',
});
at.addGrant({ roomJoin: true, room: 'voice-1' });
const token = await at.toJwt();          // 交给浏览器
```

浏览器端用 `livekit-client` 连 `wss://voice.example.com:7443` + 上面签出的 token。
**密钥只留在后端**,浏览器永远只拿 token。

MinVoice 若用 `LIVEKIT_*` 这套环境变量名,可直接引用 `credentials.env`。

## 架构与几个必须知道的坑

```
浏览器 ──wss:7443──> Caddy(终止 TLS) ──http:127.0.0.1:7880──> livekit-server
浏览器 ──udp:50000-50200────────────────────────────────────> livekit-server   (媒体,不经代理)
浏览器 ──tcp:7881───────────────────────────────────────────> livekit-server   (ICE/TCP 兜底)
浏览器 ──udp:3478───────────────────────────────────────────> livekit-server   (内置 TURN/STUN)
```

1. **LiveKit 主端口不支持自带 TLS**。当前版本 `pkg/config/config.go` 的顶层 `Config`
   里根本没有 `cert_file` 字段(只有 `key_file`,而且那是节点私钥,不是证书)。
   配了会直接启动失败:
   `could not parse config: field cert_file not found in type config.Config`。
   所以信令必须由 Caddy 终止 TLS,`livekit-server` 只监听 `127.0.0.1:7880`。

2. **TURN/TLS 没启用,是故意的**。LiveKit 把 TURN/TLS 的广告端口**硬编码成 443**:
   ```go
   // pkg/service/roommanager.go
   urls = append(urls, fmt.Sprintf("turns:%s:443?transport=tcp", r.config.TURN.Domain))
   ```
   而 443 得留给浏览器的 wss。两个都抢 443 只能上 L4 ALPN 分流,那层没有可靠客户端
   能验证(客户端 `iceTransportPolicy` 由服务端 `forceRelay` 决定,无法本地强制),
   所以没往生产机上放,只保留确实可用的 TURN/UDP + ICE/TCP。
   若日后确实要支持"只放行 443 出站"的网络,正路是加一层 HAProxy/nginx-stream 做
   ALPN 分流(带 ALPN → Caddy,Caddy 挪到 8443;无 ALPN → LiveKit TURN),并配
   `turn.domain` + `turn.tls_port`,先验证再上。

3. **必须 `use_external_ip: true`**。云服务器通常在 1:1 NAT 后面(网卡是内网地址),
   靠 STUN 才能把正确公网 IP 播给客户端,否则对方连不上。

4. **Docker 日志要显式轮转**。LiveKit 在 info 级别会打印完整 SDP,单条能到几 KB。
   Docker 的 `json-file` 驱动默认不限制大小,会把磁盘写满。部署脚本已加
   `max-size=10m max-file=3`。

5. **证书续期会短暂占 80 端口**。Caddyfile 里设了 `auto_https disable_redirects`,
   让 Caddy 不绑 80,把 80 留给 certbot standalone。续期脚本会先停 Caddy、
   续完再起,并在证书变化后重启两个容器(`check.sh` 会校验 80 是否空闲)。

6. **这台机器还跑着其它服务**,所以 `rtc.interfaces.excludes` 排除了 `docker0`,
   避免把容器网段当候选地址播出去。资源占用很小:LiveKit ~50MB、Caddy ~13MB。

## 端到端自测

`e2e/` 是一个真实浏览器测试:一个无头 Chrome 用画布造视频推流,另一个订阅,
比对实际收到的字节/帧数。用来验证 信令 → ICE/DTLS → SFU 转发 整条链路。

```bash
cd e2e
node server.mjs 8099 &                       # 带结果回收的静态服务

# 造两个 token(房间名自取)
cd .. && node gen-token.mjs --room t1 --identity pub --ttl 15m > e2e/.tokens/pub.jwt
node gen-token.mjs --room t1 --identity sub --ttl 15m > e2e/.tokens/sub.jwt

# 起两个无头 Chrome,分别访问
#   http://127.0.0.1:8099/index.html?url=wss://voice.example.com:7443&token=<jwt>&role=publish
#   http://127.0.0.1:8099/index.html?url=wss://voice.example.com:7443&token=<jwt>&role=subscribe
# 结果落在 e2e/results/*.json
```

> 注：`livekit-client.esm.mjs`（第三方 bundle，约 1.3 MB）不入库。首次使用时把它
> 放进 `e2e/` 目录即可：`npm pack livekit-client@2.22.3` 解包后取包内
> `dist/livekit-client.esm.mjs`；或从 ESM CDN 下载对应版本的 ESM 构建。

`role=relay` 会带 `iceTransportPolicy: 'relay'`,但当前 livekit-client(2.22.3)会忽略
客户端传入的 `rtcConfig`,relay 只受服务端 `forceRelay` 控制,所以这个角色目前**不能**
用来验证 TURN,别被骗了。

### 最近一次实测结果

```
推流端  发出 260KB / 332 包,编码 242 帧        udp/srflx ice=connected dtls=connected rtt=47ms
订阅端  收到 211KB / 267 包,解码 206 帧,丢 0  udp/srflx ice=connected dtls=connected rtt=34ms
data 通道  正常
服务端下发  turn:203.0.113.10:3478?transport=udp(带凭据)
```

## 出问题先看这三处

```bash
ssh sfu-host 'docker ps --filter name=livekit'
ssh sfu-host 'docker logs --tail 50 livekit-server'
ssh sfu-host 'docker logs --tail 50 livekit-caddy'
./check.sh
```

密钥在服务器的 `/opt/livekit/livekit.env`;配置 `/opt/livekit/config.yaml`;
Caddyfile `/opt/livekit/Caddyfile`。改完配置重跑 `deploy-remote.sh` 即可(幂等)。
