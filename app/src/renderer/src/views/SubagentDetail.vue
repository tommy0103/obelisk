<!-- Copyright (C) 2026 tommy0103 and contributors. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

<script setup>
import { ref, reactive, onMounted, watch } from 'vue';
import { loadSubagentDetail, isTextTruncated, loadFullText } from '../data.js';
import { fmtClockTime, renderMarkdown } from '../utils.js';

defineOptions({ name: 'SubagentDetail' });
const props = defineProps({ id: String, agentId: String });

const messages = ref([]);
const loading = ref(false);

onMounted(async () => { await load(); });
watch(() => props.agentId, async (n, o) => { if (n && n !== o) { messages.value = []; await load(); } });

async function load() {
  if (!props.agentId) return;
  loading.value = true;
  try {
    messages.value = await loadSubagentDetail(props.agentId);
  } finally { loading.value = false; }
}

const fullText = reactive(new Map());

async function handleLoadFull(uuid) {
  const full = await loadFullText(uuid);
  if (full) fullText.set(uuid, full);
}

function renderMsgMarkdown(msg, text, variant) {
  return renderMarkdown(text, { variant, cwd: msg?.cwd || null, sessionId: msg?.session_id || null });
}
</script>

<template>
  <div class="session-detail-wrap" ref="wrapRef">
    <div class="detail-wide">
      <div class="session-header">
        <div class="session-eyebrow">
          <span style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;">Subagent</span>
        </div>
        <div class="session-title">{{ agentId }}</div>
        <div class="session-meta-inline">
          <span>{{ messages.length }} messages</span>
        </div>
      </div>

      <div v-if="loading" class="empty">Loading…</div>

      <div v-else class="timeline">
        <div
          v-for="msg in messages"
          :key="msg.uuid"
          class="msg"
          :class="[msg.type === 'user' ? 'user' : 'assistant']"
          :data-uuid="msg.uuid"
        >
          <template v-if="msg.content_type === 'thinking'">
            <div class="msg-thinking">
              <button class="thinking-toggle" @click="$event.currentTarget.closest('.msg-thinking').classList.toggle('open')">
                <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                <span class="thinking-label">Thinking</span>
              </button>
              <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown() -->
              <div class="thinking-body" v-html="renderMsgMarkdown(msg, msg.text, 'msg')"></div>
            </div>
          </template>

          <template v-else-if="msg.is_meta">
            <div class="msg-meta-collapsed">
              <button class="meta-toggle" @click="$event.currentTarget.closest('.msg-meta-collapsed').classList.toggle('open')">
                <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                <span class="meta-label">System</span>
                <span class="meta-preview">{{ (msg.text || '').replace(/<[^>]+>/g, '').slice(0, 80) }}</span>
              </button>
              <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown() -->
              <div class="meta-body" v-html="renderMsgMarkdown(msg, msg.text, 'compact')"></div>
            </div>
          </template>

          <template v-else>
            <div class="msg-head">
              <span class="role">{{ msg.type === 'user' ? 'Prompt' : 'Assistant' }}</span>
              <span class="when">{{ msg.timestamp ? fmtClockTime(msg.timestamp) : '' }}</span>
            </div>
            <div v-if="msg._thinking" class="msg-thinking">
              <button class="thinking-toggle" @click="$event.currentTarget.closest('.msg-thinking').classList.toggle('open')">
                <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                <span class="thinking-label">Thinking</span>
              </button>
              <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown() -->
              <div class="thinking-body" v-html="renderMsgMarkdown(msg, msg._thinking, 'msg')"></div>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown() -->
            <div v-if="msg.text" v-html="renderMsgMarkdown(msg, fullText.get(msg.uuid) ?? msg.text, 'msg')"></div>
            <div v-else-if="!msg.tool_calls?.length" class="msg-text empty-text">(no text content)</div>
            <button
              v-if="isTextTruncated(msg.text) && !fullText.has(msg.uuid)"
              class="truncated-btn"
              @click="handleLoadFull(msg.uuid)"
            >Message truncated — click to load full text</button>

            <div v-if="msg.tool_calls?.length" class="msg-tools">
              <div v-for="tc in msg.tool_calls" :key="tc.id" class="msg-tool" :class="{ 'is-error': tc.result?.is_error }">
                <button class="toolcall-toggle" @click="$event.currentTarget.closest('.msg-tool').classList.toggle('open')">
                  <svg class="chevron" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M2.5 1.5l3 2.5-3 2.5"/></svg>
                  <span class="tool-name">{{ tc.name }}</span>
                  <span class="tool-arg">{{ getToolArgPreview(tc) }}</span>
                  <span v-if="tc.result?.is_error" class="tool-error">error</span>
                </button>
                <div class="toolcall-body">
                  <div class="tc-section">Input</div>
                  <pre>{{ tc.input_json }}</pre>
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
    </div>
  </div>
</template>

<script>
function getToolArgPreview(tc) {
  try {
    const j = JSON.parse(tc.input_json || '{}');
    return j.file_path || j.command || j.path || j.description || JSON.stringify(j).slice(0, 100);
  } catch { return (tc.input_json || '').slice(0, 100); }
}
</script>
