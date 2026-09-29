<script setup>
/**
 * 自绘下拉选择器。
 * 原生 <select> 的展开列表由浏览器绘制，CSS 无法触及，
 * 所以这里用 Teleport + fixed 定位自己实现，才能和玻璃主题统一。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { usePopup } from '../../composables/usePopup.js';

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  /** [{ value, label, hint? }] */
  options: { type: Array, default: () => [] },
  /** 触发按钮左侧的小标题，如"项目" */
  label: { type: String, default: '' },
  /** 选中值对应的展示文案；给空值时用它 */
  placeholder: { type: String, default: '请选择' },
  align: { type: String, default: 'left' },
  width: { type: String, default: '' },
});

const emit = defineEmits(['update:modelValue', 'change']);

const { triggerRef, panelRef, isOpen, pos, open, close, toggle, updatePosition } = usePopup({
  align: props.align,
});

const hl = ref(-1);

const currentIndex = computed(() => props.options.findIndex((o) => o.value === props.modelValue));
const current = computed(() => props.options[currentIndex.value] || null);

watch(isOpen, (v) => {
  if (v) {
    hl.value = currentIndex.value >= 0 ? currentIndex.value : 0;
    nextTick(() => {
      // 把高亮项滚进可视区
      const el = panelRef.value?.querySelector('.opt.hl');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }
});

function pick(opt) {
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  close();
  triggerRef.value?.focus?.();
}

function onKeydown(e) {
  if (!isOpen.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open();
    }
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    hl.value = Math.min(props.options.length - 1, hl.value + 1);
    nextTick(() => panelRef.value?.querySelector('.opt.hl')?.scrollIntoView({ block: 'nearest' }));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    hl.value = Math.max(0, hl.value - 1);
    nextTick(() => panelRef.value?.querySelector('.opt.hl')?.scrollIntoView({ block: 'nearest' }));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const opt = props.options[hl.value];
    if (opt) pick(opt);
  } else if (e.key === 'Home') {
    hl.value = 0;
  } else if (e.key === 'End') {
    hl.value = props.options.length - 1;
  }
}

defineExpose({ updatePosition });
</script>

<template>
  <div
    ref="triggerRef"
    class="field sel"
    :class="{ 'is-open': isOpen }"
    :style="width ? { width } : null"
    role="combobox"
    tabindex="0"
    :aria-expanded="isOpen"
    @click="toggle"
    @keydown="onKeydown"
  >
    <span v-if="label" class="sel-label">{{ label }}</span>
    <span class="sel-value" :class="{ ph: !current }">
      {{ current ? current.label : placeholder }}
    </span>
    <svg class="sel-chev" :class="{ up: isOpen }" viewBox="0 0 12 12" width="10" height="10">
      <path d="M2.5 4.5 L6 8 L9.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </div>

  <Teleport to="body">
    <div
      v-if="isOpen"
      ref="panelRef"
      class="pop"
      :class="{ 'from-top': pos.placement === 'top' }"
      :style="{
        top: pos.top != null ? pos.top + 'px' : undefined,
        bottom: pos.bottom != null ? pos.bottom + 'px' : undefined,
        left: pos.left != null ? pos.left + 'px' : undefined,
        right: pos.right != null ? pos.right + 'px' : undefined,
        minWidth: pos.minWidth + 'px',
      }"
    >
      <div class="pop-scroll">
        <div
          v-for="(o, i) in options"
          :key="o.value"
          class="opt"
          :class="{ on: o.value === modelValue, hl: i === hl }"
          @mouseenter="hl = i"
          @click="pick(o)"
        >
          <span v-if="o.dot" class="dot" :style="{ background: o.dot }" />
          <span>{{ o.label }}</span>
          <span v-if="o.hint" class="opt-hint">{{ o.hint }}</span>
          <span class="opt-check">✓</span>
        </div>
        <div v-if="!options.length" class="opt" style="color: var(--text-3); cursor: default">无可选项</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sel {
  gap: 6px;
}

.sel-label {
  font-size: 10px;
  color: var(--text-3);
  letter-spacing: 0.3px;
}

.sel-value {
  font-size: 12px;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sel-value.ph {
  color: var(--text-3);
}

.sel-chev {
  color: var(--text-3);
  transition: transform 0.2s;
  flex: none;
}

.sel-chev.up {
  transform: rotate(180deg);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);
}
</style>
