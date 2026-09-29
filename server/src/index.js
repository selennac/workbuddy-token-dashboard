import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, PROJECTS_DIR, HOME } from './config.js';
import { Scanner } from './scanner.js';
import {
  Store,
  applyFilter,
  summarize,
  groupBy,
  timeline,
  toolStats,
  round,
  pct,
} from './store.js';
import { mergePhases } from './timing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', '.cache');

const scanner = new Scanner({ fileCacheDir: CACHE_DIR });
const store = new Store(scanner);

/**
 * 解析日期参数。
 * 注意：new Date('2026-09-26') 会按 UTC 解析，在东八区会整体偏移 8 小时，
 * 所以纯日期字符串一律补上本地零点，保证"按天筛选"符合直觉。
 */
function parseDate(v, endOfDay = false) {
  if (!v) return null;
  const s = String(v);
  const d = s.length <= 10 ? new Date(`${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}`) : new Date(s);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/** 从请求里解析过滤器 */
function parseFilter(url) {
  const q = url.searchParams;
  const days = q.get('days');
  let from = parseDate(q.get('from'));
  const to = parseDate(q.get('to'), true);
  if (from == null && days) {
    const d = new Date(Date.now() - Number(days) * 86400_000);
    d.setHours(0, 0, 0, 0);
    from = d.getTime();
  }

  return {
    from,
    to,
    projectId: q.get('projectId'),
    sessionId: q.get('sessionId'),
    model: q.get('model'),
    kind: q.get('kind'),
    keyword: q.get('keyword'),
  };
}

function sessionAggregates(records) {
  const bySession = groupBy(records, (r) => r.sessionId);
  const out = [];
  for (const [sessionId, list] of bySession) {
    const meta = store.sessions.get(sessionId) || {};
    const s = summarize(list);
    const models = [...new Set(list.map((r) => r.model))];
    const toolCalls = list.filter((r) => r.kind === 'function_call').length;
    out.push({
      sessionId,
      projectId: list[0].projectId,
      title: meta.title || '',
      cwd: meta.cwd || list[0].cwd || '',
      startTs: Math.min(...list.map((r) => r.ts)),
      endTs: Math.max(...list.map((r) => r.ts)),
      models,
      toolCalls,
      ...s,
    });
  }
  return out.sort((a, b) => b.credit - a.credit);
}

/**
 * 把工具调用明细收窄到与当前筛选一致的范围。
 * 工具明细挂在 sessionId 上，而 model / kind / keyword 这些筛选维度它没有，
 * 所以统一用"筛选后出现过哪些会话"来对齐，口径才不会和表格打架。
 */
function pickToolCalls(sessionIds, f) {
  const from = f.from ? Number(f.from) : -Infinity;
  const to = f.to ? Number(f.to) : Infinity;
  const projects = f.projectId && f.projectId !== 'all' ? new Set(String(f.projectId).split(',')) : null;
  return store.toolCalls.filter(
    (c) =>
      sessionIds.has(c.sessionId) &&
      c.ts >= from &&
      c.ts <= to &&
      (!projects || projects.has(c.projectId)),
  );
}

/** 时间去向：把筛选范围内的会话的阶段时长累加 */
function pickPhase(sessionIds) {
  const list = [];
  for (const sid of sessionIds) {
    const p = store.phases.get(sid);
    if (p) list.push(p);
  }
  return mergePhases(list);
}

/**
 * 按会话拆时间去向，给总览做下钻用。
 * 总量只有一个数说明不了"时间花在哪"，摊到会话上才能看出是哪一个吃掉的在岗时间。
 */
function pickPhaseBySession(sessionIds, limit = 8) {
  const out = [];
  for (const sid of sessionIds) {
    const p = store.phases.get(sid);
    if (!p || !p.activeMs) continue;
    const meta = store.sessions.get(sid) || {};
    out.push({
      sessionId: sid,
      title: meta.title || '',
      projectId: p.projectId,
      spanMs: p.spanMs,
      modelMs: p.modelMs,
      toolMs: p.toolMs,
      waitMs: p.waitMs,
      awayMs: p.awayMs,
      activeMs: p.activeMs,
    });
  }
  return out.sort((a, b) => b.activeMs - a.activeMs).slice(0, limit);
}

/** 请求行里跟耗时有关的字段，统一在这里产出，保证各处口径一致 */
function timingFields(r) {
  return {
    startTs: r.startTs,
    durMs: r.durMs,
    overheadMs: r.overheadMs,
    netMs: r.netMs,
    tps: r.tps,
  };
}

/**
 * 一组数据的吐字速度口径。
 *
 * 为什么不直接对这批记录做一次拟合：筛选到单个会话时样本可能只有十几条，
 * 拟合出来的斜率会乱跳。吐字速度是**模型的固有属性**，不该随筛选条件变，
 * 所以速度一律取模型的（全量拟合）画像，聚合时按各模型贡献的输出 token 加权。
 *
 * 同时把"实测口径"一并给出：Σ输出 / Σ净时长。它系统性偏低——因为
 * "上一次工具返回到真正发起请求"之间的调度空转也被算进去了。
 * 两个口径都要，但必须标清楚，混着展示会让人以为数字前后矛盾。
 */
function speedOf(byModel, summary) {
  let wsum = 0;
  let weight = 0;
  for (const m of byModel) {
    if (m.speed == null || !m.completion) continue;
    wsum += m.speed * m.completion;
    weight += m.completion;
  }
  const dominant = [...byModel].filter((m) => m.speed != null).sort((a, b) => b.completion - a.completion)[0];
  // 不可信的画像连开销也别信：kimi 只 6 条样本时拟合出来的截距是 0，
  // 直接展示会得到"每请求开销 0 秒"这种明显错误的结论。
  const ovh =
    dominant && dominant.speedReliable && dominant.overheadMs != null
      ? dominant.overheadMs
      : store.defaultOverheadMs;
  return {
    /** 拟合吐字速度（按输出量加权），看板主指标 */
    tps: weight > 0 ? round(wsum / weight, 1) : null,
    /** 实测口径 Σ输出 / Σ净时长，作对照 */
    measuredTps: summary ? summary.measuredSpeed : null,
    /** 每请求固定开销 */
    overheadMs: ovh,
    dominantModel: dominant ? dominant.model : null,
    /** 主导模型的画像是否可信，不可信时前端要标"仅供参考" */
    reliable: dominant ? !!dominant.speedReliable : false,
    models: byModel
      .filter((m) => m.speed != null)
      .map((m) => ({
        model: m.model,
        tps: m.speed,
        samples: m.speedSamples,
        r2: m.speedR2,
        reliable: m.speedReliable,
      }))
      .sort((a, b) => b.tps - a.tps),
  };
}

const routes = {
  /** 数据源与筛选维度 */
  '/api/meta': async () => {
    const records = store.records();
    const uniq = (fn) => [...new Set(records.map(fn))].filter(Boolean);
    return {
      home: HOME,
      projectsDir: PROJECTS_DIR,
      lastScanAt: store.lastScanAt,
      recordCount: store.size(),
      sessionCount: store.sessions.size,
      projects: uniq((r) => r.projectId),
      models: uniq((r) => r.model),
      kinds: uniq((r) => r.kind),
      minTs: records.length ? records[0].ts : null,
      maxTs: records.length ? records[records.length - 1].ts : null,
      /** 全量口径的模型速度画像：速度不随筛选变，前端筛选时也能引用 */
      speedProfiles: [...store.speedProfiles.values()],
      defaultOverheadMs: store.defaultOverheadMs,
    };
  },

  /** 总览：KPI + 趋势 + 模型/项目分布 + 时间去向 */
  '/api/overview': async (_p, f) => {
    const all = store.records();
    const picked = applyFilter(all, f);
    const granularity = f.granularity || 'day';
    const sessionIds = new Set(picked.map((r) => r.sessionId));

    const byModel = [...groupBy(picked, (r) => r.model)]
      .map(([model, list]) => {
        const p = store.speedProfiles.get(model);
        return {
          model,
          ...summarize(list),
          /** 速度来自全量拟合，样本数与拟合优度一并给出，前端据此决定要不要标注"仅供参考" */
          speed: p ? p.speed : null,
          overheadMs: p ? p.overheadMs : null,
          speedSamples: p ? p.samples : 0,
          speedR2: p ? p.r2 : null,
          speedReliable: p ? p.reliable : false,
        };
      })
      .sort((a, b) => b.credit - a.credit);

    const byProject = [...groupBy(picked, (r) => r.projectId)]
      .map(([projectId, list]) => {
        const sessions = new Set(list.map((r) => r.sessionId));
        const s = summarize(list);
        return {
          projectId,
          cwd: list.find((r) => r.cwd)?.cwd || '',
          sessionCount: sessions.size,
          ...s,
        };
      })
      .sort((a, b) => b.credit - a.credit);

    const byKind = [...groupBy(picked, (r) => r.kind)]
      .map(([kind, list]) => ({ kind, ...summarize(list) }))
      .sort((a, b) => b.total - a.total);

    const byTool = [...groupBy(picked.filter((r) => r.toolName), (r) => r.toolName)]
      .map(([name, list]) => ({ name, calls: list.length, ...summarize(list) }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 20);

    const calls = pickToolCalls(sessionIds, f);
    const summary = summarize(picked);

    return {
      summary,
      speed: speedOf(byModel, summary),
      timeline: timeline(picked, granularity),
      byModel,
      byProject,
      byKind,
      byTool,
      /** 工具真实耗时排行（callId 配对，无需任何推导假设） */
      toolTime: toolStats(calls).slice(0, 15),
      /** 单次最慢的工具调用，用来定位"卡在哪一条命令上" */
      slowTools: [...calls]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 10)
        .map((c) => ({
          callId: c.callId,
          sessionId: c.sessionId,
          projectId: c.projectId,
          ts: c.ts,
          name: c.name,
          ms: c.ms,
          title: store.sessions.get(c.sessionId)?.title || '',
        })),
      phase: pickPhase(sessionIds),
      phaseBySession: pickPhaseBySession(sessionIds),
      cacheHitRatePct: pct(picked.length ? summarize(picked).cacheHitRate : 0),
    };
  },

  /** 会话列表 */
  '/api/sessions': async (_p, f) => {
    const picked = applyFilter(store.records(), f);
    const items = sessionAggregates(picked).map((s) => ({
      ...s,
      phase: store.phases.get(s.sessionId) || null,
    }));
    return { items };
  },

  /** 单会话详情：逐次请求时间线 */
  '/api/session': async (_p, f) => {
    if (!f.sessionId) throw new HttpError(400, '缺少 sessionId');
    const sessionId = f.sessionId.split(',')[0];
    const list = applyFilter(store.records(), { ...f, sessionId });
    const meta = store.sessions.get(sessionId) || {};
    const calls = pickToolCalls(new Set([sessionId]), { ...f, sessionId });
    const summary = summarize(list);
    const byModel = [...groupBy(list, (r) => r.model)].map(([model, l]) => {
      const p = store.speedProfiles.get(model);
      return {
        model,
        completion: l.reduce((a, r) => a + r.completion, 0),
        speed: p ? p.speed : null,
        overheadMs: p ? p.overheadMs : null,
        speedSamples: p ? p.samples : 0,
        speedR2: p ? p.r2 : null,
        speedReliable: p ? p.reliable : false,
      };
    });
    return {
      sessionId,
      meta,
      summary,
      speed: speedOf(byModel, summary),
      steps: list.map((r) => ({
        id: r.id,
        ts: r.ts,
        kind: r.kind,
        toolName: r.toolName,
        model: r.model,
        prompt: r.prompt,
        completion: r.completion,
        total: r.total,
        cacheRead: r.cacheRead,
        cacheMiss: r.cacheMiss,
        reasoning: r.reasoning,
        credit: round(r.credit, 4),
        ...timingFields(r),
      })),
      /** 上下文增长曲线：输入 token 随轮次的爬升，能直观看出"上下文膨胀" */
      contextGrowth: list.map((r, i) => ({ index: i + 1, ts: r.ts, prompt: r.prompt })),
      /** 本会话：时间去向 + 工具耗时 + 单次最慢 */
      phase: store.phases.get(sessionId) || null,
      toolTime: toolStats(calls).slice(0, 15),
      slowTools: [...calls]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 8)
        .map((c) => ({ callId: c.callId, ts: c.ts, name: c.name, ms: c.ms })),
    };
  },

  /** 请求明细（分页） */
  '/api/requests': async (_p, f) => {
    const picked = applyFilter(store.records(), f).sort((a, b) => b.ts - a.ts);
    const page = Math.max(1, Number(f.page || 1));
    const size = Math.min(500, Number(f.size || 50));
    const start = (page - 1) * size;
    return {
      total: picked.length,
      page,
      size,
      items: picked.slice(start, start + size).map((r) => ({
        id: r.id,
        ts: r.ts,
        sessionId: r.sessionId,
        projectId: r.projectId,
        title: r.title,
        model: r.model,
        kind: r.kind,
        toolName: r.toolName,
        prompt: r.prompt,
        completion: r.completion,
        total: r.total,
        cacheRead: r.cacheRead,
        reasoning: r.reasoning,
        credit: round(r.credit, 4),
        ...timingFields(r),
      })),
    };
  },
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * 生产模式：如果 web/dist 存在，就顺手把打包产物托管在同一端口，
 * 这样部署时只需要跑一个 Node 进程（无需 nginx）。
 */
const DIST_DIR = path.resolve(__dirname, '../../web/dist');
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  // 防目录穿越
  const target = path.join(DIST_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(DIST_DIR)) return false;

  let file = target;
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(DIST_DIR, 'index.html'); // SPA 兜底
  }

  try {
    const buf = fs.readFileSync(file);
    const ext = path.extname(file).toLowerCase();
    const isHashed = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  // 强制重扫
  if (url.pathname === '/api/refresh') {
    try {
      await store.refresh();
      return json(res, 200, { ok: true, recordCount: store.size(), lastScanAt: store.lastScanAt });
    } catch (err) {
      console.error('[refresh error]', err);
      return json(res, 500, { error: err.message });
    }
  }

  const handler = routes[url.pathname];
  if (!handler) {
    // 非 /api 请求交给静态产物
    if (!url.pathname.startsWith('/api') && HAS_DIST && serveStatic(url.pathname, res)) return;
    return json(res, 404, { error: 'Not Found', path: url.pathname });
  }

  try {
    const f = parseFilter(url);
    f.granularity = url.searchParams.get('granularity') || 'day';
    f.page = url.searchParams.get('page');
    f.size = url.searchParams.get('size');
    const body = await handler(url, f);
    json(res, 200, body);
  } catch (err) {
    console.error('[api error]', url.pathname, err);
    json(res, err.status || 500, { error: err.message });
  }
});

// 启动时全量扫一次，之后每 15s 增量扫（JSONL 是追加写，代价很低）
await store.refresh();
setInterval(() => store.refresh().catch((e) => console.error('[scan]', e)), 15_000);

server.listen(PORT, () => {
  console.log(`[token-dashboard] API 已启动  http://localhost:${PORT}`);
  console.log(`[token-dashboard] 数据源      ${PROJECTS_DIR}`);
  console.log(`[token-dashboard] 已解析 ${store.size()} 条请求 / ${store.sessions.size} 个会话`);
  const fitted = [...store.speedProfiles.values()].filter((p) => p.reliable);
  console.log(
    `[token-dashboard] 耗时维度    ${store.toolCalls.length} 次工具调用 / ` +
      `${fitted.length} 个模型完成速度拟合 · 兜底固定开销 ${store.defaultOverheadMs}ms`,
  );
});
