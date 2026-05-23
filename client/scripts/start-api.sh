#!/usr/bin/env bash
# Launch the API with day-stamped log tee'd to logs/.
# NOTE: do NOT add prisma db push / prisma:push here — it is destructive.
# Schema changes must go through prisma db execute per project_prisma_migrations.md.

set -euo pipefail

mkdir -p logs

LOG_FILE="logs/caw-client-$(date +%Y-%m-%d).log"
exec node -r ./file-polyfill.js -r tsx/cjs programs/start.ts 2>&1 | tee -a "$LOG_FILE"
