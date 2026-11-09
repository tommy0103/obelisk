// Renderer trace analysis shared by Electron probes and captured-trace regressions.
export function rendererTaskMetrics(traceEvents, startMark, endMark) {
  const start = traceEvents.find(event => event.name === startMark);
  const end = [...traceEvents].reverse().find(event => event.name === endMark);
  if (!start || !end) throw new Error(`Missing renderer trace marks: ${startMark}, ${endMark}`);
  const tasks = traceEvents
    .filter(event => (
      /RunTask$/.test(event.name || '')
      && event.ph === 'X'
      && event.pid === start.pid
      && event.tid === start.tid
      && event.ts >= start.ts
      && event.ts <= end.ts
    ));
  const workDuration = event => {
    if (!Number.isFinite(event.dur) || event.dur < 0
      || (event.tdur !== undefined && (!Number.isFinite(event.tdur) || event.tdur < 0))) {
      throw new Error(`Invalid renderer duration for ${event.name}`);
    }
    // Missing thread CPU data is not a free pass: wall time is the conservative
    // bound. Chromium omits tdur on some events below CPU clock resolution.
    return (event.tdur ?? event.dur) / 1000;
  };
  const taskWork = tasks.map(workDuration);
  const taskDurations = tasks.map(event => event.dur / 1000);
  const functions = traceEvents.filter(event => (
    event.name === 'FunctionCall' && event.ph === 'X'
    && event.pid === start.pid && event.tid === start.tid
    && event.ts >= start.ts && event.ts <= end.ts
  ));
  const functionWork = functions.map(workDuration);
  if (taskDurations.length === 0) throw new Error('Renderer trace contained no RunTask events');
  const slowest = tasks.reduce((best, task) => !best || task.dur > best.dur ? task : best, null);
  const slowestChildren = slowest
    ? traceEvents
      .filter(event => (
        event.ph === 'X'
        && event.pid === slowest.pid
        && event.tid === slowest.tid
        && event !== slowest
        && event.ts >= slowest.ts
        && event.ts + (event.dur || 0) <= slowest.ts + slowest.dur
      ))
      .sort((a, b) => (b.dur || 0) - (a.dur || 0))
      .slice(0, 8)
      .map(event => ({ name: event.name, durationMs: (event.dur || 0) / 1000, cpuDurationMs: event.tdur === undefined ? null : event.tdur / 1000, args: event.args }))
    : [];
  return {
    tasks: taskDurations.length,
    slowestTaskCpuMs: slowest?.tdur === undefined ? null : slowest.tdur / 1000,
    maxTaskMs: Math.max(0, ...taskDurations),
    maxTaskWorkMs: Math.max(...taskWork),
    tasksWithoutCpu: tasks.filter(event => event.tdur === undefined).length,
    maxFunctionCallMs: Math.max(0, ...functions.map(event => event.dur / 1000)),
    maxFunctionWorkMs: Math.max(0, ...functionWork),
    slowestChildren,
  };
}

