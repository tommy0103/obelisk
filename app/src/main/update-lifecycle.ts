// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Updates must await actual cleanup, unlike the bounded ordinary quit path.
// A timeout abandons this install attempt, but keeps writes blocked until the
// in-flight cleanup settles. It never schedules a late installation.
export function createUpdateLifecycle({ stop, resume, timeoutMs = 30_000 }: {
  stop: () => Promise<unknown>;
  resume: () => void;
  timeoutMs?: number;
}) {
  let blocked = false;
  let prepared = false;
  let recovering: Promise<void> | null = null;
  const tasks = new Set<Promise<unknown>>();
  function assertWritable() {
    if (blocked) throw new Error('Obelisk is preparing an update; try again after it finishes');
  }
  function mutate<T>(work: () => Promise<T>): Promise<T> {
    assertWritable();
    const task = Promise.resolve().then(work);
    tasks.add(task);
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  }
  async function prepare() {
    if (blocked) throw new Error('Update cleanup is still in progress');
    blocked = true;
    const cleanup = (async () => {
      await Promise.allSettled([...tasks]);
      await stop();
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cleanup, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Update cleanup took too long; the app will stay open')), timeoutMs);
      })]);
      prepared = true;
    } catch (error) {
      recovering = cleanup.catch(() => {}).then(() => {
        blocked = false;
        prepared = false;
        recovering = null;
        resume();
      });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function recover() {
    if (recovering) return recovering;
    prepared = false;
    blocked = false;
    resume();
  }
  return { prepare, recover, mutate, assertWritable, isBlocked: () => blocked, isPrepared: () => prepared };
}
