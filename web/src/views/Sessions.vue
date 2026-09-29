<script setup>
import { computed, ref, watch } from 'vue';
import { api, toParams } from '../api.js';
import { fmtCompact, fmtCredit, fmtNum, fmtPct, fmtTime, fmtDuration, fmtSec, baseName } from '../utils/format.js';
import PhaseMiniBar from '../components/PhaseMiniBar.vue';

const props = defineProps({ filter: Object });
const emit = defineEmits(['open-session']);

const items = ref([]);
const error = ref('');
const sortKey = ref('credit');
const sortDir = ref(-1);
/** 被收起的项目。默认全展开，所以只记"收起来的"，新项目天然是展开的 */
const collapsed = ref(new Set());

async function load() {
  error.value = '';
  try {
    const r = await api.sessions(toParams(props.filter));
    items.value = r.items;
  } catch (e) {
    error.value = e.message;
  }
}

watch(() => props.filter, load, { deep: true, immediate: true });
defineExpose({ reload: load });

const sorted = computed(() => {
  const arr = [...items.value];
  arr.sort((a, b) => {
    const av = a[sortKey.value];
    const bv = b[sortKey.value];
    if (typeof av === 'string') return av.localeCompare(bv) * sortDir.value;
    return (av - bv) * sortDir.value;
  });
  return arr;
});

/**
 * 按项目分组。
 * 为什么值得分组：会话列表一屏看不出"钱花在哪个项目的哪些会话上"，
 * 而项目维度原来只能靠筛选器一个个切。组头同时当**小计行**——数值按列对齐，
 * 所以收起一个组不会丢失它的总量信息。
 * 组顺序按 credit 排，与总览的「项目用量排行」口径一致。
 * 排序只在组内生效（跨组比较没有意义）。
 */
const groups = computed(() => {
  const map = new Map();
  for (const s of sorted.value) {
    const key = s.projectId || '(未知项目)';
    let g = map.get(key);
    if (!g) {
      g = {
        projectId: key,
        name: baseName(s.cwd) || key,
        path: s.cwd || '',
        sessions: [],
        requests: 0,
        prompt: 0,
        completion: 0,
        cacheRead: 0,
        credit: 0,
        startTs: Infinity,
      };
      map.set(key, g);
    }
    g.sessions.push(s);
    g.requests += s.requests;
    g.prompt += s.prompt;
    g.completion += s.completion;
    g.cacheRead += s.cacheRead;
    g.credit += s.credit;
    g.startTs = Math.min(g.startTs, s.startTs);
  }
  return [...map.values()]
    .map((g) => ({ ...g, cacheHitRate: g.prompt ? g.cacheRead / g.prompt : 0 }))
    .sort((a, b) => b.credit - a.credit);
});

/** 进度条口径保持全局：组内组外的条形才能横向比较 */
const maxCredit = computed(() => Math.max(1, ...items.value.map((s) => s.credit)));
const maxGroupCredit = computed(() => Math.max(1, ...groups.value.map((g) => g.credit)));

function sortBy(k) {
  if (sortKey.value === k) sortDir.value *= -1;
  else {
    sortKey.value = k;
    sortDir.value = -1;
  }
}

const arrow = (k) => (sortKey.value === k ? (sortDir.value === -1 ? ' ↓' : ' ↑') : '');

function toggleGroup(id) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}
const isCollapsed = (id) => collapsed.value.has(id);

const allCollapsed = computed(
  () => groups.value.length > 0 && groups.value.every((g) => collapsed.value.has(g.projectId)),
);
function toggleAll() {
  collapsed.value = allCollapsed.value ? new Set() : new Set(groups.value.map((g) => g.projectId));
}

/* ---------- 用时构成（模型生成 / 工具执行 / 等待用户） ---------- */

/** 组头的小计：把组内各会话的阶段时长加起来，再交给微缩条渲染 */
function groupPhase(g) {
  const acc = { modelMs: 0, toolMs: 0, waitMs: 0, activeMs: 0 };
  for (const s of g.sessions) {
    if (!s.phase) continue;
    acc.modelMs += s.phase.modelMs;
    acc.toolMs += s.phase.toolMs;
    acc.waitMs += s.phase.waitMs;
    acc.activeMs += s.phase.activeMs;
  }
  return acc;
}

/** 条宽按"在岗时长"归一化，一眼能看出哪个会话真正耗时多 */
const maxActiveMs = computed(() => Math.max(1, ...items.value.map((s) => (s.phase ? s.phase.activeMs : 0))));
const maxGroupActiveMs = computed(() => Math.max(1, ...groups.value.map((g) => groupPhase(g).activeMs)));
</script>

<template>
  <div class="panel view-fill">
    <div class="panel-head">
      <div>
        <div class="panel-title">会话列表</div>
        <div class="panel-sub">
          共 {{ items.length }} 个会话 · 按项目归类为 {{ groups.length }} 组 · 点击行查看逐次请求明细
        </div>
      </div>
      <button v-if="groups.length > 1" class="btn ghost" @click="toggleAll">
        {{ allCollapsed ? '全部展开' : '全部收起' }}
      </button>
    </div>

    <div v-if="error" class="empty">{{ error }}</div>

    <div v-else class="scroll">
      <table>
        <thead>
          <tr>
            <th style="cursor: pointer" @click="sortBy('title')">会话{{ arrow('title') }}</th>
            <th style="cursor: pointer" @click="sortBy('projectId')">项目{{ arrow('projectId') }}</th>
            <th>模型</th>
            <th class="right" style="cursor: pointer" @click="sortBy('requests')">请求{{ arrow('requests') }}</th>
            <th class="right" style="cursor: pointer" @click="sortBy('prompt')">输入{{ arrow('prompt') }}</th>
            <th class="right" style="cursor: pointer" @click="sortBy('completion')">输出{{ arrow('completion') }}</th>
            <th class="right" style="cursor: pointer" @click="sortBy('cacheHitRate')">
              缓存命中{{ arrow('cacheHitRate') }}
            </th>
            <th class="right" style="cursor: pointer" @click="sortBy('credit')">credit{{ arrow('credit') }}</th>
            <th style="width: 90px" />
            <th class="right" style="cursor: pointer" @click="sortBy('startTs')">起始时间{{ arrow('startTs') }}</th>
            <th class="right" style="cursor: pointer" @click="sortBy('startTs')">时长</th>
            <th style="width: 128px">用时构成</th>
          </tr>
        </thead>

        <!-- 一个项目一个 tbody：组头本身是一行"小计"，数值与下面各列对齐 -->
        <tbody v-for="g in groups" :key="g.projectId">
          <tr class="group-head" @click="toggleGroup(g.projectId)">
            <td>
              <!-- 注意：flex 要放在内层 div 上，直接给 td 设 display:flex
                   会让它退回普通盒模型、被浏览器塞进匿名单元格，列宽就乱了 -->
              <div class="g-name">
                <span class="caret" :class="{ closed: isCollapsed(g.projectId) }" aria-hidden="true">
                  <svg viewBox="0 0 10 10" width="9" height="9">
                    <path
                      d="M2.6 1.6 L7 5 L2.6 8.4"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.7"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                  </svg>
                </span>
                <b>{{ g.name }}</b>
                <span class="muted g-count">{{ g.sessions.length }} 个会话</span>
              </div>
            </td>
            <td class="g-path mono" :title="g.path">{{ g.path }}</td>
            <td />
            <td class="right num">{{ fmtNum(g.requests) }}</td>
            <td class="right num">{{ fmtCompact(g.prompt) }}</td>
            <td class="right num">{{ fmtCompact(g.completion) }}</td>
            <td class="right num" :class="{ warn: g.cacheHitRate < 0.7 }">{{ fmtPct(g.cacheHitRate) }}</td>
            <td class="right num"><b>{{ fmtCredit(g.credit) }}</b></td>
            <td>
              <div class="bar"><i :style="{ width: (g.credit / maxGroupCredit) * 100 + '%' }" /></div>
            </td>
            <td class="right num muted">{{ fmtTime(g.startTs) }}</td>
            <td />
            <td>
              <!-- 组头的小计条：组内各会话的用时构成累加，宽度同样按在岗时长归一化 -->
              <PhaseMiniBar
                v-if="groupPhase(g).activeMs"
                :phase="groupPhase(g)"
                :max-ms="maxGroupActiveMs"
              />
              <span v-else class="muted">—</span>
            </td>
          </tr>

          <template v-if="!isCollapsed(g.projectId)">
            <tr
              v-for="s in g.sessions"
              :key="s.sessionId"
              class="srow"
              @click="emit('open-session', s.sessionId)"
            >
              <td class="title-cell">
                <span class="title">{{ s.title || '(无标题)' }}</span>
                <span class="sid mono">{{ s.sessionId.slice(0, 8) }}</span>
              </td>
              <td>
                <span class="tag gray" :title="s.cwd || s.projectId">{{ baseName(s.cwd) || s.projectId }}</span>
              </td>
              <td>
                <span v-for="m in s.models" :key="m" class="tag" style="margin-right: 4px">{{ m }}</span>
              </td>
              <td class="right num">{{ s.requests }}</td>
              <td class="right num">{{ fmtCompact(s.prompt) }}</td>
              <td class="right num">{{ fmtCompact(s.completion) }}</td>
              <td class="right num" :class="{ warn: s.cacheHitRate < 0.7 }">{{ fmtPct(s.cacheHitRate) }}</td>
              <td class="right num"><b>{{ fmtCredit(s.credit) }}</b></td>
              <td>
                <div class="bar"><i :style="{ width: (s.credit / maxCredit) * 100 + '%' }" /></div>
              </td>
              <td class="right num muted">{{ fmtTime(s.startTs) }}</td>
              <td class="right num muted">{{ fmtDuration(s.endTs - s.startTs) }}</td>
              <td>
                <PhaseMiniBar
                  v-if="s.phase && s.phase.activeMs"
                  :phase="s.phase"
                  :max-ms="maxActiveMs"
                  :value="fmtSec(s.phase.activeMs)"
                />
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </template>
        </tbody>

        <tbody v-if="!groups.length">
          <tr>
            <td colspan="12" class="empty">当前筛选条件下没有会话</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.title-cell {
  max-width: 260px;
}
.title {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}
.sid {
  color: var(--text-3);
  font-size: 10px;
}
.warn {
  color: var(--warn);
}

/* ---------- 项目分组行（同时是小计行） ---------- */
.group-head {
  cursor: pointer;
}
.group-head > td {
  background: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid rgba(120, 132, 156, 0.2);
  padding-top: 7px;
  padding-bottom: 7px;
  font-size: 12px;
  /* 比表头淡、比数据行亮：介于两者之间才是"次级表头" */
  transition: background 0.15s;
}
.group-head:hover > td {
  background: rgba(255, 255, 255, 0.66);
}
.g-name {
  display: flex;
  align-items: center;
  gap: 7px;
}
.g-count {
  font-size: 10.5px;
  font-weight: 400;
}
.g-path {
  font-size: 10px;
  color: var(--text-3);
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 展开时朝下（rotate 90°），收起时朝右 */
.caret {
  display: inline-flex;
  color: var(--text-3);
  transform: rotate(90deg);
  transition: transform 0.18s;
  flex: none;
}
.caret.closed {
  transform: rotate(0deg);
}

/* 组内会话行缩进一档，层级看得出来 */
.srow {
  cursor: pointer;
}
.srow > td:first-child {
  padding-left: 30px;
}
</style>
