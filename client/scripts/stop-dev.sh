#!/usr/bin/env bash
# Kill every process the dev stack can spawn. Run after `npm run dev` crashes
# or if something was left orphaned. Safe to run when nothing is up.

set -u

# Processes started directly by our scripts
pkill -9 -f 'programs/start.ts'        2>/dev/null
pkill -9 -f 'tsx watch.*programs/start' 2>/dev/null
pkill -9 -f 'concurrently.*restart'    2>/dev/null
pkill -9 -f 'vite.*FrontEnd'           2>/dev/null
pkill -9 -f 'vite.*localhost'          2>/dev/null
pkill    -f 'dev-runner.js'            2>/dev/null
pkill    -f 'redis-server.*6379'       2>/dev/null
pkill    -f 'elasticsearch'            2>/dev/null

# Anything still listening on our known ports (API 4000, vite 5274) —
# catches orphans that don't match the pkill patterns above.
for port in 4000 5274; do
  pids=$(lsof -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null)
  if [[ -n "$pids" ]]; then
    echo "  killing stale listener on :${port} (pid ${pids//$'\n'/, })"
    echo "$pids" | xargs kill -9 2>/dev/null
  fi
done

# PID file written by dev-runner.js
PIDFILE=/tmp/caw-dev-runner.pid
if [[ -f "$PIDFILE" ]]; then
  kill -9 "$(cat "$PIDFILE")" 2>/dev/null
  rm -f "$PIDFILE"
fi

echo 'All services stopped.'
