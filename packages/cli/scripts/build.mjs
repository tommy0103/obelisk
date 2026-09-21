import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliRoot, '../..');
const outDir = resolve(cliRoot, 'dist');
const tsc = resolve(repoRoot, 'node_modules/typescript/bin/tsc');

rmSync(outDir, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', resolve(cliRoot, 'tsconfig.build.json')], {
  cwd: repoRoot,
  stdio: 'inherit',
});

const schemaTarget = resolve(outDir, 'core/src/schema.sql');
mkdirSync(dirname(schemaTarget), { recursive: true });
copyFileSync(resolve(repoRoot, 'packages/core/src/schema.sql'), schemaTarget);

// tsc emits 0644; restore the bin shebang's executable bit so npm-linked installs keep working.
chmodSync(resolve(outDir, 'cli/src/obelisk.js'), 0o755);
