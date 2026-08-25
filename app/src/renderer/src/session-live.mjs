// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

export function createSessionLiveState() {
  return {
    dirtySessions: new Set(),
  };
}

export const sessionLiveState = createSessionLiveState();

export function markSessionDirty(sessionId, live = sessionLiveState) {
  if (sessionId) live.dirtySessions.add(sessionId);
}

export function noteSessionUpdated(live, sessionId, currentSessionId = null) {
  if (!sessionId) return { reload: false, sessionId: null };
  if (sessionId === currentSessionId) {
    live.dirtySessions.delete(sessionId);
    return { reload: true, sessionId };
  }
  markSessionDirty(sessionId, live);
  return { reload: false, sessionId };
}

export function clearSessionDirty(sessionId, live = sessionLiveState) {
  if (sessionId) live.dirtySessions.delete(sessionId);
}

export function consumeSessionDirty(live, sessionId) {
  if (!sessionId || !live.dirtySessions.has(sessionId)) return false;
  live.dirtySessions.delete(sessionId);
  return true;
}

export function consumeGlobalSessionDirty(sessionId) {
  return consumeSessionDirty(sessionLiveState, sessionId);
}
