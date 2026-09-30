/**
 * 内存存储 + 查询层。
 * 数据量级（几千~几十万条）完全放得下内存；
 * 如果要长期留存 + 复杂查询，把 upsert 换到 SQLite 即可，上层 API 不变。
 */
import {
  deriveTimings,
  buildSpeedProfiles,
  attachSpeeds,
  summarizeSpeed,
  bucketKey,
  bucketStart,
} from './timing.js';

export class Store {
  constructor(scanner) {
    this.scanner = scanner;
    /** @type {Map<string, any>} 以 messageId 为键天然去重 */
    this.byId = new Map();
    /** @type {Map<string, any>} sessionId -> 会话元信息 */
    this.sessions = new Map();
    /** 工具调用明细（含实测耗时），一个 callId 一条 */
    this.toolCalls = [];
    /** @type {Map<string, object>} sessionId -> 时间去向 */
    this.phases = new Map();
    /**
     * sessionId -> { from, to, segs } 时间去向的区间明细。
     * 单独存不挂在 phases 上：总览要把多个会话的区间做并集（并行会重叠），
     * 而这些明细是内部用的，不该跟着 API 一起吐出去。
     * @type {Map<string, {from:number,to:number,segs:Array<{s:number,e:number,type:string}>}>}
     */
    this.phaseIntervals = new Map();
    /** @type {Map<string, object>} model -> 速度画像 */
    this.speedProfiles = new Map();
    this.defaultOverheadMs = 0;
    this.lastScanAt = 0;
  }

  async refresh() {
    const changed = await this.scanner.scan();
    if (changed) this.rebuild();
    this.lastScanAt = Date.now();
    return changed;
  }

  rebuild() {
    const { records, sessions, timelines } = this.scanner.all();
    this.byId = new Map();
    this.sessions = new Map(sessions.map((s) => [s.sessionId, s]));

    for (const r of records) {
      if (!r.id) continue;
      const prev = this.byId.get(r.id);
      // 同一 messageId 保留先到的（含完整 usage 的那条）
      if (!prev || (prev.total === 0 && r.total > 0)) this.byId.set(r.id, r);
    }

    // 用会话元信息补齐/覆写标题、路径
    for (const r of this.byId.values()) {
      const s = this.sessions.get(r.sessionId);
      if (!s) continue;
      if (!r.title) r.title = s.title;
      if (!r.cwd) r.cwd = s.cwd;
    }

    // ---------- 耗时维度 ----------
    // 顺序有依赖：先把时间线的差值贴回记录，才能拿 (输出 token, 耗时) 去拟合速度
    const { reqDur, toolCalls, phases, intervals } = deriveTimings(timelines);
    for (const r of this.byId.values()) {
      const d = reqDur.get(r.id);
      r.durMs = d ? d.durMs : null;
      r.startTs = d ? d.startTs : null;
    }

    const all = [...this.byId.values()];
    const { profiles, defaultOverheadMs } = buildSpeedProfiles(all);
    attachSpeeds(all, profiles, defaultOverheadMs);

    this.toolCalls = toolCalls;
    this.phases = phases;
    this.phaseIntervals = intervals;
    this.speedProfiles = profiles;
    this.defaultOverheadMs = defaultOverheadMs;
  }

  /** 全部记录，按时间升序 */
  records() {
    return [...this.byId.values()].sort((a, b) => a.ts - b.ts);
  }

  sessionList() {
    return [...this.sessions.values()];
  }

  size() {
    return this.byId.size;
  }
}

/** 过滤：所有维度都走这一个函数，保证口径一致 */
export function applyFilter(records, f = {}) {
  const from = f.from ? Number(f.from) : -Infinity;
  const to = f.to ? Number(f.to) : Infinity;
  const projects = toSet(f.projectId);
  const sessions = toSet(f.sessionId);
  const models = toSet(f.model);
  const kinds = toSet(f.kind);
  const keyword = f.keyword ? String(f.keyword).toLowerCase() : null;

  return records.filter((r) => {
    if (r.ts < from || r.ts > to) return false;
    if (projects && !projects.has(r.projectId)) return false;
    if (sessions && !sessions.has(r.sessionId)) return false;
    if (models && !models.has(r.model)) return false;
    if (kinds && !kinds.has(r.kind)) return false;
    if (keyword) {
      const hay = `${r.title || ''} ${r.cwd || ''} ${r.model} ${r.toolName || ''} ${r.sessionId}`;
      if (!hay.toLowerCase().includes(keyword)) return false;
    }
    return true;
  });
}

function toSet(v) {
  if (v == null || v === '' || v === 'all') return null;
  return new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean));
}

/** 汇总指标 */
export function summarize(records) {
  const acc = {
    requests: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    cacheRead: 0,
    cacheMiss: 0,
    reasoning: 0,
    credit: 0,
    /** 有耗时数据的请求合计时长（模型生成阶段） */
    durMs: 0,
    /** 扣掉每请求固定开销后的净出字时长 */
    netMs: 0,
    /** 有耗时数据的请求数，用来判断速度指标是否可信 */
    timed: 0,
  };
  for (const r of records) {
    acc.requests += 1;
    acc.prompt += r.prompt;
    acc.completion += r.completion;
    acc.total += r.total;
    acc.cacheRead += r.cacheRead;
    acc.cacheMiss += r.cacheMiss;
    acc.reasoning += r.reasoning;
    acc.credit += r.credit;
    if (r.durMs) {
      acc.durMs += r.durMs;
      acc.timed += 1;
    }
    if (r.netMs) acc.netMs += r.netMs;
  }
  // 缓存命中率：命中 token / 总输入 token
  acc.cacheHitRate = acc.prompt > 0 ? acc.cacheRead / acc.prompt : 0;
  acc.credit = round(acc.credit, 4);
  acc.avgPrompt = acc.requests ? Math.round(acc.prompt / acc.requests) : 0;
  acc.avgCompletion = acc.requests ? Math.round(acc.completion / acc.requests) : 0;
  acc.avgCredit = acc.requests ? round(acc.credit / acc.requests, 4) : 0;
  acc.avgDurMs = acc.timed ? Math.round(acc.durMs / acc.timed) : 0;

  // 吐字速度：Σ输出 / Σ净时长。加权而不是逐条求平均——短请求的瞬时速度噪声太大。
  // 注意这是**实测口径**，里面混着"上一次工具返回到真正发起请求之间"的调度空转，
  // 所以它系统性低于拟合出来的吐字速度。两者都留，别混着展示。
  const sp = summarizeSpeed(records);
  acc.measuredSpeed = sp.speed;
  acc.speedSamples = sp.samples;
  return acc;
}

/**
 * 工具耗时统计：从 callId 配对出来的原始明细聚合。
 * 这个数不需要任何推导假设，是耗时维度里最硬的一部分。
 * @param {Array} calls store.toolCalls 的子集
 */
export function toolStats(calls) {
  const map = new Map();
  for (const c of calls) {
    let t = map.get(c.name);
    if (!t) {
      t = { name: c.name, calls: 0, totalMs: 0, maxMs: 0 };
      map.set(c.name, t);
    }
    t.calls += 1;
    t.totalMs += c.ms;
    if (c.ms > t.maxMs) t.maxMs = c.ms;
  }
  return [...map.values()]
    .map((t) => ({
      name: t.name,
      calls: t.calls,
      totalMs: t.totalMs,
      avgMs: Math.round(t.totalMs / t.calls),
      maxMs: t.maxMs,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** 通用分组汇总 */
export function groupBy(records, keyFn) {
  const map = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

/** 按时间分桶（本地时区） */
export function timeline(records, granularity = 'day') {
  const buckets = new Map();
  for (const r of records) {
    const k = bucketKey(r.ts, granularity);
    if (!buckets.has(k)) {
      buckets.set(k, {
        ts: bucketStart(r.ts, granularity),
        key: k,
        requests: 0,
        prompt: 0,
        completion: 0,
        total: 0,
        cacheRead: 0,
        cacheMiss: 0,
        reasoning: 0,
        credit: 0,
      });
    }
    const b = buckets.get(k);
    b.requests += 1;
    b.prompt += r.prompt;
    b.completion += r.completion;
    b.total += r.total;
    b.cacheRead += r.cacheRead;
    b.cacheMiss += r.cacheMiss;
    b.reasoning += r.reasoning;
    b.credit += r.credit;
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, credit: round(b.credit, 4) }))
    .sort((a, b) => a.ts - b.ts);
}

/* 分桶口径（bucketKey / bucketStart）已挪到 timing.js：
   时间去向的趋势分桶也要用，放这边会形成 timing → store 的反向依赖。 */

export function round(n, p = 2) {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}

export function pct(n) {
  return round(n * 100, 2);
}
