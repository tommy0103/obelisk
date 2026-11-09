// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(repoRoot, 'skill-doc');
const target = resolve(repoRoot, 'dist/obelisk-skill');

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(resolve(source, 'SKILL.md'), resolve(target, 'SKILL.md'));
cpSync(resolve(source, 'references'), resolve(target, 'references'), { recursive: true });
cpSync(resolve(repoRoot, 'packaging/skill-package.json'), resolve(target, 'package.json'));
