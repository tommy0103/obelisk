// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Tests point HOME at a makeTempDir() home, but providers find some stores
// through environment variables first: OpenCode reads $XDG_DATA_HOME before
// ~/.local/share. A value inherited from the developer's shell would aim the
// test at the real store on that machine. `npm test` loads this module into
// every test-file process with --import, so each test starts from an
// environment that names no host store and sets the variables it needs.
export const HOST_STORE_ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'OBELISK_HOME',
  'OBELISK_USE_XDG',
  'OPENCODE_DB',
  'CODEXHOST_DATA_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'KIMI_CODE_HOME',
  'HERMES_HOME',
  'DSH_HOME',
];

for (const key of HOST_STORE_ENV_KEYS) delete process.env[key];
