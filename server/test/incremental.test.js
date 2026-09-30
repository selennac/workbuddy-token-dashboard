/**
 * 增量解析自测：验证"分多次追加写入"的结果 == "一次性全量解析"的结果。
 * 这是整个看板最容易出错的地方——文件是边写边读的。
 *
 * 运行：node test/incremental.test.js
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { Scanner } from '../src/scanner.js';
import { parseChunk } from '../src/parser.js';
import { deriveTimings, fitSpeed, buildSpeedProfiles, attachSpeeds } from '../src/timing.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'token-dash-'));
const projectsDir = path.join(tmpHome, 'projects', 'e-WORK-Demo');
fs.mkdirSync(projectsDir, { recursive: true });
const file = path.join(projectsDir, 'session-abc.jsonl');

// 覆盖三种边界：正常行、脏行、只有半截的行
const line = (i, usage) =>
  JSON.stringify({
    type: 'function_call',
    timestamp: 1790000000000 + i * 1000,
    sessionId: 'session-abc',
    cwd: 'e:\\WORK\\Demo',
    name: 'Bash',
    providerData: {
      messageId: 'msg-' + i,
      traceId: 'trace-1',
      model: 'demo-model',
      rawUsage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
        prompt_cache_hit_tokens: usage.hit,
        prompt_cache_miss_tokens: usage.prompt - usage.hit,
        completion_thinking_tokens: 10,
        credit: usage.credit,
      },
    },
  });

const lines = [
  line(0, { prompt: 1000, completion: 100, hit: 800, credit: 1 }),
  line(1, { prompt: 2000, completion: 200, hit: 1500, credit: 2 }),
  JSON.stringify({ type: 'ai-title', timestamp: 1790000000000, aiTitle: '演示会话', cwd: 'e:\\WORK\\Demo' }),
  'not-json-{{{' /* 脏行 */,
  line(2, { prompt: 3000, completion: 300, hit: 2500, credit: 3 }),
  line(3, { prompt: 4000, completion: 400, hit: 3900, credit: 4 }),
];

// 全量基准
const full = parseChunk(lines.join('\n') + '\n', { projectId: 'e-WORK-Demo', sessionId: 'session-abc' });

const scanner = new Scanner({ fileCacheDir: path.join(tmpHome, '.cache') });
// 不依赖真实 HOME：直接接管 discover，把扫描范围限定到临时目录
scanner.discover = async () => [
  { filePath: file, projectId: 'e-WORK-Demo', sessionId: 'session-abc' },
];

let appended = '';
async function append(text) {
  appended += text;
  fs.writeFileSync(file, appended);
}

// 第一次：写入前 2 行
await append(lines[0] + '\n' + lines[1] + '\n');
await scanner.scan();
assert.strictEqual(scanner.all().records.length, 2, '第 1 次扫描应有 2 条');

// 第二次：追加标题 + 脏行 + 半截行（无换行），半截行不应被计入
await append(lines[2] + '\n' + lines[3] + '\n' + lines[4].slice(0, 40));
await scanner.scan();
assert.strictEqual(scanner.all().records.length, 2, '半截行不应被解析');

// 第三次：补全半截行的剩余部分
await append(lines[4].slice(40) + '\n');
await scanner.scan();
assert.strictEqual(scanner.all().records.length, 3, '补全后应有 3 条');

// 第四次：再追加一条
await append(lines[5] + '\n');
await scanner.scan();
const inc = scanner.all();

// 对账
assert.strictEqual(inc.records.length, full.records.length, '增量与全量条数应一致');

const sum = (arr) => ({
  prompt: arr.reduce((a, r) => a + r.prompt, 0),
  completion: arr.reduce((a, r) => a + r.completion, 0),
  cacheRead: arr.reduce((a, r) => a + r.cacheRead, 0),
  credit: Number(arr.reduce((a, r) => a + r.credit, 0).toFixed(6)),
});

const a = sum(inc.records);
const b = sum(full.records);
assert.deepStrictEqual(a, b, '增量与全量的聚合值应完全一致');

// 元信息（标题）应被保留
assert.strictEqual(inc.sessions[0].title, '演示会话', '会话标题应被解析到');
assert.strictEqual(inc.sessions[0].cwd, 'e:\\WORK\\Demo', 'cwd 应被解析到');

// 文件被重写时（变小）应整体重解析，不重复累计
fs.writeFileSync(file, lines[0] + '\n' + lines[1] + '\n');
await scanner.scan();
assert.strictEqual(scanner.all().records.length, 2, '文件被重写后不应残留旧记录');

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log('✓ 增量解析自测全部通过');
console.log('  分 4 次追加 → 最终', inc.records.length, '条，与全量解析一致');
console.log('  聚合对账：', JSON.stringify(a));
console.log('  边界覆盖：脏行 / 半截行 / 文件重写 / 元信息保留');

/* ==========================================================================
 * 耗时推导自测
 *
 * 这里才是新逻辑最容易错的地方：一次请求的"起点"是**上一条工具返回**，
 * 而这两行很可能被拆在两次增量读里（工具跑了几分钟，中间文件被追加过好几轮）。
 * 所以必须验证"分次追加"和"一次全量"算出来的耗时完全一致。
 * ======================================================================== */

const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'token-dash-tl-'));
const proj2 = path.join(dir2, 'projects', 'e-WORK-Demo');
fs.mkdirSync(proj2, { recursive: true });

const T0 = 1790000000000;
const at = (offset) => T0 + offset;

/** 一次请求：带用量的 function_call */
const req = (offset, { mid, out, callId, name = 'Bash', prompt = 1000 }) =>
  JSON.stringify({
    type: 'function_call',
    timestamp: at(offset),
    name,
    callId,
    sessionId: 'session-t',
    cwd: 'e:\\WORK\\Demo',
    providerData: {
      messageId: mid,
      traceId: 'trace-1',
      model: 'demo-model',
      rawUsage: {
        prompt_tokens: prompt,
        completion_tokens: out,
        total_tokens: prompt + out,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: prompt,
        completion_thinking_tokens: 0,
        credit: 1,
      },
    },
  });

const userMsg = (offset) =>
  JSON.stringify({ type: 'message', role: 'user', timestamp: at(offset), content: 'hi', sessionId: 'session-t' });

const toolResult = (offset, callId, name = 'Bash') =>
  JSON.stringify({
    type: 'function_call_result',
    timestamp: at(offset),
    callId,
    name,
    status: 'completed',
    output: { type: 'text', text: 'ok' },
    sessionId: 'session-t',
  });

/** 夹在中间、必须被忽略的碎行（它们的 timestamp 和请求完成点几乎重合） */
const noise = (offset) =>
  JSON.stringify({
    type: 'reasoning',
    timestamp: at(offset),
    sessionId: 'session-t',
    providerData: { messageId: 'm-ignore', model: 'demo-model' },
    content: [],
  });

// 时间线设计：
//   t=0      用户发消息
//   t=5000   请求 A 完成（耗时 5000）→ 调工具 c1
//   t=9000   c1 返回（工具耗时 4000）
//   t=11000  请求 B 完成（耗时 2000）→ 调工具 c2
//   t=21000  c2 返回（工具耗时 10000）
//   t=24000  请求 C 完成（耗时 3000），不调工具 → 一轮结束
const tl = [
  userMsg(0),
  noise(4990),
  req(5000, { mid: 'mA', out: 1000, callId: 'c1' }),
  noise(5020),
  toolResult(9000, 'c1'),
  noise(10990),
  req(11000, { mid: 'mB', out: 1000, callId: 'c2' }),
  toolResult(21000, 'c2'),
  req(24000, { mid: 'mC', out: 1000, callId: 'c3' }),
];
const tlText = tl.join('\n');

const tlFile = path.join(proj2, 'session-t.jsonl');
const tlScanner = new Scanner({ fileCacheDir: path.join(dir2, '.cache') });
tlScanner.discover = async () => [
  { filePath: tlFile, projectId: 'e-WORK-Demo', sessionId: 'session-t' },
];

// 断点刻意落在"请求 A 与工具返回之间"，逼出跨块的边界还原
const cuts = [2, 4, 7];
let written = '';
for (let i = 0; i < cuts.length; i++) {
  written += tl.slice(i === 0 ? 0 : cuts[i - 1], cuts[i]).join('\n') + '\n';
  fs.writeFileSync(tlFile, written);
  await tlScanner.scan();
}
written += tl.slice(cuts[cuts.length - 1]).join('\n') + '\n';
fs.writeFileSync(tlFile, written);
await tlScanner.scan();

const fullParsed = parseChunk(tlText + '\n', { projectId: 'e-WORK-Demo', sessionId: 'session-t' });
const fullTimings = deriveTimings([
  { sessionId: 'session-t', projectId: 'e-WORK-Demo', events: fullParsed.events },
]);
const incTimings = deriveTimings(tlScanner.all().timelines);

// 3 个请求 + 2 个工具返回 + 1 条用户消息；中间的 reasoning 碎行不上时间线
assert.strictEqual(fullParsed.events.length, 6, '只有用户消息 / 带用量的请求 / 工具返回上时间线');
assert.strictEqual(
  incTimings.reqDur.size,
  fullTimings.reqDur.size,
  '增量与全量应还原出同样多的请求耗时',
);
for (const mid of ['mA', 'mB', 'mC']) {
  assert.deepStrictEqual(
    incTimings.reqDur.get(mid),
    fullTimings.reqDur.get(mid),
    `增量与全量对 ${mid} 的耗时还原应完全一致`,
  );
}
assert.strictEqual(fullTimings.reqDur.get('mA').durMs, 5000, '请求 A 耗时 = 用户消息 → 完成');
assert.strictEqual(fullTimings.reqDur.get('mB').durMs, 2000, '请求 B 耗时 = 工具返回 → 完成');
assert.strictEqual(fullTimings.reqDur.get('mC').durMs, 3000, '请求 C 耗时 = 工具返回 → 完成');

// c3 没有返回（被中断），不该产生一条耗时记录
assert.strictEqual(fullTimings.toolCalls.length, 2, '只有配得上返回的调用才计入工具耗时');
const byCall = Object.fromEntries(fullTimings.toolCalls.map((c) => [c.callId, c.ms]));
assert.deepStrictEqual(byCall, { c1: 4000, c2: 10000 }, '工具耗时按 callId 配对');

const ph = fullTimings.phases.get('session-t');
assert.strictEqual(ph.spanMs, 24000, '全程跨度 = 首末事件之差');
assert.strictEqual(ph.modelMs, 10000, '模型生成 = 5000 + 2000 + 3000');
assert.strictEqual(ph.toolMs, 14000, '工具执行 = 4000 + 10000');
assert.strictEqual(ph.humanMs, 0, '本次全程没有人的环节（事件之间都紧接着）');
assert.strictEqual(ph.activeMs, 24000, '在岗 = 模型 + 工具 + 等待');

/* ---------- 速度拟合：能不能从带噪声的样本里还原出设定的斜率和截距 ---------- */
const SPEED = 200; // t/s
const OVERHEAD = 3000; // ms
const samples = [];
for (let i = 0; i < 40; i++) {
  const out = 500 + i * 250;
  // 抖动 ±8%：模拟真实的调度波动
  const jitter = 1 + (((i * 37) % 17) - 8) / 100;
  samples.push({ x: out, y: OVERHEAD + (out / SPEED) * 1000 * jitter });
}
const fit = fitSpeed(samples);
assert.ok(fit, '样本量足够时应能拟合出结果');
assert.ok(Math.abs(fit.speed - SPEED) / SPEED < 0.15, `吐字速度应接近 ${SPEED}，实际 ${fit.speed.toFixed(1)}`);
assert.ok(
  Math.abs(fit.overheadMs - OVERHEAD) / OVERHEAD < 0.35,
  `固定开销应接近 ${OVERHEAD}，实际 ${Math.round(fit.overheadMs)}`,
);
assert.ok(fit.r2 > 0.9, `拟合优度应 >0.9，实际 ${fit.r2}`);
assert.strictEqual(fit.reliable, true, '样本量 40、R² 高，应判为可信');
assert.strictEqual(fitSpeed(samples.slice(0, 3)), null, '样本少于 5 条不拟合');

/* ---------- 净出字时长与瞬时速度 ---------- */
// 用同一套"耗时 = 固定开销 + 输出/速度"的模型造样本，看能不能反推回来。
// 抖动必须与输出量不相关：周期性的抖动会和 x 产生虚假相关，把斜率带偏，
// 测出来"速度不对"其实是被测试数据坑了。这里用一个确定性 LCG。
let seed = 20260929;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const profileRecs = [];
for (let i = 0; i < 30; i++) {
  const out = 1000 + i * 300;
  const jitter = 1 + (rnd() * 0.14 - 0.07);
  profileRecs.push({
    id: 'r' + i,
    model: 'demo-model',
    completion: out,
    durMs: OVERHEAD + (out / SPEED) * 1000 * jitter,
  });
}
// 比固定开销还快：净出字时长会算成负数，必须判为不可用而不是给个负速度。
// 刻意不放进画像素材里——这种离群点会把截距拉偏，而真实数据里低输出请求
// 本来就要花掉固定开销，不存在这种点。
const tiny = { id: 'tiny', model: 'demo-model', completion: 20, durMs: 2500 };
const recs = [...profileRecs, tiny];

const { profiles, defaultOverheadMs } = buildSpeedProfiles(profileRecs);
attachSpeeds(recs, profiles, defaultOverheadMs);
const prof = profiles.get('demo-model');
assert.ok(prof, '应画出 demo-model 的速度画像');
assert.ok(prof.speed != null, '样本足够时应给出吐字速度');
assert.ok(Math.abs(prof.speed - SPEED) / SPEED < 0.15, `模型速度应接近 ${SPEED}，实际 ${prof.speed}`);
assert.ok(
  Math.abs(prof.overheadMs - OVERHEAD) / OVERHEAD < 0.25,
  `固定开销应接近 ${OVERHEAD}，实际 ${prof.overheadMs}`,
);
assert.strictEqual(prof.reliable, true, '30 条样本、R² 高，应判为可信');

const good = profileRecs[0];
assert.ok(good.tps != null, '净出字时长充足的请求应算得出瞬时速度');
assert.ok(Math.abs(good.tps - prof.speed) / prof.speed < 0.4, `瞬时速度应与模型速度同量级，实际 ${good.tps}`);
assert.strictEqual(tiny.netMs, null, '净出字时长不足的请求应判为不可用');
assert.strictEqual(tiny.tps, null, '不可用的请求不应给出吐字速度');

// 处理不了的情况要老实返回 null，而不是抛异常或给出假数字
const empty = buildSpeedProfiles([]);
assert.strictEqual(empty.profiles.size, 0, '没有样本时不产出任何画像');
assert.ok(empty.defaultOverheadMs > 0, '取不到画像时应有兜底的固定开销');

const sameX = Array.from({ length: 6 }, (_, i) => ({ x: 100, y: 1000 + i * 100 }));
assert.strictEqual(fitSpeed(sameX), null, '输出量全都相同则拟合不出斜率');
const decreasing = [5, 4, 3, 2, 1].map((k) => ({ x: 6 - k, y: k * 5000 }));
assert.strictEqual(fitSpeed(decreasing), null, '耗时随输出量下降（斜率非正）时应拒绝拟合');

fs.rmSync(dir2, { recursive: true, force: true });

console.log('');
console.log('✓ 耗时推导自测全部通过');
console.log('  跨块边界：请求 A/B/C 的耗时在分次追加与全量解析下完全一致');
console.log('  工具配对：callId → 4000ms / 10000ms（无返回的调用不计入）');
console.log('  阶段分解：模型 10000ms ｜ 工具 14000ms ｜ 全程 24000ms');
console.log(`  速度拟合：${fit.speed.toFixed(1)} t/s（设定 ${SPEED}）· 开销 ${Math.round(fit.overheadMs)}ms · R²=${fit.r2.toFixed(3)}`);
