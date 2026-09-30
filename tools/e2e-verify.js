/**
 * 端到端验证：用 Edge/Chrome 的 CDP 协议真实渲染看板并逐个交互，断言 DOM 状态。
 *
 * 为什么需要它：编译通过不代表能跑。本项目实际踩到过两个只有真实浏览器才暴露的问题——
 *   1. ECharts 容器在 v-else-if 分支里，组件挂载时还不存在 → 图表一直空白
 *   2. 总览视图有多个根节点，v-show 对 fragment 不生效 → 切 tab 时内容叠加
 * 这两类问题构建阶段都不会报错。
 *
 * 前置：
 *   - 解析服务已启动
 *   - 已执行过 npm run build（验证生产产物），或把 BASE_URL 指到 dev server
 *   - 本机有 Edge 或 Chrome
 *
 * 运行：node tools/e2e-verify.js
 * 可选环境变量：
 *   BASE_URL  默认 http://localhost:5178
 *   BROWSER   浏览器可执行文件路径
 *   CDP_PORT  默认 9338
 *
 * 断言围绕"构建阶段查不出来"的问题设计：图表容器挂载时机、v-show 对多根节点无效、
 * 以及耗时段落的分段宽度是否真的加起来等于 100%（算漏一段只会表现为条变短，
 * 肉眼很难发现，但堆叠条会直接撑不满）。
 * 具体条数由脚本自己统计输出，不在注释里写死。
 *
 * 视图定位说明：三个视图是 .content 的直接子元素，顺序固定为
 * [0]=总览、[1]=会话、[2]=明细。每个视图内部还有各自的内容块，
 * 所以先用索引取视图，再用视图内的选择器取内容。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * ⚠ 调试端口和浏览器 profile 都必须**每次运行唯一**。
 * 原来两处都写死（9338 / e2e-profile），于是两个终端同时跑 e2e 时会：
 *   1) 端口被前一个 Chromium 占着 → 后一个压根起不来（或更糟：连上**前一个的页面**）
 *   2) profile 目录被锁 → 启动直接失败
 * 表现是"同一个断言时好时坏"的假失败（实测踩过：明细行数 51、日期点了没回填，
 * 都是被另一个 run 在同一个页面上乱点造成的）。所以这里取随机端口 + 带端口的 profile。
 */
const CDP_PORT = Number(process.env.CDP_PORT || 9300 + Math.floor(Math.random() * 600));
const BASE_URL = process.env.BASE_URL || 'http://localhost:5178';
const HOST = new URL(BASE_URL).host;

const BROWSER_CANDIDATES = [
  process.env.BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const BROWSER = BROWSER_CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) {
  console.error('找不到浏览器，请用 BROWSER=<可执行文件路径> 指定');
  process.exit(1);
}

const CACHE_DIR = path.resolve(__dirname, '..', '.cache');
const SHOT_DIR = path.join(CACHE_DIR, 'shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

/**
 * 浏览器 profile 放**系统临时目录**，不放在 .cache/。
 *
 * 理由：它不是项目产物；而且 Windows 上 Chromium 退出后句柄还要释放一会儿，
 * 删除经常失败 —— 留在 .cache/ 里失败一次就是 57MB，实测攒到过 743MB。
 * 扔进 tmp，就算这次没删干净也不会污染仓库，下次运行时开头的 sweep 再清。
 */
const PROFILE_PREFIX = 'wb-e2e-profile-';
/** profile 带上端口：并发运行时各用各的，不会互相锁目录 */
const PROFILE_DIR = path.join(os.tmpdir(), PROFILE_PREFIX + CDP_PORT);

/**
 * 扫掉历史遗留的 profile。
 *
 * 为什么需要：cleanup() 只在正常退出时跑到。Ctrl+C、崩在断言里、以及上面说的
 * 文件被锁，都会留下一个 ~57MB 的 profile。
 *
 * 只删**一小时前**的：并发跑 e2e 是这脚本刻意支持的场景，另一个 run 的 profile
 * 一直在写、mtime 是新的，按时间筛就不会误删它。前缀也限定死，不碰 tmp 里别人的东西。
 */
function sweepStaleProfiles() {
  let names = [];
  try {
    names = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }
  const cutoff = Date.now() - 60 * 60 * 1000;
  let n = 0;
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(dir).mtimeMs > cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
      n++;
    } catch {
      /* 还被锁着就留给下次 */
    }
  }
  if (n) console.log('顺便清掉 ' + n + ' 个遗留的浏览器 profile');
}
sweepStaleProfiles();

async function cleanup() {
  /* Windows 上 proc.kill() 只杀主进程，Edge 的渲染/GPU 子进程还活着、还占着
     profile 里的文件 —— 必须连子进程一起杀（taskkill /T）。 */
  if (proc.pid) {
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* 进程可能已经退了 */
      }
    } else {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* 已经退了 */
      }
    }
  }

  /* 杀完之后句柄还要释放一会儿，头几次删经常失败（实测残留过 746 个文件）。
     e2e 本来就要跑一分钟，这里多等几秒不心疼；实在删不掉就交给下次的 sweep。 */
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    try {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
      return;
    } catch {
      /* 再试一次 */
    }
  }
  console.log('提示：本次的浏览器 profile 没能删干净（在系统临时目录），下次运行会扫掉');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  const tail = extra ? '  (' + extra + ')' : '';
  if (cond) {
    pass++;
    console.log('  [OK] ' + name + tail);
  } else {
    fail++;
    console.log('  [!!] ' + name + tail);
  }
}

const proc = spawn(
  BROWSER,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    // profile 带上端口：并发运行时各用各的，不会互相锁目录
    '--user-data-dir=' + PROFILE_DIR,
    '--window-size=1680,1400',
    BASE_URL + '/',
  ],
  { stdio: 'ignore' },
);

(async () => {
  // 等浏览器起来并找到承载看板的那个 target
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(1000);
    try {
      const list = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list')).json();
      target = list.find((x) => x.type === 'page' && x.url.includes(HOST));
    } catch {
      /* 还没起来 */
    }
  }
  if (!target) throw new Error('未找到可调试的页面 target');

  const ws = new WebSocket(target.webSocketDebuggerUrl); // Node 22+ 内置
  let id = 0;
  const pending = new Map();
  const msgs = [];

  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    });

  ws.addEventListener('message', (e) => {
    const o = JSON.parse(e.data);
    if (o.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(o.params.type)) {
      msgs.push(
        o.params.type.toUpperCase() +
          ': ' +
          o.params.args.map((a) => a.value || a.description).join(' '),
      );
    }
    if (o.method === 'Runtime.exceptionThrown') {
      msgs.push(
        'EXCEPTION: ' +
          (o.params.exceptionDetails.exception?.description || o.params.exceptionDetails.text),
      );
    }
    if (o.id && pending.has(o.id)) {
      pending.get(o.id)(o.result);
      pending.delete(o.id);
    }
  });

  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      return 'THREW: ' + (r.exceptionDetails.exception?.description || '');
    }
    return r.result ? r.result.value : undefined;
  };
  /**
   * 按 KPI 的中文标签取它的数值，避免用下标去猜卡片顺序。
   * root 必须是一段**求值出元素**的表达式（如 document.querySelector(".drawer")），
   * 不能是 ".drawer" 这种选择器字符串——那样会拼出 '.drawer'.querySelectorAll 直接抛错。
   * 抛错时返回 null 而不是把 THREW 当字符串带出去，否则断言会"假通过"。
   */
  const kpiText = async (root, label) => {
    const v = await ev(
      '(function(){var k=[...' +
        root +
        '.querySelectorAll(".kpi")].find(function(e){return e.querySelector(".kpi-label").textContent.trim()===' +
        JSON.stringify(label) +
        ';});return k?k.querySelector(".kpi-value").textContent.trim():null;})()',
    );
    return typeof v === 'string' && v.startsWith('THREW') ? null : v;
  };
  /** 表头里有没有这一列 */
  const hasCol = async (root, label) => {
    const v = await ev(
      '[...' +
        root +
        '.querySelectorAll("th")].some(function(t){return t.textContent.indexOf(' +
        JSON.stringify(label) +
        ')>=0;})',
    );
    return v === true;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(s.data, 'base64'));
  };

  // 等看板挂载完成
  for (let i = 0; i < 30; i++) {
    if ((await ev('document.querySelectorAll(".tab").length')) === 3) break;
    await sleep(1000);
  }
  await sleep(3000);

  const V = (i) => 'document.querySelectorAll(".content > *")[' + i + ']';
  // v-show 生效时，未激活的视图 display 为 none，所以可见块数应恒为 1
  const VIS =
    '[...document.querySelectorAll(".content > *")].filter(v=>getComputedStyle(v).display!=="none").length';
  const charts =
    '[...document.querySelectorAll(".content canvas")].filter(c=>c.offsetWidth>0).length';

  console.log('【总览 tab】');
  check('KPI 卡片 6 个', (await ev(V(0) + '.querySelectorAll(".kpi").length')) === 6);
  check('图表 canvas 4 个', (await ev(charts)) === 4);
  check('仅总览可见（无叠加）', (await ev(VIS)) === 1, '可见块=' + (await ev(VIS)));

  // 品牌图标已从内联 SVG 换成 src/assets/logo.jpg。
  // 光断言 CSS 里有 url() 不够——路径写错时 url() 照样在，只是加载 404，
  // 所以真的 new Image() 加载一次，看自然尺寸。
  check(
    '品牌图标用的是图片资源',
    await ev('getComputedStyle(document.querySelector(".logo")).backgroundImage.indexOf("url(") >= 0'),
    await ev('getComputedStyle(document.querySelector(".logo")).backgroundImage.slice(0, 64)'),
  );
  const logoSize = await ev(
    '(function(){return new Promise(function(res){' +
      'var m=getComputedStyle(document.querySelector(".logo")).backgroundImage.match(/url\\((.*?)\\)/);' +
      'if(!m)return res("no-url");var i=new Image();' +
      'i.onload=function(){res(i.naturalWidth+"x"+i.naturalHeight)};' +
      'i.onerror=function(){res("load-error")};' +
      // 计算值形如 url("http://…")，匹配到的是带引号的整段，去掉首尾引号即可
      'i.src=m[1].charAt(0)===\'"\' ? m[1].slice(1,-1) : m[1];})})()',
  );
  check('图标资源能真正加载', /^\d+x\d+$/.test(String(logoSize)), String(logoSize));
  check(
    'favicon 指向同一张图',
    /\.jpg/.test(await ev('document.querySelector("link[rel=icon]")?.getAttribute("href") || ""')),
    await ev('document.querySelector("link[rel=icon]")?.getAttribute("href")'),
  );

  // 吐字速度：本地 JSONL 没有耗时字段，全靠时间线推导，是这次新增的主指标
  const speed = await kpiText(V(0), '吐字速度');
  check('吐字速度 KPI 有值', !!speed && speed !== '—' && /t\/s/.test(speed), String(speed));
  check('模型明细有吐字速度列', await hasCol(V(0), '吐字速度'));
  // 三个模型的 t/s 单元格都应有内容（不可信的也该出数，只是压淡）
  const speedCells = await ev(
    V(0) + '.querySelectorAll("table tbody tr").length && ' +
      '[...' + V(0) + '.querySelectorAll("table tbody tr")].filter(function(tr){' +
      'return tr.querySelector(".unit") && tr.querySelector(".unit").textContent.indexOf("t/s")>=0;}).length',
  );
  check('模型行带出 t/s', speedCells > 0, speedCells + ' 行');
  check('速度列标注了可信度', await ev(V(0) + '.querySelectorAll(".lowconf").length > 0'), '样本不足的模型被压淡');

  // 时间去向：三段堆叠条，宽度之和必须是 100%，否则说明分段算漏了
  check('时间去向条已渲染', await ev('!!' + V(0) + '.querySelector(".phase .track")'));
  const segSum = await ev(
    '(function(){var t=' + V(0) + '.querySelector(".phase .track");if(!t)return null;' +
      'return [...t.children].reduce(function(a,i){return a+parseFloat(i.style.width);},0);})()',
  );
  check('三段宽度合计 ≈100%', segSum !== null && Math.abs(segSum - 100) < 0.6, segSum + '%');
  const segs = await ev(V(0) + '.querySelectorAll(".phase .legend .item").length');
  check('图例三段齐全', segs === 3, segs + ' 段');

  // 工具耗时：callId 配对出来的实测值，是耗时维度里唯一不靠推导的部分
  const slowRows = await ev(V(0) + '.querySelectorAll(".slow-row").length');
  check('最慢工具列表有行', slowRows > 0, slowRows + ' 条');
  const slowVal = await ev(V(0) + '.querySelector(".slow-row .slow-val")?.textContent.trim()');
  check('最慢工具显示耗时', !!slowVal && slowVal !== '-', String(slowVal));
  await shot('01-overview.png');

  // 时间去向与慢工具在首屏之下，单独滚到底截一张，方便文档引用
  await ev('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(700);
  await shot('01b-overview-bottom.png');
  await ev('window.scrollTo(0, 0)');
  await sleep(300);

  console.log('【会话 tab】');
  await ev('document.querySelectorAll(".tab")[1].click()');
  await sleep(2200);
  check('仅会话可见', (await ev(VIS)) === 1, '可见块=' + (await ev(VIS)));
  // 会话现在按项目分组：组头是 tbody 里的 tr.group-head，会话行是 tr.srow
  const srows = await ev(V(1) + '.querySelectorAll("tbody tr.srow").length');
  check('会话行数 > 0', srows > 0, srows + ' 行');
  const stitle = await ev(V(1) + '.querySelector(".title")?.textContent');
  check('会话标题已解析', !!stitle, stitle);
  const gheads = await ev(V(1) + '.querySelectorAll("tbody tr.group-head").length');
  check('会话已按项目分组', gheads > 0, gheads + ' 组');
  check('分组默认展开（会话行数 = 会话总数）', srows === (await ev(V(1) + '.querySelector(".panel-sub").textContent.match(/共 (\\d+) 个会话/)[1] * 1')), '展开 ' + srows);
  check('会话列表有用时构成列', await hasCol(V(1), '用时构成'));
  const minis = await ev(V(1) + '.querySelectorAll("tbody tr.srow .mini-track").length');
  check('会话行渲染出用时构成条', minis > 0, minis + ' 条');
  const miniSum = await ev(
    '(function(){var t=' + V(1) + '.querySelector("tbody tr.srow .mini-track");if(!t)return null;' +
      'return [...t.children].reduce(function(a,i){return a+parseFloat(i.style.width);},0);})()',
  );
  check('构成条宽度合计 ≈100%', miniSum !== null && Math.abs(miniSum - 100) < 0.6, miniSum + '%');
  await shot('02-sessions.png');

  console.log('【分组折叠】');
  await ev(V(1) + '.querySelector("tbody tr.group-head").click()');
  await sleep(300);
  const afterFold = await ev(V(1) + '.querySelectorAll("tbody tr.srow").length');
  check('点击组头可收起该组', afterFold < srows, `收起后 ${afterFold} 行`);
  await ev(V(1) + '.querySelector("tbody tr.group-head").click()');
  await sleep(300);
  check('再点一次恢复展开', (await ev(V(1) + '.querySelectorAll("tbody tr.srow").length')) === srows);
  if (gheads > 1) {
    await ev(V(1) + '.querySelector(".panel-head .btn").click()');
    await sleep(300);
    check('「全部收起」生效', (await ev(V(1) + '.querySelectorAll("tbody tr.srow").length')) === 0);
    await ev(V(1) + '.querySelector(".panel-head .btn").click()');
    await sleep(300);
    check('「全部展开」生效', (await ev(V(1) + '.querySelectorAll("tbody tr.srow").length')) === srows);
  }

  console.log('【会话详情抽屉】');
  await ev(V(1) + '.querySelector("tbody tr.srow").click()');
  await sleep(2800);
  check('抽屉打开', await ev('!!document.querySelector(".drawer")'));
  check('上下文增长曲线 canvas', (await ev('document.querySelectorAll(".drawer canvas").length')) === 1);
  const drows = await ev('document.querySelectorAll(".drawer tbody tr").length');
  check('逐次请求明细 > 0', drows > 0, drows + ' 条');
  check('抽屉 KPI 6 个', (await ev('document.querySelectorAll(".drawer .kpi").length')) === 6);
  const dSpeed = await kpiText('document.querySelector(".drawer")', '吐字速度');
  check('抽屉吐字速度 KPI 有值', !!dSpeed && dSpeed !== '—' && /t\/s/.test(dSpeed), String(dSpeed));
  check('抽屉有耗时列', await hasCol('document.querySelector(".drawer")', '耗时'));
  const dDur = await ev(
    '[...document.querySelectorAll(".drawer tbody tr")].filter(function(tr){' +
      'var td=tr.querySelectorAll("td");return td.length>9 && td[9] && td[9].textContent.trim()!="-";}).length',
  );
  check('明细行带出耗时', dDur > 0, dDur + ' 行');
  check('抽屉有时间去向', await ev('!!document.querySelector(".drawer .phase .track")'));
  check('抽屉有最慢工具列表', (await ev('document.querySelectorAll(".drawer .slow-row").length')) > 0);
  await shot('03-session-detail.png');
  await ev('document.querySelector(".drawer .btn").click()');
  await sleep(800);

  console.log('【明细 tab】');
  await ev('document.querySelectorAll(".tab")[2].click()');
  await sleep(2200);
  check('仅明细可见', (await ev(VIS)) === 1, '可见块=' + (await ev(VIS)));
  const rrows = await ev(V(2) + '.querySelectorAll("tbody tr").length');
  check('明细行数 = 50（每页）', rrows === 50, rrows + ' 行');
  check('明细有耗时列', await hasCol(V(2), '耗时'));
  check('明细有吐字速度列', await hasCol(V(2), '吐字速度'));
  const rDur = await ev(V(2) + '.querySelector("tbody tr td:nth-child(12)").textContent.trim()');
  check('首行耗时已渲染', !!rDur && rDur !== '-', String(rDur));
  await ev(V(2) + '.querySelector("tbody tr").click()');
  await sleep(800);
  check('行展开详情', await ev('!!document.querySelector(".detail")'));
  check(
    '展开区含耗时推导字段',
    await ev('[...document.querySelectorAll(".detail .k")].some(function(e){return e.textContent.indexOf("净出字时长")>=0;})'),
  );
  await shot('04-requests.png');

  console.log('【筛选联动】');
  await ev('document.querySelectorAll(".tab")[0].click()');
  await sleep(1500);
  const before = await ev(V(0) + '.querySelector(".kpi-value").textContent');

  // 自绘下拉：点触发器 → 弹层里点选项（原生 select 已全部替换，这里同时验证替换是否成功）
  check('页面上已无原生 select', (await ev('document.querySelectorAll("select").length')) === 0);
  check('页面上已无原生 date 输入', (await ev('document.querySelectorAll("input[type=date]").length')) === 0);

  const projectTrigger = await ev(
    '[...document.querySelectorAll(".filterbar .field.sel")].map(function(e,i){' +
      'return e.textContent.indexOf("项目")>=0 ? i : -1;}).filter(function(i){return i>=0;})[0]',
  );
  await ev('document.querySelectorAll(".filterbar .field.sel")[' + projectTrigger + '].click()');
  await sleep(600);
  const popOpen = await ev('!!document.querySelector(".pop")');
  const optCount = await ev('document.querySelectorAll(".pop .opt").length');
  check('下拉弹层打开', popOpen);
  check('下拉选项已渲染', optCount > 1, optCount + ' 项');
  check('弹层已 Teleport 到 body', await ev('!!document.body.querySelector(".pop")'));
  await shot('06-select-open.png');

  // 选中第一个非「全部」的项目：不依赖任何具体项目名，换任何人的数据都能跑
  const picked = await ev(
    '(function(){var o=[...document.querySelectorAll(".pop .opt")].filter(function(x){' +
      'return x.textContent.indexOf("全部")<0;})[0];' +
      'if(!o)return null;o.click();return o.textContent.trim();})()',
  );
  await sleep(2200);
  if (picked) {
    const after = await ev(V(0) + '.querySelector(".kpi-value").textContent');
    check('项目筛选生效', before !== after, '全部=' + before + ' → ' + picked + '=' + after);
    check('选完后弹层关闭', (await ev('!!document.querySelector(".pop")')) === false);
    check('筛选后图表仍 4 个', (await ev(charts)) === 4);
    check('筛选后时间去向仍渲染', await ev('!!' + V(0) + '.querySelector(".phase .track")'));
    check('筛选后最慢工具仍有数据', (await ev(V(0) + '.querySelectorAll(".slow-row").length')) > 0);
  } else {
    console.log('  [跳过] 数据源只有一个「全部」档位，无法验证项目筛选');
  }
  await shot('07-filtered.png');

  console.log('【自绘日历】');
  const dateTrigger = '[...document.querySelectorAll(".filterbar .field.dp")][0]';
  await ev(dateTrigger + '.click()');
  await sleep(600);
  check('日历打开', await ev('!!document.querySelector(".pop .cal-grid")'));
  const dayCells = await ev('document.querySelectorAll(".pop .cal-day").length');
  check('日历渲染 6×7 网格', dayCells === 42, dayCells + ' 格');
  check('有"今天"快捷按钮', await ev('!!document.querySelector(".pop .cal-foot-btn")'));
  await shot('08-datepicker-open.png');

  // 选一个具体日期
  await ev('[...document.querySelectorAll(".pop .cal-day")].filter(function(d){return !d.classList.contains("dim");})[9].click()');
  await sleep(2200);
  check('选日期后日历关闭', (await ev('!!document.querySelector(".pop .cal-grid")')) === false);
  const dateText = await ev('document.querySelectorAll(".filterbar .field.dp")[0].textContent');
  check('起始日期已回填', /\d+月\d+日/.test(dateText), dateText.trim());
  await shot('09-date-picked.png');

  // 重置筛选
  await ev(
    '[...document.querySelectorAll(".btn")].find(function(b){return b.textContent.indexOf("重置")>=0;}).click()',
  );
  await sleep(2200);
  // 注意：本会话仍在写入 JSONL，所以不能断言"总数等于最初的值"，
  // 只能校验筛选状态本身已清空。
  const projText = await ev(
    '[...document.querySelectorAll(".filterbar .field.sel")].filter(function(e){' +
      'return e.textContent.indexOf("项目")>=0;})[0].textContent',
  );
  check('重置后项目回到「全部项目」', projText.includes('全部项目'), projText.trim());
  const fromText = await ev('document.querySelectorAll(".filterbar .field.dp")[0].textContent');
  check('重置后起始日期清空', fromText.includes('不限'), fromText.trim());
  check('重置按钮自身已隐藏', (await ev('[...document.querySelectorAll(".btn")].some(function(b){return b.textContent.indexOf("重置")>=0;})')) === false);

  console.log('【趋势粒度随区间联动】');
  // 粒度档位不是固定全开：区间决定能选哪几档（见 web/src/utils/granularity.js）
  const GSEG = 'document.querySelector(".fb-row.secondary .seg")';
  const gstate = async () =>
    JSON.parse(
      await ev(
        'JSON.stringify([...' +
          GSEG +
          '.querySelectorAll("button")].map(function(b){' +
          'return [b.textContent.trim(), b.disabled, b.classList.contains("on")];}))',
      ),
    );
  const pickRange = (label) =>
    ev(
      '[...document.querySelectorAll(".fb-row .seg-btn")].filter(function(b){' +
        'return b.textContent.trim()===' +
        JSON.stringify(label) +
        ';})[0].click()',
    );

  await pickRange('今天');
  await sleep(1800);
  let gs = await gstate();
  check(
    '「今天」→ 只留小时且自动选中',
    gs[0][1] === false && gs[0][2] === true && gs[1][1] === true && gs[2][1] === true,
    JSON.stringify(gs),
  );
  check('粒度被限定时有说明文字', await ev('!!document.querySelector(".gran-note")'));
  check('切到「今天」后图表仍渲染', (await ev(charts)) === 4);

  await pickRange('近 30 天');
  await sleep(1800);
  gs = await gstate();
  check(
    '「近 30 天」→ 只留天',
    gs[1][1] === false && gs[1][2] === true && gs[0][1] === true && gs[2][1] === true,
    JSON.stringify(gs),
  );

  console.log('【昨天】');
  // 「昨天」是闭区间（起止都给），和其它档位"只给起点"的语义不同：
  // 只给起点会变成"不限 → 昨天"，把今天之前的所有历史数据都算进来。
  await pickRange('昨天');
  await sleep(2000);
  const yHint = await ev('document.querySelector(".range-hint b").textContent.trim()');
  const todayStr = await ev(
    '(function(){var d=new Date();var p=function(n){return String(n).padStart(2,"0")};' +
      'return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());})()',
  );
  check('「昨天」提示是单日区间', /^\d{4}-\d{2}-\d{2}$/.test(yHint), yHint);
  check('「昨天」不等于今天', yHint !== todayStr, `昨天=${yHint} 今天=${todayStr}`);
  gs = await gstate();
  check(
    '「昨天」→ 只留小时（跨度 1 天，按天只有 1 根柱）',
    gs[0][1] === false && gs[0][2] === true && gs[1][1] === true && gs[2][1] === true,
    JSON.stringify(gs),
  );
  // 顺便覆盖空区间：空数据不能白屏、不能报错，图表容器和耗时段都要正常降级。
  // 「昨天」有没有数据因机器而异——恰好为空才断言降级文案，有数据就跳过这两项。
  const yRequests = await kpiText(V(0), '请求总数');
  check('区间切换后 KPI 仍渲染', yRequests !== null, yRequests);
  check('区间切换后图表容器仍在', (await ev(charts)) === 4);
  if (yRequests === '0') {
    check('空区间下时间去向给出降级文案', await ev('!!' + V(0) + '.querySelector(".phase .empty")'));
    check('空区间下最慢工具给出降级文案', await ev('!!' + V(0) + '.querySelector(".slow .empty")'));
  } else {
    console.log('  [跳过] 「昨天」有数据（' + yRequests + ' 条），空区间降级断言不适用');
  }
  await shot('11-yesterday-empty.png');

  await pickRange('全部');
  await sleep(1800);
  gs = await gstate();
  check(
    '「全部」→ 选中项必须是可用项',
    gs.some((x) => !x[1] && x[2]),
    JSON.stringify(gs),
  );

  console.log('【窄屏布局】');
  // 窗口 1680 时 6 张 KPI 在同一排，Grid 的行高问题压根不会暴露。
  // 这里把视口压到 1150（低于 1420px 断点）逼出 3 列 × 2 排的布局，
  // 才能验证「某一排的卡片比另一排高」这类只在窄屏出现的毛病。
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1150,
    height: 1500,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(900);
  await ev('document.querySelectorAll(".tab")[0].click()');
  await sleep(2000);

  const kpiH = JSON.parse(
    await ev(
      'JSON.stringify([...' +
        V(0) +
        '.querySelectorAll(".kpi")].map(function(e){return e.offsetHeight;}))',
    ),
  );
  check('窄屏下 KPI 换行成两排', kpiH.length === 6, JSON.stringify(kpiH));
  check(
    '窄屏下 6 张 KPI 卡片全部等高',
    new Set(kpiH).size === 1,
    JSON.stringify(kpiH),
  );
  check('窄屏下图表仍渲染', (await ev(charts)) === 4);
  const bdRows = await ev(V(0) + '.querySelectorAll(".bd-row").length');
  check('时间去向有按会话的下钻列表', bdRows >= 3, bdRows + ' 行');
  const bdSum = await ev(
    '(function(){var t=' + V(0) + '.querySelector(".bd-row .mini-track");if(!t)return null;' +
      'return [...t.children].reduce(function(a,i){return a+parseFloat(i.style.width);},0);})()',
  );
  check('下钻条三段合计 ≈100%', bdSum !== null && Math.abs(bdSum - 100) < 0.6, bdSum + '%');
  const bdVal = await ev(V(0) + '.querySelector(".bd-row .bd-val")?.textContent.trim()');
  check('下钻列表显示在岗时长', !!bdVal && bdVal !== '-', String(bdVal));
  // 两栏等高是 Grid 拉伸的必然结果，所以真正要量的是"内容占了多少高度"：
  // 内容只填了半张卡、下面大片留白，正是左右配对看起来别扭的原因。
  const fill = await ev(
    '(function(){var ps=' + V(0) + '.querySelectorAll(".grid2")[2].children;if(ps.length<2)return null;' +
      'var pad=ps[0].querySelector(".pad");var r=pad.getBoundingClientRect();' +
      'var bottom=Math.max(...[...pad.children].map(function(k){return k.getBoundingClientRect().bottom;}));' +
      'return Math.round((bottom-r.top)/r.height*100);})()',
  );
  check('时间去向内容填充率 > 70%', fill !== null && fill > 70, fill + '%');
  await shot('10-narrow-overview.png');

  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(600);

  console.log('【控制台】');
  check('无 error / warning', msgs.length === 0, msgs.length ? JSON.stringify(msgs) : '干净');

  console.log('\n════ 通过 ' + pass + ' 项，失败 ' + fail + ' 项 ════');
  console.log('截图已保存到 .cache/shots/');
  ws.close();
  await cleanup();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('验证失败: ' + e.message);
  await cleanup();
  process.exit(1);
});
