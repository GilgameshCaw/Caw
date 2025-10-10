#!/bin/bash

# Create logs directory if it doesn't exist
mkdir -p logs

# Get current date for log filename
DATE=$(date +%Y-%m-%d)
LOG_FILE="logs/caw-client-${DATE}.log"

echo "Starting CAW API Server with logging to: ${LOG_FILE}"
echo "========================================" | tee -a "${LOG_FILE}"
echo "[$(date +%Y-%m-%dT%H:%M:%S)] Starting CAW API Server" | tee -a "${LOG_FILE}"
echo "========================================" | tee -a "${LOG_FILE}"

# Run npm api command and pipe all output (stdout and stderr) through tee
npm run api 2>&1 | tee -a "${LOG_FILE}"