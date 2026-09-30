<script setup>
/**
 * 用时构成微缩条：模型生成 / 工具执行 / 人的环节。
 *
 * 三处都在用（会话列表的分组小计行、会话行、总览的时间去向下钻），
 * 所以抽出来——不然同一套三段配色和 tooltip 文案要抄三遍，
 * 改一处忘一处就会出现"同一个概念在两个页面对不上"。
 *
 * 条宽按 `maxMs` 归一化，调用方传入"当前范围内的最大在岗时长"，
 * 这样多行之间可以横向比较；条内部的三段则始终占满 100%。
 */
import { computed } from 'vue';
import { fmtSec } from '../utils/format.js';

const props = defineProps({
  /** 阶段对象，至少要带 modelMs / toolMs / humanMs / activeMs */
  phase: Object,
  /** 条宽归一化基准 */
  maxMs: { type: Number, default: 0 },
  /** 条右侧的可选文字 */
  value: { type: String, default: '' },
});

/** 与总览「时间去向」、图表语义保持一致的三段配色 */
const COLORS = { model: '#27618c', tool: '#2c7a83', human: '#b8863a' };

const active = computed(() => (props.phase ? props.phase.activeMs || 0 : 0));

const segs = computed(() => {
  if (!active.value) return [];
  const p = props.phase;
  return [
    { k: 'model', label: '模型生成', ms: p.modelMs || 0 },
    { k: 'tool', label: '工具执行', ms: p.toolMs || 0 },
    { k: 'human', label: '人的环节', ms: p.humanMs || 0 },
  ]
    .filter((s) => s.ms > 0)
    .map((s) => ({ ...s, share: s.ms / active.value }));
});

const pct = computed(() => {
  if (!active.value) return 0;
  const base = props.maxMs > 0 ? props.maxMs : active.value;
  return Math.min(100, (active.value / base) * 100);
});

const title = computed(() => {
  if (!active.value) return '暂无耗时数据';
  const p = props.phase;
  const parts = [
    `在岗 ${fmtSec(active.value)}`,
    `模型生成 ${fmtSec(p.modelMs || 0)}`,
    `工具执行 ${fmtSec(p.toolMs || 0)}`,
    `人的环节 ${fmtSec(p.humanMs || 0)}`,
  ];
  if (p.awayMs) parts.push(`离开 ${fmtSec(p.awayMs)}（未计入在岗）`);
  return parts.join(' ｜ ');
});
</script>

<template>
  <div class="mini">
    <div class="mini-track" :style="{ width: pct + '%' }" :title="title">
      <i v-for="s in segs" :key="s.k" :style="{ width: s.share * 100 + '%', background: COLORS[s.k] }" />
    </div>
    <span v-if="value" class="mini-val num">{{ value }}</span>
  </div>
</template>

<style scoped>
.mini {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mini-track {
  display: flex;
  height: 8px;
  min-width: 6px;
  border-radius: 4px;
  overflow: hidden;
  background: rgba(120, 132, 156, 0.12);
  transition: width 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.mini-track > i {
  display: block;
  height: 100%;
}
.mini-val {
  font-size: 10px;
  color: var(--text-3);
  flex: none;
}
</style>
