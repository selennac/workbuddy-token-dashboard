/**
 * 耗时维度：从时间线上把"官方没给"的时间信息还原出来。
 *
 * 本地 JSONL **没有任何耗时字段**（全字段枚举验证过）。能算出来的只有第二种东西：
 * 相邻事件的 timestamp 差。三个关键结论都来自真实数据实测：
 *
 * 1. 一次请求 = 一个 providerData.messageId，且**恰好只有一行**带 rawUsage
 *    （1167 个分组里 1167 次命中）。这一行的 timestamp 就是该次请求的完成时刻。
 * 2. 请求的起点 ≈ 上一个"边界事件"（用户消息 / 上一条工具返回）的时间戳。
 *    两者相减 = 端到端耗时，里面混着首字延迟、排队、agent 循环开销。
 * 3. 工具耗时可以直接配对：function_call.callId ↔ function_call_result.callId，
 *    只差 1 条配不上（被中断的会话）。这一个 100% 可靠，不做任何假设。
 *
 * 直接拿"输出 token ÷ 耗时"当吐字速度是错的 —— 短请求会被固定开销拖垮。
 * 实测分桶：deepseek-v4.1-flash 输出 0~200 token 只有 29 t/s，
 * 输出 20000+ 却有 226 t/s。真相是耗时 ≈ 固定开销 + 输出/吐字速度，
 * 所以**用最小二乘拟合的斜率当吐字速度、截距当每请求固定开销**：
 * 实测 deepseek-v4.1-flash 斜率 = 250 t/s、截距 = 3.41s、R² = 0.96（n=1154）。
 *
 * 于是每条请求的"净出字时长" = 实测耗时 − 该模型的固定开销，
 * 这样短请求也能算出量级正确的瞬时速度。
 */

/**
 * 超过这个间隔视为"人离开了电脑"，不计入在岗时长的任何阶段。
 *
 * 30 分钟不是拍出来的：实测 97 个人机间隔，长度从 1.1min **连续**铺到 23.8min，
 * 唯一一个真实断层在 23.8min → 51.8min（×2.18），30 分钟正好落在断口里。
 *
 * ⚠ 所以**没有**再加"90 秒 / 10 分钟"那种中间档 —— 数据里不存在第二个断点，
 * 硬切只会把"读一段长回复"误判成"离开"。人机间隔分档到这个精度就是极限了，
 * 再细就只能靠输入事件，而 JSONL 里没有。
 *
 * 实测参考：模型段最长 11.8min、工具段最长 5.1min，都远够不到这个阈值，
 * 所以它实际上只作用于「人的环节」那一段。
 */
const AWAY_MS = 30 * 60 * 1000;
/** 工具耗时的上限，超过只可能是解析异常（实测最长 5.1min，留足余量） */
const MAX_TOOL_MS = 30 * 60 * 1000;
/**
 * 「人的环节」里超过这个长度的间隔，单独报一个数出来。
 * 是"读长文档 / 去开会 / 真的走开了"，日志里区分不出来 ——
 * 如实交代，而不是替用户假设一个档位把它切掉。
 */
const LONG_HUMAN_MS = 5 * 60 * 1000;
/** 净出字时长太短时算出来的速度是噪声（分母趋零），直接判为不可用 */
const MIN_NET_MS = 300;
/** 样本少于这个数就不拟合了（5 个点已经能定一条线，但别更少） */
const MIN_FIT_N = 5;
/** 判定"可信"的样本量与拟合优度门槛。达不到仍然出数，但会打上 reliable:false */
const RELIABLE_N = 30;
const RELIABLE_R2 = 0.6;
/** 兜底固定开销：取不到模型画像时用它，避免整块功能哑掉 */
const FALLBACK_OVERHEAD_MS = 3000;

/**
 * 走一遍每个会话的时间线，产出四样东西：
 *   reqDur    messageId → { startTs, durMs }   每次请求的端到端耗时
 *   toolCalls 每个工具调用的实测耗时（callId 配对）
 *   phases    每个会话的时间去向（模型生成 / 工具执行 / 人的环节 / 离开）
 *   intervals 每个会话的区间明细，喂给 mergePhases 做并集（见那边的注释）
 *
 * 阶段划分是**互不重叠**的：并行工具调用会先来 fc#1、fc#2 再来 fcr#1、fcr#2，
 * 逐段累加正好等于 fcr#2 − fc#1，不会因为工具并行而重复计时。
 */
export function deriveTimings(timelines) {
  const reqDur = new Map();
  const toolCalls = [];
  const phases = new Map();
  /** @type {Map<string, {from:number,to:number,segs:Array<{s:number,e:number,type:string}>}>} */
  const intervals = new Map();

  for (const tl of timelines) {
    const ev = tl.events || [];
    /** callId → 调用事件，等对应的 result 来配对 */
    const open = new Map();
    let prevSig = null;
    let modelMs = 0;
    let toolMs = 0;
    let humanMs = 0;
    let awayMs = 0;
    let longHumanMs = 0;
    let longHumanCount = 0;
    const segs = [];

    const first = ev.length ? ev[0].t : null;
    const last = ev.length ? ev[ev.length - 1].t : null;

    for (const e of ev) {
      if (e.ty === 'fc' && e.cid) open.set(e.cid, e);

      if (e.ty === 'fcr' && e.cid) {
        const c = open.get(e.cid);
        if (c) {
          open.delete(e.cid);
          const ms = e.t - c.t;
          if (ms >= 0 && ms <= MAX_TOOL_MS) {
            toolCalls.push({
              callId: e.cid,
              sessionId: tl.sessionId,
              projectId: tl.projectId,
              ts: c.t,
              name: e.nm || c.nm || 'unknown',
              ms,
              requestId: c.mid || '',
            });
          }
        }
      }

      // 显著事件：请求完成点 / 工具返回 / 用户发消息
      const sig = e.u === 1 || e.ty === 'fcr' || (e.ty === 'msg' && e.role === 'user');
      if (!sig) continue;

      if (prevSig) {
        const gap = Math.max(0, e.t - prevSig.t);
        // 这一段是谁在花时间：请求完成点 = 模型生成，工具返回 = 工具执行，其余 = 人
        const type = e.u === 1 ? 'model' : e.ty === 'fcr' ? 'tool' : 'human';

        if (gap > AWAY_MS) {
          awayMs += gap;
          segs.push({ s: prevSig.t, e: e.t, type: 'away' });
        } else {
          if (type === 'model') {
            modelMs += gap;
            if (e.mid) reqDur.set(e.mid, { startTs: prevSig.t, durMs: gap });
          } else if (type === 'tool') {
            toolMs += gap;
          } else {
            humanMs += gap;
            if (gap > LONG_HUMAN_MS) {
              longHumanMs += gap;
              longHumanCount += 1;
              // 同一个区间打两个标签：longHuman 是 human 的子集，
              // 合并时按同一分母均分，所以它天然不会超过人的环节总时长
              segs.push({ s: prevSig.t, e: e.t, type: 'longHuman' });
            }
          }
          segs.push({ s: prevSig.t, e: e.t, type });
        }
      }
      prevSig = e;
    }

    const spanMs = first != null && last != null ? Math.max(0, last - first) : 0;
    phases.set(tl.sessionId, {
      sessionId: tl.sessionId,
      projectId: tl.projectId,
      spanMs,
      modelMs,
      toolMs,
      humanMs,
      awayMs,
      longHumanMs,
      longHumanCount,
      /** 在岗时长 = 全程 − 离开（离开时段会把其它三段压成看不见的细线） */
      activeMs: modelMs + toolMs + humanMs,
    });

    if (segs.length) {
      intervals.set(tl.sessionId, { from: first ?? 0, to: last ?? 0, segs });
    }
  }

  return { reqDur, toolCalls, phases, intervals };
}

/**
 * 对一组 (输出 token, 耗时) 样本做最小二乘拟合。
 * 斜率倒数 = 吐字速度（token/秒），截距 = 每请求固定开销。
 * @param {Array<{x:number, y:number}>} samples x=输出token y=耗时ms
 */
export function fitSpeed(samples) {
  const n = samples.length;
  if (n < MIN_FIT_N) return null;

  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const s of samples) {
    sx += s.x;
    sy += s.y;
    sxy += s.x * s.y;
    sxx += s.x * s.x;
  }

  const den = n * sxx - sx * sx;
  if (den <= 0) return null; // 所有样本输出量相同，拟合不出斜率

  const slope = (n * sxy - sx * sy) / den;
  if (!(slope > 0)) return null;

  const intercept = (sy - slope * sx) / n;

  // R²：拟合得好不好，决定这个速度值能不能拿出来说
  const my = sy / n;
  let ss = 0;
  let sr = 0;
  for (const s of samples) {
    const p = slope * s.x + intercept;
    ss += (s.y - my) ** 2;
    sr += (s.y - p) ** 2;
  }
  const r2 = ss > 0 ? 1 - sr / ss : 0;
  const overheadMs = Math.max(0, intercept);

  return {
    n,
    speed: 1000 / slope,
    overheadMs,
    r2,
    reliable: n >= RELIABLE_N && r2 >= RELIABLE_R2 && overheadMs <= 120_000,
  };
}

/**
 * 按模型建立速度画像。
 * 用**全量记录**而不是当前筛选结果：筛选到单个会话时样本会掉到几条，
 * 拟合出来的斜率会乱跳；速度是模型的固有属性，不该随筛选条件变。
 *
 * @param {Array} records 全部用量记录（必须已带 completion 与 durMs）
 */
export function buildSpeedProfiles(records) {
  const byModel = new Map();
  for (const r of records) {
    if (!r.durMs || r.completion <= 0) continue;
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push({ x: r.completion, y: r.durMs });
  }

  const profiles = new Map();
  for (const [model, samples] of byModel) {
    const fit = fitSpeed(samples);
    profiles.set(model, {
      model,
      samples: samples.length,
      speed: fit ? round(fit.speed, 1) : null,
      overheadMs: fit ? Math.round(fit.overheadMs) : null,
      r2: fit ? round(fit.r2, 4) : null,
      reliable: fit ? fit.reliable : false,
    });
  }

  // 兜底开销取可信画像的中位数，取不到就用常量
  const ok = [...profiles.values()].filter((p) => p.reliable).map((p) => p.overheadMs);
  const defaultOverheadMs = ok.length ? median(ok) : FALLBACK_OVERHEAD_MS;

  return { profiles, defaultOverheadMs };
}

/**
 * 给每条请求补上净出字时长与瞬时吐字速度。
 * 直接改传入的 record（同一批对象，调用方不必再回填）。
 */
export function attachSpeeds(records, profiles, defaultOverheadMs) {
  for (const r of records) {
    const p = profiles.get(r.model);
    const overheadMs = p && p.reliable ? p.overheadMs : defaultOverheadMs;
    r.overheadMs = overheadMs;
    r.netMs = null;
    r.tps = null;
    if (!r.durMs || r.completion <= 0) continue;
    const net = r.durMs - overheadMs;
    if (net < MIN_NET_MS) continue; // 比固定开销还快，算出来只能是噪声
    r.netMs = net;
    r.tps = round(r.completion / (net / 1000), 1);
  }
}

/**
 * 一组记录的加权平均吐字速度。
 * 用 Σ输出 / Σ净时长 而不是"每条速度求平均"——短请求的速度噪声大，
 * 逐条平均会让噪声主导结果。
 */
export function summarizeSpeed(records) {
  let completion = 0;
  let netMs = 0;
  let samples = 0;
  for (const r of records) {
    if (r.netMs == null) continue;
    completion += r.completion;
    netMs += r.netMs;
    samples += 1;
  }
  return {
    samples,
    netMs,
    speed: netMs > 0 ? round(completion / (netMs / 1000), 1) : null,
  };
}

/**
 * 把多个会话的时间去向合成**墙钟口径**。
 *
 * 为什么不能直接相加：并行开两个会话时，同一段时间会被算两次。
 * 实测 15 个会话相加 107.5h，而真实墙钟（并集）只有 100.4h —— **虚高 7%**，
 * 并行用得越多错得越离谱。
 *
 * 做法是扫描线：把时间轴切成"活跃集合不变"的小段，每段按该段的活跃会话数
 * 均分给各自的类型。这样 Σ(模型 + 工具 + 人的环节) 恒等于并集长度，
 * 「在岗时长」和它上面三段占比才是自洽的（否则占比之和会超过 100%）。
 *
 * 离开（>30 分钟的间隔）只在**没有任何会话在工作**时才计入 —— 否则一个人
 * 去开会，会把另一个还在跑的会话的真实在岗时间也涂成"离开"。
 *
 * @param {Array<{from:number,to:number,segs:Array<{s:number,e:number,type:string}>}>} items 每个会话一条
 * @param {{from?:number,to?:number,granularity?:string|null}} opts 裁剪区间与分桶粒度
 */
export function mergePhases(items, opts = {}) {
  const { from = -Infinity, to = Infinity, granularity = null } = opts;

  // 全程跨度：各会话 [起,止] 的并集（同样不能相加）
  const spanMs = unionLength(
    items.map((it) => [it.from, it.to]),
    from,
    to,
  );

  const segs = [];
  let longHumanCount = 0;
  for (const it of items) {
    for (const g of it.segs) {
      const s = Math.max(g.s, from);
      const e = Math.min(g.e, to);
      if (e <= s) continue; // 裁掉的部分不计时也不计数，口径才和 longHumanMs 对得上
      segs.push({ s, e, type: g.type });
      if (g.type === 'longHuman') longHumanCount += 1;
    }
  }

  const t = sweepTotals(segs);
  /* ⚠ 在岗时长必须**由三段相加得出**，不能各自取整后再加：
     三个 Math.round 的误差会让"三段之和 ≠ 在岗时长"，占比就会差一丝，
     堆叠条撑不满 100%（这个不变量有 e2e 断言盯着）。 */
  const modelMs = Math.round(t.modelMs);
  const toolMs = Math.round(t.toolMs);
  const humanMs = Math.round(t.humanMs);
  return {
    spanMs: Math.round(spanMs),
    modelMs,
    toolMs,
    humanMs,
    activeMs: modelMs + toolMs + humanMs,
    longHumanMs: Math.round(t.longHumanMs),
    longHumanCount,
    awayMs: Math.round(t.awayMs),
    sessions: items.length,
    /** 按粒度的趋势。没有它，「时间去向」只有一个总数 —— 看不出变好还是变坏 */
    buckets: granularity ? bucketize(segs, granularity, sweepTotals) : [],
  };
}

/**
 * 扫描线：返回各类型在**并集**口径下的时长。
 * 同一时刻有 k 个会话活跃时，这一段按活跃类型数均分，避免重复计时。
 */
function sweepTotals(segs) {
  const out = { modelMs: 0, toolMs: 0, humanMs: 0, longHumanMs: 0, awayMs: 0, activeMs: 0 };
  if (!segs.length) return out;

  const events = [];
  for (const g of segs) {
    events.push([g.s, 1, g.type]);
    events.push([g.e, -1, g.type]);
  }
  // 同一时刻先收（-1）后放（+1），零长度的首尾相接区间就不会被算进去
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const cnt = { model: 0, tool: 0, human: 0, longHuman: 0, away: 0 };
  let prev = null;
  let i = 0;
  while (i < events.length) {
    const t = events[i][0];
    if (prev !== null && t > prev) {
      const dt = t - prev;
      // longHuman 是 human 的子集，不额外占份额，只按同一分母分到它自己那份
      const k = cnt.model + cnt.tool + cnt.human;
      if (k > 0) {
        out.activeMs += dt;
        out.modelMs += (dt * cnt.model) / k;
        out.toolMs += (dt * cnt.tool) / k;
        out.humanMs += (dt * cnt.human) / k;
        out.longHumanMs += (dt * cnt.longHuman) / k;
      } else if (cnt.away > 0) {
        out.awayMs += dt;
      }
    }
    while (i < events.length && events[i][0] === t) {
      cnt[events[i][2]] += events[i][1];
      i++;
    }
    prev = t;
  }
  return out;
}

/** 一组 [起,止] 的并集长度（截到 [from,to]） */
function unionLength(ranges, from, to) {
  const list = [];
  for (const [a, b] of ranges) {
    const s = Math.max(a, from);
    const e = Math.min(b, to);
    if (e > s) list.push([s, e]);
  }
  if (!list.length) return 0;
  list.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cs = list[0][0];
  let ce = list[0][1];
  for (let i = 1; i < list.length; i++) {
    if (list[i][0] <= ce) {
      ce = Math.max(ce, list[i][1]);
    } else {
      total += ce - cs;
      cs = list[i][0];
      ce = list[i][1];
    }
  }
  return total + (ce - cs);
}

/**
 * 按粒度把区间切开、逐桶做扫描线。
 * 先切后算：一段区间可能横跨零点，不切就会整段算进前一天。
 */
function bucketize(segs, granularity, sweep) {
  const map = new Map();
  for (const g of segs) {
    let t = g.s;
    let guard = 0;
    // guard 防的是 bucketEnd 返回不比 t 大的异常值导致死循环
    while (t < g.e && guard++ < 100_000) {
      const end = Math.min(g.e, bucketEnd(t, granularity));
      if (end <= t) break;
      const key = bucketKey(t, granularity);
      let b = map.get(key);
      if (!b) {
        b = { key, ts: bucketStart(t, granularity), segs: [] };
        map.set(key, b);
      }
      b.segs.push({ s: t, e: end, type: g.type });
      t = end;
    }
  }
  return [...map.values()]
    .map((b) => {
      const r = sweep(b.segs);
      // 同 mergePhases：在岗由三段相加得出，保证每个桶里三段也撑满 100%
      const modelMs = Math.round(r.modelMs);
      const toolMs = Math.round(r.toolMs);
      const humanMs = Math.round(r.humanMs);
      return {
        key: b.key,
        ts: b.ts,
        modelMs,
        toolMs,
        humanMs,
        activeMs: modelMs + toolMs + humanMs,
        awayMs: Math.round(r.awayMs),
      };
    })
    .sort((a, b) => a.ts - b.ts);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 分桶键（本地时区）。与 store.js 的记录分桶共用同一套口径 */
export function bucketKey(ts, granularity) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  if (granularity === 'hour') return `${y}-${m}-${day} ${pad2(d.getHours())}:00`;
  if (granularity === 'month') return `${y}-${m}`;
  return `${y}-${m}-${day}`;
}

/** 分桶起点 */
export function bucketStart(ts, granularity) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  if (granularity === 'day') d.setHours(0);
  if (granularity === 'month') d.setDate(1);
  return d.getTime();
}

/** 分桶终点（下一个桶的起点）。用 setHours/setDate 走本地时区，跨夏令时也不会偏 */
function bucketEnd(ts, granularity) {
  const d = new Date(bucketStart(ts, granularity));
  if (granularity === 'hour') d.setHours(d.getHours() + 1);
  else if (granularity === 'month') d.setMonth(d.getMonth() + 1);
  else d.setDate(d.getDate() + 1);
  return d.getTime();
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function round(n, p = 2) {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}
