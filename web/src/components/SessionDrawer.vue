<script setup>
import { computed, ref, watch } from 'vue';
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

/** 上下文增长曲线：输入 token 随轮次爬升，缓存命中垫底 */
const growthEl = ref(null);
useChart(growthEl, () => {
  const g = data.value?.contextGrowth || [];
  return {
    grid: { left: 8, right: 12, top: 30, bottom: 4, containLabel: true },
    tooltip: {
      ...baseTooltip,
      trigger: 'axis',
      formatter: (ps) => {
        const step = data.value.steps[ps[0].dataIndex];
        return `<b>第 ${step.index || ps[0].dataIndex + 1} 次请求</b> · ${fmtTime(step.ts)}<br/>
          ${step.toolName ? '工具：<b>' + step.toolName + '</b><br/>' : ''}
          输入 <b>${fmtNum(step.prompt)}</b>（命中 ${fmtNum(step.cacheRead)}）<br/>
          输出 <b>${fmtNum(step.completion)}</b>（思考 ${fmtNum(step.reasoning)}）<br/>
          耗时 <b>${fmtSec(step.durMs)}</b>${step.tps != null ? ` · 吐字 <b>${fmtSpeed(step.tps)}</b> t/s` : ''}<br/>
          结算 <b>${fmtCredit(step.credit)}</b>`;
      },
    },
    legend: { top: 0, right: 0, itemWidth: 9, itemHeight: 9, textStyle: { color: theme.sub, fontSize: 11 } },
    xAxis: {
      type: 'category',
      data: g.map((d) => '#' + d.index),
      axisLine: { lineStyle: { color: theme.axis } },
      axisTick: { show: false },
      axisLabel: baseAxisLabel,
    },
    yAxis: {
      type: 'value',
      axisLabel: { ...baseAxisLabel, formatter: (v) => fmtCompact(v) },
      splitLine: { lineStyle: { color: theme.grid } },
    },
    series: [
      {
        name: '缓存命中输入',
        type: 'line',
        stack: 'ctx',
        smooth: true,
        symbol: 'none',
        /* 和主趋势图保持同一套语义配色：命中=浅，未命中=深，输出=赭黄。
           两张图画的是同一组指标，配色必须能对上，否则看的人要重新学一遍。 */
        areaStyle: { color: 'rgba(77,155,163,.18)' },
        lineStyle: { color: '#4d9ba3', width: 1.5 },
        data: (data.value?.steps || []).map((r) => r.cacheRead),
      },
      {
        name: '未命中输入',
        type: 'line',
        stack: 'ctx',
        smooth: true,
        symbol: 'none',
        areaStyle: { color: 'rgba(39,97,140,.22)' },
        lineStyle: { color: '#1f5175', width: 1.5 },
        data: (data.value?.steps || []).map((r) => r.cacheMiss),
      },
      {
        name: '输出',
        type: 'line',
        smooth: true,
        symbolSize: 4,
        itemStyle: { color: '#b8863a' },
        lineStyle: { width: 1.5 },
        data: (data.value?.steps || []).map((r) => r.completion),
      },
    ],
  };
});

const maxStepTotal = computed(() => Math.max(1, ...(data.value?.steps || []).map((r) => r.total)));
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
                <div class="panel-sub">在岗时间拆成模型生成 / 工具执行 / 等待用户</div>
              </div>
            </div>
            <div class="pad">
              <PhaseBar :phase="data.phase" />
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
          <div ref="growthEl" style="height: 240px; width: 100%" />
        </div>

        <div class="panel">
          <div class="panel-head">
            <div>
              <div class="panel-title">逐次请求明细</div>
              <div class="panel-sub">{{ data.steps.length }} 条</div>
            </div>
          </div>
          <div class="scroll" style="max-height: 380px">
            <table>
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
                <tr v-for="(r, i) in data.steps" :key="r.id">
                  <td class="num muted">{{ i + 1 }}</td>
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
