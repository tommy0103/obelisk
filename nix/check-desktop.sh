#!/usr/bin/env bash
# Run under Xvfb on Linux or in the native macOS GUI session.
set -euo pipefail

desktop=$1
cli=$2
fixture=$3
work=$(mktemp -d)
desktop_pid=
cleanup() {
  if [[ $? != 0 && -f $work/desktop.log ]]; then cat "$work/desktop.log" >&2; fi
  if [[ -n $desktop_pid ]]; then
    kill "$desktop_pid" 2>/dev/null || true
    wait "$desktop_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT
project="$work/.claude/projects/nix-smoke"
database="$work/.obelisk/obelisk.sqlite"
mkdir -p "$project"
cp "$fixture" "$project/e3d532d5-1980-4b10-92dc-34bd2af2ea8f.jsonl"

# Both processes use default storage in the same disposable home.
isolated=(env -i HOME="$work" PATH="$PATH")
flags=(--user-data-dir="$work/user-data" --devtools --remote-debugging-port=0)
if [[ $(uname -s) == Darwin ]]; then
  # Exercise the bundle directly, including Finder's entry point and the native
  # Electron runtime. A translated Intel app could otherwise pass on arm64.
  arch=$(uname -m)
  lipo -verify_arch "$arch" "$desktop"
  runtime_arch=$("${isolated[@]}" ELECTRON_RUN_AS_NODE=1 timeout 10 "$desktop" -p process.arch)
  if [[ $runtime_arch != "${arch/x86_64/x64}" ]]; then
    echo "Packaged Electron runs as $runtime_arch on the $arch runner" >&2
    exit 1
  fi
else
  isolated+=(DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY")
  flags+=(--no-sandbox --ozone-platform=x11 --disable-dev-shm-usage)
fi
"${isolated[@]}" timeout -k 5 60 "$desktop" "${flags[@]}" >"$work/desktop.log" 2>&1 &
desktop_pid=$!

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

# Read the updater state from the running renderer through the shipped preload.
timeout 20 node --input-type=module - "$work/user-data/DevToolsActivePort" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

let page;
while (!page) {
  const portFile = await readFile(process.argv[2], 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const port = portFile.split('\n')[0];
  if (port) {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
    page = (await response.json()).find(tab => tab.type === 'page' && tab.url.includes('/out/renderer/index.html'));
  }
  if (!page) await delay(100);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
try {
  const state = await new Promise((resolve, reject) => {
    socket.onerror = () => reject(new Error('Failed to connect to the installed renderer'));
    socket.onclose = () => reject(new Error('The installed renderer disconnected'));
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
      params: { expression: 'window.obelisk.getUpdateState()', awaitPromise: true, returnByValue: true } }));
    socket.onmessage = event => {
      const { id, error, result } = JSON.parse(event.data);
      if (id !== 1) return;
      if (error || result.exceptionDetails) reject(new Error(JSON.stringify(error || result.exceptionDetails)));
      else resolve(result.result.value);
    };
  });
  assert.equal(state.phase, 'disabled');
  assert.equal(state.backend, null);
} finally {
  socket.close();
}
JS
