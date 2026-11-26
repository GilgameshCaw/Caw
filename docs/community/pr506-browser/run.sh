#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
sha256sum --check sources.sha256 >&2
tmp=$(mktemp -d)
anvil --host 127.0.0.1 --port 0 --chain-id 11155111 >"$tmp/node.log" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -f "$tmp/node.log"; rmdir "$tmp"; }
trap cleanup EXIT
for ((i=0; i<100; i++)); do
  port=$(sed -n 's/^Listening on 127\.0\.0\.1:\([0-9]*\).*/\1/p' "$tmp/node.log")
  if [[ -n "$port" ]]; then break; fi
  kill -0 "$pid"
  sleep 0.1
done
: "${port:?Anvil did not start}"
node replay.mjs "$port"
