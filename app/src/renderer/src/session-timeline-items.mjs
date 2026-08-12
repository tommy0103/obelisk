// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

function timelineItem(kind, message, messageUuid, extras = {}) {
  return {
    key: `${kind}:${messageUuid}`,
    kind,
    anchorUuid: kind === 'workflow-tools' ? `${messageUuid}-tools` : messageUuid,
    messageUuid,
    message,
    ...extras,
  };
}

function messageItems(message, index) {
  const messageUuid = message?.uuid || `message-${index}`;
  if (message?.is_meta === 1) {
    return [timelineItem('meta', message, messageUuid)];
  }

  const workflowCall = message?.type !== 'user'
    ? (message?.tool_calls || []).find(call => call.name === 'Workflow' && call.workflow)
    : null;
  if (workflowCall) {
    const items = [timelineItem('workflow', message, messageUuid, { workflowCall })];
    const toolCalls = (message.tool_calls || []).filter(call => call !== workflowCall);
    if (toolCalls.length) {
      items.push(timelineItem('workflow-tools', message, messageUuid, { toolCalls }));
    }
    return items;
  }

  if (
    message?.type === 'assistant'
    && (message.tool_calls || []).length === 1
    && message.tool_calls[0].name === 'Skill'
    && !message.text
  ) {
    return [timelineItem('skill', message, messageUuid)];
  }

  if (message?.type === 'assistant' && message.content_type === 'thinking') {
    return [timelineItem('thinking', message, messageUuid)];
  }

  return [timelineItem('message', message, messageUuid)];
}

export function reconcileTimelineItems(current = [], messages = []) {
  const currentByKey = new Map(current.map(item => [item.key, item]));
  return messages.flatMap((message, index) => (
    messageItems(message, index).map(item => {
      const existing = currentByKey.get(item.key);
      return existing?.message === item.message ? existing : item;
    })
  ));
}
