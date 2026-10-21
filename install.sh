#!/bin/sh
set -eu

PACKAGE='@obelisk-apps/cli'

if ! command -v node >/dev/null 2>&1; then
  echo 'Obelisk requires Node.js 22.13 or newer.' >&2
  exit 1
fi

if ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)"; then
  echo 'Obelisk requires Node.js 22.13 or newer.' >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo 'Obelisk installation requires npm.' >&2
  exit 1
fi

echo "Installing ${PACKAGE}..."
OBELISK_SKIP_SKILL_INSTALL=1 npm install --global "$PACKAGE"

if ! command -v obelisk >/dev/null 2>&1; then
  echo 'The CLI was installed, but `obelisk` is not on PATH.' >&2
  echo 'Add the npm global bin directory to PATH, then run `obelisk --version`.' >&2
  exit 1
fi

obelisk --version
echo 'Obelisk CLI installed. Run `obelisk install` to install the agent skill.'
