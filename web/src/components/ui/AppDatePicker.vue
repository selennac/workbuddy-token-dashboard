<script setup>
/**
 * 自绘日期选择器。
 * 原生 <input type="date"> 的日历面板同样是浏览器绘制的，无法统一风格，
 * 这里用 Teleport + fixed 定位自己画。值格式 YYYY-MM-DD，空字符串表示未选。
 */
import { computed, ref, watch } from 'vue';
import { usePopup } from '../../composables/usePopup.js';

const props = defineProps({
  modelValue: { type: String, default: '' },
  label: { type: String, default: '' },
  placeholder: { type: String, default: '选择日期' },
  clearable: { type: Boolean, default: true },
});

const emit = defineEmits(['update:modelValue', 'change']);

const { triggerRef, panelRef, isOpen, pos, close, toggle } = usePopup();

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];

/** 解析 YYYY-MM-DD 为本地时间 Date，避免 new Date('2026-09-29') 按 UTC 解析导致偏移 */
function parseDay(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toDayStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const today = new Date();
today.setHours(0, 0, 0, 0);

/** 面板当前展示的月份（每月 1 号） */
const viewMonth = ref(new Date(today.getFullYear(), today.getMonth(), 1));

// 打开时跳转到已选值所在月份
watch(isOpen, (v) => {
  if (!v) return;
  const sel = parseDay(props.modelValue);
  viewMonth.value = new Date((sel || today).getFullYear(), (sel || today).getMonth(), 1);
});

const display = computed(() => {
  const d = parseDay(props.modelValue);
  if (!d) return '';
  const isThisYear = d.getFullYear() === today.getFullYear();
  const p = (n) => String(n).padStart(2, '0');
  return isThisYear
    ? `${d.getMonth() + 1}月${d.getDate()}日`
    : `${d.getFullYear()}年${p(d.getMonth() + 1)}月${p(d.getDate())}日`;
});

const monthTitle = computed(() => {
  const d = viewMonth.value;
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
});

/**
 * 生成 6×7 网格。
 * 以周一开始，所以要把 JS 的周日=0 映射成 周一=0。
 */
const cells = computed(() => {
  const first = viewMonth.value;
  const offset = (first.getDay() + 6) % 7; // 周一为 0
  const start = new Date(first);
  start.setDate(1 - offset);

  const out = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push({
      ts: d.getTime(),
      day: d.getDate(),
      str: toDayStr(d),
      dim: d.getMonth() !== first.getMonth(),
      today: d.getTime() === today.getTime(),
      selected: props.modelValue === toDayStr(d),
    });
  }
  return out;
});

function shiftMonth(n) {
  const d = viewMonth.value;
  viewMonth.value = new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function pick(cell) {
  emit('update:modelValue', cell.str);
  emit('change', cell.str);
  close();
  triggerRef.value?.focus?.();
}

function pickToday() {
  const s = toDayStr(today);
  emit('update:modelValue', s);
  emit('change', s);
  close();
}

function clear() {
  emit('update:modelValue', '');
  emit('change', '');
  close();
}

function onKeydown(e) {
  if (!isOpen.value && ['Enter', ' ', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    toggle();
  }
}

defineExpose({ close });
</script>

<template>
  <div
    ref="triggerRef"
    class="field dp"
    :class="{ 'is-open': isOpen }"
    role="button"
    tabindex="0"
    :aria-expanded="isOpen"
    @click="toggle"
    @keydown="onKeydown"
  >
    <span v-if="label" class="dp-label">{{ label }}</span>
    <svg class="dp-icon" viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
      <rect x="1.6" y="2.6" width="10.8" height="9.8" rx="2" fill="none" stroke="currentColor" stroke-width="1.3" />
      <path d="M1.6 5.6 h10.8 M4.6 1.4 v2.4 M9.4 1.4 v2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
    <span class="dp-value" :class="{ ph: !display }">{{ display || placeholder }}</span>
  </div>

  <Teleport to="body">
    <div
      v-if="isOpen"
      ref="panelRef"
      class="pop"
      :class="{ 'from-top': pos.placement === 'top' }"
      :style="{
        top: pos.top != null ? pos.top + 'px' : undefined,
        bottom: pos.bottom != null ? pos.bottom + 'px' : undefined,
        left: pos.left != null ? pos.left + 'px' : undefined,
        right: pos.right != null ? pos.right + 'px' : undefined,
      }"
    >
      <div class="cal">
        <div class="cal-head">
          <button class="cal-nav" type="button" title="上个月" @click="shiftMonth(-1)">‹</button>
          <span class="cal-title">{{ monthTitle }}</span>
          <button class="cal-nav" type="button" title="下个月" @click="shiftMonth(1)">›</button>
        </div>

        <div class="cal-week">
          <span v-for="w in WEEK" :key="w">{{ w }}</span>
        </div>

        <div class="cal-grid">
          <div
            v-for="c in cells"
            :key="c.ts"
            class="cal-day"
            :class="{ dim: c.dim, today: c.today, on: c.selected }"
            @click="pick(c)"
          >
            {{ c.day }}
          </div>
        </div>

        <div class="cal-foot">
          <button class="cal-foot-btn" type="button" @click="pickToday">今天</button>
          <button v-if="clearable" class="cal-foot-btn plain" type="button" @click="clear">清除</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dp {
  gap: 6px;
  min-width: 118px;
}

.dp-label {
  font-size: 10px;
  color: var(--text-3);
  letter-spacing: 0.3px;
}

.dp-icon {
  color: var(--text-3);
  flex: none;
}

.dp-value {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.dp-value.ph {
  color: var(--text-3);
}
</style>
