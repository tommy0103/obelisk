// Generate DSH session fixtures for quiet-zero's deepseek adapter tests using
// the REAL DSH writers (ADR-0014): the current v3 persistence plugin for v3
// logs, the frozen v2 codec for the v2 generation, and the real migration path
// (v2 write-open) for the multi-generation directory.
// Run: DSH_REPO=/path/to/deepseek-harness node scripts/gen-dsh-fixtures.mjs
// (from the quiet-zero repo root; DSH_REPO defaults to ~/Code/deepseek-harness
// and must be a built checkout — packages/*/lib present).

import { homedir } from 'node:os';
import { mkdir, rm, readdir, writeFile, readFile, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DSH_REPO = process.env.DSH_REPO ?? join(homedir(), 'Code', 'deepseek-harness');
const { Context } = await import(join(DSH_REPO, 'packages/session/session-persistence-jsonl/node_modules/@deepseek-ai/cordis/lib/index.js'));
const { default: JsonlSessionPersistence } = await import(join(DSH_REPO, 'packages/session/session-persistence-jsonl/lib/index.js'));
const { releasedV2SessionFormatCodec } = await import(join(DSH_REPO, 'packages/session/session-format-v1-to-v2/lib/index.js'));

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const stagingZstd = join(repoRoot, 'tmp', 'dsh-fixture-staging-zstd');
const stagingNone = join(repoRoot, 'tmp', 'dsh-fixture-staging-none');
const fixtureRoot = join(repoRoot, 'tests', 'fixtures', 'deepseek', 'sessions', '--dsh-v3--');

const CWD = '/dsh-fixtures';
let clock = 1000;
const t = () => ++clock;

// ---- event builders (v3 shapes; types per core/session/src/types.ts) ----

const turnStart = (turn) => ({ type: 'turn/start', seq: seq(), time: t(), data: { turn } });
const turnEnd = (turn) => ({ type: 'turn/end', seq: seq(), time: t(), data: { turn, reason: { kind: 'completed' } } });
const stepStart = (turn, step) => ({ type: 'step/start', seq: seq(), time: t(), data: { turn, step } });
const stepEnd = (turn, step) => ({ type: 'step/end', seq: seq(), time: t(), data: { turn, step } });

let seqCounter = -1;
function seq() { return ++seqCounter; }
function resetSeq() { seqCounter = -1; }

const userMessage = (id, text, extra = {}) => ({
  type: 'user/message', seq: seq(), time: t(),
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  surfaceOp: 'append',
  ...extra,
});

const systemMessage = (turn, step, text) => ({
  type: 'system/message', seq: seq(), time: t(),
  data: {
    turn, step,
    message: { id: 'sys-1', role: 'system', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'system-prompt' } },
  },
  surfaceOp: 'append',
});

const requestHeader = (model = 'deepseek-chat') => ({
  type: 'request/header', seq: seq(), time: t(),
  data: { header: { config: { provider: 'deepseek', model } }, reason: 'initial' },
});

const DEFAULT_USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 };

/** Build an embedded stream whose assembled content matches `content` exactly
 * (the migration path verifies stream/content agreement). */
function streamFor(content) {
  const records = [];
  content.forEach((part, index) => {
    const blockType = part.type;
    records.push({ type: 'chunk', time: t(), chunk: { type: 'block-start', index, blockType } });
    if (part.type === 'reasoning') {
      records.push({ type: 'reasoning-chunks', time0: clock, index, dt: [], texts: [part.text] });
    } else if (part.type === 'text') {
      records.push({ type: 'text-chunks', time0: clock, index, dt: [], texts: [part.text] });
    } else if (part.type === 'tool-call') {
      records.push({ type: 'tool-call-chunks', time0: clock, index, dt: [], id: part.id, name: part.name, args: [part.arguments] });
    }
    records.push({ type: 'chunk', time: t(), chunk: { type: 'block-end', index, block: part } });
  });
  records.push({ type: 'chunk', time: t(), chunk: { type: 'usage', usage: DEFAULT_USAGE } });
  records.push({ type: 'chunk', time: t(), chunk: { type: 'finish', reason: { kind: 'stop' } } });
  return records;
}

const assistantMessage = (turn, step, id, content, extra = {}) => ({
  type: 'assistant/message', seq: seq(), time: t(),
  data: {
    turn, step,
    message: { id, role: 'assistant', content, source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' } },
    stream: streamFor(content),
    usage: DEFAULT_USAGE,
    ...extra,
  },
  surfaceOp: 'append',
});

const toolCall = (turn, step, callId, name, args) => ({
  type: 'tool/call', seq: seq(), time: t(),
  data: { turn, step, callId, name, arguments: JSON.stringify(args) },
});

const toolResult = (turn, step, callId, text) => ({
  type: 'tool/result', seq: seq(), time: t(),
  data: {
    turn, step,
    message: {
      id: `tr-${callId}`, role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId },
    },
  },
  surfaceOp: 'append',
});

const sessionTitle = (title) => ({ type: 'session/title', seq: seq(), time: t(), data: { title } });

const ptcDispatchStart = (parentCallId, subCallId, name, args) => ({
  type: 'tool/ptc-dispatch-start', seq: seq(), time: t(),
  data: { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: args },
});

const ptcDispatch = (parentCallId, subCallId, name, args, text) => ({
  type: 'tool/ptc-dispatch', seq: seq(), time: t(),
  data: { rootCallId: parentCallId, parentCallId, subCallId, name, arguments: args, isError: false, content: [{ type: 'text', text }] },
});

// ---- writer plumbing ----

async function mount(root, compression) {
  const ctx = new Context();
  const fiber = await ctx.plugin(JsonlSessionPersistence, { root, compression });
  return { fiber, persistence: ctx.sessionPersistence };
}

async function writeSession(persistence, header, events, options) {
  const handle = await persistence.create(header, options);
  try {
    await handle.append(events);
  } finally {
    await handle.close();
  }
}

const v3Header = (id, extra = {}) => ({
  version: 3, id, createdAt: ++clock, cwd: CWD, isSeeded: false, delegationDepth: 0, ...extra,
});

// ---- scenarios ----

async function genBasic(persistence) {
  resetSeq();
  await writeSession(persistence, v3Header('v3-basic'), [
    turnStart(1),
    stepStart(1, 1),
    systemMessage(1, 1, 'You are a fixture system prompt.'),
    userMessage('u-basic-1', 'please read a.ts'),
    requestHeader('deepseek-chat'),
    assistantMessage(1, 1, 'a-basic-1', [
      { type: 'reasoning', text: 'need to read the file first' },
      { type: 'text', text: 'Let me read it.' },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"/dsh-fixtures/a.ts"}' },
    ]),
    toolCall(1, 1, 'call-1', 'read', { file_path: '/dsh-fixtures/a.ts' }),
    toolResult(1, 1, 'call-1', 'contents of a.ts'),
    sessionTitle('v3 basic session'),
    stepEnd(1, 1),
    turnEnd(1),
  ]);
}

async function genPtc(persistence) {
  resetSeq();
  await writeSession(persistence, v3Header('v3-ptc'), [
    turnStart(1),
    stepStart(1, 1),
    userMessage('u-ptc-1', 'run the ptc script'),
    requestHeader('deepseek-chat'),
    assistantMessage(1, 1, 'a-ptc-1', [
      { type: 'tool-call', id: 'call-1', name: 'run_code', arguments: '{"code":"await tools.read({file_path:\\"/dsh-fixtures/a.ts\\"})"}' },
    ]),
    toolCall(1, 1, 'call-1', 'run_code', { code: 'await tools.read({file_path:"/dsh-fixtures/a.ts"})' }),
    ptcDispatchStart('call-1', 'call-1:ptc:1', 'read', { file_path: '/dsh-fixtures/a.ts' }),
    ptcDispatch('call-1', 'call-1:ptc:1', 'read', { file_path: '/dsh-fixtures/a.ts' }, 'a.ts contents via ptc'),
    ptcDispatchStart('call-1', 'call-1:ptc:2', 'write', { file_path: '/dsh-fixtures/b.ts', content: 'x' }),
    ptcDispatch('call-1', 'call-1:ptc:2', 'write', { file_path: '/dsh-fixtures/b.ts', content: 'x' }, 'wrote b.ts'),
    toolResult(1, 1, 'call-1', 'run_code finished: 2 sub-calls'),
    stepEnd(1, 1),
    turnEnd(1),
  ]);
}

async function genCompacted(persistence) {
  resetSeq();
  const shadowed = [2, 3, 4, 5];
  await writeSession(persistence, v3Header('v3-compacted'), [
    turnStart(1),
    stepStart(1, 1),
    userMessage('u-comp-1', 'first question'),                    // seq 2, shadowed
    assistantMessage(1, 1, 'a-comp-1', [{ type: 'text', text: 'first answer' }]), // seq 3, shadowed
    userMessage('u-comp-2', 'second question'),                   // seq 4, shadowed
    assistantMessage(1, 1, 'a-comp-2', [{ type: 'text', text: 'second answer' }]), // seq 5, shadowed
    { type: 'compaction/start', seq: seq(), time: t(), data: { compactionId: 'c1', turn: 1 } },
    {
      type: 'compaction/summary', seq: seq(), time: t(),
      data: {
        compactionId: 'c1', summary: 'summary of the first two exchanges',
        shadowedRange: { start: 2, end: 5 }, shadowedSeqs: shadowed, shadowedTokenCount: 42,
        provider: 'deepseek', model: 'deepseek-chat',
      },
    },
    // The checkpoint message REPLACES the shadowed surface span (compaction
    // pattern: region.ts appends user/message with a replace surfaceOp). The
    // writer range-encodes sourceEventSeqs on disk itself.
    {
      ...userMessage('u-comp-checkpoint', '[compacted summary] first and second exchanges'),
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 5 },
      sourceEventSeqs: shadowed,
    },
    { type: 'compaction/end', seq: seq(), time: t(), data: { compactionId: 'c1', turn: 1 } },
    userMessage('u-comp-3', 'third question'),
    assistantMessage(1, 1, 'a-comp-3', [{ type: 'text', text: 'third answer' }]),
    stepEnd(1, 1),
    turnEnd(1),
  ]);
}

async function genSeeded(persistence) {
  resetSeq();
  await writeSession(persistence, v3Header('v3-seeded-parent'), [
    turnStart(1),
    stepStart(1, 1),
    userMessage('u-parent-1', 'parent question'),
    assistantMessage(1, 1, 'a-parent-1', [{ type: 'text', text: 'parent answer' }]),
    stepEnd(1, 1),
    turnEnd(1),
  ]);
  resetSeq();
  await writeSession(persistence, v3Header('v3-seeded-child', {
    parentSession: 'v3-seeded-parent', origin: 'subagent', delegationDepth: 1, isSeeded: true,
  }), [
    turnStart(1),                                               // seq 0, inherited
    userMessage('u-parent-1', 'parent question'),               // seq 1, inherited
    assistantMessage(1, 1, 'a-parent-1', [{ type: 'text', text: 'parent answer' }]), // seq 2, inherited
    turnEnd(1),                                                 // seq 3, inherited
    { type: 'session/end-seed', seq: seq(), time: t(), data: { inherited: true } }, // seq 4 = inherited count
    {
      type: 'subagent/descriptor', seq: seq(), time: t(),
      data: {
        version: 3, mode: 'continuable', provider: 'subagents', label: 'seeded child',
        agentProvider: 'deepseek', agentModel: 'deepseek-chat',
      },
    },
    turnStart(2),
    stepStart(2, 1),
    userMessage('u-child-1', 'child task'),
    assistantMessage(2, 1, 'a-child-1', [{ type: 'text', text: 'child answer' }]),
    stepEnd(2, 1),
    turnEnd(2),
  ], { inheritedEventCount: 4 });
}

// v2 events use the frozen v2 codec: system prompt in request/header,
// code-dispatch spelling, optional surfaceOp ('append' present, as in
// released v2 logs; replace endpoints named start/end).
async function genMigrated(persistence) {
  // 1. Let the real v3 writer lay out the directory.
  resetSeq();
  await writeSession(persistence, v3Header('v3-migrated'), [
    turnStart(1),
    stepStart(1, 1),
    userMessage('u-mig-0', 'placeholder'),
    stepEnd(1, 1),
    turnEnd(1),
  ]);
  const projDir = join(stagingNone, await onlyDir(stagingNone));
  const sessDir = join(projDir, 'v3-migrated');
  // 2. Replace the v3 artifact with a real v2 one via the frozen v2 codec.
  const v2Header = { version: 2, id: 'v3-migrated', createdAt: 42, cwd: CWD, isSeeded: false, delegationDepth: 0 };
  resetSeq();
  const v2Events = [
    turnStart(1),
    stepStart(1, 1),
    userMessage('u-mig-1', 'legacy v2 question'),
    {
      type: 'request/header', seq: seq(), time: t(),
      data: { header: { config: { provider: 'deepseek', model: 'deepseek-chat' }, system: 'v2 system prompt' }, reason: 'initial' },
    },
    assistantMessage(1, 1, 'a-mig-1', [
      { type: 'text', text: 'v2 answer' },
      { type: 'tool-call', id: 'call-9', name: 'run_code', arguments: '{"code":"return 1"}' },
    ]),
    toolCall(1, 1, 'call-9', 'run_code', { code: 'return 1' }),
    {
      type: 'tool/code-dispatch-start', seq: seq(), time: t(),
      data: {
        rootCallId: 'call-9', parentCallId: 'call-9', subCallId: 'call-9:code:0',
        name: 'read', arguments: { file_path: '/dsh-fixtures/legacy.ts' },
      },
    },
    {
      type: 'tool/code-dispatch', seq: seq(), time: t(),
      data: {
        rootCallId: 'call-9', parentCallId: 'call-9', subCallId: 'call-9:code:0',
        name: 'read', arguments: { file_path: '/dsh-fixtures/legacy.ts' },
        isError: false, content: [{ type: 'text', text: 'legacy dispatch content' }],
      },
    },
    toolResult(1, 1, 'call-9', 'run_code done'),
    stepEnd(1, 1),
    turnEnd(1),
  ];
  const v2Lines = [
    JSON.stringify(releasedV2SessionFormatCodec.encodeHeader(v2Header, 0)),
    ...v2Events.map((event) => JSON.stringify(releasedV2SessionFormatCodec.encodeEvent(event))),
  ];
  await rm(join(sessDir, 'session.v3.jsonl'));
  await writeFile(join(sessDir, 'session.v2.jsonl'), v2Lines.join('\n') + '\n');
  // 3. The real write-open migration publishes the v3 twin beside v2.
  const handle = await persistence.open('v3-migrated', 'write');
  try {
    // Continue the log: the migrated v3 artifact ends at seq 12.
    seqCounter = 12;
    await handle.append([{ type: 'session/title', seq: seq(), time: t(), data: { title: 'migrated session' } }]);
  } finally {
    await handle.close();
  }
}

async function onlyDir(parent) {
  const entries = await readdir(parent, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length !== 1) throw new Error(`expected exactly one project dir in ${parent}, got ${dirs.join(', ')}`);
  return dirs[0];
}

// ---- main ----

await rm(stagingZstd, { recursive: true, force: true });
await rm(stagingNone, { recursive: true, force: true });
await mkdir(stagingZstd, { recursive: true });
await mkdir(stagingNone, { recursive: true });

const zstdMount = await mount(stagingZstd, 'zstd');
await genBasic(zstdMount.persistence);
await zstdMount.fiber.dispose().catch(() => {});

const noneMount = await mount(stagingNone, 'none');
await genPtc(noneMount.persistence);
await genCompacted(noneMount.persistence);
await genSeeded(noneMount.persistence);
await genMigrated(noneMount.persistence);
await noneMount.fiber.dispose().catch(() => {});

// Copy scenario dirs into the fixture tree, keeping real names.
await rm(fixtureRoot, { recursive: true, force: true });
await mkdir(fixtureRoot, { recursive: true });
for (const stagingRoot of [stagingZstd, stagingNone]) {
  const proj = join(stagingRoot, await onlyDir(stagingRoot));
  for (const entry of await readdir(proj, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await cp(join(proj, entry.name), join(fixtureRoot, entry.name), { recursive: true });
  }
}

// Write-noise siblings the adapter must ignore (ADR-0014).
await writeFile(join(fixtureRoot, 'v3-ptc', 'session.migration.deadbeef.jsonl.zstd.tmp'), '');
await writeFile(join(fixtureRoot, 'v3-ptc', 'session.v9.jsonl.zstd.ab12cd34ef56.tmp'), '');

// Report the produced tree.
async function report(dir, indent = '') {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      console.log(`${indent}${entry.name}/`);
      await report(path, `${indent}  `);
    } else {
      const head = entry.name.endsWith('.jsonl')
        ? JSON.parse((await readFile(path, 'utf8')).split('\n')[0])
        : null;
      console.log(`${indent}  ${entry.name}${head ? `  (version=${head.version} id=${head.id})` : ''}`);
    }
  }
}
await report(fixtureRoot);
console.log('fixtures written to', fixtureRoot);
