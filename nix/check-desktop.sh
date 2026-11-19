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
  lipo "$desktop" -verify_arch "$arch"
  runtime_arch=$("${isolated[@]}" ELECTRON_RUN_AS_NODE=1 timeout 10 "$desktop" -p process.arch)
  if [[ $runtime_arch != "${arch/x86_64/x64}" ]]; then
    echo "Packaged Electron runs as $runtime_arch on the $arch runner" >&2
    exit 1
  fi
else
  isolated+=(DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY")
  if [[ -n ${FONTCONFIG_FILE:-} ]]; then isolated+=(FONTCONFIG_FILE="$FONTCONFIG_FILE"); fi
  flags+=(--no-sandbox --ozone-platform=x11 --disable-gpu --disable-dev-shm-usage)
fi
"${isolated[@]}" timeout -k 5 180 "$desktop" "${flags[@]}" >"$work/desktop.log" 2>&1 &
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
timeout 100 node --input-type=module - "$work/user-data/DevToolsActivePort" <<'JS'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

async function rendererPage() {
  const portFile = await readFile(process.argv[2], 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const port = portFile.split('\n')[0];
  if (!port) return;
  const signal = AbortSignal.timeout(10_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal });
    if (!response.ok) throw new Error(`DevTools target discovery returned HTTP ${response.status}`);
    return (await response.json()).find(tab => tab.type === 'page' && tab.url.includes('/out/renderer/index.html'));
  } catch (error) {
    // Electron may publish the port before it accepts connections or responds.
    if (!signal.aborted && !['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(error.cause?.code)) throw error;
  }
}

async function verifyUpdatesDisabled(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let timer;
  try {
    const response = await new Promise(resolve => {
      // A renderer target may be replaced between discovery and attachment.
      timer = setTimeout(() => resolve(null), 10_000);
      socket.onclose = socket.onerror = () => resolve(null);
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
        params: { expression: 'window.obelisk.getUpdateState()', awaitPromise: true, returnByValue: true } }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message);
      };
    });
    if (!response) return false;
    const { error, result } = response;
    if (error || result.exceptionDetails) throw new Error(JSON.stringify(error || result.exceptionDetails));
    assert.equal(result.result.value.phase, 'disabled');
    assert.equal(result.result.value.backend, null);
    return true;
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}

const deadline = Date.now() + 60_000;
let foundPage = false;
while (true) {
  const page = await rendererPage();
  if (page) {
    foundPage = true;
    if (await verifyUpdatesDisabled(page)) break;
  }
  if (Date.now() >= deadline) {
    throw new Error(foundPage ? 'Installed renderer did not return its updater state'
      : 'Installed renderer did not appear in DevTools targets');
  }
  await delay(200);
}
JS
