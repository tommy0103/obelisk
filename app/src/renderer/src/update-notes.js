// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import DOMPurify from 'dompurify';
import { marked } from 'marked';

// Treat both Markdown (GitHub) and HTML (Sparkle) as untrusted. No media,
// forms, styles, or active content; only user-initiated HTTPS links reach the existing main navigation guard.
export function renderUpdateNotes(notes) {
  return DOMPurify.sanitize(marked.parse(String(notes || '').slice(0, 65_536), { async: false }), {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'strong', 'em', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'br', 'a'],
    ALLOWED_ATTR: ['href', 'title'],
    ALLOWED_URI_REGEXP: /^https:\/\//i,
    ALLOW_DATA_ATTR: false,
  });
}
