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

/** 超过这个间隔视为"人离开了电脑"，不计入在岗时长的任何阶段 */
const AWAY_MS = 30 * 60 * 1000;
/** 工具耗时的上限，超过只可能是解析异常 */
const MAX_TOOL_MS = 30 * 60 * 1000;
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
 * 走一遍每个会话的时间线，产出三样东西：
 *   reqDur    messageId → { startTs, durMs }   每次请求的端到端耗时
 *   toolCalls 每个工具调用的实测耗时（callId 配对）
 *   phases    每个会话的时间去向（模型生成 / 工具执行 / 等待用户 / 离开）
 *
 * 阶段划分是**互不重叠**的：并行工具调用会先来 fc#1、fc#2 再来 fcr#1、fcr#2，
 * 逐段累加正好等于 fcr#2 − fc#1，不会因为工具并行而重复计时。
 */
export function deriveTimings(timelines) {
  const reqDur = new Map();
  const toolCalls = [];
  const phases = new Map();

  for (const tl of timelines) {
    const ev = tl.events || [];
    /** callId → 调用事件，等对应的 result 来配对 */
    const open = new Map();
    let prevSig = null;
    let modelMs = 0;
    let toolMs = 0;
    let waitMs = 0;
    let awayMs = 0;

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
        if (gap > AWAY_MS) {
          awayMs += gap;
        } else if (e.u === 1) {
          modelMs += gap;
          if (e.mid) reqDur.set(e.mid, { startTs: prevSig.t, durMs: gap });
        } else if (e.ty === 'fcr') {
          toolMs += gap;
        } else {
          waitMs += gap;
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
      waitMs,
      awayMs,
      /** 在岗时长 = 全程 − 离开（离开时段会把其它三段压成看不见的细线） */
      activeMs: modelMs + toolMs + waitMs,
    });
  }

  return { reqDur, toolCalls, phases };
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

/** 把若干会话的时间去向累加成一份（总览用） */
export function mergePhases(phaseList) {
  const acc = { spanMs: 0, modelMs: 0, toolMs: 0, waitMs: 0, awayMs: 0, activeMs: 0, sessions: 0 };
  for (const p of phaseList) {
    if (!p) continue;
    acc.spanMs += p.spanMs;
    acc.modelMs += p.modelMs;
    acc.toolMs += p.toolMs;
    acc.waitMs += p.waitMs;
    acc.awayMs += p.awayMs;
    acc.activeMs += p.activeMs;
    acc.sessions += 1;
  }
  return acc;
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
