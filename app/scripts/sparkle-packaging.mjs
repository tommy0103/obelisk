// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Arch } from 'builder-util';

export async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const arch = Arch[context.arch];
  if (!['arm64', 'x64'].includes(arch)) throw new Error('macOS updates require separate arm64 and x64 packages');
  const key = (await readFile(fileURLToPath(new URL('../build/sparkle-public-key.txt', import.meta.url)), 'utf8')).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, 'base64').length !== 32) throw new Error('Invalid Sparkle public key');
  if (process.env.SPARKLE_ED_PUBLIC_KEY && process.env.SPARKLE_ED_PUBLIC_KEY.trim() !== key) {
    throw new Error('SPARKLE_ED_PUBLIC_KEY does not match the trusted key in app/build/sparkle-public-key.txt');
  }
  context.packager.config.mac.extendInfo = {
    ...context.packager.config.mac.extendInfo,
    SUFeedURL: `https://github.com/tommy0103/obelisk/releases/latest/download/appcast-${arch}.xml`,
    SUPublicEDKey: key,
    SUEnableInstallerLauncherService: false,
    SUAutomaticallyUpdate: false,
    SUVerifyUpdateBeforeExtraction: true,
    SUScheduledCheckInterval: 3600,
    SUDeltaChainHistory: 0,
    CFBundleLocalizations: ['en'],
  };
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/electron-sparkle-updater/bin/electron-sparkle-updater.js', 'rebuild', '--arch', arch],
      { cwd: context.packager.projectDir, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Sparkle rebuild failed (${code})`)));
  });
}
export default beforePack;
