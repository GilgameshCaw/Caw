#!/bin/bash

# Cleanup script for old CAW processes
# This script is run automatically when the server starts

echo "[Cleanup] Checking for old CAW processes..."

# Function to safely kill processes
safe_kill() {
  local process_name=$1
  local pattern=$2

  # Get list of PIDs except current session
  local pids=$(pgrep -f "$pattern" 2>/dev/null)

  if [ -z "$pids" ]; then
    return
  fi

  # Count how many we're killing
  local count=$(echo "$pids" | wc -l | tr -d ' ')

  if [ "$count" -gt 0 ]; then
    echo "[Cleanup] Found $count old $process_name process(es), cleaning up..."

    # Kill old processes (excluding current session)
    # We exclude processes from the last 10 seconds to avoid killing the process that just started
    ps -eo pid,lstart,command | grep -E "$pattern" | grep -v grep | while read pid rest; do
      # Get process start time in seconds since epoch
      start_time=$(ps -p $pid -o lstart= 2>/dev/null)
      if [ -n "$start_time" ]; then
        start_epoch=$(date -j -f "%a %b %d %T %Y" "$start_time" "+%s" 2>/dev/null)
        now_epoch=$(date "+%s")
        age=$((now_epoch - start_epoch))

        # Only kill if process is older than 10 seconds
        if [ $age -gt 10 ]; then
          echo "[Cleanup]   - Killing PID $pid (age: ${age}s)"
          kill $pid 2>/dev/null
        fi
      fi
    done
  fi
}

# Kill old Vite dev server processes (frontend)
# Keep only the most recent one by sorting by PID (higher PID = more recent)
vite_pids=$(pgrep -f "vite.*localhost" | sort -n)
old_vite_count=$(echo "$vite_pids" | wc -l | tr -d ' ')
if [ "$old_vite_count" -gt 1 ]; then
  echo "[Cleanup] Found $((old_vite_count - 1)) old Vite process(es), cleaning up..."
  # Kill all but the last (most recent) process
  echo "$vite_pids" | sed '$d' | xargs kill 2>/dev/null
fi

# Kill old nodemon processes watching CAW
# Keep only the most recent one (highest PID)
nodemon_pids=$(ps aux | grep "nodemon.*CAW" | grep -v grep | awk '{print $2}' | sort -n)
nodemon_count=$(echo "$nodemon_pids" | grep -v '^$' | wc -l | tr -d ' ')
if [ "$nodemon_count" -gt 1 ]; then
  echo "[Cleanup] Found $((nodemon_count - 1)) old nodemon process(es), cleaning up..."
  # Kill all but the last (most recent) process
  echo "$nodemon_pids" | sed '$d' | grep -v '^$' | xargs kill 2>/dev/null
fi

# Clean up zombie node processes that are no longer attached to a terminal
zombie_nodes=$(ps aux | grep -E "node.*CAW|tsx.*start.ts" | grep -v grep | grep "?" | awk '{print $2}')
if [ -n "$zombie_nodes" ]; then
  echo "[Cleanup] Found zombie node process(es), cleaning up..."
  echo "$zombie_nodes" | xargs kill 2>/dev/null
fi

echo "[Cleanup] Cleanup complete!"
