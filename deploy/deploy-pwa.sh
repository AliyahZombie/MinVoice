#!/usr/bin/env bash
# Upload only public assets, never source files or credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=us2
BASE=/srv/us1-migrate/NPM/data/minvoice
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
pnpm build
ssh "$HOST" "mkdir -p '$BASE/releases/$RELEASE'"
rsync -a --delete dist/ "$HOST:$BASE/releases/$RELEASE/"
scp -q deploy/minvoice.nginx.conf "$HOST:$BASE/site-$RELEASE.conf"
ssh "$HOST" bash -s -- "$RELEASE" <<'REMOTE'
set -euo pipefail
release=$1
base=/srv/us1-migrate/NPM/data/minvoice
custom=/srv/us1-migrate/NPM/data/nginx/custom
backup="$base/backups/$release"
mkdir -p "$backup"
cp -p "$custom/http.conf" "$backup/http.conf"
if [ -f "$custom/minvoice.conf" ]; then cp -p "$custom/minvoice.conf" "$backup/minvoice.conf"; fi
previous=$(readlink "$base/current" || true)
printf '%s\n' "$previous" > "$backup/previous-release"
rollback() {
    cp -p "$backup/http.conf" "$custom/http.conf"
    if [ -f "$backup/minvoice.conf" ]; then cp -p "$backup/minvoice.conf" "$custom/minvoice.conf"; else rm -f "$custom/minvoice.conf"; fi
    if [ -n "$previous" ]; then ln -sfn "$previous" "$base/rollback"; mv -Tf "$base/rollback" "$base/current"; else rm -f "$base/current"; fi
    docker exec nginx-proxy-manager nginx -t && docker exec nginx-proxy-manager nginx -s reload
}
trap 'rollback; exit 1' ERR
chmod -R a+rX "$base/releases/$release"
ln -s "releases/$release" "$base/current-$release"
mv -Tf "$base/current-$release" "$base/current"
cp "$base/site-$release.conf" "$custom/minvoice.conf"
if ! grep -Fq 'include /data/nginx/custom/minvoice.conf;' "$custom/http.conf"; then
    printf '\ninclude /data/nginx/custom/minvoice.conf;\n' >> "$custom/http.conf"
fi
docker exec nginx-proxy-manager nginx -t
docker exec nginx-proxy-manager nginx -s reload
curl --fail --silent --show-error --retry 4 --retry-delay 1 --retry-all-errors -H 'Host: voice.aliyahzombie.top' -H 'X-Forwarded-Proto: https' http://127.0.0.1/manifest.webmanifest | python3 -c 'import json,sys; m=json.load(sys.stdin); assert m["name"]=="MinVoice"; print("Origin manifest OK")'
trap - ERR
printf 'Deployed %s; previous release: %s\n' "$release" "$previous"
REMOTE
curl --fail --silent --show-error --max-time 20 --retry 3 https://voice.aliyahzombie.top/manifest.webmanifest | python3 -c 'import json,sys; m=json.load(sys.stdin); assert m["name"]=="MinVoice"; print("Public HTTPS manifest OK")'
printf 'MinVoice PWA: https://voice.aliyahzombie.top\n'
