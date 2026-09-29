<script setup>
/**
 * 筛选工具栏。
 * 所有选择类控件都用自绘组件（AppSelect / AppDatePicker），
 * 不用原生 select / input[type=date] —— 原生下拉和日历面板是浏览器绘制的，
 * 无法参与玻璃主题。
 */
import { computed } from 'vue';
import AppSelect from './ui/AppSelect.vue';
import AppDatePicker from './ui/AppDatePicker.vue';
import { colorOf } from '../utils/format.js';
import { allowedGranularities, spanDaysOf } from '../utils/granularity.js';

const props = defineProps({
  filter: { type: Object, required: true },
  meta: { type: Object, default: () => ({}) },
  loading: Boolean,
});
const emit = defineEmits(['update:filter', 'refresh']);

function set(key, value) {
  emit('update:filter', { ...props.filter, [key]: value });
}

/* ---------- 时间区间 ---------- */

/** 取 n 天前的本地零点。用 setDate 而不是"减 n × 86400000 毫秒"——
 *  后者在夏令时切换日会偏一小时，跨时区跑也会出怪值。 */
function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

function toDayStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 起止留空的含义：起点空 = 不限，终点空 = 到今天。
 *  按钮按时间先后从左到右排列：昨天 → 今天 → 近 7 天 → 近 30 天 → 全部。 */
const RANGES = [
  // 昨天是**闭区间**，两端都要给："不限 → 昨天"会把今天之前的全部数据都算进来
  { label: '昨天', range: () => ({ from: toDayStr(daysAgo(1)), to: toDayStr(daysAgo(1)) }) },
  { label: '今天', range: () => ({ from: toDayStr(daysAgo(0)), to: '' }) },
  { label: '近 7 天', range: () => ({ from: toDayStr(daysAgo(7)), to: '' }) },
  { label: '近 30 天', range: () => ({ from: toDayStr(daysAgo(30)), to: '' }) },
  { label: '全部', range: () => ({ from: '', to: '' }) },
];

const activeRange = computed(() => props.filter.preset);

function pickRange(r) {
  emit('update:filter', { ...props.filter, preset: r.label, ...r.range() });
}

/** 手动改日期视为自定义区间 */
function setFrom(value) {
  emit('update:filter', { ...props.filter, preset: 'custom', from: value });
}
function setTo(value) {
  emit('update:filter', { ...props.filter, preset: 'custom', to: value });
}

const rangeHint = computed(() => {
  const { from, to } = props.filter;
  if (!from && !to) return '全部时间';
  // 单日区间（如"昨天"）两端相同，只显示一次日期，否则读起来像笔误
  if (from && from === to) return from;
  return `${from || '不限'} → ${to || '今天'}`;
});

/* ---------- 各维度选项 ---------- */
const projectOptions = computed(() => [
  { value: 'all', label: '全部项目' },
  ...(props.meta.projects || []).map((p, i) => ({
    value: p,
    label: p.replace(/^[a-z]-/, '').replace(/-/g, ' / '),
    hint: '',
    dot: colorOf(i),
  })),
]);

const modelOptions = computed(() => [
  { value: 'all', label: '全部模型' },
  ...(props.meta.models || []).map((m) => ({ value: m, label: m })),
]);

const kindOptions = computed(() => [
  { value: 'all', label: '全部类型' },
  ...(props.meta.kinds || []).map((k) => ({ value: k, label: k === 'function_call' ? '工具调用' : k === 'message' ? '对话消息' : k, hint: k })),
]);

const GRANULARITIES = [
  { value: 'hour', label: '小时' },
  { value: 'day', label: '天' },
  { value: 'month', label: '月' },
];

/* 粒度必须跟着区间走：选了「今天」就不可能再看"天/月"（那只会得到 1 根柱子）。
   规则与阈值集中在 utils/granularity.js，App.vue 用同一套做自动切换。 */
const spanDays = computed(() => spanDaysOf(props.filter, props.meta));
const allowedGrans = computed(() => allowedGranularities(spanDays.value));

function granReason(value) {
  const s = spanDays.value;
  if (!Number.isFinite(s)) return '';
  const n = s < 1 ? `${Math.max(1, Math.round(s * 24))} 小时` : `${Math.round(s)} 天`;
  if (value === 'hour') return `区间 ${n}，按小时会有 ${Math.round(s * 24)} 根柱子，太碎；先缩小时间区间`;
  if (value === 'day') return `区间 ${n}，按天只有 1 根柱子；先放大时间区间`;
  return `区间 ${n}，按月只有 ${Math.max(1, Math.ceil(s / 30))} 根柱子；区间跨两个月以上才有意义`;
}

const granularities = computed(() =>
  GRANULARITIES.map((g) => ({
    ...g,
    allowed: allowedGrans.value.includes(g.value),
    reason: granReason(g.value),
  })),
);

const granNote = computed(() => {
  // 只在"没得选"时才说明；只是禁掉某一档（比如跨 30 天没有"月"）不必啰嗦，
  // 那种情况鼠标悬到灰按钮上会给出原因
  if (allowedGrans.value.length > 1) return '';
  const s = spanDays.value;
  if (!Number.isFinite(s)) return '';
  const spanText = s < 1 ? `${Math.max(1, Math.round(s * 24))} 小时` : `${Math.round(s)} 天`;
  return `区间 ${spanText}，粒度已按区间限定`;
});

const hasFilter = computed(
  () =>
    (props.filter.projectId && props.filter.projectId !== 'all') ||
    (props.filter.model && props.filter.model !== 'all') ||
    (props.filter.kind && props.filter.kind !== 'all') ||
    !!props.filter.keyword ||
    !!props.filter.from ||
    !!props.filter.to,
);

function reset() {
  emit('update:filter', {
    preset: '全部',
    from: '',
    to: '',
    projectId: 'all',
    model: 'all',
    kind: 'all',
    granularity: props.filter.granularity || 'day',
    keyword: '',
  });
}
</script>

<template>
  <div class="filterbar glass">
    <!-- 第一行：主筛选条件 -->
    <div class="fb-row">
      <div class="seg">
        <button
          v-for="r in RANGES"
          :key="r.label"
          class="seg-btn"
          :class="{ on: activeRange === r.label }"
          @click="pickRange(r)"
        >
          {{ r.label }}
        </button>
      </div>

      <span class="vsep" />

      <AppDatePicker :model-value="filter.from || ''" label="起" placeholder="不限" @update:model-value="setFrom" />
      <span class="arrow">→</span>
      <AppDatePicker :model-value="filter.to || ''" label="止" placeholder="今天" @update:model-value="setTo" />

      <span class="vsep" />

      <AppSelect
        :model-value="filter.projectId || 'all'"
        :options="projectOptions"
        label="项目"
        @update:model-value="set('projectId', $event)"
      />
      <AppSelect
        :model-value="filter.model || 'all'"
        :options="modelOptions"
        label="模型"
        @update:model-value="set('model', $event)"
      />
      <AppSelect
        :model-value="filter.kind || 'all'"
        :options="kindOptions"
        label="类型"
        @update:model-value="set('kind', $event)"
      />
    </div>

    <!-- 第二行：粒度 / 搜索 / 操作 -->
    <div class="fb-row secondary">
      <span class="row-label">趋势粒度</span>
      <div class="seg">
        <button
          v-for="g in granularities"
          :key="g.value"
          class="seg-btn"
          :class="{ on: (filter.granularity || 'day') === g.value }"
          :disabled="!g.allowed"
          :title="g.allowed ? `按${g.label}分桶` : g.reason"
          @click="set('granularity', g.value)"
        >
          {{ g.label }}
        </button>
      </div>
      <span v-if="granNote" class="gran-note">{{ granNote }}</span>

      <span class="range-hint">
        <span class="hint-dot" />
        <b>{{ rangeHint }}</b>
        <span v-if="hasFilter" class="muted">· 已应用筛选</span>
      </span>

      <div class="grow" />

      <div class="search" :class="{ filled: !!filter.keyword }">
        <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden="true">
          <circle cx="6.2" cy="6.2" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path d="M9.4 9.4 L12.4 12.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <input
          type="text"
          placeholder="搜索标题 / 路径 / 工具…"
          :value="filter.keyword || ''"
          @input="set('keyword', $event.target.value)"
        />
        <button v-if="filter.keyword" class="search-clear" title="清空" @click="set('keyword', '')">×</button>
      </div>

      <button v-if="hasFilter" class="btn ghost" title="清空全部筛选" @click="reset">重置</button>

      <button class="btn primary" :disabled="loading" @click="emit('refresh')">
        <span class="spin" :class="{ on: loading }">
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <path
              d="M10 6a4 4 0 1 1-1.2-2.9M10 1.6V4H7.6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        {{ loading ? '扫描中…' : '重新扫描' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.filterbar {
  padding: 11px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

/* 两行之间用极淡的分隔，而不是让 flex 自己折行 */
.fb-row {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
}

.fb-row.secondary {
  padding-top: 9px;
  border-top: 1px solid rgba(120, 132, 156, 0.12);
}

.row-label {
  font-size: 10px;
  color: var(--text-3);
  letter-spacing: 0.3px;
}

/* 粒度被区间限定时的说明，跟着粒度控件走 */
.gran-note {
  font-size: 10.5px;
  color: var(--text-3);
}

.vsep {
  width: 1px;
  height: 22px;
  background: linear-gradient(180deg, transparent, rgba(120, 132, 156, 0.3), transparent);
  flex: none;
}

.grow {
  flex: 1;
  min-width: 0;
}

.arrow {
  color: var(--text-3);
  font-size: 11px;
}

.range-hint {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--text-2);
  padding-left: 4px;
}

.range-hint b {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--text);
}

.hint-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-ring);
  flex: none;
}

/* 搜索框 */
.search {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 10px;
  width: 232px;
  border: 1px solid rgba(255, 255, 255, 0.7);
  border-radius: var(--radius-xs);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(255, 255, 255, 0.5));
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
  color: var(--text-3);
  transition: border-color 0.18s, box-shadow 0.18s;
}

.search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring), inset 0 1px 0 rgba(255, 255, 255, 0.9);
}

.search.filled {
  color: var(--accent);
}

/* 提高一档特异性，盖掉 style.css 里的全局 input 样式 */
.filterbar .search input {
  flex: 1;
  min-width: 0;
  height: auto;
  padding: 0;
  border: none;
  border-radius: 0;
  background: none;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  font-size: 12px;
  color: var(--text);
}

.filterbar .search input:focus {
  border: none;
  box-shadow: none;
}

.search-clear {
  border: none;
  background: none;
  color: var(--text-3);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
  transition: color 0.15s;
}

.search-clear:hover {
  color: var(--text);
}

/* 重新扫描按钮里的旋转图标 */
.spin {
  display: inline-flex;
}

.spin.on {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
