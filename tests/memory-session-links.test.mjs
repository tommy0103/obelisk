import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectInlineSessionCandidates,
  inlineCodeSessionCandidate,
} from '../app/src/renderer/src/memory-session-links.mjs';

function inlineCode(text, { fenced = false } = {}) {
  return {
    textContent: text,
    closest(selector) {
      return fenced && selector === 'pre' ? {} : null;
    },
  };
}

test('collects whole inline-code values without assuming a provider or ID format', () => {
  const codexId = 'codex:019f6392-0dba-7f13-be12-541db3645a69';
  const providerNeutralId = 'claude-session-id';
  const ordinaryCode = 'npm test';
  const nodes = [
    inlineCode(codexId),
    inlineCode(`  ${providerNeutralId}  `),
    inlineCode(ordinaryCode),
    inlineCode(codexId),
    inlineCode(codexId, { fenced: true }),
  ];

  assert.deepEqual(
    collectInlineSessionCandidates({ querySelectorAll: () => nodes }),
    [codexId, providerNeutralId, ordinaryCode],
  );
});

test('ignores fenced, empty, and unreasonably large code values before DB lookup', () => {
  assert.equal(inlineCodeSessionCandidate(inlineCode('codex:session', { fenced: true })), null);
  assert.equal(inlineCodeSessionCandidate(inlineCode('   ')), null);
  assert.equal(inlineCodeSessionCandidate(inlineCode('x'.repeat(513))), null);
});

test('bounds the number of inline-code candidates sent for exact lookup', () => {
  const nodes = Array.from({ length: 120 }, (_, index) => inlineCode(`candidate-${index}`));
  const candidates = collectInlineSessionCandidates({ querySelectorAll: () => nodes });
  assert.equal(candidates.length, 100);
  assert.equal(candidates.at(-1), 'candidate-99');
});
