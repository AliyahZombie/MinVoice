#!/usr/bin/env bash
# LiveKit 服务端端到端体检
#
#   ./check.sh
#
# 检查项:容器 → TLS 证书 → 对外信令 → 管理 API 鉴权 → 媒体端口 → 80 端口是否留给续期

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_CFG="${SSH_CFG:-$HERE/../.sshcfg/config}"
# 下面三个默认值是占位示例,实际使用时用环境变量覆盖(或直接改这里)
HOST="${HOST:-sfu-host}"
DOMAIN="${DOMAIN:-voice.example.com}"
PUBIP="${PUBIP:-203.0.113.10}"
TLS_PORT="${TLS_PORT:-7443}"
CURL=(curl --noproxy "*" --resolve "$DOMAIN:$TLS_PORT:$PUBIP")
SSH=(ssh -F "$SSH_CFG" -o BatchMode=yes -o ConnectTimeout=15 "$HOST")

PASS=0; FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }

head_ "1. 远端容器"
CONTAINERS=$("${SSH[@]}" "docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}' | grep -E 'livekit-server|livekit-caddy'" 2>&1)
for name in livekit-server livekit-caddy; do
  line=$(grep "^$name|" <<<"$CONTAINERS")
  if grep -q '^Up' <<<"$(cut -d'|' -f2 <<<"$line")"; then
    ok "$name: $(cut -d'|' -f2,3 <<<"$line" | tr '|' ' ')"
  else
    bad "$name 未运行: ${line:-未找到}"
  fi
done

head_ "2. 对外 TLS 证书(Caddy $TLS_PORT)"
CERT_INFO=$(echo | timeout 15 openssl s_client -connect "$PUBIP:$TLS_PORT" -servername "$DOMAIN" 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName 2>/dev/null)
if [ -n "$CERT_INFO" ]; then
  SAN=$(grep -o 'DNS:[^,]*' <<<"$CERT_INFO" | head -1)
  NOTAFTER=$(sed -n 's/^notAfter=//p' <<<"$CERT_INFO")
  ok "证书可协商($SAN,到期 $NOTAFTER)"
else
  bad "${TLS_PORT} 上 TLS 握手失败"
fi

head_ "3. 信令端点"
CODE=$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN:$TLS_PORT/" || true)
[ "$CODE" != "000" ] && ok "https://$DOMAIN:$TLS_PORT/ → HTTP $CODE" || bad "https 信令不可达"
WSCODE=$("${CURL[@]}" -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN:$TLS_PORT/rtc?access_token=bogus" || true)
# LiveKit 对无 token 返回 404、错误 token 返回 401;两者都说明路由活着
if [ "$WSCODE" = "401" ] || [ "$WSCODE" = "404" ]; then
  ok "信令路由 /rtc 经 Caddy 可达(错误 token → HTTP $WSCODE,符合预期)"
else
  bad "信令路由 /rtc 异常: HTTP $WSCODE"
fi

head_ "4. 管理 API(API key/secret 换管理员 token 调 ListRooms)"
if [ ! -f "$HERE/credentials.env" ]; then
  bad "credentials.env 不存在,先跑 ./fetch-secrets.sh"
else
  ADMIN_TOKEN=$(node "$HERE/gen-token.mjs" --admin --ttl 5m 2>/dev/null)
  if [ -z "$ADMIN_TOKEN" ]; then
    bad "token 生成失败"
  else
    RESP=$("${CURL[@]}" -s --max-time 10 -X POST "https://$DOMAIN:$TLS_PORT/twirp/livekit.RoomService/ListRooms" \
      -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{}' 2>&1)
    if grep -q '"rooms"' <<<"$RESP"; then
      N=$(python3 -c "import json,sys;print(len(json.load(sys.stdin).get('rooms') or []))" <<<"$RESP" 2>/dev/null || echo '?')
      ok "ListRooms 鉴权通过,当前 $N 个活跃房间"
    else
      bad "ListRooms 失败: ${RESP:0:200}"
    fi
  fi
fi

head_ "5. 媒体 / TURN 端口"
for p in 7881; do
  timeout 6 bash -c "echo > /dev/tcp/$PUBIP/$p" 2>/dev/null \
    && ok "TCP $p (ICE/TCP 兜底) 可达" || bad "TCP $p 不可达"
done
echo "  · WebRTC 媒体走 UDP 50000-50200,TURN 走 UDP 3478,需真实客户端验证(README 里有 e2e 自测)"
# LiveKit 会把 turn.tls_port>0 的 TURN/TLS 硬编码广告成 :443,与 wss 抢端口,必须为 0
TLSPORT=$("${SSH[@]}" "sed -n 's/^ *tls_port: *//p' /opt/livekit/config.yaml | tr -d '[:space:]'" 2>/dev/null)
case "$TLSPORT" in
  0) ok "turn.tls_port=0,不会向客户端广告坏掉的 turns:...:443 地址" ;;
  '') bad "配置里读不到 turn.tls_port" ;;
  *) bad "turn.tls_port=$TLSPORT ≠ 0,客户端会拿到打到 Caddy 的假 TURN/TLS 地址" ;;
esac

head_ "6. 续期通道"
# grep -c 在计数为 0 时返回非零退出码,这里用 tr 取纯数字
PORT80=$("${SSH[@]}" "ss -tlnp 2>/dev/null | grep -cE ':80\\b' | tr -d '[:space:]'" 2>/dev/null)
case "$PORT80" in
  0) ok "80 端口空闲（公网 HTTP-01 可达性尚需独立验证）" ;;
  ''|*[!0-9]*) bad "无法确认 80 端口状态(远端返回: ${PORT80:-空})" ;;
  *) bad "80 端口被 $PORT80 个进程占用,会挡住自动续期" ;;
esac
CRON=$("${SSH[@]}" "test -f /etc/cron.d/livekit-cert-renew && echo yes" 2>/dev/null)
[ "$CRON" = "yes" ] && ok "续期 cron 已安装" || bad "续期 cron 缺失"

head_ "结果"
printf '  通过 %d 项,失败 %d 项\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
