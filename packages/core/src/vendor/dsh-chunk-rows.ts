// Vendored from DeepSeek Harness — github.com/deepseek-ai/deepseek-harness.
//
// Upstream source file (MIT License, Copyright (c) DeepSeek AI):
//   packages/core/session/src/chunk-rows.ts
// Vendored at commit 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
// (last touch 25dcd7293c "docs: purge chain-of-thought leakage from prose").
//
// Adapted for Obelisk: this is a read-only port of the lossless storage
// codec's DECODE side (`decodeStorageRecord` / `validateRow` / `expandRow`).
// The write-side encoder (`packChunkRuns`) is omitted and the `@deepseek-ai/*`
// type imports are replaced by minimal local types, so the module is
// self-contained. Validation and expansion follow upstream verbatim. See
// vendor/README.md for the sync procedure.
//
// DeepSeek Harness packs runs of ≥3 consecutive same-block `assistant/chunk`
// delta events into ONE storage row — `text-chunks`, `reasoning-chunks`, or
// `tool-call-chunks` — to shrink the log. Member k reconstructs as seq
// `seq0 + k` and time `time0` plus the first k `dt` gaps. A malformed row
// throws rather than silently dropping a whole run.

/** One reconstructed session event (a minimal SessionEvent projection). */
export interface DshEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

interface ChunkRow {
  type: 'text-chunks' | 'reasoning-chunks' | 'tool-call-chunks';
  seq0: number;
  time0: number;
  data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
}

/** Throw the uniform malformed-row diagnostic. */
function malformed(tag: string, why: string): never {
  throw new Error(`malformed ${tag} storage row: ${why}`);
}

/** Validate the shared run-data fields and the payload/dt arity; returns the member payload. */
function validateRunData(tag: string, data: Record<string, unknown>, payloadKey: 'texts' | 'args'): string[] {
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    malformed(tag, 'turn/step/index must be numbers');
  }
  const payload = data[payloadKey];
  if (!Array.isArray(payload) || payload.length === 0 || payload.some(entry => typeof entry !== 'string')) {
    malformed(tag, `${payloadKey} must be a non-empty string array`);
  }
  const dt = data.dt;
  if (!Array.isArray(dt) || dt.some(gap => !Number.isSafeInteger(gap))) {
    malformed(tag, 'dt must be an array of safe integers');
  }
  if (dt.length !== payload.length - 1) {
    malformed(tag, `dt length ${dt.length} does not match ${payload.length} members`);
  }
  return payload as string[];
}

/** Validate a row-tagged parsed value's envelope and data, throwing on any malformation. */
function validateRow(value: Record<string, unknown>, tag: ChunkRow['type']): ChunkRow {
  if (!hasExactKeys(value, ['type', 'seq0', 'time0', 'data'])) {
    malformed(tag, 'envelope must be exactly {type, seq0, time0, data}');
  }
  if (!Number.isSafeInteger(value.seq0) || (value.seq0 as number) < 0) {
    malformed(tag, 'seq0 must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(value.time0)) {
    malformed(tag, 'time0 must be a safe integer');
  }
  const data = value.data;
  if (!isRecord(data)) malformed(tag, 'data must be an object');
  let payload: string[];
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args']);
    if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) {
      malformed(tag, 'data must be exactly {turn, step, index, id, name?, dt, args}');
    }
    if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) {
      malformed(tag, 'id (and name when present) must be strings');
    }
    payload = validateRunData(tag, data, 'args');
  } else {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) {
      malformed(tag, 'data must be exactly {turn, step, index, dt, texts}');
    }
    payload = validateRunData(tag, data, 'texts');
  }
  // Reconstruction bounds. The encoder only packs runs whose member seqs and
  // times are all safe integers, so a running value that leaves safe range is
  // outside any encoder's image: float arithmetic would round it to a
  // different number than exact arithmetic, a silent corruption. Within safe
  // range every step is exact, so the first departure is always caught.
  if (!Number.isSafeInteger((value.seq0 as number) + payload.length - 1)) {
    malformed(tag, 'member seqs must stay safe integers');
  }
  let time = value.time0 as number;
  for (const gap of data.dt as number[]) {
    time += gap;
    if (!Number.isSafeInteger(time)) malformed(tag, 'member times must stay safe integers');
  }
  return value as unknown as ChunkRow;
}

/** Expand a validated row back into its exact original events, in order. */
function expandRow(row: ChunkRow): DshEvent[] {
  const members = (row.type === 'tool-call-chunks' ? row.data.args : row.data.texts) as string[];
  const dt = row.data.dt as number[];
  const events: DshEvent[] = [];
  let time = row.time0;
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += dt[k - 1];
    let chunk: Record<string, unknown>;
    switch (row.type) {
      case 'text-chunks':
        chunk = { type: 'text-delta', index: row.data.index, text: members[k] };
        break;
      case 'reasoning-chunks':
        chunk = { type: 'reasoning-delta', index: row.data.index, text: members[k] };
        break;
      case 'tool-call-chunks':
        chunk = {
          type: 'tool-call-delta',
          index: row.data.index,
          id: row.data.id as string,
          ...Object.hasOwn(row.data, 'name') ? { name: row.data.name as string } : {},
          argumentsDelta: members[k],
        };
        break;
      default:
        throw new Error(`malformed ${row.type} storage row: unknown row tag`);
    }
    events.push({
      type: 'assistant/chunk',
      seq: row.seq0 + k,
      time,
      data: { turn: row.data.turn, step: row.data.step, chunk },
    });
  }
  return events;
}

/**
 * Decode one parsed JSONL line value into the session event(s) it stores.
 * Chunk-row-tagged values validate and expand (a malformed row throws — it is
 * corrupt storage, and treating it as an event would silently drop a whole
 * run); every other value passes through as a single event, unvalidated.
 *
 * @param value - one line's `JSON.parse` result.
 * @returns the stored events, in log order.
 */
export function decodeStorageRecord(value: unknown): DshEvent[] {
  if (!isRecord(value)) return [value as unknown as DshEvent];
  const tag = value.type;
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') {
    return [value as unknown as DshEvent];
  }
  return expandRow(validateRow(value, tag));
}
