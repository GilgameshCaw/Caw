#!/usr/bin/env bash
# Launch Elasticsearch with a sensibly-sized JVM heap.
#
# Heap selection (first match wins):
#   1. --heap=<size>    CLI flag, e.g. --heap=2g or --heap=1536m
#   2. ES_HEAP_SIZE     env var, same format
#   3. Auto: ~12.5% of total system RAM, clamped to [1g, 4g]
#
# ES's built-in auto-sizing picks ~50% of system RAM, which on a 64 GB dev box
# reserves ~31 GB heap + ~15 GB direct memory — wildly oversized for local dev.

set -euo pipefail

HEAP=""
for arg in "$@"; do
  case "$arg" in
    --heap=*) HEAP="${arg#--heap=}" ;;
  esac
done

if [[ -z "$HEAP" && -n "${ES_HEAP_SIZE:-}" ]]; then
  HEAP="$ES_HEAP_SIZE"
fi

if [[ -z "$HEAP" ]]; then
  # Auto-pick based on system RAM. macOS = sysctl, Linux = /proc/meminfo.
  if [[ "$(uname)" == "Darwin" ]]; then
    TOTAL_BYTES=$(sysctl -n hw.memsize)
  else
    TOTAL_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
    TOTAL_BYTES=$((TOTAL_KB * 1024))
  fi
  TOTAL_MB=$((TOTAL_BYTES / 1024 / 1024))
  # 12.5% of total, clamped to [1024, 4096] MB
  PICK_MB=$((TOTAL_MB / 8))
  if (( PICK_MB < 1024 )); then PICK_MB=1024; fi
  if (( PICK_MB > 4096 )); then PICK_MB=4096; fi
  HEAP="${PICK_MB}m"
  SOURCE="auto (${TOTAL_MB}MB system RAM → 1/8)"
else
  SOURCE="override"
fi

OVERRIDE_DIR="$HOME/elasticsearch/config/jvm.options.d"
OVERRIDE_FILE="$OVERRIDE_DIR/heap.options"
mkdir -p "$OVERRIDE_DIR"
cat > "$OVERRIDE_FILE" <<EOF
# Managed by client/scripts/start-elasticsearch.sh — regenerated on each start.
-Xms${HEAP}
-Xmx${HEAP}
EOF

echo "[elasticsearch] heap=${HEAP} (${SOURCE})"
echo "[elasticsearch] override: $OVERRIDE_FILE"

pkill -f elasticsearch 2>/dev/null || true
sleep 1
exec "$HOME/elasticsearch/bin/elasticsearch"
