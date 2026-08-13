// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

const TOOL_ROOT_KINDS = new Set(['workflow', 'workflow-tools', 'skill']);

export function normalizeSessionTimelineVisibility(value = {}) {
  return {
    tools: value?.tools !== false,
    thinking: value?.thinking !== false,
  };
}

function messageHasVisibleContent(message, visibility) {
  if (message?.text || message?.summary) return true;
  if (visibility.thinking && message?._thinking) return true;
  return visibility.tools && (message?.tool_calls?.length || 0) > 0;
}

export function filterSessionTimelineItems(items = [], value = {}) {
  const visibility = normalizeSessionTimelineVisibility(value);
  if (visibility.tools && visibility.thinking) return items;

  return items.filter(item => {
    if (item?.kind === 'thinking') return visibility.thinking;
    if (TOOL_ROOT_KINDS.has(item?.kind)) return visibility.tools;
    if (item?.kind === 'message') {
      return messageHasVisibleContent(item.message, visibility);
    }
    return true;
  });
}
