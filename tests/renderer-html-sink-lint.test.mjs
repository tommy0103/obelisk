// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// The renderer HTML-sink rules in eslint.config.js must catch every way to name
// a sink property, in every renderer extension they claim to cover, and every
// v-html that does not say why it is safe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

const sinks = {
  innerHTML: access => `el${access('innerHTML')} = html;`,
  outerHTML: access => `el${access('outerHTML')} = html;`,
  insertAdjacentHTML: access => `el${access('insertAdjacentHTML')}('beforeend', html);`,
};
const forms = {
  dot: name => `.${name}`,
  'single-quoted bracket': name => `['${name}']`,
  'double-quoted bracket': name => `["${name}"]`,
  'template bracket': name => `[\`${name}\`]`,
};

async function lint(source, extension) {
  const [result] = await eslint.lintText(source, {
    filePath: `app/src/renderer/src/html-sink-probe.${extension}`,
  });
  return result.messages;
}

async function sinkReports(code, extension) {
  const typed = extension === 'ts' ? 'el: HTMLElement, html: string' : 'el, html';
  const module = `export function render(${typed}) { ${code} }\n`;
  const source = extension === 'vue' ? `<script>\n${module}</script>\n` : module;
  return (await lint(source, extension)).filter(message => message.ruleId === 'no-restricted-syntax');
}

for (const extension of ['js', 'mjs', 'ts', 'vue']) {
  for (const [sink, write] of Object.entries(sinks)) {
    for (const [form, access] of Object.entries(forms)) {
      test(`renderer .${extension}: ${form} ${sink} is reported`, async () => {
        assert.equal((await sinkReports(write(access), extension)).length, 1);
      });
    }
  }
  test(`renderer .${extension}: textContent is not reported`, async () => {
    assert.deepEqual(await sinkReports(`el['textContent'] = html; el.textContent = html;`, extension), []);
  });
}

const vHtml = comment => `<template>\n  <div>\n    ${comment}<div v-html="html"></div>\n  </div>\n</template>\n`;
const vHtmlReports = async source => (await lint(source, 'vue')).map(message => message.ruleId);

test('renderer .vue: v-html is reported', async () => {
  assert.deepEqual(await vHtmlReports(vHtml('')), ['vue/no-v-html']);
});

test('renderer .vue: v-html under a disable comment is not reported', async () => {
  const comment = '<!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown() -->\n    ';
  assert.deepEqual(await vHtmlReports(vHtml(comment)), []);
});
