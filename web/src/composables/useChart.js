import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue';

// ECharts 按需引入：只注册用到的图表与组件，产物从 1.1MB 降到 ~620KB
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);

/** 统一图表风格（浅色 + 玻璃） */
export const theme = {
  text: '#14171f',
  sub: '#4d5665',
  // 和 style.css 的 --text-3 保持一致（原来 #8b95a6 在面板上只有 2.8:1）
  faint: '#5f6b82',
  grid: 'rgba(120,132,156,.16)',
  axis: 'rgba(120,132,156,.3)',
};

/** 与页面玻璃面板一致的浮层 tooltip */
export const baseTooltip = {
  backgroundColor: 'rgba(255,255,255,.88)',
  borderColor: 'rgba(255,255,255,.9)',
  borderWidth: 1,
  padding: [9, 12],
  textStyle: { color: theme.text, fontSize: 12 },
  extraCssText: [
    'backdrop-filter:blur(24px) saturate(180%)',
    '-webkit-backdrop-filter:blur(24px) saturate(180%)',
    'box-shadow:0 12px 32px -8px rgba(16,22,34,.22), inset 0 1px 0 rgba(255,255,255,.95)',
    'border-radius:12px',
  ].join(';'),
};

export const baseAxisLabel = { color: theme.faint, fontSize: 11 };

/**
 * 把一个 DOM ref 变成 ECharts 实例。
 *
 * 用法（elRef 必须是在组件里直接声明的 ref，模板上用 ref="xxx" 绑定）：
 *   const trendEl = ref(null)
 *   useChart(trendEl, () => ({ ...option }))
 *
 * 两个必须处理的现实情况：
 * 1. 图表常常在 v-if / v-else-if 分支里，首次挂载时容器还不存在
 *    （数据没回来）。所以不能只在 onMounted 里 init 一次，必须监听
 *    elRef 从 null 变成真实元素的那一刻再补一次初始化。
 * 2. 分支切换会让容器被销毁重建，此时要重新绑定，否则画在废弃的 DOM 上。
 *
 * 另外刻意接收 ref 本身而不是返回 ref —— 从返回值里解构出来的 ref
 * 无法被 <script setup> 的模板 ref 绑定识别。
 *
 * @param {{value: HTMLElement|null}} elRef 容器 ref
 * @param {() => object} optionGetter 每次重绘时重新求值的 option 工厂
 */
export function useChart(elRef, optionGetter) {
  let chart = null;
  let ro = null;

  function render() {
    if (!chart) return;
    const option = optionGetter();
    if (!option) return;
    chart.setOption(option, true);
  }

  /** 容器可用则初始化/重新绑定；返回是否已就绪 */
  function ensure() {
    const dom = elRef.value;
    if (!dom) return false;
    if (chart && chart.getDom() === dom) return true;

    // 容器被重建（v-if 切换）——丢掉旧实例
    if (chart) {
      if (ro) ro.disconnect();
      chart.dispose();
      chart = null;
    }

    chart = echarts.init(dom, null, { renderer: 'canvas' });
    render();

    ro = new ResizeObserver(() => {
      if (chart) chart.resize();
    });
    ro.observe(dom);
    return true;
  }

  onMounted(() => {
    nextTick(ensure);
  });

  // 容器晚于组件挂载才出现（数据加载完成后才渲染 v-else-if 分支）
  watch(elRef, () => {
    nextTick(ensure);
  });

  onBeforeUnmount(() => {
    if (ro) ro.disconnect();
    if (chart) chart.dispose();
    chart = null;
  });

  // 数据变化时重绘。deep 保证 option 工厂读到的嵌套数据变化也能触发。
  watch(optionGetter, render, { deep: true });

  return { render, ensure, isReady: () => !!chart };
}
