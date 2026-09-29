<script setup>
/**
 * 时间去向：把一段时间拆成「模型生成 / 工具执行 / 等待用户」三段。
 *
 * 刻意不用 ECharts——这是一根 100% 宽度的堆叠条，用 CSS 画更准也更轻，
 * 而且三段占比一眼就能读出来，做成图表反而要多一次"看图例—找颜色"的动作。
 *
 * 关键取舍：**离开电脑的时段不画进条里**。
 * 实测十几个会话跨度 34.9 小时，其中 29.0 小时是用户不在。
 * 把它画进去，另外三段会被压成看不见的细线，整块图就废了。
 * 所以条只画"在岗时长"，离开时间单独用一行文字交代。
 */
import { computed } from 'vue';
import { fmtSec, fmtShare } from '../utils/format.js';

const props = defineProps({ phase: Object });

const p = computed(() => props.phase || null);
const active = computed(() => (p.value ? p.value.activeMs : 0));

/** 三段：模型生成 / 工具执行 / 等待用户 */
const segs = computed(() => {
  if (!p.value || !active.value) return [];
  return [
    { key: 'model', label: '模型生成', ms: p.value.modelMs, color: '#27618c' },
    { key: 'tool', label: '工具执行', ms: p.value.toolMs, color: '#2c7a83' },
    { key: 'wait', label: '等待用户', ms: p.value.waitMs, color: '#b8863a' },
  ].map((s) => ({ ...s, share: s.ms / active.value }));
});

const hasData = computed(() => active.value > 0);
/** 被排除在条外的"离开"时段。占比超过 5% 才值得一提 */
const awayShare = computed(() => (p.value && p.value.spanMs ? p.value.awayMs / p.value.spanMs : 0));
const ariaLabel = computed(() => segs.value.map((s) => `${s.label} ${fmtSec(s.ms)}`).join('，'));
</script>

<template>
  <div class="phase">
    <div v-if="!hasData" class="empty">暂无可用的耗时数据</div>

    <template v-else>
      <div class="rows">
        <div class="row">
          <span class="k">在岗时长</span>
          <span class="v num">{{ fmtSec(p.activeMs) }}</span>
        </div>
        <div class="row">
          <span class="k">全程跨度</span>
          <span class="v num muted">{{ fmtSec(p.spanMs) }}</span>
        </div>
      </div>

      <div class="track" role="img" :aria-label="ariaLabel">
        <i
          v-for="s in segs"
          :key="s.key"
          :style="{ width: s.share * 100 + '%', background: s.color }"
        />
      </div>

      <div class="legend">
        <div v-for="s in segs" :key="s.key" class="item">
          <span class="dot" :style="{ background: s.color }" />
          <span class="name">{{ s.label }}</span>
          <span class="ms num">{{ fmtSec(s.ms) }}</span>
          <span class="share num muted">{{ fmtShare(s.share) }}</span>
        </div>
      </div>

      <div v-if="awayShare > 0.05" class="note">
        另有 {{ fmtSec(p.awayMs) }}（{{ fmtShare(awayShare) }}）处于离开状态，未计入在岗时长
      </div>
      <div class="note dim">区间超过 30 分钟的间隔一律按「离开」处理，避免挂机时段把占比带偏</div>
    </template>
  </div>
</template>

<style scoped>
.phase {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rows {
  display: flex;
  gap: 26px;
}
.row {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.k {
  font-size: 11px;
  color: var(--text-3);
}
.v {
  font-size: 15px;
  font-weight: 600;
}
.track {
  display: flex;
  height: 12px;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(120, 132, 156, 0.12);
}
.track > i {
  display: block;
  height: 100%;
  transition: width 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 22px;
}
.item {
  display: flex;
  align-items: baseline;
  gap: 7px;
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: none;
  transform: translateY(-1px);
}
.name {
  color: var(--text-2);
}
.ms {
  font-weight: 600;
}
.share {
  font-size: 11px;
}
.note {
  font-size: 11px;
  color: var(--text-3);
}
.note.dim {
  opacity: 0.8;
}
</style>
