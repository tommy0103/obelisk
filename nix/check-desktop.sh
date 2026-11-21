#!/usr/bin/env bash
# Run under Xvfb on Linux or in the native macOS GUI session.
set -euo pipefail

desktop=$1
cli=$2
fixture=$3
electron=${4:-$desktop}
work=$(mktemp -d)
desktop_pid=
desktop_status=
crash_marker=$work/.crash-marker
: >"$crash_marker"

# Bash reduces a signalled background job to "Bus error: 10". Name the status so
# a CI log states the reason instead of leaving it inside a job notification.
report_exit() {
  [[ -n $desktop_status ]] || return 0
  if ((desktop_status > 128)); then
    echo "The installed app died from SIG$(kill -l $((desktop_status - 128)) 2>/dev/null || echo $((desktop_status - 128))) (status $desktop_status)" >&2
  else
    echo "The installed app exited with status $desktop_status" >&2
  fi
}

# The crash reporter writes to the passwd home, not to the disposable $HOME, and
# its reports are the only record of which binary faulted.
report_crashes() {
  local dir report
  for dir in "$work/Library/Logs/DiagnosticReports" "/Users/$(id -un)/Library/Logs/DiagnosticReports"; do
    [[ -d $dir ]] || continue
    while IFS= read -r report; do
      printf -- '--- %s ---\n' "${report##*/}" >&2
      head -c 20000 "$report" >&2
      echo >&2
    done < <(find "$dir" -maxdepth 1 -name '*.ips' -newer "$crash_marker" 2>/dev/null)
  done
}

# electron-builder rewrites the main executable and the nested helper bundles after
# the Electron distribution signed them, and mac.identity=null leaves the result
# unsigned, so a store bundle carries a mix of stale and valid signatures. Report
# what the platform sees instead of deciding here: Apple silicon refuses to run code
# whose signature no longer matches, and that refusal surfaces as the app dying.
report_bundle_state() {
  local bundle=$1 item bundles=0 bundles_ok=0 files=0 files_ok=0
  echo "Signatures in $bundle" >&2
  while IFS= read -r item; do
    bundles=$((bundles + 1))
    if codesign --verify --deep --strict "$item" 2>/dev/null; then
      bundles_ok=$((bundles_ok + 1))
    else
      printf 'codesign: %s: seal not verified\n' "${item#"$bundle"/}" >&2
    fi
  done < <(find "$bundle" -type d \( -name '*.app' -o -name '*.framework' \) 2>/dev/null)
  while IFS= read -r item; do
    [[ $item == */Contents/MacOS/* || $item == */Versions/* ]] && continue
    lipo -archs "$item" >/dev/null 2>&1 || continue
    files=$((files + 1))
    if codesign --verify "$item" 2>/dev/null; then
      files_ok=$((files_ok + 1))
    else
      printf 'codesign: %s: not signed\n' "${item#"$bundle"/}" >&2
    fi
  done < <(find "$bundle" -type f \( -perm -111 -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) 2>/dev/null)
  printf 'codesign: %s of %s bundles and %s of %s standalone Mach-O verify\n' \
    "$bundles_ok" "$bundles" "$files_ok" "$files" >&2
}

cleanup() {
  local status=$?
  if [[ -n $desktop_pid ]]; then
    # Only a job that already ended reports its own status; a killed one would
    # otherwise report this script's own SIGTERM as the app's cause of death.
    if ! kill -0 "$desktop_pid" 2>/dev/null; then
      wait "$desktop_pid" 2>/dev/null || desktop_status=$?
    fi
    kill "$desktop_pid" 2>/dev/null || true
    wait "$desktop_pid" 2>/dev/null || true
  fi
  if [[ $status != 0 ]]; then
    if [[ -f $work/desktop.log ]]; then
      printf -- '--- packaged app output ---\n' >&2
      cat "$work/desktop.log" >&2
    fi
    report_exit
    report_crashes
    if [[ $(uname -s) == Darwin ]]; then
      local app=${desktop%/Contents/MacOS/*}
      [[ -d $app ]] && report_bundle_state "$app"
    fi
  fi
  rm -rf "$work"
}
trap cleanup EXIT
project="$work/.claude/projects/nix-smoke"
database="$work/.obelisk/obelisk.sqlite"
session=e3d532d5-1980-4b10-92dc-34bd2af2ea8f
mkdir -p "$project"
cp "$fixture" "$project/$session.jsonl"

# Both processes use default storage in the same disposable home.
isolated=(env -i HOME="$work" PATH="$PATH")
# Electron logs nothing to stderr without this, so a runtime failure leaves no
# trace beyond the signal that ends the process.
flags=(--user-data-dir="$work/user-data" --devtools --remote-debugging-port=0 --enable-logging=stderr)
arch=$(uname -m)
if [[ $(uname -s) == Darwin ]]; then
  # A translated Intel app could otherwise pass on arm64.
  lipo "$desktop" -verify_arch "$arch"
else
  isolated+=(DISPLAY="$DISPLAY" XAUTHORITY="$XAUTHORITY")
  if [[ -n ${FONTCONFIG_FILE:-} ]]; then isolated+=(FONTCONFIG_FILE="$FONTCONFIG_FILE"); fi
  flags+=(--no-sandbox --ozone-platform=x11 --disable-gpu --disable-dev-shm-usage)
fi

# Linux passes the Electron executable used by its app.asar launcher.
"${isolated[@]}" ELECTRON_RUN_AS_NODE=1 timeout 30 "$electron" -e '
  const assert = require("node:assert/strict");
  const { arch, versions: { electron, node, modules: abi } } = process;
  assert.equal(arch, process.argv[1]);
  assert.ok(electron && node && abi, "Missing packaged Electron runtime versions");
  console.log(JSON.stringify({ electron, node, abi, arch }));
' "${arch/x86_64/x64}"
"${isolated[@]}" timeout -k 5 180 "$desktop" "${flags[@]}" >"$work/desktop.log" 2>&1 &
desktop_pid=$!

# The CLI can build an index itself. Verify the desktop wrote the fixture before
# allowing the CLI to open the database.
marker="SELECT count(*) FROM index_state WHERE jsonl_path = '__app_last_successful_build__'"
until [[ $(sqlite3 -readonly "$database" "$marker" 2>/dev/null) == 1 ]]; do
  if ! kill -0 "$desktop_pid" 2>/dev/null; then
    echo "The desktop app exited before finishing its first index" >&2
    exit 1
  fi
  sleep 0.2
done

# A CLI pointed at its own database could index the same fixture. Require the
# desktop-only marker in the query run by both readers.
query="SELECT text FROM messages WHERE session_id = '$session' AND uuid = 'e895cf23-a540-4481-b1d3-9d13799d33e6' AND ($marker) = 1"
expected='Reply with exactly: ok'
if [[ $(sqlite3 -readonly "$database" "$query") != "$expected" ]]; then
  echo "Desktop completed its index without the expected Claude message" >&2
  exit 1
fi
printf 'return sql("%s")[0]?.text;\n' "$query" >"$work/query.mjs"
result=$("${isolated[@]}" timeout 30 "$cli" --query "$work/query.mjs")
if [[ $result != "\"$expected\"" ]]; then
  echo "Expected the installed CLI to retrieve the desktop-indexed Claude message, received: $result" >&2
  exit 1
fi

# Verify Vue mounted the shipped UI, then query its updater through the preload.
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

async function verifyRenderer(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let timer;
  try {
    const response = await new Promise(resolve => {
      // A renderer target may be replaced between discovery and attachment.
      timer = setTimeout(() => resolve(null), 10_000);
      socket.onclose = socket.onerror = () => resolve(null);
      socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
        params: {
          expression: `document.querySelector('#app main') && document.querySelector('#app aside')
            ? window.obelisk.getUpdateState() : null`,
          awaitPromise: true, returnByValue: true,
        } }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message);
      };
    });
    if (!response) return false;
    const { error, result } = response;
    if (error || result.exceptionDetails) throw new Error(JSON.stringify(error || result.exceptionDetails));
    if (result.result.value === null) return false;
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
    if (await verifyRenderer(page)) break;
  }
  if (Date.now() >= deadline) {
    throw new Error(foundPage ? 'Installed renderer did not mount its UI and return its updater state'
      : 'Installed renderer did not appear in DevTools targets');
  }
  await delay(200);
}
JS
