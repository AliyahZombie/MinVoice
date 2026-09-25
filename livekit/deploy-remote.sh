#!/usr/bin/env bash
# LiveKit SFU 部署脚本 —— 在服务器(Ubuntu 22.04)上以 root 执行
#
#   bash deploy-remote.sh
#
# 架构(2026-09 实测:当前 LiveKit 主端口不支持自带 TLS,必须前置终止代理):
#
#   浏览器 --wss:7443--> Caddy(终止 TLS) --http:127.0.0.1:7880--> livekit-server
#   浏览器 --udp:50000-50200------------------------------------> livekit-server   (媒体,不经代理)
#   浏览器 --tcp:7881-------------------------------------------> livekit-server   (ICE/TCP 兜底)
#   浏览器 --udp:3478-------------------------------------------> livekit-server   (内置 TURN,兼作 STUN)
#
#   架构限制:当前 LiveKit 主端口不支持自带 TLS(没有 cert_file 配置项),
#   所以信令必须由 Caddy 终止;TURN/TLS 又只会广告 443,与 wss 抢端口,故未启用。
#
# 做什么:
#   1. 生成 LiveKit API key/secret(仅首次,写入 /opt/livekit/livekit.env)
#   2. Docker 版 certbot 为 $DOMAIN 签 Let's Encrypt 证书(standalone,占 80)
#   3. 渲染 /opt/livekit/config.yaml 与 /opt/livekit/Caddyfile
#   4. host 网络拉起 livekit-server 与 caddy 两个容器
#   5. 装每日续期 cron
#
# 幂等:重复执行保留已有 key/secret 与证书,重建容器。

set -euo pipefail

LK_DIR=${LK_DIR:-/opt/livekit}
DOMAIN=${DOMAIN:-voice.example.com}
CONTAINER=${CONTAINER:-livekit-server}
CADDY_CONTAINER=${CADDY_CONTAINER:-livekit-caddy}
IMAGE=${IMAGE:-livekit/livekit-server:latest}
CADDY_IMAGE=${CADDY_IMAGE:-caddy:2-alpine}
CERTBOT_IMAGE=${CERTBOT_IMAGE:-certbot/certbot:latest}
ACME_EMAIL=${ACME_EMAIL:-}

# --- 端口规划(安全组需放行下述 TCP/UDP 端口) ---
PUBLIC_TLS_PORT=${PUBLIC_TLS_PORT:-7443}
SIGNAL_PORT=7880        # 信令,只绑 loopback,由 Caddy 反代
RTC_TCP_PORT=7881       # ICE over TCP 回退
RTC_UDP_START=50000     # WebRTC 媒体 UDP 范围
RTC_UDP_END=50200
TURN_UDP_PORT=3478
# 关掉 TURN/TLS:LiveKit 源码把 TURN/TLS 的广告端口写死成 443
#   pkg/service/roommanager.go: fmt.Sprintf("turns:%s:443?transport=tcp", TURN.Domain)
# 而 443 必须留给浏览器的 wss 信令。两个都抢 443 只能上 L4 ALPN 分流,
# 那层没有可靠客户端可验证,就不往生产机上放 —— 只保留确实可用的 TURN/UDP + ICE/TCP。
TURN_TLS_PORT=0
TURN_RELAY_START=40000
TURN_RELAY_END=41000

log() { printf '\033[36m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '\033[31m[!]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root 执行"
command -v docker >/dev/null || die "docker 未安装"
command -v openssl >/dev/null || die "openssl 未安装"

mkdir -p "$LK_DIR" "$LK_DIR/letsencrypt" "$LK_DIR/lib"

# ---------------------------------------------------------------- 1. 密钥
ENV_FILE="$LK_DIR/livekit.env"
if [ ! -f "$ENV_FILE" ]; then
  API_KEY="API$(openssl rand -hex 6)"
  API_SECRET="$(openssl rand -hex 32)"
  ( umask 077; printf 'LIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n' "$API_KEY" "$API_SECRET" > "$ENV_FILE" )
  log "已生成 API key/secret -> $ENV_FILE"
else
  log "复用已有密钥 $ENV_FILE"
fi
# shellcheck disable=SC1090
. "$ENV_FILE"
[ -n "${LIVEKIT_API_KEY:-}" ] && [ -n "${LIVEKIT_API_SECRET:-}" ] || die "密钥文件损坏"

# ---------------------------------------------------------------- 2. 证书
CERT_FULLCHAIN="$LK_DIR/letsencrypt/live/$DOMAIN/fullchain.pem"
CERT_KEY="$LK_DIR/letsencrypt/live/$DOMAIN/privkey.pem"
if [ -s "$CERT_FULLCHAIN" ] && openssl x509 -checkend 604800 -noout -in "$CERT_FULLCHAIN" >/dev/null 2>&1; then
  log "证书有效(>7天),跳过签发"
else
  log "签发 Let's Encrypt 证书: $DOMAIN"
  if [ -n "$ACME_EMAIL" ]; then
    EMAIL_ARG=(-m "$ACME_EMAIL")
  else
    EMAIL_ARG=(--register-unsafely-without-email)
  fi
  # 续期/重签要占用 80 端口,先确保没有容器占着
  docker rm -f "$CADDY_CONTAINER" >/dev/null 2>&1 || true
  docker run --rm \
    -p 80:80 \
    -v "$LK_DIR/letsencrypt:/etc/letsencrypt" \
    -v "$LK_DIR/lib:/var/lib/letsencrypt" \
    "$CERTBOT_IMAGE" certonly --standalone \
      -d "$DOMAIN" \
      --agree-tos --non-interactive --keep-until-expiring \
      "${EMAIL_ARG[@]}" || die "certbot 签发失败(检查 80 端口/ACME 出网)"
fi
[ -s "$CERT_FULLCHAIN" ] && [ -s "$CERT_KEY" ] || die "证书文件缺失: $CERT_FULLCHAIN"

# ---------------------------------------------------------------- 3. LiveKit 配置
CONFIG="$LK_DIR/config.yaml"
cat > "$CONFIG" <<YAML
# LiveKit server —— 由 deploy-remote.sh 生成,手改请同步脚本
# 注意 1: 典型 1:1 NAT 环境(网卡是内网地址),必须靠 STUN 发现公网 IP
# 注意 2: 当前版本主端口不支持自带 TLS,信令只绑 loopback,由同机 Caddy 终止 wss
# 注意 3: cert_file/key_file 只存在于 turn 段;本部署未启用 TURN/TLS,见 TURN_TLS_PORT 注释

port: $SIGNAL_PORT
bind_addresses:
  - 127.0.0.1

rtc:
  tcp_port: $RTC_TCP_PORT
  port_range_start: $RTC_UDP_START
  port_range_end: $RTC_UDP_END
  use_external_ip: true
  # 机器上混跑着其它服务,显式排除 docker0,避免把容器网段当候选地址播给客户端
  interfaces:
    excludes:
      - docker0

keys:
  "$LIVEKIT_API_KEY": "$LIVEKIT_API_SECRET"

# 内置 TURN(仅 UDP):给严格 NAT 的客户端兜底,同时充当 STUN。
# 不启用 TLS 的原因见文件上方 TURN_TLS_PORT 注释。
turn:
  enabled: true
  domain: $DOMAIN
  tls_port: $TURN_TLS_PORT
  udp_port: $TURN_UDP_PORT
  relay_range_start: $TURN_RELAY_START
  relay_range_end: $TURN_RELAY_END

room:
  auto_create: true
  empty_timeout: 300
  departure_timeout: 20

logging:
  level: info
  json: false
YAML
chmod 600 "$CONFIG"
log "已渲染 $CONFIG"

# ---------------------------------------------------------------- 4. Caddy 配置
CADDYFILE="$LK_DIR/Caddyfile"
cat > "$CADDYFILE" <<CADDY
# 由 deploy-remote.sh 生成
{
	admin off
	# 关键:不要占用 80 端口做跳转,把 80 留给 certbot standalone 续期
	auto_https disable_redirects
}

https://$DOMAIN:$PUBLIC_TLS_PORT {
	tls /etc/letsencrypt/live/$DOMAIN/fullchain.pem /etc/letsencrypt/live/$DOMAIN/privkey.pem
	encode zstd gzip
	reverse_proxy 127.0.0.1:$SIGNAL_PORT
}
CADDY
chmod 644 "$CADDYFILE"
log "已渲染 $CADDYFILE"

# ---------------------------------------------------------------- 5. 容器
log "拉取镜像"
docker pull "$IMAGE" >/dev/null
docker pull "$CADDY_IMAGE" >/dev/null

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$CADDY_CONTAINER" >/dev/null 2>&1 || true

# host 网络:WebRTC 需要大量 UDP 端口,桥接/NAT 会严重掉性能
# 日志轮转必须显式给:docker 的 json-file 驱动默认无限增长,
# 而 livekit 在 info 级别会把整个 SDP 打出来,小盘机器会被写满。
LOG_OPTS=(--log-opt max-size=10m --log-opt max-file=3)

docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --network host \
  "${LOG_OPTS[@]}" \
  -v "$CONFIG:/livekit/config.yaml:ro" \
  -v "$LK_DIR/letsencrypt:/etc/letsencrypt:ro" \
  "$IMAGE" --config /livekit/config.yaml >/dev/null

docker run -d \
  --name "$CADDY_CONTAINER" \
  --restart unless-stopped \
  --network host \
  "${LOG_OPTS[@]}" \
  -v "$CADDYFILE:/etc/caddy/Caddyfile:ro" \
  -v "$LK_DIR/letsencrypt:/etc/letsencrypt:ro" \
  -v "$LK_DIR/caddy-data:/data" \
  -v "$LK_DIR/caddy-config:/config" \
  "$CADDY_IMAGE" >/dev/null

log "容器已启动,等待就绪…"
sleep 8
docker ps --filter "name=$CONTAINER" --filter "name=$CADDY_CONTAINER" \
  --format '  {{.Names}}  {{.Status}}  {{.Image}}'
echo "  --- livekit 日志(仅关键行,截断到 200 字符) ---"
docker logs --tail 60 "$CONTAINER" 2>&1 | grep -E 'starting LiveKit|found external IP|Starting TURN|error|ERROR' \
  | tail -6 | cut -c1-200 | sed 's/^/  | /'
echo "  --- caddy 日志 ---"
docker logs --tail 30 "$CADDY_CONTAINER" 2>&1 | grep -viE 'autosaved|cleaning storage|finished cleaning' \
  | tail -5 | cut -c1-200 | sed 's/^/  | /'

# ---------------------------------------------------------------- 6. 续期
cat > "$LK_DIR/renew-cert.sh" <<RENEW
#!/usr/bin/env bash
# 每日续期;证书有更新则重启 livekit-server(读 TURN 证书)与 caddy(读站点证书)
set -euo pipefail
LK_DIR=/opt/livekit
DOMAIN=$DOMAIN
CERT="\$LK_DIR/letsencrypt/live/\$DOMAIN/fullchain.pem"
BEFORE=\$(stat -c %Y "\$CERT" 2>/dev/null || echo 0)
# 续期要占 80,临时停 caddy
trap 'docker start $CADDY_CONTAINER >/dev/null 2>&1 || true' EXIT
docker stop $CADDY_CONTAINER >/dev/null 2>&1 || true
docker run --rm -p 80:80 \\
  -v "\$LK_DIR/letsencrypt:/etc/letsencrypt" \\
  -v "\$LK_DIR/lib:/var/lib/letsencrypt" \\
  certbot/certbot renew --non-interactive --quiet
docker start $CADDY_CONTAINER >/dev/null 2>&1 || true
AFTER=\$(stat -c %Y "\$CERT" 2>/dev/null || echo 0)
if [ "\$BEFORE" != "\$AFTER" ]; then
  echo "\$(date -Is) 证书已更新,重启 livekit-server 与 $CADDY_CONTAINER"
  docker restart $CONTAINER >/dev/null
  docker restart $CADDY_CONTAINER >/dev/null
else
  echo "\$(date -Is) 证书未变,无需重启"
fi
RENEW
chmod +x "$LK_DIR/renew-cert.sh"
cat > /etc/cron.d/livekit-cert-renew <<CRON
# LiveKit 证书自动续期(Let's Encrypt 到期前 30 天才会真正续)
17 3 * * * root $LK_DIR/renew-cert.sh >> /var/log/livekit-renew.log 2>&1
CRON
chmod 644 /etc/cron.d/livekit-cert-renew
log "已装续期 cron: /etc/cron.d/livekit-cert-renew"

log "完成。密钥在 $ENV_FILE,配置在 $CONFIG"
