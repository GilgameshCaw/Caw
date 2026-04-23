#!/usr/bin/env bash
# Ensure Node 22 is selected via nvm, then hand off to dev-runner.js.
# dev-runner.js owns the `concurrently` lifecycle and the interactive shell.

set -euo pipefail

unset npm_config_prefix
export NVM_DIR="$HOME/.nvm"

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  echo "nvm not found at $NVM_DIR/nvm.sh" >&2
  exit 1
fi

# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

if ! nvm list | grep -q 'v22.0.0'; then
  nvm install 22.0.0
fi
nvm use 22.0.0

# Sweep stale processes from previous sessions before launching a fresh stack.
# Orphans accumulate when a crash-loop spawns replacements without fully killing
# the old ones — most visibly as vite silently climbing past its pinned port.
echo '[start-dev] Sweeping orphans from previous sessions…'
bash scripts/stop-dev.sh >/dev/null 2>&1 || true

exec node scripts/dev-runner.js
