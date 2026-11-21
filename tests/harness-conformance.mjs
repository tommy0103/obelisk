// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// What every provider's records must say about who wrote a message (ADR-0007;
// docs/usf-spec.md, section 5). A consumer of the canonical records never looks
// at the provider and never reads message text, so a message the harness wrote
// has to say so in its fields, the same way for every provider.
//
// Each provider's own tests call assertHarnessConformance() on complete parses
// (cursor = null) of its real fixtures; tests/provider-harness-conformance.test.mjs
// checks that none of the built-in providers is left out.

import assert from 'node:assert/strict';

import { USF_HARNESS_KINDS, assembleUsf, publishedUsf, validateUsf } from '../packages/core/src/usf.ts';

const short = (text) => (text == null ? 'no text' : JSON.stringify(String(text).slice(0, 40)));

/** The ways `records` break the contract, as text. Empty when they conform. */
export function harnessContractProblems(records) {
  const all = [...records];
  const problems = [];
  for (const record of all) {
    if (record.kind === 'message') {
      const where = `message ${record.uuid} (role ${record.role}, ${short(record.text)})`;
      const kind = record.harness_kind ?? null;
      if (kind !== null && !USF_HARNESS_KINDS.includes(kind)) {
        problems.push(`${where}: harness_kind ${JSON.stringify(kind)} is not a known kind`);
      }
      // `is_meta` only takes a message out of default retrieval. What it is, is said separately.
      if (record.is_meta && kind === null) problems.push(`${where}: is_meta without a harness_kind`);
      // A role other than user and assistant is the harness speaking, unless the
      // message only brings a tool result back.
      if (record.role !== 'user' && record.role !== 'assistant' && record.content_type !== 'tool_result' && kind === null) {
        problems.push(`${where}: neither the person's nor the model's, and no harness_kind`);
      }
    } else if (record.kind === 'session' && record.started_by != null && record.started_by !== 'agent') {
      problems.push(`session ${record.id}: started_by ${JSON.stringify(record.started_by)} is neither "agent" nor empty`);
    }
  }
  // The records must also assemble into sessions the format accepts: among
  // other things, a session a sub-agent started has no submission of a person's.
  for (const { session } of assembleUsf(all).sessions) {
    for (const problem of validateUsf(session)) problems.push(`session ${session.id}, local form: ${problem}`);
    for (const problem of validateUsf(publishedUsf(session), { profile: 'published' })) {
      problems.push(`session ${session.id}, published form: ${problem}`);
    }
  }
  return problems;
}

/** Fails with every way `records` break the contract. */
export function assertHarnessConformance(records) {
  assert.deepEqual(harnessContractProblems(records), []);
}
