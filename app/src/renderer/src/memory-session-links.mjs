const MAX_SESSION_CANDIDATES = 100;
const MAX_SESSION_ID_LENGTH = 512;

export function inlineCodeSessionCandidate(code) {
  if (!code || code.closest?.('pre')) return null;
  const raw = code.textContent;
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (!candidate || candidate.length > MAX_SESSION_ID_LENGTH) return null;
  return candidate;
}

// Memory agents already expose session IDs as inline code. The renderer does not
// interpret their shape: it collects bounded candidates and lets an exact DB lookup
// decide whether any of them are real sessions.
export function collectInlineSessionCandidates(root) {
  if (!root?.querySelectorAll) return [];
  const candidates = new Set();
  for (const code of root.querySelectorAll('code')) {
    const candidate = inlineCodeSessionCandidate(code);
    if (!candidate) continue;
    candidates.add(candidate);
    if (candidates.size >= MAX_SESSION_CANDIDATES) break;
  }
  return [...candidates];
}

function sessionIcon(document) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  const frame = document.createElementNS(namespace, 'path');
  frame.setAttribute('d', 'M3 4h10v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4z');
  const lines = document.createElementNS(namespace, 'path');
  lines.setAttribute('d', 'M5.5 7h5M5.5 9.5h3');
  lines.setAttribute('stroke-linecap', 'round');
  svg.append(frame, lines);
  return svg;
}

function sessionLabel(session, sessionId) {
  const title = typeof session?.title === 'string' ? session.title.trim() : '';
  return title || sessionId;
}

export function decorateResolvedInlineSessions(root, sessionsById) {
  if (!root?.querySelectorAll) return;
  const resolved = sessionsById instanceof Map ? sessionsById : new Map();

  for (const code of root.querySelectorAll('code')) {
    const sessionId = inlineCodeSessionCandidate(code);
    const session = sessionId ? resolved.get(sessionId) : null;
    if (!sessionId || !session) continue;

    const button = code.ownerDocument.createElement('button');
    const label = sessionLabel(session, sessionId);
    button.type = 'button';
    button.classList.add('session-link', 'markdown-session-link');
    button.dataset.sessionId = sessionId;
    button.title = `Session ID: ${sessionId}`;
    button.setAttribute('aria-label', `Open session: ${label}`);
    button.append(sessionIcon(code.ownerDocument), code.ownerDocument.createTextNode(label));
    code.replaceWith(button);
  }
}
