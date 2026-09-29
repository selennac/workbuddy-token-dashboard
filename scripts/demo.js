/**
 * 生成一份合成的 WorkBuddy 演示数据，并（可选）直接用它启动看板。
 *
 * 用途有二：
 *   1. 没装 WorkBuddy 也能体验看板：npm run demo
 *   2. 给 README 生成截图用数据——开源项目的截图不应该暴露
 *      作者本机的真实项目名、路径与用量，所以截图全部基于这份合成数据。
 *
 * 生成逻辑不是随便编数字：为了让看板的耗时推导（timing.js）算出量级正确的
 * 速度与时间去向，时间线严格按真实规律构造——
 *   - 一次请求的端到端耗时 = 每请求固定开销 + 输出 token ÷ 吐字速度 + 噪声
 *   - 工具耗时靠 function_call / function_call_result 的 callId 配对
 *   - 超过 30 分钟的事件间隔会被判定为"离开"，用来还原真实的使用节奏
 *
 * 运行：node scripts/demo.js          生成并启动（http://localhost:5178）
 *       node scripts/demo.js --gen    只生成数据，不启动服务
 *       DEMO_SEED=42 node scripts/demo.js   固定随机种子（默认固定，输出可复现）
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const OUT = path.join(root, '.demo', 'workbuddy');

/* ---------------- 随机数（固定种子，保证每次生成的数据一致） ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(Number(process.env.DEMO_SEED) || 20260929);
const rand = (min, max) => min + rnd() * (max - min);
const int = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[int(0, arr.length - 1)];
const hex = (n) =>
  Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');
const uuid = () => `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;

/* ---------------- 模型画像：两个模型，一快一慢、一廉一贵 ---------------- */

const MODELS = {
  // 主力模型：便宜、快，承担绝大多数请求
  'deepseek-v4.1-flash': { tps: 240, overheadMs: 3200, thinking: true },
  // 少量高价请求：贵一个量级、慢近 8 倍，样本少（看板会把它标成低置信）
  'kimi-k3-1': { tps: 31.5, overheadMs: 6800, thinking: false },
};

/* ---------------- 工具耗时画像（秒） ---------------- */

const TOOLS = [
  { name: 'Bash', min: 0.4, max: 75, weight: 30 }, // 重尾：大多数快，偶尔跑安装/构建很久
  { name: 'Read', min: 0.15, max: 2.5, weight: 26 },
  { name: 'Edit', min: 0.12, max: 0.9, weight: 18 },
  { name: 'Write', min: 0.1, max: 0.7, weight: 8 },
  { name: 'Grep', min: 0.3, max: 6, weight: 9 },
  { name: 'WebSearch', min: 2, max: 18, weight: 5 },
  { name: 'TaskOutput', min: 0.5, max: 25, weight: 4 },
];
const TOOL_BAG = TOOLS.flatMap((t) => Array(t.weight).fill(t));
// Bash 的重尾：10% 概率拖到几十秒~几分钟
function toolDuration(t) {
  let s = rand(t.min, t.max);
  if (t.name === 'Bash' && rnd() < 0.1) s = rand(20, 160);
  return Math.round(s * 1000);
}

/* ---------------- 会话剧本 ---------------- */

const DAY = 86400_000;

const PLAN = [
  {
    dir: 'd-code-webshop',
    cwd: 'D:\\code\\webshop',
    sessions: [
      { title: '购物车数量联动与结算页适配', daysAgo: 0, startHour: 9.6, turns: 7, model: 'deepseek-v4.1-flash' },
      { title: '修复下单接口超时的重试逻辑', daysAgo: 0, startHour: 14.2, turns: 5, model: 'deepseek-v4.1-flash', lunchBreak: true },
      { title: '商品列表虚拟滚动优化', daysAgo: 2, startHour: 10.3, turns: 6, model: 'deepseek-v4.1-flash' },
      { title: '优惠券核销的并发去重', daysAgo: 4, startHour: 15.1, turns: 8, model: 'deepseek-v4.1-flash', overnight: true },
      { title: '接入新的支付渠道并回归测试', daysAgo: 5, startHour: 20.8, turns: 4, model: 'kimi-k3-1' },
    ],
  },
  {
    dir: 'd-code-blog',
    cwd: 'D:\\code\\blog',
    sessions: [
      { title: '文章页目录侧栏与阅读进度条', daysAgo: 1, startHour: 11.2, turns: 5, model: 'deepseek-v4.1-flash' },
      { title: '首页改版：卡片栅格与暗色模式', daysAgo: 3, startHour: 14.6, turns: 6, model: 'deepseek-v4.1-flash', lunchBreak: true },
      { title: 'SEO 元信息与 sitemap 补全', daysAgo: 6, startHour: 9.9, turns: 3, model: 'kimi-k3-1' },
    ],
  },
  {
    dir: 'd-code-mlnotes',
    cwd: 'D:\\code\\mlnotes',
    sessions: [
      { title: '手写数字分类器：从零训练与调参', daysAgo: 2, startHour: 16.4, turns: 6, model: 'deepseek-v4.1-flash' },
      { title: '整理注意力机制笔记并画图', daysAgo: 5, startHour: 10.5, turns: 4, model: 'deepseek-v4.1-flash' },
    ],
  },
];

/* ---------------- 单个会话的 JSONL 构造 ---------------- */

class SessionWriter {
  constructor(project, spec) {
    this.project = project;
    this.spec = spec;
    this.sessionId = uuid();
    this.lines = [];
    this.callSeq = 0;
    this.msgSeq = 0;
    this.traceId = hex(16);
  }

  line(o) {
    this.lines.push(JSON.stringify({ sessionId: this.sessionId, cwd: this.project.cwd, ...o }));
  }

  now() {
    // 起点：daysAgo 天前的 startHour 点（本地时区），加一点随机抖动
    if (this._t == null) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      this._t = Math.floor(
        d.getTime() - this.spec.daysAgo * DAY + this.spec.startHour * 3600_000 + int(0, 20) * 60_000,
      );
    }
    return this._t;
  }
  advance(ms) {
    this._t += ms;
    return this._t;
  }

  /** 一次模型请求：1~P 个并行 function_call（共享 messageId，恰好一行带 rawUsage）+ 对应 result */
  emitRequest({ model, isFinal, ctxTokens }) {
    const m = MODELS[model];
    const completion = isFinal ? int(400, 6000) : int(150, 2600);
    const thinking = m.thinking && rnd() < 0.75 ? Math.round(completion * rand(0.1, 0.55)) : 0;

    // 缓存：多数请求命中良好，偶发缓存失效（命中率骤降的长尾）
    const hitRatio = rnd() < 0.08 ? rand(0.2, 0.55) : rand(0.86, 0.97);
    const hit = Math.round(ctxTokens * hitRatio);
    const miss = ctxTokens - hit;
    const total = ctxTokens + completion;

    // 端到端耗时 = 固定开销 + 输出（含 thinking）÷ 吐字速度 + 噪声（±12%）
    // 注意 rawUsage.completion_tokens 已包含 thinking，时间必须按全量输出算，
    // 否则看板拟合出来的速度会虚高
    const durMs = Math.round(
      m.overheadMs + ((completion + thinking) / m.tps) * 1000 * rand(0.88, 1.12),
    );
    const tDone = this.advance(durMs);

    const messageId = `mid-${hex(24)}`;
    const rawUsage = {
      prompt_tokens: ctxTokens,
      completion_tokens: completion + thinking, // thinking 计入输出
      total_tokens: total + thinking,
      prompt_cache_hit_tokens: hit,
      prompt_cache_miss_tokens: miss,
      credit: this.credit(model, miss, completion + thinking),
    };
    if (thinking > 0) rawUsage.completion_thinking_tokens = thinking;

    if (isFinal) {
      // 最终回答：带用量的 assistant 消息行（真实数据里 message 行也承担用量）
      this.line({
        type: 'message',
        role: 'assistant',
        timestamp: tDone,
        providerData: {
          messageId,
          traceId: this.traceId,
          conversationRequestId: `req-${++this.msgSeq}-${hex(8)}`,
          model,
          rawUsage,
        },
      });
      return { ctxAfter: ctxTokens + completion, durMs };
    }

    // 工具调用：同一响应里的多个 call 共享 messageId，只有第一个带 rawUsage
    const parallel = rnd() < 0.18 ? 2 : 1;
    const callIds = [];
    for (let i = 0; i < parallel; i++) {
      const tool = pick(TOOL_BAG);
      const callId = `call-${++this.callSeq}-${hex(6)}`;
      callIds.push({ callId, tool });
      this.line({
        type: 'function_call',
        timestamp: tDone,
        callId,
        name: tool.name,
        providerData: {
          messageId,
          traceId: this.traceId,
          conversationRequestId: `req-${++this.msgSeq}-${hex(8)}`,
          model,
          ...(i === 0 ? { rawUsage } : {}),
        },
      });
    }

    // 工具串行返回：逐段累加恰好等于 fcr#P − fc#1，不会重复计时
    let t = this.now();
    for (const { callId, tool } of callIds) {
      t += toolDuration(tool) + int(30, 220);
      this.line({
        type: 'function_call_result',
        timestamp: t,
        callId,
        name: tool.name,
      });
    }
    this._t = t; // 时间推进到最后一个工具返回，下一次请求从这里起算
    return {
      ctxAfter: ctxTokens + completion + int(2000, 12000), // 工具结果回灌，上下文增长
      durMs,
    };
  }

  credit(model, miss, out) {
    if (model === 'kimi-k3-1') return round2(3 + miss * 4.5e-4 + out * 8e-4);
    return round2(0.02 + miss * 8e-6 + out * 2.2e-5);
  }

  write() {
    const dir = path.join(OUT, 'projects', this.project.dir);
    fs.mkdirSync(dir, { recursive: true });
    this.line({ type: 'session-meta', timestamp: this.now() });
    this.line({ type: 'ai-title', aiTitle: this.spec.title, timestamp: this.now() });

    let ctx = int(45000, 90000);
    const { turns, model } = this.spec;

    for (let turn = 0; turn < turns; turn++) {
      // 用户发言：第一轮立即开始，之后隔一段"等待用户"
      if (turn > 0) {
        if (this.spec.lunchBreak && turn === Math.ceil(turns / 2)) {
          this.advance(int(45, 80) * 60_000); // 午休 → 判定为"离开"
        } else if (this.spec.overnight && turn === Math.ceil(turns / 2)) {
          this.advance(int(11, 14) * 3600_000); // 隔夜 → 大段"离开"
        } else {
          this.advance(rand(8_000, 150_000));
        }
      }
      this.line({
        type: 'message',
        role: 'user',
        timestamp: this.now(),
        message: { text: pick(USER_ASKS) },
      });

      // agent 循环：一轮对话 = 思考 → 调工具 → 拿结果 → 再思考 …… 1~5 次请求
      const steps = turn === 0 ? int(2, 4) : int(1, 5);
      for (let step = 0; step <= steps; step++) {
        const isFinal = step === steps;
        const r = this.emitRequest({ model, isFinal, ctxTokens: ctx });
        ctx = r.ctxAfter;
        if (!isFinal && rnd() < 0.6) {
          // 思考过程与文件快照：落在时间线中间、时间戳几乎与请求重合，看板会忽略它们
          this.line({ type: 'reasoning', timestamp: this.now() });
          this.line({ type: 'file-history-snapshot', timestamp: this.now() });
        }
      }
      this.traceId = hex(16); // 一轮对话一个 traceId
    }

    const body = this.lines.join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `${this.sessionId}.jsonl`), body);
    return Buffer.byteLength(body);
  }
}

const USER_ASKS = [
  '帮我看看这个报错是怎么回事',
  '按我刚才说的思路改一下，注意别动其他模块',
  '这里为什么这么慢？帮我定位一下',
  '补一下边界情况的测试',
  '把这个逻辑抽成公共函数',
  '跑一下测试，失败了就修',
  '继续',
  '把刚才的改动整理成一次提交',
];

const round2 = (n) => Math.round(n * 100) / 100;

/* ---------------- 生成入口 ---------------- */

function generate() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const t0 = Date.now();
  let sessions = 0;
  let bytes = 0;
  for (const project of PLAN) {
    for (const spec of project.sessions) {
      bytes += new SessionWriter(project, spec).write();
      sessions++;
    }
  }
  const mb = (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `已生成演示数据：${PLAN.length} 个项目 / ${sessions} 个会话 / ${mb} MB（耗时 ${Date.now() - t0}ms）`,
  );
  console.log(`目录：${OUT}`);
}

function serve() {
  const port = Number(process.env.PORT || 5178);
  if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) {
    console.error('还没有前端构建产物，请先执行：npm run build');
    process.exit(1);
  }
  const child = spawn(process.execPath, [path.join(root, 'server', 'src', 'index.js')], {
    stdio: 'inherit',
    env: { ...process.env, WORKBUDDY_HOME: path.join(OUT), PORT: String(port) },
  });
  console.log(`\n看板地址：http://localhost:${port}  （数据源为演示数据，Ctrl+C 退出）`);
  child.on('exit', (code) => process.exit(code ?? 0));
}

const onlyGen = process.argv.includes('--gen');
generate();
if (!onlyGen) serve();
