// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// One flat config for every tracked JS/TS source, including the Electron app.
// Vue single-file components are not linted. Every rule is an error: a warning
// that CI tolerates is a rule nobody follows.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const unusedVars = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }];

const htmlSinkMessage = 'Transcript text is attacker-controlled. Build markup with renderMarkdown()/escapeHTML() in utils.js or DOM APIs.';

// el.innerHTML, el['innerHTML'] and el[`innerHTML`] name the same sink.
function htmlSinkSelectors(node, member, names) {
  return [
    `${node}[${member}.property.name=${names}]`,
    `${node}[${member}.property.value=${names}]`,
    `${node}[${member}.property.expressions.length=0][${member}.property.quasis.0.value.cooked=${names}]`,
  ].map(selector => ({ selector, message: htmlSinkMessage }));
}

// Raw tmpdir() paths leak (ENOSPC) and differ from realpath on macOS, where
// /var/folders is a symlink to /private/var/folders.
const tmpdirMessage = 'Use makeTempDir() from tests/temp-dirs.mjs: it returns a realpath and removes the directory when the test process exits.';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'app/out/**',
      'app/release/**',
      'release/**',
      '.dev.docs/**',
      '.obelisk/**',
      '.claude/**',
    ],
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Best-effort probes (JSON.parse, fs.stat on a racing file) may ignore failures.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    rules: { 'no-unused-vars': unusedVars },
  },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': unusedVars,
      // Provider adapters parse untyped external transcript JSON; `any` at those
      // boundaries is deliberate.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['app/src/renderer/**/*.{js,mjs,ts}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // CONTRIBUTING: transcript content is attacker-controlled.
      'no-restricted-syntax': ['error',
        ...htmlSinkSelectors('AssignmentExpression', 'left', '/^(innerHTML|outerHTML)$/'),
        ...htmlSinkSelectors('CallExpression', 'callee', "/^insertAdjacentHTML$/"),
      ],
    },
  },
  {
    files: ['app/src/main/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', {
        object: 'shell',
        property: 'openPath',
        message: 'macOS executes .app/.command/.sh files passed to shell.openPath. Resolve transcript paths with resolveFileReference() in file-reference.ts and open them in the editor.',
      }],
    },
  },
  {
    files: ['tests/**/*.{js,mjs,ts}'],
    ignores: ['tests/temp-dirs.mjs'],
    rules: {
      'no-restricted-imports': ['error', ...['os', 'node:os'].map(name => ({
        name, importNames: ['tmpdir'], message: tmpdirMessage,
      }))],
      'no-restricted-properties': ['error', { object: 'os', property: 'tmpdir', message: tmpdirMessage }],
    },
  },
);
