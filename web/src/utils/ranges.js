/**
 * 时间区间的相对档位定义。
 *
 * 放在 utils 里而不是 FilterBar 内部：'记住上次筛选'要按**同一个档位**重算区间
 * （存的是"近 7 天"，还原时得按今天重新算），两边各写一套迟早会对不上。
 */

/** 取 n 天前的本地零点。用 setDate 而不是"减 n × 86400000 毫秒"——
 *  后者在夏令时切换日会偏一小时，跨时区跑也会出怪值。 */
export function daysAgo(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

export function toDayStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 起止留空的含义：起点空 = 不限，终点空 = 到今天。
 *  按钮按时间先后从左到右排列：昨天 → 今天 → 近 7 天 → 近 30 天 → 全部。 */
export const RANGES = [
  // 昨天是**闭区间**，两端都要给："不限 → 昨天"会把今天之前的全部数据都算进来
  { label: '昨天', range: () => ({ from: toDayStr(daysAgo(1)), to: toDayStr(daysAgo(1)) }) },
  { label: '今天', range: () => ({ from: toDayStr(daysAgo(0)), to: '' }) },
  { label: '近 7 天', range: () => ({ from: toDayStr(daysAgo(7)), to: '' }) },
  { label: '近 30 天', range: () => ({ from: toDayStr(daysAgo(30)), to: '' }) },
  { label: '全部', range: () => ({ from: '', to: '' }) },
];

/** 相对档位：日期永远相对于"今天"，所以**绝不能**把算出来的绝对日期冻结下来存盘 */
export const RELATIVE_PRESETS = RANGES.map((r) => r.label);

/** 手动改日期对应的档位名（不在这份列表里，属于绝对区间） */
export const CUSTOM_PRESET = 'custom';

export function rangeOfPreset(label) {
  const r = RANGES.find((x) => x.label === label);
  return r ? r.range() : { from: '', to: '' };
}
