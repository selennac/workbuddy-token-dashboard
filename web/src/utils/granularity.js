/**
 * 趋势粒度：从区间跨度反推「哪些粒度是有意义的」。
 *
 * 规则不是拍脑袋定的，是按**分桶数量**定的——粒度必须让趋势图落在
 * "能看趋势、又不糊成一片"的区间里：
 *
 *   - 小时：跨度 ≤ 5 天（最多 120 根柱子，约 11px 一根，还看得清；
 *           7 天按小时就是 168 根，会挤成一条线——看某一天的细粒度本来就该
 *           把区间收到那一天）
 *   - 天：  1 天 < 跨度 ≤ 90 天（1 天以内的区间按天只有 1 根柱，没有趋势可言）
 *   - 月：  跨度 ≥ 45 天（不足两个月时按月只有 1~2 根柱，等于没分桶）
 *
 * 举例：
 *   今天（跨度 ~0.7 天）  → 只能按小时
 *   近 7 天               → 只能按天
 *   近 30 天              → 只能按天
 *   自定义 3 天           → 小时 / 天
 *   自定义 半年           → 天 / 月
 *
 * ⚠ 前后端共用同一套口径：粒度的合法值由前端算（它知道区间），
 * 服务端只负责分桶。改这里的阈值等于改 UI 上能点什么，别只改一边。
 */

/** 由细到粗，用于挑"最贴近"的粒度时的优先级 */
export const GRANULARITY_ORDER = ['hour', 'day', 'month'];

export const GRANULARITY_LABEL = { hour: '小时', day: '天', month: '月' };

/** 各粒度折算成"天"，用于估算分桶数 */
const DAYS_PER = { hour: 1 / 24, day: 1, month: 30.44 };

/** 理想的分桶数：20 来根柱子读趋势最舒服 */
const IDEAL_BUCKETS = 24;

/**
 * 区间跨度（天）。
 * @param {{from?:string,to?:string}} filter 日期是 'YYYY-MM-DD'
 * @param {{minTs?:number}} meta 数据自身的最早时间戳（"全部"区间靠它兜底）
 * @returns {number} NaN 表示还不知道（没数据），此时不限制粒度
 */
export function spanDaysOf(filter = {}, meta = {}) {
  const DAY = 86400_000;
  const from = filter.from ? new Date(`${filter.from}T00:00:00`).getTime() : null;
  // 终点缺省 = 今天；用 23:59:59 而不是 now，免得"今天"因为当前是几点而在 0.3~1 天之间跳
  const to = filter.to ? new Date(`${filter.to}T23:59:59.999`).getTime() : Date.now();
  if (from == null) {
    // 未指定起点 = 全部：只能用数据自身的范围，否则无法判断"能细到哪一档"
    const min = Number(meta.minTs);
    if (!Number.isFinite(min)) return NaN;
    return Math.max(0, (to - min) / DAY);
  }
  return Math.max(0, (to - from) / DAY);
}

/** 给定跨度，返回可用粒度（由细到粗） */
export function allowedGranularities(spanDays) {
  if (!Number.isFinite(spanDays)) return [...GRANULARITY_ORDER]; // 数据还没到 → 不限制
  const out = [];
  if (spanDays <= 5) out.push('hour');
  if (spanDays > 1 && spanDays <= 90) out.push('day');
  if (spanDays >= 45) out.push('month');
  // 兜底：跨度为 0（数据都在同一瞬间）时至少给一档，避免控件全灰
  return out.length ? out : ['day'];
}

/**
 * 当前粒度不可用时挑一个最贴近的：按分桶数与理想值的**对数距离**比较，
 * 避免"越粗越赢"（线性距离下 1 个月永远比 200 天更接近 24）。
 */
export function pickGranularity(spanDays, current) {
  const list = allowedGranularities(spanDays);
  if (list.includes(current)) return current;
  let best = list[0];
  let bestD = Infinity;
  for (const g of list) {
    const buckets = spanDays / DAYS_PER[g];
    const d = Math.abs(Math.log(Math.max(buckets, 1e-6) / IDEAL_BUCKETS));
    if (d < bestD) {
      bestD = d;
      best = g;
    }
  }
  return best;
}
