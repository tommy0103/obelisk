<script setup>
// Five writers, one database file.
//
// Step through the same six moments twice: once with the writer lease in place,
// once without. The second run is the actual incident — a secondary ROLLBACK
// destroying the primary exception, and a single-file failure escalating into a
// whole-build failure.

import { computed, onBeforeUnmount, ref, watch } from 'vue';

const ACTORS = [
  { id: 'daemon', label: 'App daemon 构建', note: '文件一变就索引' },
  { id: 'manual', label: 'App 手动重建', note: '用户点「重建索引」' },
  { id: 'cli', label: 'CLI 被动拉取', note: '每次 --search / --query / --attune' },
  { id: 'beat', label: '心跳写入', note: 'App 每 30 秒一次' },
  { id: 'attune', label: 'attune 记忆写入', note: '用户批准后' },
];

const E = (actor, kind, text, detail) => ({ actor, kind, text, detail });

const WITH_LEASE = [
  {
    t: '00:00',
    events: [
      E('cli', 'read', '只读检查心跳', 'inspectBuildOwnership 用只读连接读 __app_heartbeat__——读连接不建表、不迁移、不设 PRAGMA。'),
      E('cli', 'skip', 'skip: daemon_active', '心跳在 60 秒新鲜窗口内。CLI 不索引、不建表、不迁移、不改 PRAGMA、不 checkpoint、不 attune——但只读查询照常。'),
    ],
  },
  {
    t: '00:02',
    events: [
      E('daemon', 'lease', '拿到写者租约', 'writer.lock.sqlite 上一个 BEGIN IMMEDIATE 事务。选独立的 SQLite 文件，是因为两个 binding 用同一个 C 库，所有平台锁语义一致，且进程崩溃时自动释放。'),
      E('daemon', 'ok', '再查一次所有权', '关掉「判断没有 daemon」到「真的拿到锁」之间的 TOCTOU 窗口。'),
      E('daemon', 'work', '逐单元索引中', '一个单元一个事务：parse → persist → 写游标。'),
    ],
  },
  {
    t: '00:30',
    events: [
      E('beat', 'lease-fail', '拿不到租约，这次心跳跳过', 'busy_timeout=0，绝不阻塞——心跳跑在 Electron 主线程上，宁可这次写失败（30 秒后再来），也不能让界面卡住哪怕 250 毫秒。'),
    ],
  },
  {
    t: '00:41',
    events: [
      E('attune', 'lease-fail', '等 1 秒后放弃', 'acquireWriterLease({ waitMs: 1000 })。拿不到返回 null，不抛错——「现在有别人在写」不是错误，是一个需要处理的状态。'),
      E('attune', 'err', 'index writer is busy; attune was not applied', '给用户的说明是「暂时忙，重试即可」。'),
    ],
  },
  {
    t: '00:48',
    events: [
      E('daemon', 'ok', '收尾完成，释放租约', 'finally 里释放——中间有五处 return，任何一处都不会漏掉清理。'),
    ],
  },
  {
    t: '00:49',
    events: [
      E('attune', 'lease', '这次拿到了租约'),
      E('attune', 'read', '拿到租约后再检查一次心跳', 'core.ts 里那句注释直接点名：Close the heartbeat TOCTOU window after acquiring the hard lease.'),
      E('attune', 'err', 'daemon owns index writes; attune is read-only until the daemon stops', '和上一条完全不同的意思：这次是「有别的程序在管，你得先关掉它」。如果只返回一个布尔值，这个区分就消失了。'),
    ],
  },
];

const WITHOUT_LEASE = [
  {
    t: '00:00',
    events: [E('cli', 'read', '检查心跳', '这一层还在——心跳表达政策。')],
  },
  {
    t: '00:02',
    events: [E('daemon', 'work', '开始写', '没有租约，谁也不知道别人在不在写。')],
  },
  {
    t: '00:30',
    events: [
      E('beat', 'work', '直接开写连接'),
      E('beat', 'busy', 'SQLITE_BUSY on BEGIN IMMEDIATE', '心跳失败。这一条其实还算好的——失败在 begin 阶段，什么都还没做，放弃是安全的。'),
    ],
  },
  {
    t: '00:41',
    events: [
      E('attune', 'work', '开写事务'),
      E('attune', 'busy', 'SQLITE_BUSY_SNAPSHOT in work', '不是「忙」，是「过期」：WAL 下事务开始读之后别人提交了新数据，这个快照就落后了。**等再久，快照也不会自己更新**——这就是 busy_timeout 解决不了问题的原因。'),
      E('attune', 'mask', 'catch 块无条件 ROLLBACK', 'SQLite 已经自动结束了事务，所以 ROLLBACK 因为「没有活跃事务」而抛错。'),
      E('attune', 'lost', 'cannot rollback - no transaction is active', '**主异常被这个新异常盖掉了。** 证据在这里被销毁——所以 ADR 只能写「contention 是最可能的解释，而不是已证实的事实」。'),
    ],
  },
  {
    t: '00:41',
    events: [
      E('daemon', 'lost', '一个单文件失败 → 整次构建失败', '错误分类依赖诊断信息（phase / code / transactionActive），而诊断信息刚刚被清理代码毁掉了。降级判断失去依据。'),
    ],
  },
  {
    t: '教训',
    events: [
      E('daemon', 'fix', '清理代码不许掩盖主异常', '先问事务还在不在（true / false / null，只有确定已结束才跳过回滚）；回滚失败被捕获成数据；最后永远 throw 原始异常。'),
      E('daemon', 'fix', '心跳表达政策，租约保证互斥', '需要两个，因为心跳是有延迟的信息：App 刚启动还没写第一次心跳、崩溃了心跳还没过期——这些情况下政策会失灵。租约是那个兜底。'),
    ],
  },
];

const leaseOn = ref(true);
const step = ref(0);
const playing = ref(false);
let timer = null;

const frames = computed(() => (leaseOn.value ? WITH_LEASE : WITHOUT_LEASE));
const visible = computed(() => frames.value.slice(0, step.value + 1));
const atEnd = computed(() => step.value >= frames.value.length - 1);

function stop() {
  playing.value = false;
  clearInterval(timer);
  timer = null;
}

function play() {
  if (playing.value) return stop();
  if (atEnd.value) step.value = 0;
  playing.value = true;
  timer = setInterval(() => {
    if (atEnd.value) return stop();
    step.value += 1;
  }, 2400);
}

watch(leaseOn, () => {
  stop();
  step.value = 0;
});

onBeforeUnmount(stop);

function nudge(delta) {
  stop();
  step.value = Math.max(0, Math.min(frames.value.length - 1, step.value + delta));
}

const busyCount = computed(
  () => frames.value.flatMap((f) => f.events).filter((e) => e.kind === 'busy' || e.kind === 'lost').length,
);
</script>

<template>
  <div class="lease">
    <div class="head">
      <button class="btn toggle" type="button" :class="leaseOn ? 'primary' : 'danger'" @click="leaseOn = !leaseOn">
        <span class="knob" />
        {{ leaseOn ? '写者租约：开' : '写者租约：关' }}
      </button>
      <span class="tally" :class="{ bad: !leaseOn }">
        {{ leaseOn ? '没有一次写入重叠' : `${busyCount} 次冲突 / 丢失的诊断` }}
      </span>
    </div>

    <div class="actors">
      <span v-for="a in ACTORS" :key="a.id" class="actor" :title="a.note">{{ a.label }}</span>
    </div>

    <ol class="timeline">
      <li v-for="(frame, i) in visible" :key="i" class="frame" :class="{ latest: i === step }">
        <span class="clock">{{ frame.t }}</span>
        <div class="events">
          <div v-for="(e, j) in frame.events" :key="j" class="event" :class="e.kind">
            <span class="who">{{ ACTORS.find((a) => a.id === e.actor)?.label }}</span>
            <span class="what">{{ e.text }}</span>
            <p v-if="e.detail" class="detail">{{ e.detail }}</p>
          </div>
        </div>
      </li>
    </ol>

    <div class="controls">
      <button class="btn" type="button" :disabled="step === 0" @click="nudge(-1)">← 回退</button>
      <button class="btn primary" type="button" @click="play">
        {{ playing ? '暂停' : atEnd ? '重放' : '播放' }}
      </button>
      <button class="btn" type="button" :disabled="atEnd" @click="nudge(1)">下一刻 →</button>
      <span class="counter">{{ step + 1 }} / {{ frames.length }}</span>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  margin-bottom: 0.85rem;
}

.toggle .knob {
  width: 0.7rem;
  height: 0.7rem;
  border-radius: 50%;
  background: currentColor;
}

.tally {
  font: 0.75rem/1.6 var(--mono);
  color: var(--green);
}

.tally.bad {
  color: var(--red);
}

.actors {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-bottom: 1rem;
}

.actor {
  padding: 0.14rem 0.5rem;
  border: 1px solid var(--edge);
  border-radius: 4px;
  font: 0.66rem/1.6 var(--mono);
  color: var(--faint);
  cursor: help;
}

.timeline {
  margin: 0;
  padding: 0;
  list-style: none;
  border-left: 1px solid var(--edge);
}

.frame {
  display: grid;
  grid-template-columns: 3.6rem 1fr;
  gap: 0.7rem;
  padding: 0.3rem 0 0.55rem 0.85rem;
  margin-left: -1px;
  border-left: 2px solid transparent;
}

.frame.latest {
  border-left-color: var(--accent);
}

.clock {
  padding-top: 0.15rem;
  font: 0.68rem/1.7 var(--mono);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}

.event {
  padding: 0.42rem 0.65rem;
  margin-bottom: 0.3rem;
  border: 1px solid var(--edge);
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.018);
}

.who {
  display: block;
  font: 0.63rem/1.6 var(--mono);
  letter-spacing: 0.06em;
  color: var(--dim);
}

.what {
  display: block;
  font: 0.82rem/1.55 var(--sans);
  color: var(--fg);
}

.detail {
  margin-top: 0.28rem;
  font-size: 0.78rem;
  line-height: 1.7;
  color: var(--muted);
}

.event.lease { border-color: var(--accent-line); background: rgba(167, 139, 250, 0.07); }
.event.lease .what { color: var(--accent); }
.event.lease-fail { border-color: rgba(245, 158, 11, 0.35); background: var(--amber-soft); }
.event.lease-fail .what { color: var(--amber); }
.event.skip { border-style: dashed; }
.event.skip .what,
.event.err .what { color: var(--amber); }
.event.busy,
.event.mask { border-color: rgba(248, 113, 113, 0.35); background: var(--red-soft); }
.event.busy .what,
.event.mask .what { color: var(--red); }
.event.lost {
  border-color: var(--red);
  background: rgba(248, 113, 113, 0.16);
}
.event.lost .what { color: var(--red); font-weight: 600; }
.event.fix { border-color: rgba(110, 231, 183, 0.35); background: var(--green-soft); }
.event.fix .what { color: var(--green); }
.event.ok .what { color: var(--green); }

.controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1rem;
  padding-top: 0.85rem;
  border-top: 1px solid var(--edge);
}

.counter {
  margin-left: auto;
  font: 0.72rem/1.6 var(--mono);
  color: var(--dim);
  font-variant-numeric: tabular-nums;
}
</style>
