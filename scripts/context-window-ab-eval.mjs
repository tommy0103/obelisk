#!/usr/bin/env node
// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createZstdFrameDecoder, scanZstdFrames } from '../packages/core/src/vendor/dsh-zstd.ts';

import {
  CONTEXT_WINDOW_TASK,
  DEFAULT_EVAL_POLICY,
  buildArmPatch,
  parseSessionJsonl,
  qualifyRun,
  summarizeSession,
} from './context-window-ab-eval-lib.mjs';

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DSH_ROOT = join(homedir(), 'Code', 'deepseek-harness');
const DEFAULT_DSH_HOME = join(homedir(), '.dsh');
const DEFAULT_DSH_SESSIONS_ROOT = join(DEFAULT_DSH_HOME, 'sessions');
const MAX_BUFFER = 128 * 1024 * 1024;

const HELP = `Usage:
  node scripts/context-window-ab-eval.mjs --output <new-dir> [options]

Options:
  --execute                 Run the real-model experiment. Without it, only materialize the plan.
  --arm <both|compact|rollover>  Default: both.
  --repetitions <n>         Runs per selected arm. Default: 1.
  --context-window <tokens> Per-window capacity. Default: 200000.
  --provider-capacity <tokens> Required with --execute; operator-confirmed real route capacity.
  --model <id>              Default: deepseek-v4-flash.
  --dsh-root <path>         Default: ~/Code/deepseek-harness.
  --timeout-minutes <n>     Optional per-agent safety cap. Omit to wait for natural completion.
  --keep-workspaces         Retain exported candidate trees after validation.
  --help                    Show this text.

The real run uses the selected DSH profile's configured credentials. Sessions
are written under ~/.dsh/sessions so Obelisk can recover the active run by
session_id. Each run gets a git-free export of the base commit. Oracle tests are
injected only after the agent stops. Output paths must not already exist.
`;

function positiveInteger(name, raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    execute: false,
    arm: 'both',
    repetitions: 1,
    contextWindow: DEFAULT_EVAL_POLICY.contextWindow,
    model: 'deepseek-v4-flash',
    dshRoot: DEFAULT_DSH_ROOT,
    timeoutMinutes: undefined,
    keepWorkspaces: false,
    providerCapacity: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new TypeError(`${argument} needs a value`);
      index += 1;
      return value;
    };
    switch (argument) {
      case '--execute': options.execute = true; break;
      case '--keep-workspaces': options.keepWorkspaces = true; break;
      case '--help': options.help = true; break;
      case '--output': options.output = resolve(take()); break;
      case '--arm': options.arm = take(); break;
      case '--repetitions': options.repetitions = positiveInteger('repetitions', take()); break;
      case '--context-window': options.contextWindow = positiveInteger('context-window', take()); break;
      case '--provider-capacity': options.providerCapacity = positiveInteger('provider-capacity', take()); break;
      case '--model': options.model = take(); break;
      case '--dsh-root': options.dshRoot = resolve(take()); break;
      case '--timeout-minutes': options.timeoutMinutes = positiveInteger('timeout-minutes', take()); break;
      default: throw new TypeError(`unknown argument ${JSON.stringify(argument)}`);
    }
  }
  if (options.help) return options;
  if (options.output === undefined) throw new TypeError('--output is required');
  if (!['both', 'compact', 'rollover'].includes(options.arm)) {
    throw new TypeError('--arm must be both, compact, or rollover');
  }
  if (options.providerCapacity !== undefined && options.providerCapacity < options.contextWindow) {
    throw new TypeError('provider-capacity must be at least context-window');
  }
  return options;
}

function checkedSpawn(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    timeout: options.timeout,
    maxBuffer: MAX_BUFFER,
  });
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function requireSuccess(label, result) {
  if (result.status === 0 && result.error === undefined) return;
  const detail = [result.error, result.stderr, result.stdout].filter(Boolean).join('\n');
  throw new Error(`${label} failed (${String(result.status ?? result.signal ?? 'unknown')}):\n${detail}`);
}

function writeCommandLog(path, result) {
  writeFileSync(path, [
    `$ ${result.command.join(' ')}`,
    `status=${String(result.status)} signal=${String(result.signal)}`,
    result.error === undefined ? '' : `error=${result.error}`,
    '--- stdout ---',
    result.stdout,
    '--- stderr ---',
    result.stderr,
  ].join('\n'));
}

function gitShow(sourceRoot, commit, path) {
  const result = checkedSpawn('git', ['-C', sourceRoot, 'show', `${commit}:${path}`]);
  requireSuccess(`read ${path} from ${commit}`, result);
  return result.stdout;
}

function gitShowBuffer(sourceRoot, commit, path) {
  const result = spawnSync('git', ['-C', sourceRoot, 'show', `${commit}:${path}`], {
    encoding: null,
    maxBuffer: MAX_BUFFER,
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`read ${path} from ${commit} failed: ${String(result.error?.message ?? result.stderr)}`);
  }
  return result.stdout;
}

function policyFor(contextWindow) {
  if (contextWindow < DEFAULT_EVAL_POLICY.contextWindow) {
    throw new TypeError('quality eval context-window must be at least 200000 tokens');
  }
  const scale = contextWindow / DEFAULT_EVAL_POLICY.contextWindow;
  const rounded = value => Math.max(1, Math.round(value * scale));
  const outputReserveTokens = rounded(DEFAULT_EVAL_POLICY.outputReserveTokens);
  const fallbackReserveTokens = rounded(DEFAULT_EVAL_POLICY.fallbackReserveTokens);
  return {
    contextWindow,
    normalBudget: contextWindow - outputReserveTokens - fallbackReserveTokens,
    reminderThresholdTokens: rounded(DEFAULT_EVAL_POLICY.reminderThresholdTokens),
    fallbackReserveTokens,
    outputReserveTokens,
    compactRetainTokens: rounded(DEFAULT_EVAL_POLICY.compactRetainTokens),
    compactSummaryMaxTokens: rounded(DEFAULT_EVAL_POLICY.compactSummaryMaxTokens),
  };
}

function armsFor(value) {
  return value === 'both' ? ['compact', 'rollover'] : [value];
}

function atomicWrite(path, content) {
  const temporary = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function createOutputRoot(path) {
  mkdirSync(path, { recursive: true });
}

function assertDescendant(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '' || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`refusing operation outside run directory: ${target}`);
  }
}

function exportTaskWorkspace(runDir) {
  const workspace = join(runDir, 'workspace');
  const archive = join(runDir, 'base.tar');
  mkdirSync(workspace);
  const exported = checkedSpawn('git', [
    '-C', SOURCE_ROOT,
    'archive', '--format=tar', '--output', archive,
    CONTEXT_WINDOW_TASK.baseCommit,
  ]);
  requireSuccess('export base task commit', exported);
  const unpacked = checkedSpawn('tar', ['-xf', archive, '-C', workspace]);
  requireSuccess('unpack base task commit', unpacked);
  rmSync(archive);
  const taskSpec = CONTEXT_WINDOW_TASK.specPaths.map(path => [
    `# Source: ${path}`,
    '',
    gitShow(SOURCE_ROOT, CONTEXT_WINDOW_TASK.oracleCommit, path),
  ].join('\n')).join('\n\n');
  writeFileSync(join(workspace, 'TASK_SPEC.md'), taskSpec);
  for (const command of [
    ['git', ['init']],
    ['git', ['config', 'user.name', 'Context Window Eval']],
    ['git', ['config', 'user.email', 'context-window-eval@invalid.local']],
    ['git', ['add', '.']],
    ['git', ['commit', '-m', 'eval baseline']],
  ]) {
    requireSuccess(`initialize isolated task repository: ${command[1].join(' ')}`, checkedSpawn(command[0], command[1], { cwd: workspace }));
  }
  return workspace;
}

export function resolveDshBin(dshRoot) {
  const bin = join(dshRoot, 'apps', 'cli', 'lib', 'bin.js');
  if (!existsSync(bin)) {
    throw new Error(`built DSH CLI not found at ${bin}; run 'pnpm build:lib:host' in deepseek-harness`);
  }
  return bin;
}

function dshInvocation(dshRoot, args, options) {
  const bin = resolveDshBin(dshRoot);
  return checkedSpawn(process.execPath, [bin, ...args], options);
}

export function taskPrompt() {
  return [
    'Implement the DeepSeek Harness root-tree provider described by TASK_SPEC.md completely in this repository.',
    'Work autonomously until the implementation and its tests pass; do not stop after planning.',
    'The task is finished only when the package builds, relevant tests pass, and the documented install surface is usable.',
    'Do not inspect filesystem paths outside the current workspace for a finished implementation or oracle tests.',
    'After a rollover, use Obelisk only with the handoff session_id and message_uuid to recover this run.',
    'Do not search global history or other sessions.',
  ].join(' ');
}

function findFiles(root, suffix, found = []) {
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) findFiles(path, suffix, found);
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(path);
  }
  return found;
}

function readSessionEvents(path) {
  if (!path.endsWith('.zstd')) return parseSessionJsonl(readFileSync(path, 'utf8'));
  const source = readFileSync(path);
  const { frames } = scanZstdFrames(source);
  const decoder = createZstdFrameDecoder();
  try {
    const chunks = [];
    for (const chunk of decoder.decode(source, frames)) chunks.push(Buffer.from(chunk));
    return parseSessionJsonl(Buffer.concat(chunks).toString('utf8'));
  } finally {
    decoder.close();
  }
}

export function sessionMetrics(sessionsRoot, workspace) {
  const files = [
    ...findFiles(sessionsRoot, '.jsonl'),
    ...findFiles(sessionsRoot, '.jsonl.zstd'),
  ];
  const sessions = files
    .map(path => ({ path, events: readSessionEvents(path) }))
    .filter(({ events }) => events[0]?.type === 'session' && events[0].cwd === workspace);
  const selectedFiles = sessions.map(session => session.path);
  const events = sessions.flatMap(session => session.events);
  return { files: selectedFiles, ...summarizeSession(events) };
}

function captureCandidate(workspace, runDir) {
  requireSuccess('mark candidate untracked files', checkedSpawn('git', ['add', '-N', '.'], { cwd: workspace }));
  const diff = checkedSpawn('git', ['diff', '--binary', 'HEAD'], { cwd: workspace });
  requireSuccess('capture candidate patch', diff);
  writeFileSync(join(runDir, 'candidate.patch'), diff.stdout);
}

function injectOracleTests(workspace) {
  for (const path of CONTEXT_WINDOW_TASK.oracleFiles) {
    const destination = join(workspace, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, gitShowBuffer(SOURCE_ROOT, CONTEXT_WINDOW_TASK.oracleCommit, path));
  }
}

function validateCandidate(workspace, runDir, timeout) {
  const commands = [
    ['build-core', 'npm', ['run', 'build:core']],
    ['build-cli', 'npm', ['run', 'build:cli']],
    ['oracle-tests', process.execPath, [
      '--experimental-test-module-mocks', '--test', ...CONTEXT_WINDOW_TASK.oracleTests,
    ]],
  ];
  const results = [];
  for (const [label, command, args] of commands) {
    const result = checkedSpawn(command, args, { cwd: workspace, timeout });
    writeCommandLog(join(runDir, `${label}.log`), result);
    results.push({ label, status: result.status, signal: result.signal, error: result.error });
    if (result.status !== 0 || result.error !== undefined) break;
  }
  return { passed: results.length === commands.length && results.every(result => result.status === 0), commands: results };
}

function prepareRun(runDir, arm, options, policy) {
  mkdirSync(runDir);
  const workspace = exportTaskWorkspace(runDir);
  const dshHome = DEFAULT_DSH_HOME;
  const sessionsRoot = DEFAULT_DSH_SESSIONS_ROOT;
  mkdirSync(sessionsRoot, { recursive: true });
  const patchPath = join(runDir, 'arm.patch.yml');
  writeFileSync(patchPath, buildArmPatch({
    arm,
    sessionsRoot,
    model: options.model,
    policy,
  }));
  return { workspace, dshHome, sessionsRoot, patchPath };
}

function executeRun(runDir, arm, index, options, policy) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const { workspace, dshHome, sessionsRoot, patchPath } = prepareRun(runDir, arm, options, policy);
  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'workspace-write',
  };
  const dependencies = checkedSpawn('npm', ['ci'], {
    cwd: workspace,
    env,
    timeout: 15 * 60_000,
  });
  writeCommandLog(join(runDir, 'dependency-install.log'), dependencies);
  requireSuccess('install isolated base dependencies', dependencies);
  const appDependencies = checkedSpawn('npm', ['ci', '--prefix', 'app'], {
    cwd: workspace,
    env,
    timeout: 15 * 60_000,
  });
  writeCommandLog(join(runDir, 'app-dependency-install.log'), appDependencies);
  requireSuccess('install isolated app dependencies', appDependencies);
  const runtimeBuild = checkedSpawn('npm', [
    'run', 'build:core',
  ], { cwd: SOURCE_ROOT, env, timeout: 5 * 60_000 });
  writeCommandLog(join(runDir, 'runtime-build-core.log'), runtimeBuild);
  requireSuccess('build eval runtime core', runtimeBuild);
  const pluginBuild = checkedSpawn('npm', [
    'run', 'build', '--workspace', '@obelisk/dsh-obelisk-plugin',
  ], { cwd: SOURCE_ROOT, env, timeout: 5 * 60_000 });
  writeCommandLog(join(runDir, 'runtime-build-plugin.log'), pluginBuild);
  requireSuccess('build eval runtime plugin', pluginBuild);
  const packed = checkedSpawn('npm', [
    'pack', '--workspace', '@obelisk/dsh-obelisk-plugin', '--pack-destination', runDir,
  ], { cwd: SOURCE_ROOT, env, timeout: 5 * 60_000 });
  writeCommandLog(join(runDir, 'plugin-pack.log'), packed);
  requireSuccess('pack eval runtime plugin', packed);
  const pluginTarball = findFiles(runDir, '.tgz')[0];
  if (pluginTarball === undefined) throw new Error('plugin pack produced no tarball');
  const packedFiles = checkedSpawn('tar', ['-tzf', pluginTarball]);
  writeCommandLog(join(runDir, 'plugin-pack-contents.log'), packedFiles);
  requireSuccess('inspect eval runtime tarball', packedFiles);
  if (!packedFiles.stdout.split(/\r?\n/u).includes('package/dist/context-window.js')) {
    throw new Error('packed eval runtime plugin lacks package/dist/context-window.js');
  }
  const install = dshInvocation(options.dshRoot, [
    'plugin', '--profile', 'headless', 'add', '--workspace-root', pluginTarball,
  ], { cwd: workspace, env, timeout: 5 * 60_000 });
  writeCommandLog(join(runDir, 'install.log'), install);
  requireSuccess('install eval plugin', install);

  const agentHome = mkdtempSync(join(tmpdir(), 'obelisk-context-window-agent-home-'));
  const agent = dshInvocation(options.dshRoot, [
    '--profile', 'headless', '--patch', patchPath, taskPrompt(),
  ], {
    cwd: workspace,
    env: { ...env, HOME: agentHome },
    timeout: options.timeoutMinutes === undefined ? undefined : options.timeoutMinutes * 60_000,
  });
  rmSync(agentHome, { recursive: true, force: true });
  writeCommandLog(join(runDir, 'agent.log'), agent);
  captureCandidate(workspace, runDir);
  const metrics = sessionMetrics(sessionsRoot, workspace);
  injectOracleTests(workspace);
  const validation = validateCandidate(workspace, runDir, 15 * 60_000);
  const qualification = qualifyRun(metrics, policy.contextWindow);
  const result = {
    task: CONTEXT_WINDOW_TASK.id,
    arm,
    repetition: index,
    startedAt,
    durationMs: Math.round(performance.now() - started),
    agent: { status: agent.status, signal: agent.signal, error: agent.error },
    metrics,
    qualification,
    validation,
    taskPassed: agent.status === 0 && validation.passed,
    comparable: agent.status === 0 && validation.passed && qualification.eligible,
  };
  atomicWrite(join(runDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  if (!options.keepWorkspaces) {
    assertDescendant(runDir, workspace);
    rmSync(workspace, { recursive: true, force: true });
  }
  return result;
}

function materializePlan(output, options, policy, arms) {
  const plan = {
    mode: options.execute ? 'execute' : 'dry-run',
    task: CONTEXT_WINDOW_TASK,
    arms,
    repetitions: options.repetitions,
    model: options.model,
    dshRoot: options.dshRoot,
    providerCapacity: options.providerCapacity ?? null,
    timeoutMinutes: options.timeoutMinutes ?? null,
    policy,
    fairness: {
      sameBaseCommit: true,
      sameModelAndBudget: true,
      obeliskSkillAvailableToBothArms: true,
      currentDshSessionIndexable: true,
      globalObeliskHistoryUnavailable: true,
      agentRunsWaitForNaturalCompletion: options.timeoutMinutes === undefined,
      gitHistoryRemovedFromWorkspace: true,
      oracleTestsInjectedAfterAgentStops: true,
    },
  };
  const planPath = join(output, 'plan.json');
  if (existsSync(planPath)) {
    const existing = JSON.parse(readFileSync(planPath, 'utf8'));
    const comparable = value => ({
      task: value.task,
      arms: value.arms,
      repetitions: value.repetitions,
      model: value.model,
      dshRoot: value.dshRoot,
      providerCapacity: value.providerCapacity,
      timeoutMinutes: value.timeoutMinutes,
      policy: value.policy,
    });
    if (JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(plan))) {
      throw new Error(`output directory belongs to a different experiment: ${output}`);
    }
  }
  for (const arm of arms) {
    atomicWrite(join(output, `${arm}.patch.yml`), buildArmPatch({
      arm,
      sessionsRoot: DEFAULT_DSH_SESSIONS_ROOT,
      model: options.model,
      policy,
    }));
  }
  atomicWrite(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!existsSync(options.dshRoot)) throw new Error(`deepseek-harness not found: ${options.dshRoot}`);
  if (options.execute && options.providerCapacity === undefined) {
    throw new Error('--execute requires --provider-capacity from the selected route provider documentation');
  }
  createOutputRoot(options.output);
  const policy = policyFor(options.contextWindow);
  const arms = armsFor(options.arm);
  const plan = materializePlan(options.output, options, policy, arms);
  if (!options.execute) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const results = [];
  for (const arm of arms) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      const runDir = join(options.output, `${arm}-${String(repetition).padStart(2, '0')}`);
      const completed = recoverRunSlot(options.output, runDir);
      if (completed !== undefined) {
        results.push(completed);
        continue;
      }
      process.stderr.write(`[context-window-ab] starting ${arm} repetition ${repetition}\n`);
      results.push(executeRun(runDir, arm, repetition, options, policy));
    }
  }
  const report = { plan, results };
  atomicWrite(join(options.output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/** Reuse an atomically completed run or clear only its known incomplete run directory. */
export function recoverRunSlot(output, runDir) {
  assertDescendant(output, runDir);
  const resultPath = join(runDir, 'result.json');
  if (existsSync(resultPath)) return JSON.parse(readFileSync(resultPath, 'utf8'));
  if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true });
  return undefined;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
