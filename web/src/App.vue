<script setup>
import { onMounted, ref, watch } from 'vue';
import { api } from './api.js';
import { fmtNum, fmtTime } from './utils/format.js';
import { pickGranularity, spanDaysOf } from './utils/granularity.js';
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

const filter = ref({
  preset: '全部',
  from: '',
  to: '',
  projectId: 'all',
  model: 'all',
  kind: 'all',
  granularity: 'day',
  keyword: '',
});

const overviewRef = ref(null);
const sessionsRef = ref(null);
const requestsRef = ref(null);

async function loadMeta() {
  try {
    meta.value = await api.meta();
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

onMounted(loadMeta);

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
      </div>
    </header>

    <!-- 筛选 -->
    <section class="toolbar">
      <FilterBar
        :filter="filter"
        :meta="meta"
        :loading="loading"
        @update:filter="filter = $event"
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

  <SessionDrawer v-if="openSessionId" :session-id="openSessionId" @close="openSessionId = ''" />
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
