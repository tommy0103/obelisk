// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { normalize } from 'node:path';

// Existing composite identities are persistent data: do not change their bytes.
export function opencodeStoreHash(storePath: string): string {
  return createHash('sha256').update(`opencode-store-v1\0${normalize(storePath)}`).digest('hex');
}

export function opencodeSessionId(nativeId: string, storePath: string): string {
  return `opencode:${encodeURIComponent(nativeId)}:${opencodeStoreHash(storePath)}`;
}

export function opencodeUnitKey(storePath: string, nativeId: string): string {
  return `${normalize(storePath)}#ses:${encodeURIComponent(nativeId)}`;
}

export function decodeOpencodeUnitKey(key: string): { dbPath: string; nativeId: string } | null {
  // The encoded native id cannot contain '#'; the store path can contain '#ses:'.
  const delimiter = key.lastIndexOf('#ses:');
  if (delimiter < 1) return null;
  try {
    const dbPath = normalize(key.slice(0, delimiter));
    const nativeId = decodeURIComponent(key.slice(delimiter + 5));
    if (!nativeId || opencodeUnitKey(dbPath, nativeId) !== key) return null;
    return { dbPath, nativeId };
  } catch { return null; }
}

/** Control state shares index_state, never canonical sessions or transcript hints. */
export function opencodeObservationKey(storePath: string): string {
  return `__opencode_observation_v1__:${opencodeStoreHash(storePath)}`;
}

export function opencodeObservationProofKey(storePath: string): string {
  return `__opencode_observation_proof_v1__:${opencodeStoreHash(storePath)}`;
}
