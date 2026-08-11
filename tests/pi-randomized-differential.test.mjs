import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createPiProvider } from '../packages/core/src/providers/pi.ts';
import {
  buildCodingAgentContextEntries,
  buildCodingAgentSessionPath,
  buildAgentCoreSessionPath,
  defaultAgentCoreContextEntryTransform,
  PI_CONTEXT_ORACLE_VERSION,
  pi083LeafId,
  projectCanonicalEvidence,
} from './fixtures/pi/pi-0.83.0-context-oracle.mjs';
import { makeTempDir } from './temp-dirs.mjs';

const CASES = 512;
const SEED = 0x5eedc0de;

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function integer(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

function timestamp(caseIndex, entryIndex) {
  return new Date(Date.UTC(2026, 7, 2, 12, caseIndex % 30, entryIndex)).toISOString();
}

function actualEvidence(records) {
  return records.flatMap((record) => {
    if (record.kind === 'message' && record.visibility === 'visible') {
      return [JSON.stringify({
        kind: 'message',
        source: null,
        role: record.role,
        content: record.text,
      })];
    }
    if (record.kind === 'summary' && record.visibility === 'visible') {
      return [JSON.stringify({
        kind: 'summary',
        source: record.source,
        role: null,
        content: record.content,
      })];
    }
    return [];
  });
}

function drain(generator) {
  const records = [];
  for (;;) {
    const step = generator.next();
    if (step.done) return records;
    records.push(step.value);
  }
}

function createCase(random, caseIndex, totals) {
  const entries = [];
  const ids = [];
  let headId = null;
  const entryCount = integer(random, 8, 64);
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    const id = `case-${caseIndex}-entry-${entryIndex}`;
    const time = timestamp(caseIndex, entryIndex);
    const roll = random();
    let entry;

    if (roll < 0.08 && ids.length > 0) {
      const targetId = random() < 0.12 ? null : ids[integer(random, 0, ids.length - 1)];
      entry = { type: 'leaf', id, parentId: headId, timestamp: time, targetId };
      headId = targetId;
      totals.leaves++;
      if (targetId === null) totals.nullLeaves++;
    } else {
      let parentId = headId;
      if (random() < 0.06) {
        parentId = `omitted-${caseIndex}-${entryIndex}`;
        totals.orphanParents++;
      } else if (ids.length > 0 && random() < 0.28) {
        parentId = ids[integer(random, 0, ids.length - 1)];
      }

      if (roll < 0.72) {
        entry = {
          type: 'message',
          id,
          parentId,
          timestamp: time,
          message: {
            role: 'user',
            content: `entry:${id}`,
            timestamp: Date.parse(time),
          },
        };
        totals.messages++;
      } else if (roll < 0.84) {
        entry = {
          type: 'branch_summary',
          id,
          parentId,
          timestamp: time,
          fromId: parentId ?? id,
          summary: `branch:${id}`,
        };
        totals.branchSummaries++;
      } else if (roll < 0.96) {
        const retained = random() < 0.5;
        entry = {
          type: 'compaction',
          id,
          parentId,
          timestamp: time,
          summary: `compaction:${id}`,
          tokensBefore: integer(random, 0, 100_000),
          ...(retained
            ? {
                retainedTail: [{
                  role: 'user',
                  content: `tail:${id}`,
                  timestamp: Date.parse(time),
                }],
              }
            : { firstKeptEntryId: parentId }),
        };
        totals.compactions++;
        if (retained) totals.retainedTailCompactions++;
      } else {
        entry = {
          type: 'model_change',
          id,
          parentId,
          timestamp: time,
          provider: 'probe',
          modelId: 'probe',
        };
      }
      headId = id;
    }

    entries.push(entry);
    ids.push(id);
    totals.entries++;
  }
  return {
    header: {
      type: 'session',
      version: 3,
      id: `differential-${caseIndex}`,
      timestamp: timestamp(caseIndex, 0),
      cwd: `/tmp/obelisk-pi-differential/project-${caseIndex}`,
    },
    entries,
  };
}

test('fixed-seed randomized differential matches vendored Pi 0.83.0 context oracles', () => {
  assert.equal(PI_CONTEXT_ORACLE_VERSION, '0.83.0');
  const random = randomGenerator(SEED);
  const root = makeTempDir('obelisk-pi-randomized-differential-');
  const generated = [];
  const totals = {
    cases: CASES,
    entries: 0,
    messages: 0,
    leaves: 0,
    nullLeaves: 0,
    compactions: 0,
    retainedTailCompactions: 0,
    branchSummaries: 0,
    orphanParents: 0,
    retainedCheckpointPathCases: 0,
    mixedCheckpointLegacyCases: 0,
  };

  for (let caseIndex = 0; caseIndex < CASES; caseIndex++) {
    const generatedCase = createCase(random, caseIndex, totals);
    generated.push(generatedCase);
    const path = join(root, `case-${caseIndex}`, 'session.jsonl');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${[generatedCase.header, ...generatedCase.entries].map(record => JSON.stringify(record)).join('\n')}\n`,
    );
  }

  const provider = createPiProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, CASES);
  for (const unit of units) {
    const caseIndex = Number(/case-(\d+)/.exec(unit.key)?.[1]);
    const entries = generated[caseIndex].entries;
    const leafId = pi083LeafId(entries);
    const fullPath = buildCodingAgentSessionPath(entries, leafId);
    const codingAgentContext = buildCodingAgentContextEntries(entries, leafId);
    const agentCoreContext = defaultAgentCoreContextEntryTransform(
      buildAgentCoreSessionPath(entries, leafId),
    );
    // Pi 0.83's CLI owns legacy firstKeptEntryId semantics. retainedTail is the
    // agent-core storage checkpoint format, so mixed/new chains use its bounded
    // storage path before the context transform.
    let checkpointIndex = -1;
    for (let index = 0; index < fullPath.length; index++) {
      const entry = fullPath[index];
      if (entry.type === 'compaction' && entry.retainedTail !== undefined) {
        checkpointIndex = index;
      }
    }
    if (checkpointIndex >= 0) {
      totals.retainedCheckpointPathCases++;
      if (fullPath.slice(checkpointIndex + 1).some(entry => (
        entry.type === 'compaction' && entry.retainedTail === undefined
      ))) {
        totals.mixedCheckpointLegacyCases++;
      }
    }
    const expectedContext = checkpointIndex >= 0
      ? agentCoreContext
      : codingAgentContext;
    assert.deepEqual(
      actualEvidence(drain(provider.parse(unit, null))),
      projectCanonicalEvidence(entries, expectedContext),
      `seed 0x${SEED.toString(16)}, case ${caseIndex}`,
    );
  }

  assert.deepEqual(totals, {
    cases: 512,
    entries: 18124,
    messages: 11586,
    leaves: 1457,
    nullLeaves: 167,
    compactions: 2230,
    retainedTailCompactions: 1137,
    branchSummaries: 2191,
    orphanParents: 1060,
    retainedCheckpointPathCases: 175,
    mixedCheckpointLegacyCases: 32,
  });
});
