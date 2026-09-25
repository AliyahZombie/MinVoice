#!/usr/bin/env bash
# 本地起一个 LiveKit server,用于端到端自测。
#
#   ./local-server.sh [端口,默认 7880]
#
# 为什么需要它:远程 SFU 不在线时,MinVoice 就没法验证。
# 本地起同版本 server,配合 e2e/ 里的 Chrome 订阅端,可以完整跑通
# "连服务器 → 推麦克风 → 对端收到音频 → 文字消息送达"。
#
# 依赖:livekit-server 可执行文件。没有的话会提示下载地址。
# 密钥复用同目录的 credentials.env,所以 gen-token.mjs 签的 token 能直接用。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-7880}"
BIN="${LIVEKIT_SERVER_BIN:-$(command -v livekit-server || true)}"
WORKDIR="${TMPDIR:-/tmp}/minvoice-local-server"

if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  cat >&2 <<'EOF'
找不到 livekit-server。装一个:

  curl -sSL -o /tmp/lk.tar.gz \
    https://github.com/livekit/livekit/releases/download/v1.13.7/livekit_1.13.7_linux_amd64.tar.gz
  tar xzf /tmp/lk.tar.gz -C /tmp
  export LIVEKIT_SERVER_BIN=/tmp/livekit-server
  ./local-server.sh

也可以直接用 LIVEKIT_SERVER_BIN 指定路径。
EOF
  exit 1
fi

# 从 credentials.env 取密钥,生成的配置里含 secret,所以权限给 600
mkdir -p "$WORKDIR"
umask 077
CREDS="$HERE/../credentials.env"
if [ ! -f "$CREDS" ]; then
  echo "找不到 $CREDS" >&2
  exit 1
fi
KEY="$(grep -E '^[[:space:]]*LIVEKIT_API_KEY[[:space:]]*=' "$CREDS" | head -1 | cut -d= -f2- | tr -d ' \r' || true)"
SECRET="$(grep -E '^[[:space:]]*LIVEKIT_API_SECRET[[:space:]]*=' "$CREDS" | head -1 | cut -d= -f2- | tr -d ' \r' || true)"

if [ -z "$KEY" ] || [ -z "$SECRET" ]; then
  echo "credentials.env 里没有 LIVEKIT_API_KEY / LIVEKIT_API_SECRET" >&2
  exit 1
fi

CONFIG="$WORKDIR/local.yaml"
cat > "$CONFIG" <<EOF
# 本地自测用 —— 含密钥,权限 600,别提交
port: $PORT
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: $((PORT + 1))
  port_range_start: 50000
  port_range_end: 50200
  use_external_ip: false
keys:
  $KEY: $SECRET
room:
  auto_create: true
  # 房间空了就快点回收,反复测试时不会残留
  empty_timeout: 60
  departure_timeout: 20
logging:
  level: info
  json: false
EOF
chmod 600 "$CONFIG"

echo "配置: $CONFIG"
echo "信令: ws://127.0.0.1:$PORT"
echo
echo "客户端 URL 填 ws://127.0.0.1:$PORT"
echo "签 token: node $HERE/gen-token.mjs --room <房间> --identity <id>"
echo

exec "$BIN" --config "$CONFIG" --node-ip 127.0.0.1
