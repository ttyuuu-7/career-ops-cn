#!/usr/bin/env node
// ui/check-followup.mjs — 「跟进提醒」这条链路的回归
//
// 覆盖什么：
//   A 段（纯函数，无浏览器）：状态族映射、节奏计算、钉日期、挂起、追加写盘的边界。
//   B 段（Playwright 打桩）：跟进卡片能不能把该追的岗位显示对、
//      把「记一次跟进」和「推迟」两个动作的请求体送对。
//
// ⚠️ B 段**当前会整段跳过**：2026-09-22「投递台账」页撤下界面入口后，
//   `followupCardHtml()` 没有调用方，卡片没有宿主页面。脚本会自动扫一遍所有视图，
//   谁渲染了 `#fuCard` 就在谁身上测 —— 把卡片接回任意页面，B 段自动恢复。
//   A 段不受影响，而它守的才是重点（见下）。这是**已知缺口**，输出里会写明。
//
// 为什么 A 段必须有：跟进节奏是**静默失败**的重灾区 —— 算错了不会报错，
// 只会「该提醒的时候没提醒」，而这种错要过几周才会以「这个岗位怎么一直不动」
// 的形式浮现出来。所以节奏数学的每一条分支都在这里钉死。
//
// 打桩的跟进数据由**真实模块**算出来（analyzeFollowups），不是手写 fixture：
// 手写的桩会慢慢和真实返回形状漂移，而漂移之后测试照样绿。
// 模块本身对不对由 A 段负责。
//
// 前置：控制台已在 127.0.0.1:7317。
// 用法：node ui/check-followup.mjs
import { chromium } from 'playwright';
import {
  analyzeFollowups, familyOf, nextFollowupNum, appendFollowupRow, appendFollowupLine,
  followupRowLine, followupPinLine, normalizeChannel, cell, hasTableHeader,
  URGENCY_ZH, CHANNELS,
} from './followup-cn.mjs';
import { normalizeStatus } from '../followup-cadence.mjs';

const URL_BASE = 'http://127.0.0.1:7317/';
const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

// ── 造台账内容的小工具 ────────────────────────────────────────────────────
const T_HEADER = [
  '# Applications Tracker', '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|---|---|---|---|---|---|---|---|',
].join('\n');

/** 一行台账。report 用真实形状的 markdown 链接，Notes 可带 "Applied YYYY-MM-DD"。 */
function trow(num, date, company, role, status, notes = '') {
  const rep = '[' + String(num).padStart(3, '0') + '](../reports/' + String(num).padStart(3, '0') + '-x.md)';
  return '| ' + num + ' | ' + date + ' | ' + company + ' | ' + role + ' | 4.0/5 | ' + status
    + ' | ❌ | ' + rep + ' | ' + notes + ' |';
}
const trackerOf = (...rows) => T_HEADER + '\n' + rows.join('\n') + '\n';

const FU_HEADER = [
  '# Follow-ups', '',
  '| num | appNum | date | company | role | channel | contact | notes |',
  '|---|---|---|---|---|---|---|---|',
].join('\n');

/** 一条跟进表格行。 */
const fuRow = (num, appNum, date, company = '甲', role = '后端', channel = 'Email', contact = '', notes = '') =>
  '| ' + num + ' | ' + appNum + ' | ' + date + ' | ' + company + ' | ' + role + ' | ' + channel + ' | ' + contact + ' | ' + notes + ' |';

const TODAY = '2026-09-21';
/** TODAY 往前 n 天（用 UTC 午夜锚点算，与 core 的日期算术同一套口径）。 */
const daysAgo = (n) => new Date(Date.UTC(2026, 8, 21) - n * 86400000).toISOString().slice(0, 10);
const one = (content, followups = '', today = TODAY) => {
  const r = analyzeFollowups(content, followups, { today });
  return r.entries;
};

console.log('\n══ A 段：纯函数（不依赖浏览器）══');

// ── A1. 状态 → 节奏族 ────────────────────────────────────────────────────
// 这张表是本次改造的**核心**：系统层的 ACTIONABLE_STATUSES 只认
// applied/responded/interview，国内中段状态一个都不认。
console.log('\n── A1. 国内中段状态必须都进得了跟进队列 ──');
const familyCases = [
  ['Applied', 'applied'], ['已投递', 'applied'], ['已网申', 'applied'],
  ['Responded', 'responded'], ['已回应', 'responded'],
  ['简历筛选', 'responded'], ['筛选中', 'responded'],
  ['笔试', 'responded'], ['测评', 'responded'], ['Written Test', 'responded'],
  ['面试', 'interview'], ['面试中', 'interview'], ['Interview', 'interview'],
  ['初试', 'interview'], ['一面', 'interview'],
  ['复试', 'interview'], ['二面', 'interview'],
  ['终面', 'interview'], ['三面', 'interview'],
  ['谈薪', 'responded'], ['hr沟通', 'responded'],
];
let mapBad = [];
for (const [input, want] of familyCases) {
  const got = familyOf(normalizeStatus(input));
  if (got !== want) mapBad.push(input + '→' + got + '（期望 ' + want + '）');
}
ok(mapBad.length === 0, familyCases.length + ' 个中英文状态都映射到节奏族'
  + (mapBad.length ? '：' + mapBad.join('，') : ''));

// 不该进队列的：还没投的、已经结束的。进了队列就是噪音，会把这个提醒训练成没人看。
const notActionable = ['Evaluated', '待投递', 'Offer', '正式 Offer', 'Rejected', '已拒',
  'No Response', 'Discarded', '已放弃', 'SKIP', '不可投', 'Hired', '已入职'];
const leaked = notActionable.filter((s) => familyOf(normalizeStatus(s)));
ok(leaked.length === 0, notActionable.length + ' 个非在跟状态都不进队列'
  + (leaked.length ? '：漏了 ' + leaked.join('，') : ''));

// ── A2. 节奏数字从 cadenceConfig 取，不写死 ───────────────────────────────
const cfg = analyzeFollowups(trackerOf(trow(1, '2026-09-01', '甲', '后端', 'Applied')), '').cadenceConfig;
console.log('\n── A2. 已投递未回应：' + cfg.applied_first + ' 天后首次到期 ──');
// 边界两侧各取一天。日期由 cadenceConfig 推出来，不写死 ——
// profile.yml 里改过节奏之后，断言要跟着变，否则红的是测试而不是代码。
const dBefore = one(trackerOf(trow(1, daysAgo(cfg.applied_first - 1), '甲', '后端', 'Applied')), '')[0];
const dExact = one(trackerOf(trow(1, daysAgo(cfg.applied_first), '甲', '后端', 'Applied')), '')[0];
const dAfter = one(trackerOf(trow(1, '2026-09-01', '甲', '后端', 'Applied')), '')[0];
ok(dBefore && dBefore.urgency === 'waiting',
  '差一天到期时是「等回应」（' + dBefore?.daysSinceApplication + ' 天 → ' + dBefore?.urgency + '）');
ok(dExact && dExact.urgency === 'overdue',
  '刚好够 ' + cfg.applied_first + ' 天就到期（' + dExact?.daysSinceApplication + ' 天 → ' + dExact?.urgency + '）');
ok(dAfter && dAfter.daysSinceApplication === 20, '天数算对：' + dAfter?.daysSinceApplication);

// Notes 里写了真实投递日就必须以它为准（台账 date 列是评估日期）
const fromNotes = one(trackerOf(trow(1, '2026-09-01', '甲', '后端', 'Applied', 'Applied 2026-09-19；西安')), '')[0];
ok(fromNotes && fromNotes.appliedDate === '2026-09-19', 'Notes 的 Applied 日期优先于 date 列');
ok(fromNotes && fromNotes.appDateSource === 'notes', '并且标出来源是 notes（量出来的）');
ok(dAfter && dAfter.appDateSource === 'evaluation-date-fallback',
  '没有真实投递日时标成「推断」，不冒充精确值');

// ── A3. 有回应 / 面试：节奏换成 responded_subsequent ─────────────────────
console.log('\n── A3. 有回应之后节奏收紧到 ' + cfg.responded_subsequent + ' 天 ──');
const fuRecent = FU_HEADER + '\n' + fuRow(1, 2, '2026-09-20') + '\n';
const respondedQuiet = one(trackerOf(trow(2, '2026-09-10', '乙', '后端', '复试')), fuRecent)[0];
const fuOld = FU_HEADER + '\n' + fuRow(1, 2, '2026-09-16') + '\n';
const respondedStale = one(trackerOf(trow(2, '2026-09-10', '乙', '后端', '复试')), fuOld)[0];
ok(respondedQuiet && respondedQuiet.urgency === 'waiting',
  '昨天刚追过 → 等回应（' + respondedQuiet?.urgency + '）');
ok(respondedStale && respondedStale.urgency === 'overdue',
  '上次跟进过了 ' + cfg.responded_subsequent + ' 天 → 已超期（' + respondedStale?.urgency + '）');
ok(respondedStale && respondedStale.nextFollowupDate === '2026-09-19',
  '下次跟进日 = 上次跟进 + ' + cfg.responded_subsequent + ' 天：' + respondedStale?.nextFollowupDate);

// ── A4. 钉日期（推迟）优先于算出来的 ──────────────────────────────────────
console.log('\n── A4. 钉日期盖过自动节奏 ──');
const pinFuture = FU_HEADER + '\n' + followupPinLine(1, '2026-10-08', '2026-09-21') + '\n';
const pinned = one(trackerOf(trow(1, '2026-09-01', '甲', '后端', 'Applied')), pinFuture)[0];
ok(pinned && pinned.nextFollowupDate === '2026-10-08', '下次跟进日变成钉的日期');
ok(pinned && pinned.urgency === 'waiting', '钉到未来 → 不再报超期（' + pinned?.urgency + '）');

// 钉了之后又真追了一次 → 钉失效，回到自动节奏（core 的 resolveNextOverride 语义）
const pinThenLogged = FU_HEADER + '\n' + fuRow(1, 1, '2026-09-22') + '\n' + followupPinLine(1, '2026-10-08', '2026-09-21') + '\n';
const revived = one(trackerOf(trow(1, '2026-09-01', '甲', '后端', 'Applied')), pinThenLogged)[0];
ok(revived && revived.nextOverride === null, '钉之后又追过 → 钉自动失效');
ok(revived && revived.nextFollowupDate === '2026-09-29',
  '回到自动节奏（2026-09-22 + ' + cfg.applied_subsequent + ' 天）：' + revived?.nextFollowupDate);

// 序号更大/日期更晚的钉覆盖前一个
const pinTwice = FU_HEADER + '\n' + followupPinLine(1, '2026-10-01', '2026-09-18') + '\n'
  + followupPinLine(1, '2026-10-08', '2026-09-21') + '\n';
ok(one(trackerOf(trow(1, '2026-09-01', '甲', '后端', 'Applied')), pinTwice)[0]?.nextFollowupDate === '2026-10-08',
  '同一个岗位钉两次，最后一条生效');

// ── A5. 追满上限转冷 ─────────────────────────────────────────────────────
console.log('\n── A5. 追满 ' + cfg.applied_max_followups + ' 次之后不再提醒 ──');
const maxFu = FU_HEADER + '\n'
  + Array.from({ length: cfg.applied_max_followups }, (_, i) => fuRow(i + 1, 1, '2026-09-0' + (i + 2))).join('\n') + '\n';
const cold = one(trackerOf(trow(1, '2026-09-01', '甲', '后端', 'Applied')), maxFu)[0];
ok(cold && cold.urgency === 'cold', '转冷，不再占「该追」名额（' + cold?.urgency + '）');
ok(cold && cold.nextFollowupDate === null, '转冷后没有下次跟进日');

// ── A6. 挂起（cleared）不进列表 ──────────────────────────────────────────
console.log('\n── A6. 挂起的岗位不进列表，但计数可见 ──');
const clearedContent = FU_HEADER + '\n' + '- cleared #1 2026-09-21 — 没有联系方式\n';
const clearedRes = analyzeFollowups(trackerOf(trow(1, '2026-09-01', '甲', '后端', 'Applied')), clearedContent, { today: TODAY });
ok(clearedRes.entries.length === 0, '挂起的不出现在清单里');
ok(clearedRes.metadata.retired === 1, '但 metadata.retired 计数为 1');
ok(clearedRes.metadata.actionable === 0, '也不占「在跟」的条数');

// ── A7. 追加写盘的三个边界 ───────────────────────────────────────────────
console.log('\n── A7. 追加一行时的边界（写坏文件不会当场报错，只会让节奏算错）──');
const noNewline = FU_HEADER + '\n' + fuRow(1, 1, '2026-09-20') + '';   // 末尾故意没有换行
const outNoNl = appendFollowupRow(noNewline, fuRow(2, 1, '2026-09-21'));
ok(outNoNl.split('\n').filter((l) => l.startsWith('| 2 ')).length === 1,
  '末行没有换行时，新行不粘在上一行上');
ok(outNoNl.includes('| Email |  |  |\n| 2 | 1 | 2026-09-21 | 甲 | 后端 | Email |'),
  '上一行完整结束、新行另起一行（没有粘成一行）');

const noHeader = '# Follow-ups\n\n';
const outNoHeader = appendFollowupRow(noHeader, fuRow(1, 1, '2026-09-21'));
ok(hasTableHeader(outNoHeader), '缺表头时自动补上（否则这行对解析器不可见）');
ok(outNoHeader.includes('# Follow-ups'), '原来的标题行保留');

// num 只数表格行：遗留的 bullet 行和 pin 指令行都不能参与，否则会撞号
const withBullets = FU_HEADER + '\n' + fuRow(1, 1, '2026-09-20') + '\n'
  + '- 2026-09-20 · #1 甲 — 旧版 bullet 行\n'
  + followupPinLine(1, '2026-09-25', '2026-09-20') + '\n';
ok(nextFollowupNum(withBullets) === 2, 'bullet 与 pin 行不参与编号（下一个应是 2）');
ok(nextFollowupNum('') === 1, '空文件从 1 开始');
ok(nextFollowupNum('# Follow-ups\n\n| # | appNum |\n|---|---|\n') === 1,
  '表头首列写成 " # " 的老格式也认得出来');

// pin 行追加也要处理末尾换行
ok(appendFollowupLine('# Follow-ups', followupPinLine(3, '2026-10-01', '2026-09-21'))
  .includes('\n- next #3 2026-10-01 (set 2026-09-21)\n'), 'pin 行的格式与 core 的解析器一致');

// ── A8. 通道与单元格清洗 ─────────────────────────────────────────────────
console.log('\n── A8. 写进文件的一定是英文规范值、单元格一定单行无竖线 ──');
ok(normalizeChannel('领英') === 'LinkedIn', '中文「领英」→ LinkedIn');
ok(normalizeChannel('邮件') === 'Email', '中文「邮件」→ Email');
ok(normalizeChannel('linkedin') === 'LinkedIn', '大小写不敏感');
ok(normalizeChannel('微信') === 'Other', '认不出的通道回落 Other（不编一个新通道出来）');
ok(normalizeChannel('') === 'Other', '空值回落 Other');
ok(CHANNELS.join() === 'Email,LinkedIn,Phone,Other', '通道集合与 web 端一致：' + CHANNELS.join('/'));

const dirty = followupRowLine({
  num: 3, appNum: 1, date: '2026-09-21', company: '甲|乙', role: '后端\n开发',
  channel: '邮件', contact: '张|三', notes: '第一行\n第二行',
});
ok(!dirty.slice(2, -1).includes('|') || dirty.split('|').length === 10,
  '竖线被替换掉，列数没有被打乱');
ok(!/[\r\n]/.test(dirty), '换行被压平（多一行就会把表格拆成两半）');
ok(dirty.includes('| Email |'), '写入的是规范通道名');
ok(cell('a|b\nc') === 'a/b c', 'cell() 同时处理竖线与换行');

// ── B 段：界面（打桩） ──────────────────────────────────────────────────
console.log('\n══ B 段：跟进卡片（打桩；宿主页面自动发现）══');

// 桩数据：三条不同节奏的岗位 + 一条已追过的
const UI_TRACKER_ROWS = [
  trow(1, '2026-09-01', '甲科技', '后端开发工程师', 'Applied'),                 // 20 天没动静 → 超期
  trow(2, '2026-09-18', '乙网络', 'Java 开发', '复试'),                          // 面试流程 → 超期
  trow(3, '2026-09-20', '丙信息', '测试开发', '笔试'),                            // 刚投 → 等回应
];
const UI_TRACKER = { header: [], rows: UI_TRACKER_ROWS.map((l) => {
  const c = l.split('|').map((s) => s.trim());
  return { num: c[1], date: c[2], company: c[3], role: c[4], score: c[5], status: c[6], pdf: c[7], report: c[8], notes: c[9] };
}), raw: trackerOf(...UI_TRACKER_ROWS) };

const UI_FU_CONTENT = FU_HEADER + '\n' + fuRow(1, 3, '2026-09-20', '丙信息', '测试开发', 'Email', '', '发了邮件') + '\n';
const uiAnalysis = (fuContent = UI_FU_CONTENT, empty = false) => (empty
  ? analyzeFollowups(trackerOf(trow(1, '2026-09-01', '甲科技', '后端', '待投递')), '', { today: TODAY })
  : analyzeFollowups(UI_TRACKER.raw, fuContent, { today: TODAY }));

// 桩的意图：拿状态和日期跑真实模块算出分析结果，再喂给页面。
// 保证「桩的形状」永远不会和真实接口漂移。
let stubPayload = { analysis: uiAnalysis(), hasLog: true, channels: CHANNELS };
let stubEmpty = false;

const STUB_STATES = [
  { id: 'evaluated', label: 'Evaluated', cn: '待投递', description: '', terminal: false },
  { id: 'applied', label: 'Applied', cn: '已投递', description: '', terminal: false },
  { id: 'written_test', label: 'Written Test', cn: '笔试 / 测评', description: '', terminal: false },
  { id: 'second_interview', label: 'Interview 2', cn: '复试', description: '', terminal: false },
  { id: 'offer', label: 'Offer', cn: '正式 Offer', description: '', terminal: true },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);

const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

const posted = [];   // { path, body }
await page.route('**/api/states', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(STUB_STATES),
}));
await page.route('**/api/tracker', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(UI_TRACKER),
}));
await page.route(/\/api\/followups(\/log|\/defer)?$/, async (route) => {
  const req = route.request();
  if (req.method() === 'GET') {
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(stubEmpty ? { ...stubPayload, analysis: uiAnalysis('', true) } : stubPayload),
    });
  }
  const body = req.postDataJSON() || {};
  posted.push({ path: new URL(req.url()).pathname, body });

  // 写成功之后返回**重新算过**的分析结果：页面刷新靠它，而不是自己本地加加减减。
  // 这样「记一次跟进之后这条变成等回应」这件事是服务端口径说了算。
  if (req.url().endsWith('/log')) {
    const next = UI_FU_CONTENT + fuRow(9, Number(body.appNum), body.date, '甲科技', '后端开发工程师',
      normalizeChannel(body.channel), '', body.notes || '') + '\n';
    stubPayload = { analysis: uiAnalysis(next), hasLog: true, channels: CHANNELS };
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, num: 9, appNum: body.appNum, date: body.date,
        channel: normalizeChannel(body.channel), company: '甲科技', followups: stubPayload }),
    });
  }
  stubPayload = { analysis: uiAnalysis(UI_FU_CONTENT + followupPinLine(Number(body.appNum), body.date, TODAY) + '\n'),
    hasLog: true, channels: CHANNELS };
  return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, appNum: body.appNum, nextDate: body.date, company: '甲科技', followups: stubPayload }),
  });
});

const exp = stubPayload.analysis;

// ── 先找出跟进卡片的宿主页面 ────────────────────────────────────────────
//
// 2026-09-22「投递台账」页撤下界面入口后，这张卡片**当前没有任何页面在渲染它**。
// 所以这里不写死 '#tracker'：那个路由已经不在 `VIEWS` 里了，`route()` 会静默
// 落到兜底页，然后 `waitForSelector('#fuCard')` 超时 —— 看起来像卡片坏了，
// 其实是页面没了。
//
// 改成先扫一遍所有视图：谁渲染了 `#fuCard` 就在谁身上测。日后把卡片接回任意页面，
// B 段会自动复活，不需要再改这个文件。
const HOST_CANDIDATES = ['overview', 'cv', 'cvkit', 'profile', 'evaluate', 'reports', 'prep', 'tools', 'help'];
let HOST = '';
for (const v of HOST_CANDIDATES) {
  await page.goto(URL_BASE + '#' + v, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(260);
  if (await page.$('#fuCard')) { HOST = v; break; }
}

if (!HOST) {
  console.log('\n── B 段：跳过（跟进卡片当前没有宿主页面）──');
  console.log('  ⚠️  「投递台账」页 2026-09-22 撤下后 `followupCardHtml()` 没有调用方，');
  console.log('      B1–B7 的界面断言无从跑起 —— 这是**已知缺口**，不是通过。');
  console.log('      A 段（纯函数）已全跑完：节奏数学才是静默失败的重灾区，它没有降级。');
  console.log('      想恢复 B 段：把卡片接回任意视图即可，本脚本会自动认出来。');
  console.log('      眼下要用跟进提醒走 CLI（node tracker.mjs / node followup.mjs）。');
} else {

console.log('\n（跟进卡片宿主页面：#' + HOST + '）');

console.log('\n── B1. 卡片渲染 ──');
await page.goto(URL_BASE + '#' + HOST, { waitUntil: 'networkidle' });
await page.waitForSelector('#fuCard');
ok(await page.isVisible('#fuCard'), '跟进卡片渲染出来了');
const order = await page.evaluate(() => {
  const card = document.querySelector('#fuCard');
  const table = document.querySelector('.table-wrap');
  // 原来钉的是「卡片在台账表格之前」。宿主页可能没有表格，这时只要卡片
  // 在第一屏可见范围内就算过 —— 该动手的信息不该被推到屏幕外。
  if (!table) {
    const r = card.getBoundingClientRect();
    return r.top < window.innerHeight;
  }
  return (card.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
});
ok(order, '卡片没被埋到列表下面（宿主页有表格时必须在表格之前）');

console.log('\n── B2. 该追的条数与清单 ──');
const n = (await page.textContent('#fuCard .badge')).match(/\d+/);
ok(Number(n && n[0]) === exp.metadata.dueNow,
  '顶部显示该追 ' + exp.metadata.dueNow + ' 条（与算出来的 metadata.dueNow 一致）');
const rowCount = await page.$$eval('#fuCard .fu-row', (els) => els.length);
ok(rowCount === Math.min(exp.entries.length, 6), '列出 ' + rowCount + ' 条在跟岗位');

const firstHtml = await page.innerHTML('#fuCard .fu-row');
ok(firstHtml.includes(exp.entries[0].company), '第一条是紧急度最高的：' + exp.entries[0].company);
ok(firstHtml.includes(URGENCY_ZH[exp.entries[0].urgency]), '紧急度用中文显示：' + URGENCY_ZH[exp.entries[0].urgency]);
ok(/已投递|复试|笔试/.test(firstHtml), '状态显示国内叫法（不是文件里的英文规范值）');
ok(firstHtml.includes('据评估日期推算'), '推断出来的天数明确标注了（不冒充精确值）');
// hint 是纯文本容器，Markdown 粗体**不会被渲染** —— 写 `**x**` 页面上就露两个星号。
// 真实数据下就是这么漏出去的（当时只断言了行内那句），所以在这里钉一道。
ok(!(await page.innerHTML('#fuCard')).includes('**'),
  '卡片里没有露出未渲染的 Markdown 星号');
ok(firstHtml.includes('记一次跟进') && firstHtml.includes('推迟'), '两个动作按钮都在');

console.log('\n── B3. 「记一次跟进」：表单默认值与请求体 ──');
await page.click('#fuCard .fu-row [data-fulog]');
await page.waitForSelector('.modal #fuDate');
ok(await page.isVisible('.modal #fuDate'), '弹出记录跟进的表单');
const defDate = await page.inputValue('.modal #fuDate');
ok(/^\d{4}-\d{2}-\d{2}$/.test(defDate), '日期默认填今天（' + defDate + '）');
const chLabels = await page.$$eval('.modal #fuCh option', (os) => os.map((o) => o.textContent.trim()));
ok(chLabels.join('') === '邮件领英电话其他', '通道下拉是中文：' + chLabels.join('/'));
ok(await page.isVisible('.modal #fuContact'), '有联系人字段（台账 Notes 里认出来的人会预填）');

const before3 = posted.length;
await page.fill('.modal #fuDate', '2026-09-22');
await page.selectOption('.modal #fuCh', 'LinkedIn');
await page.fill('.modal #fuContact', '张经理');
await page.fill('.modal #fuNote', '发消息问了进度');
await page.click('.modal #fuOk');
await page.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 15000 });
ok(posted.length === before3 + 1, '确实发出了一次请求');
const logReq = posted[posted.length - 1];
ok(logReq.path === '/api/followups/log', '打到 /api/followups/log（不是复用别的写盘口子）');
ok(logReq.body.appNum === exp.entries[0].num, 'appNum 传对：' + logReq.body.appNum);
ok(logReq.body.date === '2026-09-22', '日期传对：' + logReq.body.date);
ok(logReq.body.channel === 'LinkedIn', '通道传规范值：' + logReq.body.channel);
ok(logReq.body.contact === '张经理', '联系人传对：' + logReq.body.contact);
ok(logReq.body.notes === '发消息问了进度', '备注传对');

console.log('\n── B4. 记完之后按服务端返回的结果重画 ──');
await page.waitForSelector('#fuCard');
const afterCard = await page.textContent('#fuCard');
ok(afterCard.includes(String(exp.metadata.dueNow - 1)),
  '该追条数按服务端重新算的结果下降（' + exp.metadata.dueNow + ' → ' + (exp.metadata.dueNow - 1) + '）');
// 原来的断言是「台账表格还在（重画没把页面搞成半截）」。宿主页不一定有表格，
// 改成检查**当前视图**没有被重画成半截：卡片还在，且视图里有实际内容。
ok(await page.isVisible('#fuCard')
  && ((await page.textContent('#view')) || '').trim().length > 40,
  '重画之后页面没变成半截（卡片与视图内容都在）');

console.log('\n── B5. 取消不发请求 ──');
const before5 = posted.length;
await page.click('#fuCard .fu-row [data-fulog]');
await page.waitForSelector('.modal #fuCancel');
await page.click('.modal #fuCancel');
await page.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 10000 });
ok(posted.length === before5, '取消后没有发出任何请求');

console.log('\n── B6. 「推迟」：early date 挡在服务端，前端带 min ──');
await page.click('#fuCard .fu-row [data-fudefer]');
await page.waitForSelector('.modal #fuNext');
const minAttr = await page.getAttribute('.modal #fuNext', 'min');
ok(/^\d{4}-\d{2}-\d{2}$/.test(minAttr || ''), '日期选择器带 min（不能选过去的日期）:' + minAttr);
const before6 = posted.length;
await page.fill('.modal #fuNext', '2026-10-08');
await page.click('.modal #fuOk');
await page.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 15000 });
const deferReq = posted[posted.length - 1];
ok(posted.length === before6 + 1 && deferReq.path === '/api/followups/defer',
  '打到 /api/followups/defer');
ok(deferReq.body.date === '2026-10-08', '推迟日期传对：' + deferReq.body.date);

console.log('\n── B7. 没有在跟岗位时给解释，而不是一张空卡片 ──');
stubEmpty = true;
// 绕一圈再回来，逼视图重建（同 hash 直接 goto 不会重建视图）
await page.evaluate(() => { window.location.hash = '#overview'; });
await page.waitForTimeout(300);
await page.evaluate((h) => { window.location.hash = '#' + h; }, HOST);
await page.waitForSelector('#fuCard');
await page.waitForTimeout(400);
ok(await page.isVisible('#fuCard'), '卡片仍在（空不等于不显示）');
const emptyTxt = await page.textContent('#fuCard');
ok(/还没有在跟的岗位|待投递/.test(emptyTxt), '说明为什么没有条目');
ok(/待投递|不需要跟进/.test(emptyTxt), '点明了「待投递」不参与跟进');
ok((await page.$$eval('#fuCard .fu-row', (e) => e.length)) === 0, '没有渲染出任何行');

} // ── B 段结束（HOST 未找到时整段跳过）──

console.log('\n── B8. 控制台错误 ──');
ok(errs.length === 0, '0 个控制台错误' + (errs.length ? '：' + errs.slice(0, 2).join(' | ') : ''));

await browser.close();
console.log('\n' + (fail.length
  ? '✗ 失败 ' + fail.length + ' 项：\n  - ' + fail.join('\n  - ')
  : (HOST ? '✓ 全部通过（A 段纯函数 + B 段界面）' : '✓ 全部通过（A 段纯函数；B 段因无宿主页面跳过）')));
process.exitCode = fail.length ? 1 : 0;
