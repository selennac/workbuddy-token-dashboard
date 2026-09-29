<script setup>
defineProps({
  label: String,
  value: String,
  sub: String,
  accent: { type: String, default: '' },
  progress: { type: Number, default: null },
  icon: { type: String, default: '' },
});
</script>

<template>
  <!--
    进度条槽位**永远占位**（没有数据时 visibility: hidden）。
    原来用 v-if，只有「缓存命中率」这张卡多出一根条 →
    它的内容比同排其它卡高 9+6px，而 CSS Grid 的行高是各自独立的，
    于是 3 列布局下第一排比第二排高一截。恒占位让所有卡片等高。
  -->
  <div class="kpi glass">
    <div class="kpi-top">
      <span class="kpi-label">{{ label }}</span>
      <span class="kpi-orb" :style="{ background: accent || 'var(--accent)' }" />
    </div>
    <div class="kpi-value num" :style="accent ? { color: accent } : null">{{ value }}</div>
    <div class="kpi-sub num">{{ sub }}</div>
    <div class="bar" :style="{ marginTop: '9px', visibility: progress == null ? 'hidden' : 'visible' }">
      <i
        v-if="progress != null"
        :style="{ width: Math.min(100, progress * 100) + '%', background: `linear-gradient(90deg, ${accent || 'var(--accent)'}, ${accent || 'var(--accent-hi)'})` }"
      />
    </div>
  </div>
</template>

<style scoped>
.kpi {
  padding: 14px 16px 16px;
  min-width: 0;
  overflow: hidden;
  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.25s;
}

.kpi:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg), var(--inner-light);
}

/* 卡片右上角的色晕，强化"玻璃后有光"的感觉 */
.kpi::after {
  content: '';
  position: absolute;
  top: -46px;
  right: -34px;
  width: 108px;
  height: 108px;
  border-radius: 50%;
  background: radial-gradient(circle, currentColor 0%, transparent 68%);
  opacity: 0.16;
  pointer-events: none;
  z-index: 0;
}

.kpi-top {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.kpi-label {
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.3px;
}

.kpi-orb {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  opacity: 0.85;
  box-shadow: 0 0 8px 0 currentColor;
}

.kpi-value {
  font-size: 23px;
  font-weight: 600;
  margin: 7px 0 3px;
  line-height: 1.12;
  letter-spacing: -0.4px;
  position: relative;
  z-index: 1;
}

.kpi-sub {
  font-size: 11px;
  color: var(--text-3);
  position: relative;
  z-index: 1;
}
</style>
