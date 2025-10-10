#!/bin/bash

# Watch CAW Client logs in real time
LOG_FILE="logs/caw-client-$(date +%Y-%m-%d).log"

echo "Watching CAW Client logs..."
echo "Log file: $LOG_FILE"
echo "Press Ctrl+C to stop"
echo "========================================="

# Create logs directory if it doesn't exist
mkdir -p logs

# Watch the log file
tail -f "$LOG_FILE" 2>/dev/null || echo "Waiting for log file to be created..."

# If log file doesn't exist yet, wait for it
while [ ! -f "$LOG_FILE" ]; do
  sleep 1
done

tail -f "$LOG_FILE"