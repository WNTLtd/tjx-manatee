#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <archive.tar.gz> <target_data_dir> <target_uploads_dir>"
  exit 1
fi

ARCHIVE="$1"
TARGET_DATA="$2"
TARGET_UPLOADS="$3"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

tar -xzf "$ARCHIVE" -C "$WORK_DIR"
EXPORT_ROOT="$(find "$WORK_DIR" -maxdepth 1 -type d -name 'truenas-export-*' | head -n 1)"
if [ -z "$EXPORT_ROOT" ]; then
  echo "Could not find export directory in archive."
  exit 1
fi

mkdir -p "$TARGET_DATA" "$TARGET_UPLOADS"

# Sync database files and uploaded assets to final dataset paths.
cp -a "$EXPORT_ROOT/data/." "$TARGET_DATA/"
cp -a "$EXPORT_ROOT/uploads/." "$TARGET_UPLOADS/"

echo "Restore complete:"
echo "  Data    -> $TARGET_DATA"
echo "  Uploads -> $TARGET_UPLOADS"
