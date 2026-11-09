// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// Repository dependency installs must not change the contributor's agent skills.
const isCheckout = existsSync(new URL('../../../skill-doc/SKILL.md', import.meta.url));
if (process.env.OBELISK_SKIP_SKILL_INSTALL !== '1' && !isCheckout) {
  const globalInstall = process.env.npm_config_global === 'true';
  const projectDir = process.env.INIT_CWD;
  const retry = globalInstall ? 'obelisk install --global --yes' : 'npx --no-install obelisk install --yes';
  if (!globalInstall && (!projectDir || !isAbsolute(projectDir))) {
    console.warn(`Obelisk CLI installed; unable to determine the invoking project for skill installation. Run \`${retry}\` from your project.`);
  } else {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawnSync(npx, [
      '--yes', 'skills', 'add', 'tommy0103/obelisk-skill', '--skill', 'obelisk', '--yes',
      ...(globalInstall ? ['--global'] : []),
    ], {
      cwd: projectDir || process.cwd(),
      // npx must resolve its own package locally even during a global CLI install.
      env: { ...process.env, npm_config_global: 'false' },
      stdio: 'inherit',
      shell: process.platform === 'win32',
      timeout: 60000,
    });
    if (child.error || child.status !== 0) {
      const cause = child.error?.message ?? (child.signal
        ? `skills installer ended with ${child.signal}`
        : `skills installer exited with code ${child.status}`);
      console.warn(`Obelisk CLI installed; skill installation failed: ${cause}. Retry with \`${retry}\`.`);
    }
  }
}
