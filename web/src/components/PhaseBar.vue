<script setup>
/**
 * 时间去向：把一段时间拆成「模型生成 / 工具执行 / 人的环节」三段。
 *
 * 刻意不用 ECharts——这是一根 100% 宽度的堆叠条，用 CSS 画更准也更轻，
 * 而且三段占比一眼就能读出来，做成图表反而要多一次"看图例—找颜色"的动作。
 *
 * 三个关键取舍：
 *
 * 1. **离开电脑的时段不画进条里**。实测十几个会话跨度 107h，其中 98h 是人不在。
 *    画进去，另外三段会被压成看不见的细线，整块图就废了。所以条只画"在岗时长"，
 *    离开单独用文字交代。
 *
 * 2. **30 分钟这个阈值实际上只作用于「人的环节」**。模型段和工具段是机器在干活，
 *    实测最长分别 11.8min / 5.1min，远够不到阈值 —— 所以"离开"判断天然只发生在
 *    "模型答完 → 你下一条消息"之间。阈值本身也不是拍的：实测人机间隔长度从
 *    1.1min 连续铺到 23.8min，唯一一个真实断层在 23.8min → 51.8min，30 分钟
 *    正好落在断口里。所以**没有**再分"90 秒 / 10 分钟"那种中间档 —— 数据里
 *    不存在第二个断点，硬切只会把"读一段长回复"误判成"离开"。
 *
 * 3. **「人的环节」不叫「等待用户」**。那段时间其实是你在读、在想、在组织下一句，
 *    不是模型在空转。名字错了，读的人就会得出相反的结论。
 */
import { computed } from 'vue';
import { fmtSec, fmtShare } from '../utils/format.js';

const props = defineProps({
  phase: Object,
  /** 该区间的结算用量，用来算"每 credit 要花多久在岗" */
  credit: { type: Number, default: null },
});

const p = computed(() => props.phase || null);
const active = computed(() => (p.value ? p.value.activeMs : 0));

/**
 * 三个占比取整后必须合计 100%。
 * 各自 Math.round 会出现 37% + 37% + 27% = 101% 这种一眼就不对的结果
 * （堆叠条本身是浮点宽度所以看不出来，但文字会打架）。用最大余数法分配。
 */
function sharesTo100(parts) {
  const total = parts.reduce((a, b) => a + b, 0);
  if (!total) return parts.map(() => 0);
  const raw = parts.map((v) => (v / total) * 100);
  const out = raw.map((v) => Math.floor(v));
  let left = 100 - out.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && left > 0; k++, left--) out[order[k].i] += 1;
  return out;
}

/** 三段：模型生成 / 工具执行 / 人的环节 */
const segs = computed(() => {
  if (!p.value || !active.value) return [];
  const parts = [
    { key: 'model', label: '模型生成', ms: p.value.modelMs, color: '#27618c' },
    { key: 'tool', label: '工具执行', ms: p.value.toolMs, color: '#2c7a83' },
    { key: 'human', label: '人的环节', ms: p.value.humanMs, color: '#b8863a' },
  ];
  const pcts = sharesTo100(parts.map((s) => s.ms));
  return parts.map((s, i) => ({ ...s, share: s.ms / active.value, pct: pcts[i] }));
});

const hasData = computed(() => active.value > 0);
/** 被排除在条外的"离开"时段。占比超过 5% 才值得一提 */
const awayShare = computed(() => (p.value && p.value.spanMs ? p.value.awayMs / p.value.spanMs : 0));

/**
 * 每 credit 的在岗时间（分钟）。
 * 在岗时长绝对值多少其实没意义，但"换 1 个 credit 要在岗多久"可以横向比 ——
 * 这是把"这段时间花得值不值"变成可算的数的最小抓手。
 */
const minPerCredit = computed(() => {
  if (!p.value || !props.credit) return null;
  return p.value.activeMs / 60000 / props.credit;
});

/** 「人的环节」里 ≥5 分钟的间隔占比：日志区分不出它是长思考、读文档还是离开 */
const longHumanShare = computed(() =>
  p.value && p.value.humanMs ? p.value.longHumanMs / p.value.humanMs : 0,
);

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
        <div
          v-if="minPerCredit"
          class="row"
          title="在岗时长 ÷ 该区间的结算 credit。越小，说明单位在岗时间的产出越高"
        >
          <span class="k">每 credit 在岗</span>
          <span class="v num">{{ minPerCredit.toFixed(1) }}<span class="unit">分</span></span>
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
          <span class="share num muted">{{ s.pct }}%</span>
        </div>
      </div>

      <div v-if="awayShare > 0.05" class="note">
        另有 {{ fmtSec(p.awayMs) }}（{{ fmtShare(awayShare) }}）处于离开状态，未计入在岗时长
      </div>
      <div v-if="p.longHumanCount" class="note">
        人的环节里有 {{ p.longHumanCount }} 次间隔 ≥ 5 分钟，合计 {{ fmtSec(p.longHumanMs) }}（{{
          fmtShare(longHumanShare)
        }}）
      </div>
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
  flex-wrap: wrap;
  gap: 10px 26px;
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
.unit {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3);
  margin-left: 2px;
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
  line-height: 1.6;
  color: var(--text-3);
}
</style>
