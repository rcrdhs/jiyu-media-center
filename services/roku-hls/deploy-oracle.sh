#!/usr/bin/env bash
# Bootstrap roku-hls on Oracle Always Free Ampere (Ubuntu/Oracle Linux).
# Usage (from your PC after SSH works):
#   scp -r services/roku-hls package.json package-lock.json ubuntu@HOST:~/jiyu-roku-hls/
#   # or rsync the app subset — then on the VM:
#   bash deploy-oracle.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/jiyu-roku-hls}"
PORT="${ROKU_HLS_PORT:-8791}"
TOKEN="${ROKU_HLS_TOKEN:-}"
SERVICE_USER="${SUDO_USER:-$USER}"

if [[ -z "$TOKEN" && -f "$APP_DIR/services/roku-hls/.deploy-token" ]]; then
  TOKEN="$(tr -d '\r\n' < "$APP_DIR/services/roku-hls/.deploy-token")"
fi
if [[ -z "$TOKEN" ]]; then
  echo "Set ROKU_HLS_TOKEN or place services/roku-hls/.deploy-token"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y curl ca-certificates ffmpeg chromium-browser \
    || sudo apt-get install -y curl ca-certificates ffmpeg chromium
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y curl ca-certificates ffmpeg chromium
fi

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

CHROME_BIN="$(command -v chromium-browser || command -v chromium || command -v google-chrome || true)"
FFMPEG_BIN="$(command -v ffmpeg)"
if [[ -z "$CHROME_BIN" ]]; then
  echo "Chromium not found"
  exit 1
fi
if [[ -z "$FFMPEG_BIN" ]]; then
  echo "ffmpeg not found"
  exit 1
fi

mkdir -p "$APP_DIR"
cd "$APP_DIR"
# Minimal package install — puppeteer-core only (system chromium + ffmpeg).
if [[ ! -f package.json ]]; then
  cat > package.json <<'EOF'
{
  "name": "jiyu-roku-hls",
  "private": true,
  "type": "module",
  "dependencies": {
    "puppeteer-core": "^25.3.0"
  }
}
EOF
fi
npm install --omit=dev

# Expect server at services/roku-hls/server.mjs or ./server.mjs
SERVER="$APP_DIR/services/roku-hls/server.mjs"
if [[ ! -f "$SERVER" ]]; then
  SERVER="$APP_DIR/server.mjs"
fi
if [[ ! -f "$SERVER" ]]; then
  echo "server.mjs missing under $APP_DIR"
  exit 1
fi

UNIT=/etc/systemd/system/roku-hls.service
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=Jiyu Roku HLS bridge
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$(dirname "$SERVER")
Environment=ROKU_HLS_PORT=$PORT
Environment=ROKU_HLS_TOKEN=$TOKEN
Environment=ROKU_HLS_REMUX_WORKERS=3
Environment=PUPPETEER_EXECUTABLE_PATH=$CHROME_BIN
Environment=FFMPEG_PATH=$FFMPEG_BIN
Environment=NODE_ENV=production
ExecStart=$(command -v node) $SERVER
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now roku-hls.service
sleep 1
curl -fsS "http://127.0.0.1:${PORT}/health" || true
echo
echo "Open security list / iptables for TCP $PORT (or put nginx TLS in front)."
echo "Pack Roku with:"
echo "  ROKU_HLS_BASE=http://PUBLIC_IP:$PORT ROKU_HLS_TOKEN=… npm run pack:roku"
