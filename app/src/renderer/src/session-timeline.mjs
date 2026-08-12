// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

function sameSnapshotValue(current, incoming) {
  if (Object.is(current, incoming)) return true;
  if (current === null || incoming === null) return false;
  if (typeof current !== 'object' || typeof incoming !== 'object') return false;

  const currentIsArray = Array.isArray(current);
  if (currentIsArray !== Array.isArray(incoming)) return false;

  const currentKeys = Object.keys(current);
  const incomingKeys = Object.keys(incoming);
  if (currentKeys.length !== incomingKeys.length) return false;

  for (const key of currentKeys) {
    if (!Object.hasOwn(incoming, key)) return false;
    if (!sameSnapshotValue(current[key], incoming[key])) return false;
  }
  return true;
}

/**
 * Reconcile a complete timeline snapshot while preserving the identity of
 * messages whose rendered content did not change.
 */
export function applySnapshot(current = [], incoming = []) {
  const currentByUuid = new Map(
    current
      .filter(message => message?.uuid)
      .map(message => [message.uuid, message]),
  );
  const incomingUuids = new Set(
    incoming.filter(message => message?.uuid).map(message => message.uuid),
  );
  const addedIds = [];
  const updatedIds = [];
  const messages = incoming.map((message, index) => {
    const uuid = message?.uuid;
    const existing = uuid ? currentByUuid.get(uuid) : current[index];
    if (!existing || (uuid && existing.uuid !== uuid)) {
      if (uuid) addedIds.push(uuid);
      return message;
    }
    if (sameSnapshotValue(existing, message)) return existing;
    if (uuid) updatedIds.push(uuid);
    return message;
  });
  const removedIds = current
    .filter(message => message?.uuid && !incomingUuids.has(message.uuid))
    .map(message => message.uuid);
  const changed = messages.length !== current.length
    || messages.some((message, index) => message !== current[index]);
  const unchangedPrefix = incoming.length > current.length
    && current.every((message, index) => messages[index] === message);
  const tailOnly = changed
    && unchangedPrefix
    && updatedIds.length === 0
    && removedIds.length === 0;

  return {
    messages: changed ? messages : current,
    addedIds,
    updatedIds,
    removedIds,
    changed,
    tailOnly,
  };
}
