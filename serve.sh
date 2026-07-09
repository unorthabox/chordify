#!/usr/bin/env bash
# Serve Chordify.
#
#   ./serve.sh            → LAN over http  (quick look; no mic, no install)
#   ./serve.sh --secure   → HTTPS tunnel   (everything, incl. mic + install)
#
# The mic (tuner / chord trainer) and the service worker both need a "secure
# context": https, or localhost. A plain http://192.168.x.x address is NOT one,
# so on the LAN the mic is blocked and the app cannot install to a home screen.
#
# To put it on a phone for good, deploy the four files to any static HTTPS host
# (GitHub Pages, Cloudflare Pages, Netlify) and Add to Home Screen from there.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8000}"

if [[ "${1:-}" == "--secure" ]]; then
  if ! command -v cloudflared >/dev/null; then
    echo "cloudflared not found. Install it, or use:  npx localtunnel --port $PORT"
    echo "  macOS:  brew install cloudflared"
    echo "  Linux:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
  fi
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  SRV=$!
  trap 'kill $SRV 2>/dev/null || true' EXIT
  echo "Opening an HTTPS tunnel — use the https://… URL it prints, on your phone."
  echo "Mic, YouTube, and Add to Home Screen all work over this."
  echo "Note: the tunnel URL changes every run. Fine for testing; deploy to a"
  echo "      static host for an install you intend to keep."
  cloudflared tunnel --url "http://localhost:$PORT"
else
  IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ipconfig getifaddr en0 2>/dev/null || echo '<your-ip>')
  echo
  echo "  This machine:        http://localhost:$PORT/     (secure context: mic + service worker both work)"
  echo "  Phone, same Wi-Fi:   http://$IP:$PORT/"
  echo
  echo "  Over LAN http, expect: playback, YouTube play-along, import, transpose,"
  echo "  capo, export. Blocked: the mic, and installing to the home screen."
  echo "  Run './serve.sh --secure' to get those."
  echo
  python3 -m http.server "$PORT"
fi
