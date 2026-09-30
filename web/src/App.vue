<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from './api.js';
import { fmtNum, fmtTime } from './utils/format.js';
import { pickGranularity, spanDaysOf } from './utils/granularity.js';
import { loadFilter, saveFilter, sanitizeFilter } from './composables/useFilterStorage.js';
import FilterBar from './components/FilterBar.vue';
import SessionDrawer from './components/SessionDrawer.vue';
import Overview from './views/Overview.vue';
import Sessions from './views/Sessions.vue';
import Requests from './views/Requests.vue';

const TABS = [
  { key: 'overview', label: '总览' },
  { key: 'sessions', label: '会话' },
  { key: 'requests', label: '明细' },
];

const tab = ref('overview');
const meta = ref({});
const loading = ref(false);
const openSessionId = ref('');

/* 上次的筛选条件：从 localStorage 恢复（只在当天有效，见 useFilterStorage 的注释） */
const boot = loadFilter();
const filter = ref(boot.filter);
/** 是否确实沿用了一份存下来的筛选 —— 顶栏要给个可见的交代 */
const restoredHint = ref(boot.restored);

/** 用户动了筛选：从这一刻起就不再是"沿用"，把提示收掉 */
function onFilter(next) {
  filter.value = next;
  restoredHint.value = false;
}

const overviewRef = ref(null);
const sessionsRef = ref(null);
const requestsRef = ref(null);
const drawerRef = ref(null);

/**
 * 前端自动取数间隔，与服务端扫描间隔（SCAN_INTERVAL_MS，默认 5s）对齐，
 * 保证每一拍拉到的都是刚扫进内存的新数据。
 */
const AUTO_REFRESH_MS = 5000;
let timer = null;
let saveTimer = null;

async function loadMeta() {
  try {
    meta.value = await api.meta();
    /* meta 到手后才能校验存下来的项目/模型/类型是否还在数据里。
       直接还原一个已经消失的选项，界面上是空选择器 + 恒 0 条结果，
       比不还原更让人困惑。 */
    const fixed = sanitizeFilter(filter.value, meta.value);
    if (JSON.stringify(fixed) !== JSON.stringify(filter.value)) filter.value = fixed;
  } catch (e) {
    meta.value = { error: e.message };
  }
}

async function refresh() {
  loading.value = true;
  try {
    await api.refresh();
    await loadMeta();
    const map = { overview: overviewRef, sessions: sessionsRef, requests: requestsRef };
    await map[tab.value].value?.reload();
  } finally {
    loading.value = false;
  }
}

/**
 * 静默重取：不动 loading 骨架（会闪），只拉 meta + 当前页签 + 已打开的会话抽屉。
 *
 * 刻意**不**调 /api/refresh —— 那是"立刻强制重扫"，属于手动按钮的语义；
 * 自动这一路只负责把服务端已经扫好的结果拉下来，两边职责分开。
 */
async function poll() {
  if (document.hidden) return; // 切到后台就停，回来时补一拍
  if (loading.value) return; // 上一拍还没回来（比如刚点过刷新），跳过
  const map = { overview: overviewRef, sessions: sessionsRef, requests: requestsRef };
  try {
    meta.value = await api.meta();
    await map[tab.value].value?.reload();
    if (openSessionId.value) await drawerRef.value?.reload();
  } catch {
    /* 网络抖动跳过这一拍，下一拍再试，不要把页面顶成错误态 */
  }
}

/** 从后台切回前台立刻补一拍，省得干等满一个周期 */
function onVisibilityChange() {
  if (!document.hidden) poll();
}

onMounted(() => {
  loadMeta();
  timer = setInterval(poll, AUTO_REFRESH_MS);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

onBeforeUnmount(() => {
  clearInterval(timer);
  clearTimeout(saveTimer);
  document.removeEventListener('visibilitychange', onVisibilityChange);
});

/**
 * 筛选条件存盘。
 * 关键词是逐字符改的，debounce 一下，别每个按键都写一次 localStorage。
 * 粒度被自动兜正（下面那个 watch）也会走这里，正好把兜正后的结果一并存下来。
 */
watch(
  filter,
  (f) => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveFilter(f), 300);
  },
  { deep: true },
);

/**
 * 粒度跟区间绑定：区间一变，原来选中的粒度可能就不适用了
 * （从"近 7 天"切到"今天"，按天只剩 1 根柱子）。
 * 在这里统一兜正，省得用户改完区间还要手动再点一次粒度。
 * 阈值口径与禁用哪些档位都在 utils/granularity.js，FilterBar 共用同一套。
 */
watch(
  () => [filter.value.from, filter.value.to, filter.value.granularity, meta.value.minTs],
  () => {
    const next = pickGranularity(spanDaysOf(filter.value, meta.value), filter.value.granularity);
    if (next !== filter.value.granularity) filter.value = { ...filter.value, granularity: next };
  },
  { immediate: true },
);
</script>

<template>
  <!-- 动态背景：主光 + 补光 + 暗角 + 细颗粒，给玻璃提供可折射的内容 -->
  <div class="aurora" aria-hidden="true">
    <div class="layer light-key" />
    <div class="layer light-fill" />
    <div class="layer vignette" />
    <div class="grain" />
  </div>
  <div class="aurora-fade" aria-hidden="true" />

  <div class="app">
    <!-- 顶栏：悬浮玻璃条 -->
    <header class="topbar glass">
      <div class="brand">
        <div class="logo" role="img" aria-label="白熊图标" />
        <div class="brand-text">
          <div class="brand-title">WorkBuddy Token 用量看板</div>
          <div class="brand-sub mono">{{ meta.error ? '未连接到解析服务' : meta.projectsDir || '读取中…' }}</div>
        </div>
      </div>

      <nav class="tabs seg">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="seg-btn tab"
          :class="{ on: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </nav>

      <div class="stats">
        <div class="stat">
          <span class="stat-k">请求</span>
          <span class="stat-v num">{{ fmtNum(meta.recordCount || 0) }}</span>
        </div>
        <div class="stat">
          <span class="stat-k">会话</span>
          <span class="stat-v num">{{ fmtNum(meta.sessionCount || 0) }}</span>
        </div>
        <div class="stat">
          <span class="stat-k">最近扫描</span>
          <span class="stat-v num">{{ meta.lastScanAt ? fmtTime(meta.lastScanAt, false) : '-' }}</span>
        </div>
        <span class="dot" title="解析服务正常" />
        <span class="auto-hint" title="页面每 5 秒自动拉取最新数据（切到后台会暂停）">自动刷新 5s</span>
      </div>
    </header>

    <!-- 筛选 -->
    <section class="toolbar">
      <FilterBar
        :filter="filter"
        :meta="meta"
        :loading="loading"
        :restored="restoredHint"
        @update:filter="onFilter"
        @dismiss-restored="restoredHint = false"
        @refresh="refresh"
      />
    </section>

    <!-- 内容 -->
    <main class="content">
      <Overview
        v-show="tab === 'overview'"
        ref="overviewRef"
        :filter="filter"
        :meta="meta"
        @open-session="openSessionId = $event"
      />
      <Sessions
        v-show="tab === 'sessions'"
        ref="sessionsRef"
        :filter="filter"
        @open-session="openSessionId = $event"
      />
      <Requests
        v-show="tab === 'requests'"
        ref="requestsRef"
        :filter="filter"
        @open-session="openSessionId = $event"
      />
    </main>
  </div>

  <SessionDrawer
    v-if="openSessionId"
    ref="drawerRef"
    :session-id="openSessionId"
    @close="openSessionId = ''"
  />
</template>

<style scoped>
.app {
  position: relative;
  z-index: 1;
  /* 不撑满整屏：居中 + 最大宽度 */
  max-width: var(--shell-max);
  margin: 0 auto;
  padding: 18px var(--shell-pad) 44px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 悬浮玻璃顶栏：滚动时内容从玻璃后面穿过，玻璃感最明显 */
.topbar {
  position: sticky;
  top: 14px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 11px 16px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 11px;
  flex: none;
}

/*
  品牌图标：直接用 src/assets/logo.jpg（白熊）。
  原来是内联 SVG + indigo→sky→teal 的三色斜渐变，那是最典型的 AI 图标配色；
  换成位图后这层渐变没有意义了（图不透明，底下什么都透不出来），
  但**底色留着**——图加载失败时它就是兜底，不会变成一块空白。

  另外保留内高光和圆角：图标和顶栏是同一套玻璃材质，
  边缘没有这道高光就会像一张贴上去的贴纸。
*/
.logo {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  background-color: var(--accent);
  background-image: url('./assets/logo.jpg');
  background-size: cover;
  /* 白熊在画面里略偏下，往上挪一点让它在圆形裁切里更居中 */
  background-position: 50% 42%;
  box-shadow: 0 4px 14px -4px var(--accent-glow), inset 0 1px 0 rgba(255, 255, 255, 0.5);
}

.brand-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.brand-sub {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 2px;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 页签做成中置分段控件 */
.tabs {
  flex: 1;
  justify-content: center;
  display: flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.3);
}

.tabs .tab {
  height: 28px;
  padding: 0 18px;
  font-size: 12px;
  border-radius: var(--radius-chip);
}

.stats {
  display: flex;
  align-items: center;
  gap: 18px;
  flex: none;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
}

.stat-k {
  font-size: 10px;
  color: var(--text-3);
  letter-spacing: 0.3px;
}

.stat-v {
  font-size: 13px;
  font-weight: 600;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-ring);
}

/* 自动刷新的可见回执：数字会自己跳，但得让人知道是"活着"还是"冻住了" */
.auto-hint {
  font-size: 10px;
  color: var(--text-3);
  letter-spacing: 0.2px;
  white-space: nowrap;
}

.toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.content {
  display: flex;
  flex-direction: column;
  gap: 14px;
  /* 撑满剩余高度，让列表页的玻璃面板能铺满可视区而不是底部留白 */
  flex: 1;
  min-height: 0;
}

@media (max-width: 1180px) {
  .topbar {
    flex-wrap: wrap;
  }
  .tabs {
    order: 3;
    width: 100%;
    flex-basis: 100%;
  }
  .brand-sub {
    max-width: 180px;
  }
}
</style>
