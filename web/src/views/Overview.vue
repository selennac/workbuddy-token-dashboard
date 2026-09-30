<script setup>
import { computed, ref, watch } from 'vue';
import { api, toParams } from '../api.js';
import { useChart, theme, baseTooltip, baseAxisLabel } from '../composables/useChart.js';
import {
  fmtCompact,
  fmtNum,
  fmtCredit,
  fmtPct,
  fmtSec,
  fmtSpeed,
  colorOf,
  baseName,
} from '../utils/format.js';
import KpiCard from '../components/KpiCard.vue';
import PhaseBar from '../components/PhaseBar.vue';
import PhaseMiniBar from '../components/PhaseMiniBar.vue';

const props = defineProps({ filter: Object, meta: Object });
const emit = defineEmits(['open-session']);

const data = ref(null);
const loading = ref(false);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.overview(toParams(props.filter));
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

watch(() => props.filter, load, { deep: true, immediate: true });
defineExpose({ reload: load });

const s = computed(() => data.value?.summary || {});

/**
 * 吐字速度。
 *
 * 两个口径必须分开说，否则数字前后矛盾：
 *   speed.tps        拟合斜率（按输出量加权）—— 模型的固有速度，看板主指标
 *   speed.measuredTps  Σ输出 / Σ净时长 —— 实测口径，系统性偏低，
 *                      因为"上一次工具返回到真正发起请求"之间的调度空转也被算进去了
 */
const sp = computed(() => data.value?.speed || {});
const speedSub = computed(() => {
  const v = sp.value;
  if (v.tps == null) return '耗时样本不足，无法拟合';
  const parts = [`${v.dominantModel || '—'} 拟合`, `每请求开销 ${fmtSec(v.overheadMs)}`];
  if (!v.reliable) parts.push('样本少，仅供参考');
  return parts.join(' · ');
});

/** 时间去向（所选范围涉及会话的合计） */
const phase = computed(() => data.value?.phase || null);

/** 按会话拆的时间去向，用来回答"这些在岗时间花在哪个会话上" */
const bySessionPhase = computed(() => data.value?.phaseBySession || []);
const maxPhaseActiveMs = computed(() =>
  Math.max(1, ...bySessionPhase.value.map((s) => s.activeMs)),
);

/** 工具耗时：按名字查表，给「工具调用分布」的 tooltip 补上真实耗时 */
const toolTimeByName = computed(() => {
  const m = new Map();
  for (const t of data.value?.toolTime || []) m.set(t.name, t);
  return m;
});
const toolTime = (name) => toolTimeByName.value.get(name) || null;

/** ECharts 竖向线性渐变（从上到下） */
function grad(from, to) {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ],
  };
}

/** ECharts 横向线性渐变（从左到右） */
function gradH(from, to) {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 1,
    y2: 0,
    colorStops: [
      { offset: 0, color: from },
      { offset: 1, color: to },
    ],
  };
}

/* ---------- 趋势图：堆叠用量 + credit 折线 ---------- */
const trendEl = ref(null);
useChart(trendEl, () => {
  const t = data.value?.timeline || [];
  const gran = props.filter.granularity || 'day';
  const fmtLabel = (b) => (gran === 'hour' ? b.key.slice(5) : gran === 'month' ? b.key : b.key.slice(5));
  // 分桶少的时候柱子要粗一些，否则宽图里显得空
  const bw = t.length <= 8 ? 62 : t.length <= 20 ? 40 : 22;
  return {
    grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps) => {
        const b = t[ps[0].dataIndex];
        const hit = b.prompt ? b.cacheRead / b.prompt : 0;
        return `<b>${b.key}</b><br/>
          ${ps.map((p) => `${p.marker} ${p.seriesName}：<b>${fmtNum(p.value)}</b>`).join('<br/>')}
          <div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee">
          输入合计 ${fmtNum(b.prompt)} ｜ 缓存命中率 <b>${fmtPct(hit)}</b><br/>
          请求 <b>${b.requests}</b> 次 ｜ 结算 <b>${fmtCredit(b.credit)}</b></div>`;
      },
    },
    legend: { top: 0, right: 0, itemWidth: 9, itemHeight: 9, textStyle: { color: theme.sub, fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: t.map(fmtLabel),
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: baseAxisLabel,
    },
    yAxis: [
      {
        type: 'value',
        axisLabel: { ...baseAxisLabel, formatter: (v) => fmtCompact(v) },
        splitLine: { lineStyle: { color: theme.grid } },
      },
      {
        type: 'value',
        axisLabel: { ...baseAxisLabel, formatter: (v) => v },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '缓存命中输入',
        type: 'bar',
        stack: 'tok',
        data: t.map((b) => b.cacheRead),
        barMaxWidth: bw,
        itemStyle: {
          color: grad('#b3c8dd', '#e4edf5'),
          borderRadius: [0, 0, 3, 3],
        },
      },
      {
        name: '未命中输入',
        type: 'bar',
        stack: 'tok',
        data: t.map((b) => b.cacheMiss),
        barMaxWidth: bw,
        // 未命中按全价计费，用最深的颜色让它跳出来
        itemStyle: { color: grad('#1f5175', '#32749f'), borderRadius: [3, 3, 0, 0] },
      },
      {
        name: '输出',
        type: 'bar',
        stack: 'tok',
        data: t.map((b) => b.completion),
        barMaxWidth: bw,
        itemStyle: { color: grad('#2c7a83', '#4d9ba3'), borderRadius: [3, 3, 0, 0] },
      },
      {
        name: '结算 (credit)',
        type: 'line',
        yAxisIndex: 1,
        // 数据点太少时不做平滑，否则会画出并不存在的弧线，误导趋势
        smooth: t.length > 6 ? 0.35 : false,
        symbolSize: 7,
        data: t.map((b) => b.credit),
        itemStyle: { color: '#b8863a', borderColor: '#fff', borderWidth: 2 },
        lineStyle: { width: 2.5, shadowColor: 'rgba(184,134,58,.45)', shadowBlur: 12, shadowOffsetY: 4 },
      },
    ],
  };
});

/* ---------- 时间去向趋势 ----------
 *
 * 为什么必须有这张图：时间去向只有一个总数时，"这周比上周怎么样"根本无从谈起 ——
 * 绝对值多少不重要，**趋势**才可行动。分桶口径与上面的用量趋势完全一致。
 *
 * 只画在岗的三段，不画「离开」：离开一天能到 20 小时，画进来另外三段会被压成零
 * （PhaseBar 当初不画离开也是同一个理由）。离开的量放在 tooltip 里，想看能查到。
 *
 * 配色与 PhaseBar、PhaseMiniBar 严格一致 —— 三处画的是同一组指标，
 * 颜色对不上，看的人就得重新学一遍。
 */
const phaseTrendEl = ref(null);
useChart(phaseTrendEl, () => {
  const t = data.value?.phaseTimeline || [];
  if (!t.length) return null;
  const gran = props.filter.granularity || 'day';
  const fmtLabel = (b) => (gran === 'hour' ? b.key.slice(5) : gran === 'month' ? b.key : b.key.slice(5));
  const bw = t.length <= 8 ? 62 : t.length <= 20 ? 40 : 22;
  // 图里用分钟：按小时分桶时在岗常常只有几分钟，拿毫秒或小时读都不直观
  const mins = (ms) => Math.round(ms / 600) / 100;
  return {
    grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps) => {
        const b = t[ps[0].dataIndex];
        return `<b>${b.key}</b><br/>
          ${ps.map((x) => `${x.marker} ${x.seriesName}：<b>${fmtSec(x.value * 60000)}</b>`).join('<br/>')}
          <div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee">
          在岗合计 <b>${fmtSec(b.activeMs)}</b> ｜ 离开 <b>${fmtSec(b.awayMs)}</b></div>`;
      },
    },
    legend: { top: 0, right: 0, itemWidth: 9, itemHeight: 9, textStyle: { color: theme.sub, fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: t.map(fmtLabel),
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: baseAxisLabel,
    },
    yAxis: {
      type: 'value',
      axisLabel: { ...baseAxisLabel, formatter: (v) => v + 'm' },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: [
      {
        name: '模型生成',
        type: 'bar',
        stack: 'ph',
        barMaxWidth: bw,
        itemStyle: { color: '#27618c' },
        data: t.map((b) => mins(b.modelMs)),
      },
      {
        name: '工具执行',
        type: 'bar',
        stack: 'ph',
        barMaxWidth: bw,
        itemStyle: { color: '#2c7a83' },
        data: t.map((b) => mins(b.toolMs)),
      },
      {
        name: '人的环节',
        type: 'bar',
        stack: 'ph',
        barMaxWidth: bw,
        itemStyle: { color: '#b8863a', borderRadius: [3, 3, 0, 0] },
        data: t.map((b) => mins(b.humanMs)),
      },
    ],
  };
});

/* ---------- 模型分布 ---------- */
const modelEl = ref(null);
/** 饼图口径：credit / token / 请求数。默认按 credit，因为那才是成本 */
const modelMetric = ref('credit');
const MODEL_METRICS = [
  { key: 'credit', label: '按 credit' },
  { key: 'total', label: '按 token' },
  { key: 'requests', label: '按请求数' },
];

useChart(modelEl, () => {
  const list = data.value?.byModel || [];
  const key = modelMetric.value;
  return {
    tooltip: {
      ...baseTooltip,
      formatter: (p) => {
        const d = p.data;
        const zero = key === 'credit' && d.realCredit === 0;
        return `<b>${p.name}</b><br/>
          ${d.req} 次请求 ｜ ${fmtCompact(d.total)} token<br/>
          结算 <b>${fmtCredit(d.realCredit)}</b> credit
          <div style="color:#9aa3b0;margin-top:4px">${zero ? '该模型未产生 credit（免费/预览模型）' : `占本口径 ${p.percent}%`}</div>`;
      },
    },
    legend: {
      orient: 'vertical',
      // 位置：把「环形图 + 图例」当成一个整体在面板里居中，而不是让图例贴右边缘。
      // 原来是 center 36% + legend right 10，实测（面板宽 685）：
      // 图占 153~342（中心 247.5，面板中心 342.5 → 图偏左 95px），
      // 图例占 550~668（右侧只剩 17px），中间空出 223px 一块 —— 整体读起来"不居中"。
      // 现在按尺寸反推：图直径 ~192px（0.72 × 画布高 267 ÷ 2 × 2）、
      // 图例块 ~122px、间隔 56px → 整体 370px，两侧各留 ~157px。
      // 于是图心 = 157+96 ≈ 253px ≈ 37%，图例左边界 = 157+192+56 ≈ 405px ≈ 59%。
      left: '59%',
      top: 'center',
      itemWidth: 9,
      itemHeight: 9,
      itemGap: 8,
      textStyle: { color: theme.sub, fontSize: 11 },
      // 原来按 15 字硬截断，"deepseek-v4.1-flash" 被切成 "deepseek-v4.1-f…"，
      // 几个模型名看起来都一个样。放宽到 28 字，只给极端长的模型名兜底。
      formatter: (n) => (n.length > 28 ? n.slice(0, 27) + '…' : n),
    },
    series: [
      {
        type: 'pie',
        radius: ['48%', '72%'],
        // 37%：让「环形图 + 右侧图例」整体在面板里居中，见上方 legend 注释。
        // 改这里记得和图例的 left 一起算，只动一个就会重新歪掉。
        center: ['37%', '50%'],
        avoidLabelOverlap: true,
        label: { show: false },
        itemStyle: {
          borderColor: 'rgba(255,255,255,.9)',
          borderWidth: 3,
          borderRadius: 6,
          shadowBlur: 14,
          shadowColor: 'rgba(16,22,34,.14)',
          shadowOffsetY: 3,
        },
        data: list.map((m, i) => ({
          name: m.model,
          value: m[key],
          req: m.requests,
          total: m.total,
          realCredit: m.credit,
          itemStyle: { color: colorOf(i) },
        })),
      },
    ],
  };
});

/* ---------- 项目排行 ---------- */
const maxProjectCredit = computed(() =>
  Math.max(1, ...(data.value?.byProject || []).map((p) => p.credit)),
);

/* ---------- 最慢的工具调用 ---------- */
const maxToolMs = computed(() => Math.max(1, ...(data.value?.slowTools || []).map((t) => t.ms)));

/* ---------- 工具调用 ---------- */
const toolEl = ref(null);
useChart(toolEl, () => {
  const list = [...(data.value?.byTool || [])].slice(0, 12).reverse();
  return {
    grid: { left: 8, right: 24, top: 8, bottom: 4, containLabel: true },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (ps) => {
        const d = list[ps[0].dataIndex];
        const tm = toolTime(d.name);
        return `<b>${d.name}</b><br/>请求 ${d.calls} 次<br/>输入 ${fmtCompact(d.prompt)} ｜ 输出 ${fmtCompact(d.completion)}<br/>结算 ${fmtCredit(d.credit)}${
          tm
            ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee">
                实测耗时 <b>${fmtSec(tm.totalMs)}</b>（均值 ${fmtSec(tm.avgMs)} ｜ 最长 ${fmtSec(tm.maxMs)}）</div>`
            : ''
        }`;
      },
    },
    xAxis: {
      type: 'value',
      axisLabel: { ...baseAxisLabel, formatter: (v) => fmtCompact(v) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    yAxis: {
      type: 'category',
      data: list.map((d) => d.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { ...baseAxisLabel, color: theme.sub },
    },
    series: [
      {
        type: 'bar',
        data: list.map((d) => d.calls),
        itemStyle: {
          color: gradH('#32749f', '#7fb0cf'),
          borderRadius: [0, 5, 5, 0],
          shadowBlur: 10,
          shadowColor: 'rgba(50,116,159,.28)',
          shadowOffsetX: -2,
        },
        barMaxWidth: 14,
        label: { show: true, position: 'right', color: theme.faint, fontSize: 11 },
      },
    ],
  };
});
</script>

<template>
  <!--
    必须包一层单一根节点：父组件用 v-show 控制显隐，
    而 v-show 对多根节点（fragment）的组件不生效，会导致切 tab 时内容叠加。
  -->
  <div class="view">
    <div v-if="error" class="empty">{{ error }}</div>

    <template v-else-if="data">
    <!-- KPI -->
    <div class="kpis">
      <KpiCard
        label="请求总数"
        :value="fmtNum(s.requests)"
        :sub="`平均 ${fmtCompact(s.avgPrompt)} 输入 / ${fmtNum(s.avgCompletion)} 输出`"
      />
      <KpiCard
        label="Token 总量"
        :value="fmtCompact(s.total)"
        :sub="`输入 ${fmtCompact(s.prompt)} ｜ 输出 ${fmtCompact(s.completion)}`"
      />
      <KpiCard
        label="缓存命中率"
        :value="fmtPct(s.cacheHitRate)"
        :sub="`命中 ${fmtCompact(s.cacheRead)} ｜ 未命中 ${fmtCompact(s.cacheMiss)}`"
        accent="#2c7a83"
        :progress="s.cacheHitRate"
      />
      <KpiCard
        label="吐字速度"
        :value="sp.tps == null ? '—' : `${fmtSpeed(sp.tps)} t/s`"
        :sub="speedSub"
        accent="#8f6a9e"
      />
      <KpiCard
        label="思考 Token"
        :value="fmtCompact(s.reasoning)"
        :sub="`占输出 ${fmtPct(s.completion ? s.reasoning / s.completion : 0)}`"
        accent="#7d9455"
      />
      <KpiCard
        label="结算用量 (credit)"
        :value="fmtCredit(s.credit)"
        :sub="`平均每次 ${fmtCredit(s.avgCredit)}`"
        accent="#b8863a"
      />
    </div>

    <!-- 趋势 -->
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">用量趋势</div>
          <div class="panel-sub">堆叠柱 = token 构成（按输入拆分缓存命中/未命中），折线 = 结算用量</div>
        </div>
      </div>
      <div ref="trendEl" class="chart chart-lg" />
    </div>

    <div class="grid2">
      <!-- 项目排行 -->
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">项目用量排行</div>
          <div class="panel-sub">按结算用量</div>
        </div>
        <div class="rank">
          <div v-for="(p, i) in data.byProject" :key="p.projectId" class="rank-row">
            <div class="rank-idx num">{{ i + 1 }}</div>
            <div class="rank-main">
              <div class="rank-name" :title="p.cwd || p.projectId">
                {{ baseName(p.cwd) || p.projectId }}
                <span class="muted rank-path">{{ p.cwd || p.projectId }}</span>
              </div>
              <div class="bar">
                <i :style="{ width: (p.credit / maxProjectCredit) * 100 + '%', background: colorOf(i) }" />
              </div>
            </div>
            <div class="rank-vals num">
              <div class="rank-credit">{{ fmtCredit(p.credit) }} <span class="muted">cr</span></div>
              <div class="rank-sub muted">
                {{ fmtCompact(p.total) }} tok · {{ p.requests }} req · {{ p.sessionCount }} 会话
              </div>
            </div>
          </div>
          <div v-if="!data.byProject.length" class="empty">暂无数据</div>
        </div>
      </div>

      <!-- 模型分布 -->
      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">模型用量分布</div>
            <div class="panel-sub">默认按结算 credit 看成本占比</div>
          </div>
          <div class="seg">
            <button
              v-for="m in MODEL_METRICS"
              :key="m.key"
              class="seg-btn"
              :class="{ on: modelMetric === m.key }"
              @click="modelMetric = m.key"
            >
              {{ m.label }}
            </button>
          </div>
        </div>
        <div ref="modelEl" class="chart" />
      </div>
    </div>

    <div class="grid2">
      <!-- 模型明细 -->
      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">模型明细</div>
            <div class="panel-sub">单价与出字速度都一目了然 · 速度由全量样本拟合得出</div>
          </div>
        </div>
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>模型</th>
                <th class="right">请求</th>
                <th class="right">输入</th>
                <th class="right">输出</th>
                <th class="right">缓存命中率</th>
                <th class="right">credit</th>
                <th class="right">均次</th>
                <th class="right">吐字速度</th>
                <th class="right">每请求开销</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in data.byModel" :key="m.model">
                <td><span class="mono">{{ m.model }}</span></td>
                <td class="right num">{{ m.requests }}</td>
                <td class="right num">{{ fmtCompact(m.prompt) }}</td>
                <td class="right num">{{ fmtCompact(m.completion) }}</td>
                <td class="right num">{{ fmtPct(m.cacheHitRate) }}</td>
                <td class="right num"><b>{{ fmtCredit(m.credit) }}</b></td>
                <td class="right num muted">{{ fmtCredit(m.avgCredit) }}</td>
                <td class="right num">
                  <span v-if="m.speed == null" class="muted">—</span>
                  <span
                    v-else
                    :class="{ lowconf: !m.speedReliable }"
                    :title="`${m.speedSamples} 条样本拟合，R²=${m.speedR2}${m.speedReliable ? '' : '，样本偏少仅供参考'}`"
                  >
                    <b>{{ fmtSpeed(m.speed) }}</b> <span class="unit">t/s</span>
                  </span>
                </td>
                <td class="right num muted">
                  {{ m.speedReliable && m.overheadMs != null ? fmtSec(m.overheadMs) : '—' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 工具调用 -->
      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">工具调用分布</div>
          <div class="panel-sub">带 tool 的请求次数 Top 12 · 悬停看实测耗时</div>
        </div>
        <div ref="toolEl" class="chart" />
      </div>
    </div>

    <div class="grid2">
      <!-- 时间去向：总量 + 按会话下钻 -->
      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">时间去向</div>
            <div class="panel-sub">在岗时间拆成三段：模型在生成、工具在执行、你在读和写。离开电脑的时段不计入</div>
          </div>
        </div>
        <div class="pad">
          <PhaseBar :phase="phase" :credit="s.credit" />

          <div v-if="bySessionPhase.length" class="breakdown">
            <div class="breakdown-head">
              <span>时间花在哪</span>
              <span class="muted">按会话在岗耗时 · 点击查看</span>
            </div>
            <div
              v-for="s in bySessionPhase"
              :key="s.sessionId"
              class="bd-row"
              @click="emit('open-session', s.sessionId)"
            >
              <span class="bd-name" :title="s.title">{{ s.title || '(无标题会话)' }}</span>
              <PhaseMiniBar :phase="s" :max-ms="maxPhaseActiveMs" />
              <span class="bd-val num">{{ fmtSec(s.activeMs) }}</span>
            </div>
          </div>
          <div v-else class="empty">所选范围内没有可用的会话耗时数据</div>
        </div>
      </div>

      <!-- 慢工具 -->
      <div class="panel">
        <div class="panel-head">
          <div>
            <div class="panel-title">最慢的工具调用</div>
            <div class="panel-sub">按 callId 把调用与返回配对算出的实测耗时，不需要任何推算</div>
          </div>
        </div>
        <div class="scroll slow">
          <div v-for="t in data.slowTools" :key="t.callId" class="slow-row" @click="emit('open-session', t.sessionId)">
            <div class="slow-main">
              <div class="slow-name">
                <span class="tag">{{ t.name }}</span>
                <span class="muted slow-title" :title="t.title">{{ t.title || '(无标题会话)' }}</span>
              </div>
              <div class="bar"><i :style="{ width: (t.ms / maxToolMs) * 100 + '%' }" /></div>
            </div>
            <div class="slow-val num">{{ fmtSec(t.ms) }}</div>
          </div>
          <div v-if="!data.slowTools.length" class="empty">暂无可用的工具耗时数据</div>
        </div>
      </div>
    </div>

    <!-- 时间去向趋势：没有时间维度，"时间花在哪"就只能看个总数 -->
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">时间去向趋势</div>
          <div class="panel-sub">按当前粒度分桶 · 只画在岗，离开量见悬停提示</div>
        </div>
      </div>
      <div ref="phaseTrendEl" class="chart chart-lg" />
    </div>
  </template>

    <div v-else class="empty">加载中…</div>
  </div>
</template>

<style scoped>
.view {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
  /* 行高统一：换行成多排时，某一排的副标题多折一行不该让它比别的排高。
     配合 KpiCard 里进度条槽位恒占位，卡片就真正等高了。 */
  grid-auto-rows: 1fr;
}
@media (max-width: 1420px) {
  .kpis {
    grid-template-columns: repeat(3, 1fr);
  }
}
/* ---------- 项目排行 / 模型分布 / 明细 / 工具：2×2，行高对齐 ---------- */
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  /* 固定行高下限，让左右两块面板等高，避免一侧留大片空白 */
  grid-auto-rows: minmax(330px, auto);
}

/* 面板内部成为纵向弹性容器，内容区撑满剩余高度 */
.grid2 > .panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.grid2 > .panel > .rank,
.grid2 > .panel > .scroll {
  flex: 1;
  min-height: 0;
}

.grid2 > .panel > .chart {
  flex: 1;
  min-height: 240px;
}

@media (max-width: 1100px) {
  .grid2 {
    grid-template-columns: 1fr;
    grid-auto-rows: auto;
  }
}

.chart {
  width: 100%;
}
.chart-lg {
  height: 300px;
}
.rank {
  padding: 8px 14px 14px;
}
.rank-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  transition: background 0.18s, box-shadow 0.18s;
}
.rank-row:hover {
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 2px 10px -3px rgba(16, 22, 34, 0.14), inset 0 1px 0 #fff;
}
.rank-row + .rank-row {
  border-top: 1px solid rgba(120, 132, 156, 0.1);
}
.rank-idx {
  width: 20px;
  font-size: 11px;
  color: var(--text-3);
  text-align: center;
}
.rank-main {
  flex: 1;
  min-width: 0;
}
.rank-name {
  font-size: 12px;
  margin-bottom: 5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rank-path {
  font-size: 10px;
  margin-left: 6px;
  font-family: 'SFMono-Regular', Consolas, monospace;
}
.rank-vals {
  text-align: right;
}
.rank-credit {
  font-size: 13px;
  font-weight: 600;
}
.rank-sub {
  font-size: 11px;
  margin-top: 2px;
}

/* 分段控件 */
.seg {  display: inline-flex;
  /* 原来是 var(--border-strong)，这个变量在整个项目里根本没定义过，
     导致 border 声明整条失效（CSS 变量未定义时该声明在计算值阶段被丢弃），
     这个控件其实一直没有边框。改用已有的控件边框 token。 */
  border: 1px solid var(--ctl-border);
  border-radius: var(--radius-xs);
  overflow: hidden;
}
.seg-btn {
  border: none;
  background: #fff;
  padding: 0 10px;
  height: 26px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  font-family: inherit;
  border-right: 1px solid rgba(120, 132, 156, 0.16);
}
.seg-btn:last-child {
  border-right: none;
}
.seg-btn:hover {
  color: var(--accent);
}
.seg-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}

/* ---------- 时间去向 / 慢工具 ---------- */
.pad {
  padding: 12px 16px 16px;
  flex: 1;
  min-height: 0;
}

/* ---------- 时间去向：按会话下钻 ---------- */
.breakdown {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(120, 132, 156, 0.16);
}
.breakdown-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 8px;
}
.breakdown-head .muted {
  font-size: 11px;
  font-weight: 400;
}
.bd-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.18s, box-shadow 0.18s;
}
.bd-row:hover {
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 2px 10px -3px rgba(16, 22, 34, 0.14), inset 0 1px 0 #fff;
}
/* 会话名占固定宽度，右边的条才能对齐成一列、互相比较 */
.bd-name {
  width: 180px;
  flex: none;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bd-row :deep(.mini) {
  flex: 1;
  min-width: 0;
}
.bd-val {
  flex: none;
  width: 58px;
  text-align: right;
  font-size: 12px;
  font-weight: 600;
}

/* 速度列：样本不足的模型不隐藏数值，但压淡并配 title 说明，避免过度承诺 */
.lowconf {
  opacity: 0.62;
}
.unit {
  font-size: 10px;
  color: var(--text-3);
}

.slow {
  padding: 8px 14px 14px;
}
.slow-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background 0.18s, box-shadow 0.18s;
}
.slow-row:hover {
  background: rgba(255, 255, 255, 0.66);
  box-shadow: 0 2px 10px -3px rgba(16, 22, 34, 0.14), inset 0 1px 0 #fff;
}
.slow-row + .slow-row {
  border-top: 1px solid rgba(120, 132, 156, 0.1);
}
.slow-main {
  flex: 1;
  min-width: 0;
}
.slow-name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.slow-title {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.slow-val {
  font-size: 13px;
  font-weight: 600;
  flex: none;
}
</style>
