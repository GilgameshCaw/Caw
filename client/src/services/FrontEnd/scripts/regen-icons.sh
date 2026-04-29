#!/usr/bin/env bash
# Regenerate every PWA / app-store icon from public/favicon/source.svg.
# Run this any time the brand mark changes — the SVG is the source of
# truth and produces pixel-crisp output at every target size.
#
# Requires Inkscape (brew install inkscape).

set -euo pipefail
cd "$(dirname "$0")/../public/favicon"

if ! command -v inkscape >/dev/null; then
  echo "inkscape not found — install with: brew install inkscape" >&2
  exit 1
fi

SRC=source.svg
# Parallel arrays — works on macOS's bash 3.2 without -A. Every name in
# NAMES is paired with the same-index entry in SIZES.
NAMES=(
  favicon-16x16.png
  favicon-32x32.png
  apple-touch-icon.png
  favicon-180x180.png
  favicon-apple-180x180.png
  favicon-192x192.png
  android-chrome-192x192.png
  android-chrome-512x512.png
  appstore-1024x1024.png
)
SIZES=(16 32 180 180 180 192 192 512 1024)

for i in "${!NAMES[@]}"; do
  out="${NAMES[$i]}"
  size="${SIZES[$i]}"
  echo "  → $out (${size}×${size})"
  inkscape --export-type=png --export-width="$size" --export-height="$size" --export-filename="$out" "$SRC" >/dev/null 2>&1
done

echo "Done. Don't forget to refresh favicon.ico if needed (use a tool like ImageMagick:"
echo "  magick favicon-16x16.png favicon-32x32.png favicon.ico)"
