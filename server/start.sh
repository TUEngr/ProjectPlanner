#!/usr/bin/env bash
# Start (or restart) the Project Planner helper and print its URL.
#   bash server/start.sh            start if not already running
#   bash server/start.sh restart    stop and start again
cd "$(dirname "$0")/.." || exit 1
PORT=${PORT:-8765}
PIDFILE=/tmp/projectplanner.pid
LOG=/tmp/projectplanner.log

url() {
  if [ -n "$CODESPACE_NAME" ]; then
    echo "https://${CODESPACE_NAME}-${PORT}.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  else
    echo "http://localhost:${PORT}"
  fi
}
# Alive and not a zombie (containers without an init never reap dead children).
running() {
  [ -f "$PIDFILE" ] || return 1
  local pid; pid=$(cat "$PIDFILE")
  kill -0 "$pid" 2>/dev/null && ! grep -q '^State:[[:space:]]*Z' "/proc/$pid/status" 2>/dev/null
}

if [ "$1" = restart ] && running; then
  kill "$(cat "$PIDFILE")"
  for _ in 1 2 3 4 5 6 7 8 9 10; do running || break; sleep 0.3; done
fi
if running; then
  echo "Project Planner already running: $(url)"
  exit 0
fi

nohup python3 server/serve.py --port "$PORT" > "$LOG" 2>&1 &
echo $! > "$PIDFILE"
sleep 1
if running; then
  echo "Project Planner: $(url)"
else
  echo "Project Planner failed to start:"
  cat "$LOG"
  exit 1
fi
