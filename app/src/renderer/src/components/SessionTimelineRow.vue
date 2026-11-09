<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { computed } from 'vue';
import { isTextTruncated } from '../data.js';
import { buildSessionTimelinePresentation } from '../session-timeline-presentation.mjs';
import { fmtClockTime } from '../utils.js';

const props = defineProps({
  item: { type: Object, required: true },
  focused: Boolean,
  query: { type: String, default: '' },
  disclosures: { type: Object, required: true },
  expandedMessageText: { type: Object, required: true },
  fullTextLoading: { type: Object, required: true },
});
const emit = defineEmits(['load-full-text', 'navigate-subagent']);

const msg = computed(() => props.item.message);
const expandedText = computed(() => props.expandedMessageText.get(msg.value.uuid));

// The expensive HTML projection is memoized by the exact inputs that can
// change its output. Focus, disclosure, nav progress, and parent scroll state
// can re-render UI chrome without re-parsing unchanged message/tool content.
const presentation = computed(() => buildSessionTimelinePresentation(props.item, {
  query: props.query,
  expandedText: expandedText.value,
}));

function toggleDisclosure(key, messageUuid) {
  props.disclosures.toggleOpen(key, messageUuid);
}

function toggleRaw(key, messageUuid) {
  props.disclosures.toggleRaw(key, messageUuid);
}

function canLoadFullText(message) {
  return !props.expandedMessageText.has(message.uuid) && isTextTruncated(message.text);
}

function loadFullText(messageUuid) {
  emit('load-full-text', messageUuid);
}

function navigateToSubagent(agentId, description = '') {
  emit('navigate-subagent', agentId, description);
}
</script>

<template>
  <template v-if="item.kind === 'meta'">
    <div class="msg meta" :class="{ 'is-focused': focused }" :data-uuid="item.anchorUuid" :data-message-uuid="item.messageUuid">
      <div class="msg-meta-collapsed" :class="{ open: disclosures.isOpen(`meta:${msg.uuid}`) }" :data-view-key="`meta:${msg.uuid}`">
        <button class="meta-toggle" @click="toggleDisclosure(`meta:${msg.uuid}`, msg.uuid)">
          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
          <span class="meta-label">System</span>
          <span class="meta-preview">{{ (msg.text || '').replace(/<[^>]+>/g, '').slice(0, 80) }}</span>
        </button>
        <div class="meta-body">
          <div v-html="presentation.messageHtml"></div>
          <button
            v-if="canLoadFullText(msg)"
            class="truncated-btn"
            :disabled="fullTextLoading.has(msg.uuid)"
            @click="loadFullText(msg.uuid)"
          >{{ fullTextLoading.has(msg.uuid) ? 'Loading full text…' : 'Message truncated — click to load full text' }}</button>
        </div>
      </div>
    </div>
  </template>

  <template v-else-if="item.kind === 'workflow'">
    <div class="wf-card" :class="{ 'is-focused': focused }" :data-uuid="item.anchorUuid" :data-message-uuid="item.messageUuid">
      <div class="wf-card-header">
        <span class="wf-card-icon">&#x2699;</span>
        <span class="wf-card-name">{{ item.workflowCall.workflow.workflow_name || 'Workflow' }}</span>
        <span class="wf-card-count">{{ item.workflowCall.workflow.agents?.length || 0 }} agents</span>
        <span
          v-if="item.workflowCall.workflow.status"
          class="wf-card-status"
          :class="item.workflowCall.workflow.status"
        >{{ item.workflowCall.workflow.status }}</span>
      </div>
      <div class="wf-card-body">
        <template v-for="(phaseAgents, phase) in presentation.standaloneWorkflowGroups" :key="phase">
          <div class="wf-card-phase">
            <div class="wf-card-phase-title">{{ phase }}</div>
            <button
              v-for="agent in phaseAgents"
              :key="agent.agent_id"
              class="wf-card-agent"
              @click="navigateToSubagent(agent.agent_id, agent.label || '')"
            >
              <span class="wf-card-agent-label">{{ agent.label || agent.agent_id }}</span>
              <span v-if="agent.state === 'error'" class="wf-card-agent-state error">error</span>
              <span class="wf-card-agent-arrow">&rarr;</span>
            </button>
          </div>
        </template>
      </div>
    </div>
  </template>

  <template v-else-if="item.kind === 'workflow-tools'">
    <div class="msg assistant" :class="{ 'is-focused': focused }" :data-uuid="item.anchorUuid" :data-message-uuid="item.messageUuid">
      <div class="msg-tools">
        <template v-for="tc in item.toolCalls" :key="tc.id">
          <div
            class="msg-tool"
            :class="{ open: disclosures.isOpen(`tool:${tc.id}`), 'is-error': tc.result && tc.result.is_error }"
            :data-view-key="`tool:${tc.id}`"
          >
            <button class="toolcall-toggle" @click="toggleDisclosure(`tool:${tc.id}`, msg.uuid)">
              <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
              <span v-if="presentation.toolIcons.get(tc.id)" class="tool-icon" v-html="presentation.toolIcons.get(tc.id)"></span>
              <span class="tool-name">{{ tc.name }}</span>
              <span class="tool-arg">{{ presentation.toolArgPreviews.get(tc.id) }}</span>
              <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
            </button>
            <div class="toolcall-body">
              <div class="toolcall-body-strip">
                <span class="strip-label">{{ tc.name }}</span>
                <span class="spacer"></span>
                <button class="raw-toggle" :class="{ active: disclosures.isRaw(`tool:${tc.id}`) }" @click.stop="toggleRaw(`tool:${tc.id}`, msg.uuid)">{ } Raw</button>
              </div>
              <div class="toolcall-pretty" :class="{ hidden: disclosures.isRaw(`tool:${tc.id}`) }" v-html="presentation.toolPrettyHtml.get(tc.id)"></div>
              <div class="toolcall-raw" :class="{ show: disclosures.isRaw(`tool:${tc.id}`) }">
                <div class="tc-section">Input</div>
                <pre>{{ presentation.toolInputText.get(tc.id) }}</pre>
                <template v-if="tc.result">
                  <div class="tc-section">{{ tc.result.is_error ? 'Error' : 'Output' }}</div>
                  <pre>{{ tc.result.content || '(empty)' }}</pre>
                </template>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </template>

  <template v-else-if="item.kind === 'skill'">
    <div
      class="skill-card"
      :class="{ 'skill-md-open': disclosures.isOpen(`skill:${msg.uuid}`), 'is-focused': focused }"
      :data-uuid="item.anchorUuid"
      :data-message-uuid="item.messageUuid"
      :data-view-key="`skill:${msg.uuid}`"
    >
      <div class="skill-card-icon">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5h6M5 9h4"/></svg>
      </div>
      <div class="skill-card-body">
        <div class="skill-card-header">
          <span class="skill-card-badge">Skill</span>
          <span class="skill-card-name">{{ presentation.toolInputs.get(msg.tool_calls[0].id)?.skill || '?' }}</span>
        </div>
        <div class="skill-card-args">{{ presentation.toolInputs.get(msg.tool_calls[0].id)?.args || '' }}</div>
        <div v-if="msg._skillMd" class="skill-card-md">
          <button class="skill-md-toggle" @click="toggleDisclosure(`skill:${msg.uuid}`, msg.uuid)">
            <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
            <span>SKILL.md</span>
          </button>
          <div class="skill-md-body" v-html="presentation.skillHtml"></div>
        </div>
      </div>
    </div>
  </template>

  <template v-else-if="item.kind === 'thinking'">
    <div class="msg assistant" :class="{ 'is-focused': focused }" :data-uuid="item.anchorUuid" :data-message-uuid="item.messageUuid">
      <div class="msg-thinking" :class="{ open: disclosures.isOpen(`thinking:${msg.uuid}`) }" :data-view-key="`thinking:${msg.uuid}`">
        <button class="thinking-toggle" @click="toggleDisclosure(`thinking:${msg.uuid}`, msg.uuid)">
          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
          <span class="thinking-label">Thinking</span>
        </button>
        <div class="thinking-body" v-html="presentation.thinkingHtml"></div>
      </div>
    </div>
  </template>

  <template v-else>
    <div
      class="msg"
      :class="[msg.type === 'user' ? 'user' : 'assistant', { 'is-focused': focused }]"
      :data-uuid="item.anchorUuid"
      :data-message-uuid="item.messageUuid"
    >
      <div class="msg-head">
        <span class="role">{{ msg.type === 'user' ? 'You' : 'Assistant' }}</span>
        <span class="when">{{ msg.timestamp ? fmtClockTime(msg.timestamp) : '' }}</span>
      </div>

      <div v-if="msg._thinking" class="msg-thinking" :class="{ open: disclosures.isOpen(`thinking:${msg.uuid}`) }" :data-view-key="`thinking:${msg.uuid}`">
        <button class="thinking-toggle" @click="toggleDisclosure(`thinking:${msg.uuid}`, msg.uuid)">
          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
          <span class="thinking-label">Thinking</span>
        </button>
        <div class="thinking-body" v-html="presentation.thinkingHtml"></div>
      </div>

      <template v-if="msg.text">
        <div v-html="presentation.messageHtml"></div>
        <button
          v-if="canLoadFullText(msg)"
          class="truncated-btn"
          :disabled="fullTextLoading.has(msg.uuid)"
          @click="loadFullText(msg.uuid)"
        >{{ fullTextLoading.has(msg.uuid) ? 'Loading full text…' : 'Message truncated — click to load full text' }}</button>
      </template>
      <template v-else-if="!(msg.tool_calls && msg.tool_calls.length)">
        <div class="msg-text empty-text">(no text content)</div>
      </template>

      <div v-if="msg.tool_calls && msg.tool_calls.length" class="msg-tools">
        <template v-for="tc in msg.tool_calls" :key="tc.id">
          <template v-if="tc.name === 'Skill'">
            <div class="skill-badge">
              <span class="skill-label">skill</span>
              <span class="skill-name">{{ presentation.toolInputs.get(tc.id)?.skill || '?' }}</span>
            </div>
          </template>

          <template v-else-if="tc.name === 'Agent' || tc.name === 'Task'">
            <div class="msg-tool agent-call" :class="{ open: disclosures.isOpen(`tool:${tc.id}`) }" :data-view-key="`tool:${tc.id}`">
              <button class="toolcall-toggle" @click="toggleDisclosure(`tool:${tc.id}`, msg.uuid)">
                <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                <span class="tool-name">{{ presentation.toolInputs.get(tc.id)?.subagent_type || presentation.toolInputs.get(tc.id)?.agentType || 'Agent' }}</span>
                <span class="tool-arg">{{ presentation.toolInputs.get(tc.id)?.description || (presentation.toolInputs.get(tc.id)?.prompt || '').slice(0, 80) }}</span>
                <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
                <button
                  v-if="tc.subagent?.agent_id"
                  class="agent-nav-btn"
                  @click.stop="navigateToSubagent(tc.subagent.agent_id, presentation.toolInputs.get(tc.id)?.description || '')"
                >View conversation &rarr;</button>
              </button>
              <div class="toolcall-body" style="padding:10px 12px;">
                <template v-if="presentation.toolInputs.get(tc.id)?.prompt">
                  <div class="tc-section">Prompt</div>
                  <div class="agent-prompt">{{ (presentation.toolInputs.get(tc.id)?.prompt || '').slice(0, 500) }}{{ (presentation.toolInputs.get(tc.id)?.prompt || '').length > 500 ? '...' : '' }}</div>
                </template>
                <template v-if="tc.result?.content">
                  <div class="tc-section">Result</div>
                  <div class="agent-result" v-html="presentation.toolResultHtml.get(tc.id)"></div>
                </template>
              </div>
            </div>
          </template>

          <template v-else-if="tc.name === 'Workflow'">
            <div class="msg-tool agent-call" :class="{ open: disclosures.isOpen(`tool:${tc.id}`) }" :data-view-key="`tool:${tc.id}`">
              <button class="toolcall-toggle" @click="toggleDisclosure(`tool:${tc.id}`, msg.uuid)">
                <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                <span class="tool-name">Workflow</span>
                <span class="tool-arg">{{ tc.workflow?.workflow_name || presentation.toolInputs.get(tc.id)?.name || 'Workflow' }}</span>
                <span v-if="tc.workflow?.status" class="workflow-status" :class="tc.workflow.status">{{ tc.workflow.status }}</span>
                <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
              </button>
              <div class="toolcall-body" style="padding:10px 12px;">
                <template v-if="tc.workflow?.agents?.length">
                  <div class="tc-section">Agents &middot; {{ tc.workflow.agents.length }}</div>
                  <div class="workflow-agent-list">
                    <template v-for="(phaseAgents, phase) in presentation.workflowAgentGroups.get(tc.id)" :key="phase">
                      <div class="workflow-phase-group">
                        <div class="workflow-phase-header">{{ phase }}</div>
                        <div class="workflow-phase-agents">
                          <button
                            v-for="agent in phaseAgents"
                            :key="agent.agent_id"
                            class="workflow-agent-row"
                            @click.stop="navigateToSubagent(agent.agent_id, agent.label || '')"
                          >
                            <span class="workflow-agent-label">{{ agent.label || agent.agent_id }}</span>
                            <span class="workflow-agent-state" :class="agent.state || ''">{{ agent.state || '' }}</span>
                          </button>
                        </div>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="msg-tool" :class="{ open: disclosures.isOpen(`tool:${tc.id}`), 'is-error': tc.result && tc.result.is_error }" :data-view-key="`tool:${tc.id}`">
              <button class="toolcall-toggle" @click="toggleDisclosure(`tool:${tc.id}`, msg.uuid)">
                <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                <span v-if="presentation.toolIcons.get(tc.id)" class="tool-icon" v-html="presentation.toolIcons.get(tc.id)"></span>
                <span class="tool-name">{{ tc.name }}</span>
                <span class="tool-arg">{{ presentation.toolArgPreviews.get(tc.id) }}</span>
                <span v-if="tc.result && tc.result.is_error" class="tool-error">error</span>
              </button>
              <div class="toolcall-body">
                <div class="toolcall-body-strip">
                  <span class="strip-label">{{ tc.name }}</span>
                  <span class="spacer"></span>
                  <button class="raw-toggle" :class="{ active: disclosures.isRaw(`tool:${tc.id}`) }" @click.stop="toggleRaw(`tool:${tc.id}`, msg.uuid)">{ } Raw</button>
                </div>
                <div class="toolcall-pretty" :class="{ hidden: disclosures.isRaw(`tool:${tc.id}`) }" v-html="presentation.toolPrettyHtml.get(tc.id)"></div>
                <div class="toolcall-raw" :class="{ show: disclosures.isRaw(`tool:${tc.id}`) }">
                  <div class="tc-section">Input</div>
                  <pre>{{ presentation.toolInputText.get(tc.id) }}</pre>
                  <template v-if="tc.result">
                    <div class="tc-section">{{ tc.result.is_error ? 'Error' : 'Output' }}</div>
                    <pre>{{ tc.result.content || '(empty)' }}</pre>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </template>
      </div>

      <div v-if="msg.summary" class="msg-summary" :class="{ open: disclosures.isOpen(`summary:${msg.uuid}`) }" :data-view-key="`summary:${msg.uuid}`">
        <button class="summary-toggle" @click="toggleDisclosure(`summary:${msg.uuid}`, msg.uuid)">
          <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
          <span class="label">Session summary</span>
          <span class="source">{{ msg.summary.source || '' }}</span>
        </button>
        <div class="summary-body" v-html="presentation.summaryHtml"></div>
      </div>
    </div>
  </template>
</template>
