#!/usr/bin/env bash
# Run prisma push, then launch the API with day-stamped log tee'd to logs/.

set -euo pipefail

npm run prisma:push
mkdir -p logs

LOG_FILE="logs/caw-client-$(date +%Y-%m-%d).log"
exec node -r ./file-polyfill.js -r tsx/cjs programs/start.ts 2>&1 | tee -a "$LOG_FILE"
