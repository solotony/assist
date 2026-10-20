#!/usr/bin/env bash
# Launch Firefox with the Assist Bridge extension and a dedicated profile.
# Extra arguments are passed to `web-ext run` (e.g. --headless, --verbose).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROFILE="${ASSIST_PROFILE:-$ROOT/.assist/firefox-profile}"
LOG="$ROOT/.assist/bridge.log"
PIDFILE="$ROOT/.assist/bridge.pid"
PORT="${ASSIST_PORT:-8787}"

mkdir -p "$PROFILE" "$ROOT/browser/shots" "$ROOT/.assist"

bridge_up() {
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
}

if bridge_up; then
  echo "[assist] bridge already running on port $PORT"
else
  node "$ROOT/browser/bridge/server.mjs" >"$LOG" 2>&1 &
  echo $! >"$PIDFILE"
  for _ in $(seq 1 20); do
    bridge_up && break
    sleep 0.1
  done
  if ! bridge_up; then
    echo "[assist] bridge failed to start; see $LOG" >&2
    exit 1
  fi
  echo "[assist] bridge started on port $PORT"
fi

echo "[assist] launching Firefox (profile: $PROFILE)"
exec npx --yes web-ext run \
  --source-dir "$ROOT/browser/extension" \
  --firefox-profile "$PROFILE" \
  --profile-create-if-missing \
  --keep-profile-changes \
  --no-reload \
  "$@"
