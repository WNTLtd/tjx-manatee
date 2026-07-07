#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT_DIR/backups"
EXPORT_DIR="$OUT_DIR/truenas-export-$STAMP"
ARCHIVE="$OUT_DIR/truenas-export-$STAMP.tar.gz"

mkdir -p "$EXPORT_DIR" "$OUT_DIR"

# Copy current persistent data for migration to TrueNAS datasets.
mkdir -p "$EXPORT_DIR/data" "$EXPORT_DIR/uploads"
if [ -d "$ROOT_DIR/data" ]; then
  cp -a "$ROOT_DIR/data/." "$EXPORT_DIR/data/"
fi
if [ -d "$ROOT_DIR/src/public/uploads" ]; then
  cp -a "$ROOT_DIR/src/public/uploads/." "$EXPORT_DIR/uploads/"
fi

# Include deployment files so NAS setup can be reproduced.
cp "$ROOT_DIR/docker-compose.yml" "$EXPORT_DIR/"
cp "$ROOT_DIR/Dockerfile" "$EXPORT_DIR/"
cp "$ROOT_DIR/.env.example" "$EXPORT_DIR/"
cp "$ROOT_DIR/README.md" "$EXPORT_DIR/"

# Create compressed archive and checksum.
tar -czf "$ARCHIVE" -C "$OUT_DIR" "$(basename "$EXPORT_DIR")"
shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256"

echo "Export complete:"
echo "  Archive: $ARCHIVE"
echo "  SHA256 : $ARCHIVE.sha256"
echo ""
echo "Next: copy this archive to your TrueNAS host and extract into datasets."
