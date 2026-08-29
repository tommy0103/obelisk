#!/usr/bin/env node
// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only


import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  DB_PATH,
  buildIndex,
  searchText,
  executeQuery,
  executeAttune,
} from '../../core/src/core.ts';

async function main() {
  const args = process.argv.slice(2);
  const fail = (value: unknown): void => {
    const error = value instanceof Error ? value : new Error(String(value));
    process.stdout.write(JSON.stringify({ error: error.message, stack: error.stack }) + '\n');
    process.exitCode = 1;
  };
  const emit = (value: unknown): void => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  };

  if (args[0] === '--version' || args[0] === '-v') {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  if (args[0] === '--build') {
    try {
      const result = buildIndex({ force: true });
      if (!('complete' in result) || result.complete !== true) {
        const reason = 'reason' in result && typeof result.reason === 'string'
          ? result.reason
          : 'incomplete_snapshot';
        const issue = 'inventoryIssues' in result && Array.isArray(result.inventoryIssues)
          ? result.inventoryIssues[0] as { provider?: unknown; path?: unknown; error?: unknown } | undefined
          : undefined;
        let detail = '';
        if ('error' in result && typeof result.error === 'string') {
          detail = ` (${result.error})`;
        } else if (
          issue
          && typeof issue.provider === 'string'
          && typeof issue.path === 'string'
          && typeof issue.error === 'string'
        ) {
          detail = ` (${issue.provider} at ${issue.path}: ${issue.error})`;
        }
        throw new Error(`Index rebuild was not published: ${reason}${detail}`);
      }
      process.stdout.write(JSON.stringify({ ok: true, db: DB_PATH }) + '\n');
    } catch (error) { fail(error); }
    return;
  }
  if (args[0] === '--search' && args[1]) {
    try {
      // --nonce <token> marks this invocation in the transcript so the query
      // layer can identify the invoking session; it is not part of the FTS text.
      let nonce: string | undefined;
      const textParts: string[] = [];
      const rest = args.slice(1);
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--nonce' && rest[i + 1]) { nonce = rest[i + 1]; i++; } else { textParts.push(rest[i]); }
      }
      emit(searchText(textParts.join(' '), undefined, { invocationNonce: nonce }));
    } catch (error) { fail(error); }
    return;
  }
  if (args[0] === '--query' && args[1]) {
    try {
      const script = readFileSync(resolve(args[1]), 'utf8');
      // Nonce candidates, tried in order: the file path as typed (not
      // resolved), then the script content itself. The transcript records the
      // content verbatim (Write input, heredoc command text) even when the
      // path sits behind a shell variable — the documented mktemp flow — and
      // never reaches the transcript. Short scripts are not distinctive enough
      // to safely identify a session, so the path stands alone there. Content
      // is not unique by construction, so it resolves in strict mode: exactly
      // one recent matching session that itself invoked the CLI, else null.
      const CONTENT_NONCE_MIN_CHARS = 40;
      const trimmed = script.trim();
      const nonceCandidates = trimmed.length >= CONTENT_NONCE_MIN_CHARS
        ? [args[1], { value: trimmed, strict: true }]
        : [args[1]];
      emit(await executeQuery(script, { invocationNonce: nonceCandidates }));
    } catch (error) { fail(error); }
    return;
  }
  if (args[0] === '--attune' && args[1]) {
    try { emit(await executeAttune(readFileSync(resolve(args[1]), 'utf8'))); } catch (error) { fail(error); }
    return;
  }
  if (args[0] === 'install') {
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawnSync(
      npx,
      ['--yes', 'skills', 'add', 'tommy0103/obelisk-skill', ...args.slice(1)],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (child.error) {
      process.stderr.write(`Unable to run the skills installer: ${child.error.message}\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = child.status ?? 1;
    }
    return;
  }
  process.stderr.write('Usage:\n  obelisk install [skills options]\n  obelisk --build\n  obelisk --search "text" [--nonce <token>]\n  obelisk --query <file.js>\n  obelisk --attune <file.js>\n');
  process.exitCode = 1;
}

void main();
