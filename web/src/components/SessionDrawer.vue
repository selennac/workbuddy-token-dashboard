<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api.js';
import { useChart, theme, baseTooltip, baseAxisLabel } from '../composables/useChart.js';
import { fmtCompact, fmtNum, fmtCredit, fmtPct, fmtTime, fmtSec, fmtSpeed } from '../utils/format.js';
import KpiCard from './KpiCard.vue';
import PhaseBar from './PhaseBar.vue';

const props = defineProps({ sessionId: String });
const emit = defineEmits(['close']);

const data = ref(null);
const error = ref('');

watch(
  () => props.sessionId,
  async (id) => {
    data.value = null;
    error.value = '';
    if (!id) return;
    try {
      data.value = await api.session({ sessionId: id });
    } catch (e) {
      error.value = e.message;
    }
  },
  { immediate: true },
);

/**
 * 供 App 的自动刷新调用：只换数据，**不**把 data 置空——
 * 否则每 5 秒抽屉会闪一下空态。出错也保持上一拍的内容，
 * 一次网络抖动不该把整个抽屉清掉。
 */
async function silentReload() {
  if (!props.sessionId) return;
  try {
    data.value = await api.session({ sessionId: props.sessionId });
  } catch {
    /* 保持上一拍的数据 */
  }
}
defineExpose({ reload: silentReload });

const s = computed(() => data.value?.summary || {});

/** 吐字速度：拟合斜率（模型固有速度）与实测口径分开给，见 Overview 的注释 */
const sp = computed(() => data.value?.speed || {});
const speedSub = computed(() => {
  const v = sp.value;
  if (v.tps == null) return '耗时样本不足';
  const parts = [`每请求开销 ${fmtSec(v.overheadMs)}`];
  if (!v.reliable) parts.push('样本少，仅供参考');
  return parts.join(' · ');
});

const maxToolMs = computed(() => Math.max(1, ...(data.value?.slowTools || []).map((t) => t.ms)));

/** 上下文增长曲线。
 *
 * 原来输入（动辄上万 token）和输出（几百 token）共用一根 Y 轴，量级差约 100 倍，
 * 结果输出被压成贴着底边的一条直线 —— 等于没画。实测最长会话 331 次请求，
 * 输入能爬到 8 万+，而输出长期在 200~1500 之间。
 *
 * 改成双 Y 轴：左轴输入（堆叠面积，就是"上下文"本身），右轴输出（柱）。
 * 双轴唯一站得住的场景就是**同单位、不同量级** —— 这里两边都是 token，
 * 看的人只要记住"右轴是输出"就行；换成 token vs 百分比那种异单位双轴就开始骗人了。
 *
 * 另外补 dataZoom：300 多次请求挤在 260px 里，一根柱子不到 1px，
 * 不给放大能力就只能看个轮廓。
 */
const growthEl = ref(null);
useChart(growthEl, () => {
  const steps = data.value?.steps || [];
  if (!steps.length) return null; // 空会话不画，交给容器的空态

  const axisName = { color: theme.faint, fontSize: 10 };
  return {
    grid: { left: 8, right: 18, top: 46, bottom: 30, containLabel: true },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      formatter: (ps) => {
        const step = steps[ps[0].dataIndex];
        if (!step) return '';
        return `<b>第 ${ps[0].dataIndex + 1} 次请求</b> · ${fmtTime(step.ts)}<br/>
          ${step.toolName ? '工具：<b>' + step.toolName + '</b><br/>' : ''}
          输入 <b>${fmtNum(step.prompt)}</b>（命中 ${fmtNum(step.cacheRead)}）<br/>
          输出 <b>${fmtNum(step.completion)}</b>（思考 ${fmtNum(step.reasoning)}）<br/>
          耗时 <b>${fmtSec(step.durMs)}</b>${step.tps != null ? ` · 吐字 <b>${fmtSpeed(step.tps)}</b> t/s` : ''}<br/>
          结算 <b>${fmtCredit(step.credit)}</b>`;
      },
    },
    /* 图例居中放顶部，两个轴的名称分列左右两端：
       原来图例靠右，正好和右轴名「输出」压在同一个角落。 */
    legend: { top: 0, left: 'center', itemWidth: 9, itemHeight: 9, textStyle: { color: theme.sub, fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: steps.map((_, i) => '#' + (i + 1)),
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: baseAxisLabel,
    },
    yAxis: [
      {
        type: 'value',
        name: '输入',
        nameTextStyle: axisName,
        axisLabel: { ...baseAxisLabel, formatter: (v) => fmtCompact(v) },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      {
        type: 'value',
        name: '输出',
        nameTextStyle: axisName,
        axisLabel: { ...baseAxisLabel, formatter: (v) => fmtCompact(v) },
        splitLine: { show: false }, // 双轴的网格线重叠会糊成一片，只留左轴的
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: 0 },
      {
        type: 'slider',
        xAxisIndex: 0,
        height: 12,
        bottom: 2,
        borderColor: 'transparent',
        backgroundColor: 'rgba(120,132,156,.08)',
        fillerColor: 'rgba(31,81,117,.12)',
        handleStyle: { color: '#1f5175' },
        textStyle: { color: theme.faint, fontSize: 10 },
      },
    ],
    series: [
      {
        name: '缓存命中输入',
        type: 'line',
        stack: 'ctx',
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        /* 和总览的主趋势图保持同一套语义配色：命中=浅，未命中=深，输出=赭黄。
           两处画的是同一组指标，配色必须能对上，否则看的人要重新学一遍。 */
        areaStyle: { color: 'rgba(77,155,163,.18)' },
        lineStyle: { color: '#4d9ba3', width: 1.5 },
        data: steps.map((r) => r.cacheRead),
      },
      {
        name: '未命中输入',
        type: 'line',
        stack: 'ctx',
        yAxisIndex: 0,
        smooth: true,
        symbol: 'none',
        areaStyle: { color: 'rgba(39,97,140,.22)' },
        lineStyle: { color: '#1f5175', width: 1.5 },
        data: steps.map((r) => r.cacheMiss),
      },
      {
        name: '输出',
        type: 'bar',
        yAxisIndex: 1,
        barMaxWidth: 6,
        itemStyle: { color: 'rgba(184,134,58,.85)', borderRadius: [2, 2, 0, 0] },
        data: steps.map((r) => r.completion),
      },
    ],
  };
});

/* ---------- 逐次请求明细：窗口化渲染 ----------
 *
 * 一个会话最多能有 300+ 条请求（实测最长 331 条）。13 列全量铺开就是 4000+ 个
 * 单元格，而看板每 5 秒重取一次数据 → 整张表跟着重渲染，滚动明显掉帧。
 * 这里只渲染视口内的行，上下各用一行占位撑出滚动高度，DOM 节点数与会话长度脱钩。
 *
 * 为什么不引三方虚拟列表：需求只有"定高行 + 单列滚动"这一种，手写不到 30 行；
 * 引个库反而要额外处理它和 sticky 表头、和 5 秒轮询的配合。
 *
 * ⚠ 前提是行高必须严格等于 ROW_H（见 .steps-table td 的固定高度）。
 * 行高一旦被内容撑开，占位高度就对不上，滚动条会跳。
 */
const ROW_H = 34;
/** 视口外多渲染几行，抵消快速滚动时的白屏 */
const OVERSCAN = 6;

const steps = computed(() => data.value?.steps || []);
const maxStepTotal = computed(() => Math.max(1, ...steps.value.map((r) => r.total)));

const listEl = ref(null);
const viewH = ref(380);
const scrollTop = ref(0);

const winStart = computed(() => {
  const n = steps.value.length;
  return Math.max(0, Math.min(n, Math.floor(scrollTop.value / ROW_H) - OVERSCAN));
});
const winEnd = computed(() =>
  Math.min(steps.value.length, Math.ceil((scrollTop.value + viewH.value) / ROW_H) + OVERSCAN),
);
const visibleSteps = computed(() => steps.value.slice(winStart.value, winEnd.value));
const padTop = computed(() => winStart.value * ROW_H);
const padBottom = computed(() => Math.max(0, (steps.value.length - winEnd.value) * ROW_H));

/** 视口高度要实测：容器是 max-height，会话短的时候它比 380 矮 */
let ro = null;
watch(listEl, (el) => {
  if (ro) {
    ro.disconnect();
    ro = null;
  }
  if (!el) return;
  viewH.value = el.clientHeight || 380;
  ro = new ResizeObserver(() => {
    viewH.value = el.clientHeight || 380;
  });
  ro.observe(el);
});
onBeforeUnmount(() => ro && ro.disconnect());

/** 换会话时把滚动位置拉回顶部：停在上一会话的滚动位置上没有意义 */
watch(
  () => props.sessionId,
  () => {
    scrollTop.value = 0;
  },
);

function onScroll(e) {
  scrollTop.value = e.target.scrollTop;
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <aside class="drawer">
      <header class="head">
        <div class="head-main">
          <div class="title">{{ data?.meta?.title || '(无标题会话)' }}</div>
          <div class="sub mono">
            {{ sessionId }}
            <span v-if="data?.meta?.cwd"> · {{ data.meta.cwd }}</span>
          </div>
        </div>
        <button class="btn" @click="emit('close')">关闭</button>
      </header>

      <div v-if="error" class="empty">{{ error }}</div>
      <div v-else-if="!data" class="empty">加载中…</div>

      <div v-else class="body scroll">
        <div class="kpis">
          <KpiCard label="请求" :value="fmtNum(s.requests)" :sub="`工具调用 ${data.steps.filter((x) => x.toolName).length} 次`" />
          <KpiCard label="输入" :value="fmtCompact(s.prompt)" :sub="`平均 ${fmtCompact(s.avgPrompt)}`" />
          <KpiCard label="输出" :value="fmtCompact(s.completion)" :sub="`思考 ${fmtCompact(s.reasoning)}`" />
          <KpiCard
            label="缓存命中率"
            :value="fmtPct(s.cacheHitRate)"
            :sub="`命中 ${fmtCompact(s.cacheRead)}`"
            accent="#2c7a83"
            :progress="s.cacheHitRate"
          />
          <KpiCard
            label="吐字速度"
            :value="sp.tps == null ? '—' : `${fmtSpeed(sp.tps)} t/s`"
            :sub="speedSub"
            accent="#8f6a9e"
          />
          <KpiCard label="结算" :value="fmtCredit(s.credit)" :sub="`平均 ${fmtCredit(s.avgCredit)}`" accent="#b8863a" />
        </div>

        <div class="grid2">
          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">时间去向</div>
                <div class="panel-sub">在岗时间拆成模型生成 / 工具执行 / 人的环节（你在读和写）</div>
              </div>
            </div>
            <div class="pad">
              <PhaseBar :phase="data.phase" :credit="s.credit" />
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div>
                <div class="panel-title">最慢的工具调用</div>
                <div class="panel-sub">调用与返回配对得到，最长 8 条</div>
              </div>
            </div>
            <div class="scroll slow">
              <div v-for="t in data.slowTools" :key="t.callId" class="slow-row">
                <span class="tag">{{ t.name }}</span>
                <div class="bar"><i :style="{ width: (t.ms / maxToolMs) * 100 + '%' }" /></div>
                <span class="slow-val num">{{ fmtSec(t.ms) }}</span>
              </div>
              <div v-if="!data.slowTools.length" class="empty">暂无可用的工具耗时数据</div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">上下文增长曲线</div>
              <div class="panel-sub">横轴为第几次请求；面积越高说明单次请求携带的上下文越大</div>
            </div>
          </div>
          <div ref="growthEl" style="height: 260px; width: 100%" />
        </div>

        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">逐次请求明细</div>
              <div class="panel-sub">{{ steps.length }} 条</div>
            </div>
          </div>
          <div ref="listEl" class="scroll" style="max-height: 380px" @scroll.passive="onScroll">
            <table class="steps-table">
              <thead>
                <tr>
                  <th style="width: 40px">#</th>
                  <th>时间</th>
                  <th>类型</th>
                  <th>工具</th>
                  <th>模型</th>
                  <th class="right">输入</th>
                  <th class="right">命中</th>
                  <th class="right">输出</th>
                  <th class="right">思考</th>
                  <th class="right">耗时</th>
                  <th class="right">吐字</th>
                  <th class="right">credit</th>
                  <th style="width: 70px" />
                </tr>
              </thead>
              <tbody>
                <!-- 上占位：把顶部滚出去的行"撑"出来，行高按 ROW_H 精确折算 -->
                <tr v-if="padTop > 0" class="vpad" :style="{ height: padTop + 'px' }">
                  <td colspan="13" />
                </tr>

                <tr v-for="(r, i) in visibleSteps" :key="r.id">
                  <td class="num muted">{{ winStart + i + 1 }}</td>
                  <td class="num muted">{{ fmtTime(r.ts, false) }}</td>
                  <td><span class="tag gray">{{ r.kind }}</span></td>
                  <td>
                    <span v-if="r.toolName" class="tag">{{ r.toolName }}</span>
                    <span v-else class="muted">—</span>
                  </td>
                  <td class="mono">{{ r.model }}</td>
                  <td class="right num">{{ fmtNum(r.prompt) }}</td>
                  <td class="right num" :style="{ color: r.prompt && r.cacheRead / r.prompt > 0.9 ? '#12885a' : undefined }">
                    {{ fmtPct(r.prompt ? r.cacheRead / r.prompt : 0, 0) }}
                  </td>
                  <td class="right num">{{ fmtNum(r.completion) }}</td>
                  <td class="right num muted">{{ fmtNum(r.reasoning) }}</td>
                  <td class="right num" :title="`含每请求固定开销 ${fmtSec(r.overheadMs)}`">{{ fmtSec(r.durMs) }}</td>
                  <td class="right num">
                    <span
                      v-if="r.tps == null"
                      class="muted"
                      title="净出字时长不足，算不出可信的瞬时速度"
                    >—</span>
                    <span
                      v-else
                      title="瞬时速度 = 输出 ÷（耗时 − 该模型每请求固定开销）。净出字时长里仍含处理输入的时间，未命中缓存输入很大的请求读数会偏低"
                    >{{ fmtSpeed(r.tps) }}</span>
                  </td>
                  <td class="right num"><b>{{ fmtCredit(r.credit) }}</b></td>
                  <td>
                    <div class="bar"><i :style="{ width: (r.total / maxStepTotal) * 100 + '%' }" /></div>
                  </td>
                </tr>

                <tr v-if="padBottom > 0" class="vpad" :style="{ height: padBottom + 'px' }">
                  <td colspan="13" />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: flex-end;
  padding: 16px;
  /* 磨砂遮罩：后面的看板被虚化，抽屉浮在上面 */
  background: rgba(22, 28, 44, 0.26);
  backdrop-filter: blur(10px) saturate(140%);
  -webkit-backdrop-filter: blur(10px) saturate(140%);
  animation: fade 0.18s ease;
}

@keyframes fade {
  from {
    opacity: 0;
  }
}

.drawer {
  position: relative;
  width: min(1100px, 94vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius);
  background: linear-gradient(158deg, rgba(255, 255, 255, 0.86), rgba(255, 255, 255, 0.7));
  backdrop-filter: var(--glass-blur-strong);
  -webkit-backdrop-filter: var(--glass-blur-strong);
  border: 1px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 24px 72px -20px rgba(16, 22, 34, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.95);
  animation: slide 0.26s cubic-bezier(0.22, 1, 0.36, 1);
}

.drawer::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(
    150deg,
    rgba(255, 255, 255, 1) 0%,
    rgba(255, 255, 255, 0.2) 30%,
    rgba(255, 255, 255, 0.05) 60%,
    rgba(255, 255, 255, 0.5) 100%
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  pointer-events: none;
  z-index: 2;
}

@keyframes slide {
  from {
    transform: translateX(36px) scale(0.985);
    opacity: 0.4;
  }
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 20px;
  border-bottom: 1px solid rgba(120, 132, 156, 0.14);
  position: relative;
  z-index: 3;
}

.title {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 3px;
}

.body {
  padding: 16px 20px 26px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  position: relative;
  z-index: 1;
}

.kpis {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
  /* 窄屏换行时各排等高，理由见 KpiCard 的注释 */
  grid-auto-rows: 1fr;
}

/* 时间去向 / 慢工具：两块并排，行高下限让它们等高 */
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  grid-auto-rows: minmax(210px, auto);
}
.grid2 > .panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.grid2 > .panel > .pad,
.grid2 > .panel > .slow {
  flex: 1;
  min-height: 0;
}
.pad {
  padding: 12px 16px 16px;
}
.slow {
  padding: 8px 12px 12px;
}
.slow-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
}
.slow-row + .slow-row {
  border-top: 1px solid rgba(120, 132, 156, 0.1);
}
.slow-row .bar {
  flex: 1;
  min-width: 0;
}
.slow-val {
  font-size: 12px;
  font-weight: 600;
  flex: none;
  min-width: 52px;
  text-align: right;
}

/* 抽屉本身已经是玻璃，内部面板不再叠加 backdrop-filter——
   嵌套模糊既拖性能又会让层次发灰，改成稍实的白底保留层次 */
.body .panel {
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  background: rgba(255, 255, 255, 0.62);
}

/* 固定行高是窗口化渲染的前提：上下占位行的高度按 ROW_H 折算出来，
   行高一旦被内容撑开就不再等于 ROW_H，滚动条会跳。
   34px 足够放下 12px 文字和 tag（约 19px），不会再被内容顶高。 */
.steps-table td {
  height: 34px;
  padding-top: 0;
  padding-bottom: 0;
}

/* 占位行只负责撑高度：不能有边框、背景和 padding，否则既多算高度又露馅 */
.steps-table tr.vpad td,
.steps-table tr.vpad:hover td {
  padding: 0;
  border: none;
  background: none;
}

@media (max-width: 900px) {
  .kpis {
    grid-template-columns: repeat(2, 1fr);
  }
  .grid2 {
    grid-template-columns: 1fr;
    grid-auto-rows: auto;
  }
}
</style>
