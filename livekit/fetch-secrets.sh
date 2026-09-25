#!/usr/bin/env bash
# 把服务器上 LiveKit 的 API 密钥与连接信息拉到本地工作区
#
#   ./fetch-secrets.sh            # 拉取并写入本目录
#   ./fetch-secrets.sh --print    # 只打印,不落盘
#
# 产出:
#   credentials.env     给程序 source 的环境变量(含密钥,chmod 600)
#   credentials.json    同样的内容,JSON 格式
#   livekit-config.yaml 服务端配置快照(不含密钥,密钥已替换为占位符)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSH_CFG="${SSH_CFG:-$HERE/../.sshcfg/config}"
HOST="${HOST:-sfu-host}"
DOMAIN="${DOMAIN:-voice.example.com}"
PRINT_ONLY=0
[ "${1:-}" = "--print" ] && PRINT_ONLY=1

SSH=(ssh -F "$SSH_CFG" -o BatchMode=yes "$HOST")

echo "[*] 读取 $HOST:/opt/livekit/livekit.env"
REMOTE_ENV="$("${SSH[@]}" 'cat /opt/livekit/livekit.env')"
API_KEY="$(sed -n 's/^LIVEKIT_API_KEY=//p' <<<"$REMOTE_ENV")"
API_SECRET="$(sed -n 's/^LIVEKIT_API_SECRET=//p' <<<"$REMOTE_ENV")"
[ -n "$API_KEY" ] && [ -n "$API_SECRET" ] || { echo "[!] 远端密钥为空" >&2; exit 1; }

WS_URL="wss://$DOMAIN"
HTTP_URL="https://$DOMAIN"

if [ "$PRINT_ONLY" = 1 ]; then
  cat <<EOF
LIVEKIT_URL=$WS_URL
LIVEKIT_HTTP_URL=$HTTP_URL
LIVEKIT_API_KEY=$API_KEY
LIVEKIT_API_SECRET=$API_SECRET
EOF
  exit 0
fi

umask 077
cat > "$HERE/credentials.env" <<EOF
# LiveKit 服务端 —— 由 fetch-secrets.sh 生成,别提交到 git
# 服务端 SDK 用这三个
LIVEKIT_URL=$WS_URL
LIVEKIT_API_KEY=$API_KEY
LIVEKIT_API_SECRET=$API_SECRET

# 浏览器端(前端只用 URL,密钥绝不能下发到浏览器)
# 浏览器端需要的 token 必须由你自己的后端用上面密钥签,见 gen-token.mjs
LIVEKIT_WS_URL=$WS_URL
LIVEKIT_HTTP_URL=$HTTP_URL

# 内置 TURN:仅 UDP(兼作 STUN),服务端会自动写进 join response,客户端无需手配
# 没有 TURN/TLS —— LiveKit 把 TURN/TLS 的广告端口写死成 443,与 wss 冲突,故未启用
LIVEKIT_TURN_URL=turn:$DOMAIN:3478?transport=udp
LIVEKIT_TURN_UDP_PORT=3478
EOF
chmod 600 "$HERE/credentials.env"

cat > "$HERE/credentials.json" <<EOF
{
  "host": "$HOST",
  "publicIp": "203.0.113.10",
  "domain": "$DOMAIN",
  "signaling": {
    "ws": "$WS_URL",
    "http": "$HTTP_URL"
  },
  "apiKey": "$API_KEY",
  "apiSecret": "$API_SECRET",
  "turn": {
    "udp": "turn:$DOMAIN:3478?transport=udp",
    "note": "仅 UDP;TURN/TLS 未启用(LiveKit 硬编码广告 :443,与 wss 冲突)。服务端会自动下发给客户端"
  },
  "ports": {
    "signaling": 443,
    "signalingInternal": 7880,
    "rtcTcp": 7881,
    "rtcUdp": "50000-50200",
    "turnUdp": 3478
  }
}
EOF
chmod 600 "$HERE/credentials.json"

echo "[*] 抓取服务端配置快照(脱敏)"
"${SSH[@]}" 'cat /opt/livekit/config.yaml' \
  | sed -E "s|^(  )\"$API_KEY\": .*|\1\"\$LIVEKIT_API_KEY\": \"<redacted>\"|" \
  > "$HERE/livekit-config.yaml"

echo "[+] 已写入:"
ls -l "$HERE/credentials.env" "$HERE/credentials.json" "$HERE/livekit-config.yaml" | sed 's/^/    /'
echo
echo "    LIVEKIT_URL=$WS_URL"
echo "    LIVEKIT_API_KEY=$API_KEY"
echo "    LIVEKIT_API_SECRET=${API_SECRET:0:8}…(共 ${#API_SECRET} 字符)"
