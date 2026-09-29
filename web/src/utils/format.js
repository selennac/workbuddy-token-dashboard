/** 数字/时间格式化 */

export function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return '-';
  return Math.round(n).toLocaleString('en-US');
}

/** 大数压缩：1.2M / 45.6K */
export function fmtCompact(n) {
  if (n == null || Number.isNaN(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + 'K';
  return String(Math.round(n));
}

export function fmtCredit(n) {
  if (n == null || Number.isNaN(n)) return '-';
  if (n === 0) return '0';
  if (Math.abs(n) < 0.01) return n.toFixed(4);
  if (Math.abs(n) < 1) return n.toFixed(3);
  if (Math.abs(n) < 100) return n.toFixed(2);
  return fmtNum(n);
}

export function fmtPct(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '-';
  const x = Math.abs(v) <= 1 ? v * 100 : v;
  return x.toFixed(digits) + '%';
}

export function fmtTime(ts, withDate = true) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  if (!withDate) return t;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}`;
}

export function fmtDate(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 时长：2h 13m */
export function fmtDuration(ms) {
  if (!ms || ms < 0) return '-';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1分';
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return `${h}小时${r ? r + '分' : ''}`;
  return `${Math.floor(h / 24)}天${h % 24 ? (h % 24) + '小时' : ''}`;
}

/**
 * 毫秒级的时长（耗时列用）。
 * 和 fmtDuration 的区别：那个只给分钟精度，用来看"这次请求花了多久"会把
 * 3.4 秒和 8 秒显示成同一个值，等于没显示。
 */
export function fmtSec(ms) {
  if (ms == null || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m}分${rs}s`;
  const h = Math.floor(m / 60);
  return `${h}小时${m % 60}分`;
}

/** 吐字速度：整数位给足，小数值保留一位，避免 250.0 / 31.5 显示成同一个样子 */
export function fmtSpeed(tps) {
  if (tps == null || Number.isNaN(tps)) return '-';
  if (tps >= 100) return String(Math.round(tps));
  if (tps >= 10) return tps.toFixed(1);
  return tps.toFixed(2);
}

/** 占比：0.4618 → 46% */
export function fmtShare(v) {
  if (v == null || Number.isNaN(v)) return '-';
  return Math.round(v * 100) + '%';
}

/**
 * 模型分类配色。
 * 原来是 Tailwind 默认色板的原样搬运（indigo/sky/teal/amber/pink/violet/lime/red），
 * 那是一眼就能认出的"默认值感"。这套换成同一明度带上的低饱和色：
 * 每个色相的彩度接近、明度接近，靠色相区分而不是靠谁更亮，
 * 放在一起像一套仪表配色，而不是随机抽签。
 * 第 1 位固定是主色，方便和界面主色呼应。
 */
export const MODEL_COLORS = [
  '#27618c', // 深蔚蓝（主色）
  '#2c7a83', // 青
  '#b8863a', // 赭黄
  '#8f6a9e', // 梅紫
  '#5b7fa6', // 灰蓝
  '#7d9455', // 橄榄
  '#a86a4e', // 陶土
  '#4d6b7a', // 石板青
];

export function colorOf(index) {
  return MODEL_COLORS[index % MODEL_COLORS.length];
}

/** 把日期字符串转成毫秒，支持 YYYY-MM-DD */
export function dayStart(str) {
  if (!str) return null;
  const d = new Date(str + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function dayEnd(str) {
  if (!str) return null;
  const d = new Date(str + 'T23:59:59');
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function isoDay(ts) {
  return fmtDate(ts);
}

/** 取路径末段作为项目短名（兼容 \ 与 /，去掉结尾斜杠） */
export function baseName(p) {
  if (!p) return '';
  const parts = String(p).replace(/[/\\]+$/, '').split(/[/\\]/);
  return parts[parts.length - 1] || '';
}
