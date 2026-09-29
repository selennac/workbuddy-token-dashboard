import { onBeforeUnmount, ref, watch, nextTick } from 'vue';

/**
 * 自绘弹层（下拉 / 日历）的公共逻辑：
 *   - 点击外部关闭（用捕获阶段监听，避免被子元素的 stopPropagation 挡住）
 *   - Esc 关闭并把焦点还给触发器
 *   - 用 fixed 定位锚在触发器下方，空间不够时自动翻到上方
 *   - 滚动 / 缩放时跟随重新定位
 *
 * 之所以要自绘而不用原生 <select> / <input type="date">：
 * 原生控件的下拉列表与日历面板由浏览器绘制，CSS 完全无法触及，
 * 放在玻璃主题里就是一块突兀的系统灰，没法统一。
 *
 * @param {{align?: 'left'|'right'}} options 弹层对齐方式
 */
export function usePopup({ align = 'left' } = {}) {
  const triggerRef = ref(null);
  const panelRef = ref(null);
  const isOpen = ref(false);
  const pos = ref({ top: 0, left: 0, minWidth: 0, placement: 'bottom' });

  function updatePosition() {
    const el = triggerRef.value;
    if (!el) return;

    const r = el.getBoundingClientRect();
    const gap = 8;
    // 先量一次真实高度，量不到就按经验值估算
    const panelH = panelRef.value?.offsetHeight || 300;
    const spaceBelow = window.innerHeight - r.bottom - gap;
    const spaceAbove = r.top - gap;
    const flip = spaceBelow < Math.min(panelH, 260) && spaceAbove > spaceBelow;

    const next = {
      minWidth: r.width,
      maxWidth: Math.max(r.width, 320),
      placement: flip ? 'top' : 'bottom',
    };
    if (align === 'right') next.right = Math.max(8, window.innerWidth - r.right);
    else next.left = r.left;

    if (flip) next.bottom = window.innerHeight - r.top + gap;
    else next.top = r.bottom + gap;

    pos.value = next;
  }

  function open() {
    if (isOpen.value) return;
    isOpen.value = true;
    // 面板渲染出来后才能量到真实高度，于是定位两次
    nextTick(() => {
      updatePosition();
      nextTick(updatePosition);
    });
  }

  function close() {
    isOpen.value = false;
  }

  function toggle() {
    if (isOpen.value) close();
    else open();
  }

  function onDocPointerDown(e) {
    const t = e.target;
    if (triggerRef.value?.contains(t)) return;
    if (panelRef.value?.contains(t)) return;
    close();
  }

  function onDocKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      triggerRef.value?.focus?.();
    }
  }

  watch(isOpen, (open) => {
    if (open) {
      document.addEventListener('pointerdown', onDocPointerDown, true);
      document.addEventListener('keydown', onDocKeydown, true);
      window.addEventListener('scroll', updatePosition, true);
      window.addEventListener('resize', updatePosition);
    } else {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeydown, true);
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    }
  });

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('keydown', onDocKeydown, true);
    window.removeEventListener('scroll', updatePosition, true);
    window.removeEventListener('resize', updatePosition);
  });

  return { triggerRef, panelRef, isOpen, pos, open, close, toggle, updatePosition };
}
