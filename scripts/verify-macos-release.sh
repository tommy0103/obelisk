#!/bin/bash
set -euo pipefail
release_dir="$(cd "$1" && pwd)"
audit_dir="$(mktemp -d)"
mount_dir="$audit_dir/dmg"
cleanup() {
  if [[ -d "$mount_dir" ]]; then hdiutil detach "$mount_dir" -quiet || true; fi
  rm -rf "$audit_dir"
}
trap cleanup EXIT
verify_app() {
  codesign --verify --deep --strict --verbose=2 "$1"
}
zip_count=0
for archive in "$release_dir"/*.zip; do
  [[ -f "$archive" ]] || continue
  zip_count=$((zip_count+1))
  ditto -x -k "$archive" "$audit_dir/zip"
  verify_app "$audit_dir/zip/Obelisk.app"
  rm -rf "$audit_dir/zip"
done
[[ "$zip_count" -gt 0 ]] || { echo "Missing macOS ZIP"; exit 1; }
dmg_count=0
for archive in "$release_dir"/*.dmg; do
  [[ -f "$archive" ]] || continue
  dmg_count=$((dmg_count+1))
  hdiutil attach "$archive" -nobrowse -readonly -mountpoint "$mount_dir" -quiet
  verify_app "$mount_dir/Obelisk.app"
  hdiutil detach "$mount_dir" -quiet
  rmdir "$mount_dir" 2>/dev/null || true
done
[[ "$dmg_count" -gt 0 ]] || { echo "Missing macOS DMG"; exit 1; }
