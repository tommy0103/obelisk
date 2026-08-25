// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { reactive } from 'vue';

export function normalizeSessionDisclosureSnapshot(snapshot, messageUuids = null) {
  if (!Array.isArray(snapshot)) return [];
  return snapshot
    .filter(entry => (
      entry
      && typeof entry.key === 'string'
      && typeof entry.messageUuid === 'string'
      && (!messageUuids || messageUuids.has(entry.messageUuid))
    ))
    .map(entry => ({
      key: entry.key,
      messageUuid: entry.messageUuid,
      open: entry.open === true,
      raw: entry.raw === true,
    }))
    .filter(entry => entry.open || entry.raw);
}

export function createSessionDisclosureState() {
  const entries = reactive(new Map());

  function update(key, messageUuid, field) {
    const current = entries.get(key) || { messageUuid, open: false, raw: false };
    const next = { ...current, messageUuid, [field]: !current[field] };
    if (!next.open && !next.raw) entries.delete(key);
    else entries.set(key, next);
  }

  return {
    isOpen(key) {
      return Boolean(entries.get(key)?.open);
    },
    isRaw(key) {
      return Boolean(entries.get(key)?.raw);
    },
    toggleOpen(key, messageUuid) {
      update(key, messageUuid, 'open');
    },
    toggleRaw(key, messageUuid) {
      update(key, messageUuid, 'raw');
    },
    retainMessages(messageUuids) {
      for (const [key, entry] of entries) {
        if (!messageUuids.has(entry.messageUuid)) entries.delete(key);
      }
    },
    snapshot() {
      return [...entries].map(([key, entry]) => ({ key, ...entry }));
    },
    restore(snapshot, messageUuids = null) {
      entries.clear();
      for (const { key, ...entry } of normalizeSessionDisclosureSnapshot(snapshot, messageUuids)) {
        entries.set(key, {
          messageUuid: entry.messageUuid,
          open: entry.open,
          raw: entry.raw,
        });
      }
    },
  };
}
