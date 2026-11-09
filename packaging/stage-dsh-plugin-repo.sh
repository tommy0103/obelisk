#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-}"
PLUGIN_DIR="${2:-$ROOT_DIR/packages/dsh-plugin}"

if [ -z "$TARGET_DIR" ]; then
  echo "Usage: packaging/stage-dsh-plugin-repo.sh <target-repo> [plugin-artifact]" >&2
  exit 1
fi

if [ "$TARGET_DIR" = "/" ] || [ "$TARGET_DIR" = "." ] || [ "$TARGET_DIR" = "$ROOT_DIR" ] || [ "$TARGET_DIR" = "$PLUGIN_DIR" ]; then
  echo "Error: refusing to replace unsafe target directory: $TARGET_DIR" >&2
  exit 1
fi

for required in package.json obelisk.cordis.yml dist/index.js dist/index.d.ts; do
  if [ ! -e "$PLUGIN_DIR/$required" ]; then
    echo "Error: plugin artifact missing $required at $PLUGIN_DIR" >&2
    exit 1
  fi
done

mkdir -p "$TARGET_DIR"
find "$TARGET_DIR" -mindepth 1 \
  ! -path "$TARGET_DIR/.git" \
  ! -path "$TARGET_DIR/.git/*" \
  -delete

cp -R "$PLUGIN_DIR/dist" "$TARGET_DIR/dist"
cp "$PLUGIN_DIR/package.json" "$TARGET_DIR/package.json"
cp "$PLUGIN_DIR/obelisk.cordis.yml" "$TARGET_DIR/obelisk.cordis.yml"
cp "$ROOT_DIR/packaging/dsh-plugin-README.md" "$TARGET_DIR/README.md"
cp "$ROOT_DIR/LICENSE" "$TARGET_DIR/LICENSE"
