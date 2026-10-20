#!/usr/bin/env bash
# Control the Avito listing watcher.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PIDFILE="$ROOT/.assist/avito-watch.pid"
LOG="$ROOT/.assist/avito-watch.log"
BRIDGE_PIDFILE="$ROOT/.assist/bridge.pid"
PORT="${ASSIST_PORT:-8787}"
CMD="${1:-start}"
shift || true

bridge_up() {
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1
}

extension_connected() {
  local health
  health="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  [ -z "$health" ] && return 1
  echo "$health" | grep -Eq '"msSincePoll":[0-9]+' || return 1
  local ms
  ms="$(echo "$health" | sed -n 's/.*"msSincePoll":\([0-9]*\).*/\1/p')"
  [ -n "$ms" ] && [ "$ms" -lt 120000 ]
}

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "$CMD" in
  start)
    if running; then
      echo "[assist] watcher already running (pid $(cat "$PIDFILE"))"
      exit 0
    fi
    if ! bridge_up; then
      node "$ROOT/browser/bridge/server.mjs" >"$ROOT/.assist/bridge.log" 2>&1 &
      echo $! >"$BRIDGE_PIDFILE"
      sleep 0.5
    fi
    if ! bridge_up; then
      echo "[assist] bridge failed to start; see .assist/bridge.log" >&2
      exit 1
    fi
    if ! extension_connected; then
      echo "[assist] Firefox is not connected. Start it with ./scripts/ff.sh first." >&2
      exit 1
    fi
    nohup node "$ROOT/browser/avito-watch.mjs" "$@" >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
    echo "[assist] watcher started (pid $(cat "$PIDFILE")); log: .assist/avito-watch.log"
    ;;
  stop)
    if running; then
      kill "$(cat "$PIDFILE")"
      rm -f "$PIDFILE"
      echo "[assist] watcher stopped"
    else
      rm -f "$PIDFILE"
      echo "[assist] watcher is not running"
    fi
    ;;
  status)
    if running; then
      echo "[assist] watcher: running (pid $(cat "$PIDFILE"))"
    else
      echo "[assist] watcher: stopped"
    fi
    if bridge_up; then
      echo "[assist] bridge: $(curl -fsS "http://127.0.0.1:$PORT/health")"
    else
      echo "[assist] bridge: down"
    fi
    if extension_connected; then
      echo "[assist] firefox: connected"
    else
      echo "[assist] firefox: not connected"
    fi
    if [ -f "$LOG" ]; then
      echo "[assist] last log lines:"
      tail -n 5 "$LOG"
    fi
    ;;
  once)
    node "$ROOT/browser/avito-watch.mjs" --once "$@"
    ;;
  log)
    tail -f "$LOG"
    ;;
  *)
    echo "Usage: $0 {start|stop|status|once|log} [watcher options]" >&2
    exit 2
    ;;
esac
