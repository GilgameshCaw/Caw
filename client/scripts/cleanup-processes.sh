#!/bin/bash

# Cleanup script for old CAW processes
# Only cleans up genuinely stale processes — avoids killing siblings
# managed by the same concurrently/dev-runner session.

echo "[Cleanup] Checking for old CAW processes..."

# Kill old Vite dev server processes (frontend)
# Keep only the most recent one by sorting by PID (higher PID = more recent)
vite_pids=$(pgrep -f "vite.*localhost" | sort -n)
old_vite_count=$(echo "$vite_pids" | grep -v '^$' | wc -l | tr -d ' ')
if [ "$old_vite_count" -gt 1 ]; then
  echo "[Cleanup] Found $((old_vite_count - 1)) old Vite process(es), cleaning up..."
  echo "$vite_pids" | sed '$d' | xargs kill 2>/dev/null
fi

# Kill old nodemon processes watching CAW
# Keep only the most recent one (highest PID)
nodemon_pids=$(ps aux | grep "nodemon.*--watch" | grep -v grep | awk '{print $2}' | sort -n)
nodemon_count=$(echo "$nodemon_pids" | grep -v '^$' | wc -l | tr -d ' ')
if [ "$nodemon_count" -gt 1 ]; then
  echo "[Cleanup] Found $((nodemon_count - 1)) old nodemon process(es), cleaning up..."
  echo "$nodemon_pids" | sed '$d' | grep -v '^$' | xargs kill 2>/dev/null
fi

echo "[Cleanup] Cleanup complete!"
