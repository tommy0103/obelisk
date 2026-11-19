#!/usr/bin/env bash
# Run under Xvfb with the installed desktop launcher, CLI and captured Claude fixture.
set -euo pipefail

desktop=$1
cli=$2
fixture=$3
work=$(mktemp -d)
project="$work/.claude/projects/nix-smoke"
database="$work/.obelisk/obelisk.sqlite"
mkdir -p "$project"
cp "$fixture" "$project/e3d532d5-1980-4b10-92dc-34bd2af2ea8f.jsonl"

# Both processes use default storage in the same disposable home.
isolated=(env -i HOME="$work" PATH="$PATH" DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY")
"${isolated[@]}" timeout -k 5 60 "$desktop" --no-sandbox --ozone-platform=x11 \
  --disable-dev-shm-usage >"$work/desktop.log" 2>&1 &
desktop_pid=$!
cleanup() {
  if [[ $? != 0 ]]; then cat "$work/desktop.log" >&2; fi
  kill "$desktop_pid" 2>/dev/null || true
  wait "$desktop_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# The CLI can build an index itself. Wait for the desktop's own completed build
# before invoking the CLI, then require the app-only marker in the CLI's query.
marker="SELECT count(*) FROM index_state WHERE jsonl_path = '__app_last_successful_build__'"
until [[ $(sqlite3 -readonly "$database" "$marker" 2>/dev/null) == 1 ]]; do
  if ! kill -0 "$desktop_pid" 2>/dev/null; then
    echo "The desktop app exited before finishing its first index" >&2
    exit 1
  fi
  sleep 0.2
done

cat >"$work/query.mjs" <<'JS'
return sql("SELECT text FROM messages WHERE EXISTS (SELECT 1 FROM index_state WHERE jsonl_path = '__app_last_successful_build__')")[0]?.text;
JS
result=$("${isolated[@]}" timeout 30 "$cli" --query "$work/query.mjs")
if [[ $result != '"Reply with exactly: ok"' ]]; then
  echo "Expected the installed CLI to retrieve the desktop-indexed Claude message, received: $result" >&2
  exit 1
fi
