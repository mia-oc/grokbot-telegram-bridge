#!/usr/bin/env bash
# Keep listener.mjs alive on 127.0.0.1:8787. Kill old PID on restart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$ROOT/listener.pid"
LOGFILE="$ROOT/listener.log"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
LISTENER="$ROOT/listener.mjs"

mkdir -p "$ROOT/spool/done"

if [[ -f "$PIDFILE" ]]; then
  old_pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
    # Wait briefly for clean exit
    for _ in 1 2 3 4 5; do
      kill -0 "$old_pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$old_pid" 2>/dev/null; then
      kill -9 "$old_pid" 2>/dev/null || true
    fi
  fi
  rm -f "$PIDFILE"
fi

cd "$ROOT"
# shellcheck disable=SC2094
nohup "$NODE_BIN" "$LISTENER" >>"$LOGFILE" 2>&1 &
echo $! >"$PIDFILE"
chmod 600 "$PIDFILE" 2>/dev/null || true

echo "listener started pid=$(cat "$PIDFILE") log=$LOGFILE"
