// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createClaudeProvider } from '../packages/core/src/providers/claude.ts';
import { createCodexProvider } from '../packages/core/src/providers/codex.ts';
import { createProviderRegistry } from '../packages/core/src/providers/registry.ts';
import { createProviderIndexPlan, indexProviderPlanStrict, writeProviderIndexMarkers } from '../packages/core/src/provider-indexing.ts';
import { persist } from '../packages/core/src/persist.ts';
import { makeTempDir } from './temp-dirs.mjs';

const schema = readFileSync(new URL('../packages/core/src/schema.sql', import.meta.url), 'utf8');
const zoned = '2026-06-10T18:00:00+08:00';
const canonical = '2026-06-10T10:00:00.000Z';
function freshDb() { const db = new DatabaseSync(':memory:'); db.exec(schema); return db; }
for (const [name, create, fixture, subdir, oldMarkers] of [
  ['claude', createClaudeProvider, 'claude/custom-title-session.jsonl', 'projects/project', ['__claude_canonical_transcript_v3__', '__claude_canonical_transcript_v4__']],
  ['codex', createCodexProvider, 'codex/real-rollout-structural-sanitized.jsonl', 'sessions', ['__codex_canonical_transcript_v3__', '__codex_canonical_transcript_v4__']],
]) {
  for (const oldMarker of oldMarkers) {
    test(`${name}: unchanged sources repair legacy timestamps from ${oldMarker} and converge`, () => {
      const root = makeTempDir('obelisk-time-backfill-');
      const dir = join(root, subdir);
      mkdirSync(dir, { recursive: true });
      const rows = readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
      // Preserve the captured provider shape, varying only timestamp values to
      // exercise the old adapter's verbatim zone-carrying representation.
      for (const row of rows) {
        if ('timestamp' in row) row.timestamp = zoned;
        if (row.type === 'session_meta') row.payload.timestamp = zoned;
      }
      writeFileSync(join(dir, 'rollout.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      const provider = create({ rootDir: root });
      const registry = createProviderRegistry([provider]);
      const db = freshDb();
      const fresh = freshDb();
      try {
        const units = provider.discover({ lastCursor: () => null });
        assert.ok(units.length > 0);
        for (const unit of units) {
          persist(db, unit, provider.parse(unit, null));
          persist(fresh, unit, provider.parse(unit, null));
        }
        // Model rows written by the old adapter, retaining the exact current
        // file cursors so only the canonical marker can schedule this repair.
        db.prepare('UPDATE messages SET timestamp=? WHERE timestamp IS NOT NULL').run(zoned);
        db.prepare('UPDATE sessions SET started_at=?,ended_at=?').run(zoned, zoned);
        db.prepare('INSERT INTO index_state(jsonl_path,mtime,lines_processed) VALUES (?,0,0)').run(oldMarker);
        const plan = createProviderIndexPlan(db, registry);
        assert.ok(plan.items.length > 0, 'the new marker schedules unchanged sources');
        const result = indexProviderPlanStrict({ db, plan });
        writeProviderIndexMarkers(db, plan, result);
        const snapshot = handle => ({
          messages: handle.prepare('SELECT uuid,timestamp FROM messages ORDER BY uuid').all(),
          sessions: handle.prepare('SELECT id,started_at,ended_at FROM sessions ORDER BY id').all(),
        });
        assert.deepEqual(snapshot(db), snapshot(fresh));
        assert.ok(snapshot(db).messages.every(row => row.timestamp === null || row.timestamp === canonical));
        assert.equal(createProviderIndexPlan(db, registry).items.length, 0, 'the second refresh does not replay again');
      } finally { db.close(); fresh.close(); }
    });
  }
}
