#!/usr/bin/env node
// ui/check-eval-flow.mjs — 评估页的流程与状态机测试
//
// 覆盖 check-ui.mjs 和 check-eval-parse.mjs 之间的空档：
// 「前端表单 → /api/eval → 渲染」这条接线。那两个测试分别只管布局和解析，
// 接线断了谁都发现不了。
//
// 默认**打桩**（stub）跑：拦截 /api/eval 返回固定数据，
// 于是断言精确、秒级完成、不消耗 AI 额度——适合每次改完前端就跑。
// 加 `--live` 才真的调一次 AI（约 40 秒，消耗额度），用于验证接线本身没断。
//
// 第 8–10 步专门守「评估会话」这条线：切页会把整个视图重建，
// 如果结果直接写在 DOM 上就会丢；请求在飞的时候切走还会去写已 detach 的
// 节点（抛 Cannot set properties of null）。所以打桩刻意**延迟返回**，
// 给「运行中切走」留出窗口。
//
// 前置：控制台已在 127.0.0.1:7317。
// 用法：
//   node ui/check-eval-flow.mjs           # 打桩，快
//   node ui/check-eval-flow.mjs --live    # 真跑一次初筛
import { chromium } from 'playwright';

// 前置：控制台已在 127.0.0.1:7317。也可以传地址换端口（和 check-ui 一致）：
//   node ui/check-eval-flow.mjs http://127.0.0.1:7320/
const URL_BASE = (process.argv.find((a) => a.startsWith('http')) || 'http://127.0.0.1:7317/')
  .replace(/\/*$/, '/');
const LIVE = process.argv.includes('--live');

// 打桩延迟：让「请求还在飞」成为一个可测试的窗口，而不是靠运气抢时机
const DELAY = 600;

// 打桩用的固定响应：刻意用「层级」这个实跑出现过的标签，
// 顺带验证前端确实在用服务端的结构化字段，而不是自己又解析一遍原文
const TRIAGE = {
  ok: true, phase: 'triage', cli: 'stub', ms: 28000, code: 0,
  timeout: false, retried: false, wroteReport: true, newReports: [],
  output: '评分：4.5/5\n结论：通过\n层级：强匹配\n原因：硬门槛全过。',
  stderr: '', friendly: '',
  triage: { score: 4.5, verdict: 'PASS', tier: '强匹配', why: '硬门槛全过，技术栈与方向完全契合。' },
};

const FULL = {
  ok: true, phase: 'full', cli: 'stub', ms: 620000, code: 0,
  timeout: false, retried: false, wroteReport: true,
  newReports: ['001-unknown-2026-09-17.md'],
  output: '报告已写入 reports/001-unknown-2026-09-17.md',
  stderr: '', friendly: '', triage: null,
};

// 报告列表也打桩：否则断言会随 reports/ 目录里真正有几份报告而漂移
const REPORTS = [{
  file: '001-unknown-2026-09-17.md', title: '桩 · 后端开发工程师', score: '4.5/5',
  archetype: '强匹配', date: '2026-09-17', legitimacy: '高',
}];

// 引擎状态的桩：CLI 可用、能写文件 → 「生成完整报告」应该是可点的。
// 形状必须和 /api/ai-status 的真实返回一致，否则打桩反而测不出问题。
const STUB_STATUS = {
  available: true, choice: 'cli', active: 'cli', activeLabel: 'CodeBuddy Code（桩）',
  unavailableText: '', writeCapable: true, writeBlockedText: '桩：本地模型不能写文件',
  engines: [
    { id: 'auto', label: '自动', desc: '桩', available: true, writeCapable: true },
    { id: 'cli', label: 'CodeBuddy', desc: '桩', available: true, writeCapable: true },
    { id: 'ollama', label: '本地模型', desc: '桩', available: true, writeCapable: false },
  ],
  cli: 'CodeBuddy Code（桩）', entry: 'stub', cliAvailable: true,
  ollama: {
    alive: true, base: 'http://127.0.0.1:11434', model: 'qwen2.5:7b',
    models: ['qwen2.5:7b'], error: '',
  },
  port: '桩', threshold: 3, autoPdf: 4,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(LIVE ? 600000 : 30000);

const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

// 打桩模式下每次打到 /api/eval 的请求体都记在这里（live 模式没人往里写，
// 4b 段会看到空数组并自动跳过依赖它的断言）。
const postedBodies = [];

if (!LIVE) {
  await page.route('**/api/eval', async (route) => {
    const body = route.request().postDataJSON() || {};
    postedBodies.push(body);
    await new Promise((r) => setTimeout(r, DELAY));
    const payload = body.phase === 'full' ? FULL : TRIAGE;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route(/\/api\/reports$/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(REPORTS),
  }));
  await page.route(/\/api\/report\?/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ markdown: '# 桩报告\n\n用于验证报告按钮的接线。' }),
  }));
  // 引擎状态也要打桩。**不打的话这一整个测试会随用户当前档位飘**：
  // 档位停在「本地模型」时前端会把「生成完整报告」禁掉（它写不了文件，
  // 这是设计如此），第 10 段等按钮改状态必然超时 —— 看着像接线断了，
  // 其实只是档位不对。这里给一个「CLI 可用、能写文件」的桩。
  await page.route(/\/api\/ai-(status|engine)/, (route) => {
    if (route.request().url().includes('/test')) {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, ms: 1, sample: '桩' }),
      });
    }
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, saved: { engine: 'cli' }, status: STUB_STATUS }),
      });
    }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(STUB_STATUS),
    });
  });
}

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };
const to = (hash) => page.evaluate((h) => { window.location.hash = h; }, hash);

console.log('\n模式：' + (LIVE ? '真实 AI（约 40 秒）' : '打桩（秒级）'));

console.log('\n── 1. 打开评估页 ──');
await page.goto(URL_BASE + '#evaluate', { waitUntil: 'networkidle' });
await page.waitForSelector('#evGo');
ok(await page.isVisible('#evGo'), '主按钮存在');
ok((await page.textContent('#evGo')).includes('开始AI评估'), '主按钮文案是「开始AI评估」');
ok((await page.textContent('#evState')).trim() === '待评估', '初始状态徽标「待评估」');
ok(await page.isVisible('#evDrop'), '上传洼地存在（mockup 上传卡）');
ok(await page.isVisible('#evUseEditor'), '「读取在线简历编辑器内容」入口存在');

// 测试用的 JD 文本（>200 字，接近真实粘贴的岗位描述）
const JD_TEXT = ('岗位职责：负责公司核心业务后端系统的设计与开发，参与微服务架构演进。'
  + '任职要求：1. 本科及以上学历，计算机相关专业；2. 熟悉 Java 语言，理解集合、并发与 JVM 常用机制；'
  + '3. 熟悉 MySQL 与 Redis，了解索引原理与缓存设计；4. 有 Spring Boot 项目经验，'
  + '了解常见中间件（Kafka/RocketMQ）；5. 有良好的沟通能力与团队协作意识。'
  + '加分项：有高并发场景实践经验，或参与过开源项目。我们提供有竞争力的薪酬与完善的成长体系，'
  + '期待与优秀的你一起把产品做到最好。这是为了凑足长度的补充句，岗位要求以技术条目为主。').repeat(2);

console.log('\n── 2. 空提交被拦截 ──');
let posted = 0;
page.on('request', (r) => { if (r.url().includes('/api/eval')) posted += 1; });
await page.click('#evGo');
await page.waitForTimeout(400);
ok(posted === 0, '空提交没有发出请求');

console.log('\n── 3. 超长 JD 被拦截 ──');
await page.fill('#evJd', 'x'.repeat(30001));
await page.click('#evGo');
await page.waitForTimeout(400);
ok(posted === 0, '超过 3 万字符的 JD 没有发出请求');
await page.fill('#evJd', '');

console.log('\n── 4. 填入 JD ──');
await page.fill('#evJd', JD_TEXT);
ok((await page.inputValue('#evJd')).length > 200, 'JD 已填入（' + (await page.inputValue('#evJd')).length + ' 字符）');

console.log('\n── 4b. 批量初筛（卡在「全部脚本」页，#108 起迁出评估页） ──');
// 批量是**前端编排**：逐条调 /api/eval（phase=triage）。打桩下三条各等 DELAY，
// 正好验证「跑一条画一行」和「全部跑完」两种状态。
if (!LIVE) {
  await to('#tools');
  await page.waitForSelector('#evBatchGo');
  ok(await page.isVisible('#evBatchJd'), '批量输入框存在');
  await page.click('#evBatchDemo');
  await page.waitForTimeout(200);
  const countTxt = (await page.textContent('#evBatchCount')).trim();
  ok(countTxt.includes('3 个岗位'), '识别出 3 个岗位：' + countTxt);

  const beforeBatch = postedBodies.length;
  await page.click('#evBatchGo');
  // 先抓「跑到一半」的样子：表格应该已经铺满占位行（而不是跑一条冒一行）
  await page.waitForFunction(
    () => document.querySelectorAll('#evBatchOut tbody tr').length === 3,
    null, { timeout: 10000 },
  );
  const placeholderRows = await page.$$eval('#evBatchOut tbody tr', (t) => t.length);
  ok(placeholderRows === 3, '占位行立刻铺满 3 行（不用等第一条返回），实际 ' + placeholderRows);
  const pendingTxt = await page.textContent('#evBatchOut');
  ok(pendingTxt.includes('待跑') || pendingTxt.includes('跑着呢'), '未跑的行标为待跑/跑着呢，不是失败');
  ok(!/退出码/.test(pendingTxt), '未跑的行不显示「失败：退出码」之类的假错误');

  await page.waitForFunction(
    () => /跑完/.test(document.querySelector('#evBatchOut').textContent),
    null, { timeout: 40000 },
  );
  const bodies = postedBodies.slice(beforeBatch);
  ok(bodies.length === 3, '一共发了 3 次初筛请求，实际 ' + bodies.length);
  ok(bodies.every((b) => b.phase === 'triage'), '每次都是 triage 阶段（批量不写报告）');
  ok(bodies.some((b) => String(b.jd).includes('示例科技')), '请求体带的是切块后的单条 JD');
  // 互斥性断言：每条请求只能含「自己那一个」岗位，且不能残留分隔线。
  // 注意别写成「任何请求都不含某个岗位名」—— 那一条自己就是那个岗位（写错过）。
  const NAMES = ['示例科技', '示例网络', '示例智能'];
  const polluted = bodies.filter((b) => {
    const jd = String(b.jd);
    const self = NAMES.filter((n) => jd.includes(n));
    if (self.length !== 1) return true;                          // 没命中或命中多个都不对
    if (/^---\s*$/m.test(jd)) return true;                        // 分隔线不该进 prompt
    return NAMES.some((n) => n !== self[0] && jd.includes(n));    // 混入别人的内容
  });
  ok(polluted.length === 0, '每条请求只含自己那一个岗位、无分隔线，污染 ' + polluted.length + ' 条');

  const rows = await page.$$eval('#evBatchOut tbody tr', (trs) => trs.map((tr) => ({
    label: tr.children[1].textContent.trim(),
    score: tr.children[2].textContent.trim(),
    verdict: tr.children[3].textContent.trim(),
  })));
  ok(rows.length === 3, '表格 3 行');
  ok(rows.every((r) => /\d(?:\.\d)?\/5/.test(r.score)), '每行都有分数：' + rows.map((r) => r.score).join(' / '));
  ok(rows.every((r) => r.verdict.includes('通过')), '结论已中文化');

  // 排序切换：分数降序 ↔ 粘贴顺序
  await page.click('[data-batch-sort]');
  await page.waitForTimeout(150);
  const orderFirst = (await page.$eval('#evBatchOut tbody tr', (tr) => tr.children[1].textContent.trim()));
  ok(orderFirst.includes('示例科技'), '切到粘贴顺序后第一行是第一个岗位：' + orderFirst);
  await page.click('[data-batch-sort]');
  await page.waitForTimeout(150);

  // 复制：clipboard 在无头环境可能不可用，这里只验证按钮存在且点击不抛错
  ok(await page.isVisible('[data-batch-copy]'), '复制按钮存在');

  // 「单独细看」把这一条填回单条评估框
  await page.click('#evBatchOut tbody tr:first-child [data-batch-fill]');
  await page.waitForTimeout(200);
  const filled = await page.inputValue('#evJd');
  ok(filled.includes('示例'), '「单独细看」把 JD 填回了单条评估框');
  ok(errs.length === 0, '4b 段没有控制台报错' + (errs.length ? '：' + errs[0] : ''));
} else {
  console.log('  （live 模式跳过：批量跑 3 条真 AI 会明显拖长自检时间）');
}

console.log('\n── 4c. 选哪份简历做评估（默认原简历）──');
// 2026-10-12 用户要求：评估页能选「用哪份简历」，默认原版 cv.md。
// 服务端 /api/eval 的 cvVersion 早就支持（id 过白名单，传什么都不可能变成
// 任意文件读），这里验的是**前端接线**：选项、默认值、请求体带没带。
await to('#evaluate');
await page.waitForSelector('#evCvVer', { timeout: 15000 });
{
  const sel = await page.evaluate(() => {
    const go = document.querySelector('#evGo');
    const s = document.querySelector('#evCvVer');
    if (!go || !s) return null;
    const g = go.getBoundingClientRect();
    const r = s.getBoundingClientRect();
    return {
      sameRow: Math.abs(r.top - g.top) < 24,
      rightOfGo: r.left >= g.right - 2,
      value: s.value,
      opts: [...s.options].map((o) => o.value + '|' + o.textContent),
      note: (document.querySelector('#evCvVerNote').textContent || '').trim(),
    };
  });
  ok(!!sel, '有「选哪份简历」下拉');
  if (sel) {
    ok(sel.sameRow && sel.rightOfGo, '下拉就在「开始AI评估」右边（同一行）');
    ok(sel.value === 'base', '默认是「原简历」（实际 ' + sel.value + '）');
    ok(sel.opts[0] === 'base|原简历', '第一项是「原简历」');
    ok(sel.opts.length >= 2,
      '选项带上了简历版本（' + sel.opts.map((o) => o.split('|')[1]).join(' / ') + '）');
    ok(/原版 cv\.md/.test(sel.note), '说明点明默认用原版 cv.md：' + sel.note);
    // 上传的正文优先级高于版本，所以「选了版本」必须真的进了请求体才作数
    if (!LIVE) {
      const pick = await page.evaluate(() => {
        const s = document.querySelector('#evCvVer');
        const opt = [...s.options].find((o) => o.value !== 'base');
        if (!opt) return '';
        s.value = opt.value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return opt.value;
      });
      if (pick) {
        const n0 = postedBodies.length;
        await page.click('#evGo');
        await page.waitForFunction(
          () => /评估完成|未完成|失败/.test(document.querySelector('#evState').textContent),
          null, { timeout: 20000 },
        );
        const last = postedBodies[postedBodies.length - 1] || {};
        ok(postedBodies.length > n0, '选了版本后真的发了新请求');
        ok(last.cvVersion === pick, '请求体带着选中的 cvVersion（' + last.cvVersion + '）');
        // 切回默认也要**如实传 base**，不是把字段省掉（省了就看不出用户选了默认）
        await page.evaluate(() => {
          const s = document.querySelector('#evCvVer');
          s.value = 'base';
          s.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const n1 = postedBodies.length;
        await page.click('#evGo');
        await page.waitForFunction(
          () => /评估完成|未完成|失败/.test(document.querySelector('#evState').textContent),
          null, { timeout: 20000 },
        );
        const last2 = postedBodies[postedBodies.length - 1] || {};
        ok(postedBodies.length > n1 && last2.cvVersion === 'base',
          '切回「原简历」时 cvVersion = base');
      } else {
        console.log('  （当前没有可选版本，跳过请求体断言）');
      }
    }
    ok(errs.length === 0, '4c 段没有控制台报错' + (errs.length ? '：' + errs[0] : ''));
  }
}

console.log('\n── 4d. 目标岗位页也能选「用哪份简历」（2026-10-14）──');
// 用户要求：JD 粘贴卡里「开始评估」左边能选简历，按选的那份评估。
// 与 4c 共用同一份会话状态（evalSession().cvVersion）—— 两边选哪个都同步。
// 这里验的是**本页接线**：位置、选项、默认值，以及请求体真的带上 cvVersion。
// ⚠️ 2026-10-14 之前 runWzEval / runWzFull 都没带 cvVersion，本页评估
//    永远偷偷用原简历（选什么版本都不生效）—— 这正是本段要钉住的。
await to('#jobs');
await page.waitForFunction(() => {
  const s = document.querySelector('#wzCvVer');
  // 等选项灌完（fillWzCvVerSelect 在一次 await 之后才跑）且 CSS 生效
  // （.select 基础规则是 width:100%，没收窄前量出来是整行宽）
  return s && s.options.length >= 1 && s.getBoundingClientRect().width < 420;
}, null, { timeout: 20000 });
{
  const sel = await page.evaluate(() => {
    const btn = document.querySelector('#wzEvalNow');
    const s = document.querySelector('#wzCvVer');
    if (!btn || !s) return null;
    const g = btn.getBoundingClientRect();
    const r = s.getBoundingClientRect();
    return {
      sameRow: Math.abs(r.top - g.top) < 24,
      leftOfBtn: r.right <= g.left + 2,
      value: s.value,
      opts: [...s.options].map((o) => o.value + '|' + o.textContent),
      // 说明句已按用户要求删除（2026-10-14）—— 用「元素不存在」断言锁住，
      // 别只删断言，否则以后又被加回来没人拦。
      noteGone: !document.querySelector('#wzCvVerNote'),
      againGone: !document.querySelector('#wzEvalAgain'),
      fullNoteGone: !/完整报告会写进/.test(document.querySelector('#wzEvalOut').textContent || ''),
    };
  });
  ok(!!sel, 'JD 卡里有「选哪份简历」下拉');
  if (sel) {
    ok(sel.sameRow && sel.leftOfBtn, '下拉在「开始评估」左边（同一行）');
    ok(sel.value === 'base', '默认「原简历」（实际 ' + sel.value + '）');
    ok(sel.opts[0] === 'base|原简历', '第一项是「原简历」');
    ok(sel.opts.length >= 2,
      '选项带上了简历版本（' + sel.opts.map((o) => o.split('|')[1]).join(' / ') + '）');
    ok(sel.noteGone, '选择器下方的说明句已删掉（2026-10-14 用户要求）');
    ok(sel.againGone, '「换个岗位再评」按钮已删掉（上面就是 JD 框，属重复入口）');
    ok(sel.fullNoteGone, '「完整报告会写进历史评估…」说明已删掉');
    // 选了版本 → 请求体必须带 cvVersion；**初筛与完整报告两条路都要带**
    // （只带一条会出现「初筛用选中简历、完整报告却悄悄用回原简历」）
    if (!LIVE) {
      const pick = await page.evaluate(() => {
        const s = document.querySelector('#wzCvVer');
        const opt = [...s.options].find((o) => o.value !== 'base');
        if (!opt) return '';
        s.value = opt.value;
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return opt.value;
      });
      if (pick) {
        await page.fill('#wzJd', JD_TEXT);
        // 用 waitForResponse 等请求，别去猜界面文案（桩返回很快）
        let wait = page.waitForResponse(
          (r) => r.url().includes('/api/eval') && r.request().method() === 'POST');
        await page.click('#wzEvalNow');
        await wait;
        await page.waitForTimeout(400);
        const tri = postedBodies[postedBodies.length - 1] || {};
        ok(tri.cvVersion === pick, '初筛请求体带着选中的 cvVersion（' + tri.cvVersion + '）');
        ok(tri.phase === 'triage', '仍是 triage 初筛（没被改坏）');

        // 结果区按钮的文案与主色（2026-10-14 用户要求）
        const acts = await page.evaluate(() => {
          const f = document.querySelector('#wzEvalFull');
          const o = document.querySelector('#wzEvalOpt');
          return {
            fullCls: f ? f.className : '',
            optText: o ? o.textContent.trim() : '',
          };
        });
        ok(/pri/.test(acts.fullCls), '「生成完整报告」标蓝（主色类，实际 ' + acts.fullCls + '）');
        ok(acts.optText === '对应优化', '优化按钮改叫「对应优化」（实际 ' + acts.optText + '）');

        // 完整报告：点结果区里的按钮，请求体同样要带
        const hasFull = await page.$('#wzEvalFull');
        if (hasFull) {
          wait = page.waitForResponse(
            (r) => r.url().includes('/api/eval') && r.request().method() === 'POST');
          await page.click('#wzEvalFull');
          await wait;
          await page.waitForTimeout(400);
          const full = postedBodies[postedBodies.length - 1] || {};
          ok(full.cvVersion === pick,
            '完整报告请求体也带着同一份 cvVersion（' + full.cvVersion + '）');
          ok(full.phase === 'full', '完整报告走的是 full 阶段');
        } else {
          console.log('  （结果区没有「完整报告」按钮，跳过该条）');
        }

        // 切回默认也要如实传 base（省了字段就看不出用户选了默认）
        await page.evaluate(() => {
          const s = document.querySelector('#wzCvVer');
          s.value = 'base';
          s.dispatchEvent(new Event('change', { bubbles: true }));
        });
        wait = page.waitForResponse(
          (r) => r.url().includes('/api/eval') && r.request().method() === 'POST');
        await page.click('#wzEvalNow');
        await wait;
        await page.waitForTimeout(400);
        const back = postedBodies[postedBodies.length - 1] || {};
        ok(back.cvVersion === 'base', '切回「原简历」时 cvVersion = base');

        // 「对应优化」必须把这份 JD 带去优化页 —— 否则只是改了个按钮说法，
        // 优化页那边仍然恒发 jd=''（通用语句优化）。这里点过去，用右栏栏头
        // 验证 JD 真的被带上了（栏头会写明「针对刚评估的岗位优化」）。
        await page.click('#wzEvalOpt');
        await page.waitForSelector('#cvOptRight', { timeout: 20000 });
        await page.waitForTimeout(1500);
        const carried = await page.evaluate(() => {
          const panes = [...document.querySelectorAll('.cvopt-pane')];
          const right = panes[panes.length - 1];
          const head = right ? right.querySelector('header') : null;
          return { head: head ? (head.textContent || '').replace(/\s+/g, ' ').trim() : '' };
        });
        ok(/针对刚评估的岗位优化/.test(carried.head),
          'JD 被带到优化页（右栏栏头：' + carried.head + '）');
      } else {
        console.log('  （当前没有可选版本，跳过请求体断言）');
      }
    }
    ok(errs.length === 0, '4d 段没有控制台报错' + (errs.length ? '：' + errs[0] : ''));
  }
}

console.log('\n── 5. 跑一次评估' + (LIVE ? '（真实 AI）' : '（打桩）') + ' ──');
await to('#evaluate');
await page.waitForSelector('#evGo');
await page.fill('#evJd', JD_TEXT);
const t0 = Date.now();
await page.click('#evGo');
await page.waitForFunction(
  () => /评估完成|未完成|失败/.test(document.querySelector('#evState').textContent),
  null,
  { timeout: LIVE ? 400000 : 20000 },
);
const secs = ((Date.now() - t0) / 1000).toFixed(0);
const state = (await page.textContent('#evState')).trim();
console.log('  状态：' + state + '，耗时 ' + secs + ' 秒');
ok(state.includes('评估完成'), '评估完成（' + secs + 's）');

console.log('\n── 6. 结果渲染（mockup 匹配报告）──');
const result = await page.textContent('#evResult');
console.log('  结果：' + result.replace(/\s+/g, ' ').trim().slice(0, 80) + '…');
// 结论从「分数环 hero」升级成 mockup 的匹配报告卡（#108 重建）：
// 得分头（x/100）+ 档位结论徽标 + 雷达 + 三组分析 + 动作区。
ok(await page.isVisible('#evResult .ev-match'), '有匹配报告块（.ev-match）');
ok(await page.isVisible('#evResult .ev-v'), '有综合匹配得分（.ev-v）');
ok(/\d+\s*\/\s*100/.test(await page.textContent('#evResult .ev-v')), '得分以 x/100 形式渲染');
ok(await page.isVisible('#evResult .pill'), '有档位结论徽标（.pill）');
ok(await page.isVisible('#evResult .ev-radar svg'), '雷达图已渲染');
const groupCount = await page.$$eval('#evResult .ev-group', (els) => els.length);
ok(groupCount === 3, '三组分析都在（优势/短板/建议），实际 ' + groupCount);
const actCount = await page.$$eval('#evResult .ev-actions [data-act]', (els) => els.length);
ok(actCount === 3, '动作区有三个主按钮，实际 ' + actCount);

if (!LIVE) {
  // 打桩模式下断言可以很精确：score 4.5/5 → 90/100，档位/门槛/五分制三枚徽标。
  // 这几条就是「前端直接用服务端结构化字段」的证据。
  const v = (await page.textContent('#evResult .ev-v')).replace(/\s+/g, '');
  ok(v.includes('90'), '分数换算正确：4.5/5 → 90/100（实际 ' + v + '）');
  // 2026-10-12 新版式：第一枚徽标是服务端 TIER（桩给的是「强匹配」）
  const pill = (await page.textContent('#evResult .pill')).trim();
  ok(pill.includes('强匹配'), '档位徽标直接取服务端 TIER：' + pill);
  const pillCls = await page.getAttribute('#evResult .pill', 'class');
  ok(/pill-ok/.test(pillCls), '档位徽标是 ok 档配色：' + pillCls);
  const pills = await page.$$eval('#evResult .ev-badges .pill', (els) => els.map((e) => e.textContent.trim()));
  ok(pills.length === 3 && pills.some((x) => x.includes('已过门槛')) && pills.some((x) => x === '4.5/5'),
    '三枚徽标：档位 + 门槛 + x/5（实际 ' + JSON.stringify(pills) + '）');
  ok(await page.isVisible('#evResult .ev-why'), '有「JD 解读」段');
  ok(/硬门槛全过/.test(await page.textContent('#evResult .ev-why')), 'JD 解读渲染了服务端的 why 字段');
  ok(/耗时 \d+ 秒/.test(await page.textContent('#evResult .ev-meta')), '有耗时与引擎说明行');
  ok(result.includes('优势匹配点') && result.includes('能力短板') && result.includes('简历优化建议'),
    '三组分析的标题都已渲染');
}

console.log('\n── 7. 按钮与下一步状态机 ──');
// 2026-09-26：第一位主按钮从「手动编辑简历」换成「生成报告」（data-act="full"，
// 原次级 ghost 的生成完整报告并了进来），次级 ghost 按钮随之删除。
ok(await page.isVisible('#evResult [data-act="full"]'), '「生成完整报告」可用（不堵死低分岗位）');
ok((await page.textContent('#evResult [data-act="full"]')).includes('生成完整报告'),
  '第一位主按钮是「生成完整报告（A–H）」');
ok(await page.isVisible('#evResult [data-act="opt"]'), '「AI优化简历」入口出现');
ok(/primary/.test(await page.getAttribute('#evResult [data-act="opt"]', 'class')),
  '「AI优化简历」是主按钮');
ok(await page.isVisible('#evResult [data-act="again"]'), '「换个岗位再评」入口出现');
ok(!(await page.isVisible('#evResult [data-act="cv"]')), '「手动编辑简历」入口已移除');
ok(!(await page.isVisible('#evResult [data-act="report"]')), '初筛后「查看评估报告」隐藏（还没报告）');

console.log('\n── 8. 切走再切回：结果不该丢 ──');
// 跳板一律用 #prep（真实存在的视图）。原先用 #tracker —— 那个路由撤下之后
// goto 会静默落到兜底页，断言照样过，但「切页重建视图」这个前提其实没被验证到。
await to('#prep');
await page.waitForTimeout(300);
ok(!(await page.isVisible('#evOutCard')), '离开评估页后结果区不在（视图已被重建）');
await to('#evaluate');
await page.waitForSelector('#evGo');
await page.waitForTimeout(300);
ok(await page.isVisible('#evOutCard'), '切回后结果卡片仍在');
ok((await page.textContent('#evState')).trim().includes('评估完成'), '切回后状态徽标仍是「评估完成」');
const back = await page.textContent('#evResult');
ok(/\d+\s*\/\s*100/.test(back), '切回后分数还在：' + back.replace(/\s+/g, ' ').trim().slice(0, 44) + '…');
ok((await page.inputValue('#evJd')).length > 200, '切回后 JD 正文还在');
ok(await page.isVisible('#evResult .ev-match'), '切回后匹配报告仍在');
ok(/primary/.test(await page.getAttribute('#evResult [data-act="opt"]', 'class')),
  '切回后「AI优化简历」仍是主按钮');

console.log('\n── 9. 请求还在飞的时候切走：不崩、不丢 ──');
await page.click('#evGo');             // 开跑（打桩要等 DELAY 毫秒才返回；JD 还在输入框里）
await page.waitForTimeout(150);        // 故意在请求飞行中……
await to('#prep');                  // ……切走
await page.waitForTimeout(DELAY + 500); // 等打桩返回（回调此时不在评估页上）
ok(!(await page.isVisible('#evOutCard')), '切走期间结果区不存在（回调没能写进页面）');
await to('#evaluate');
await page.waitForSelector('#evGo');
await page.waitForTimeout(300);
const st9 = (await page.textContent('#evState')).trim();
ok(st9.includes('评估完成'), '切回后结果已就位（状态：' + st9 + '）');
ok(/\d+\s*\/\s*100/.test(await page.textContent('#evResult')), '切回后分数已渲染');

console.log('\n── 10. 完整评估 → 报告按钮 → 切页 → 切回 ──');
// 真实模式下若档位停在写不了文件的引擎上，完整报告本来就会被挡住（设计如此），
// 这时跳过而不是报失败 —— 否则用户切到「本地模型」再跑自检会看到假的红灯。
let canFull = true;
if (LIVE) {
  const st = await page.evaluate(async () => {
    const r = await fetch('/api/ai-status');
    return r.json();
  });
  // live 完整评估只在 CodeBuddy 档下跑：它 20~30 秒一单。
  // 本地模型也能出完整报告（服务端编排），但一单几分钟起步，
  // 不适合挂在自检里等 —— 想验证本地通路，在评估页手动跑一单即可。
  canFull = st.active === 'cli';
  if (!canFull) {
    console.log('  （跳过：当前档位「' + (st.activeLabel || st.choice)
      + '」的完整评估要几分钟起步，不在自检里等 —— 用评估页手动验证）');
  }
}

if (canFull) {
  await page.click('#evResult [data-act="full"]');
  await page.waitForFunction(
    () => /报告已生成|未完成|失败/.test(document.querySelector('#evState').textContent),
    null,
    { timeout: LIVE ? 900000 : 30000 },
  );
  ok((await page.textContent('#evState')).trim().includes('报告已生成'), '完整评估完成');
  ok(await page.isVisible('[data-open-report]'), '报告按钮已渲染');

  await to('#prep');
  await page.waitForTimeout(300);
  await to('#evaluate');
  await page.waitForSelector('#evGo');
  await page.waitForTimeout(300);
  ok((await page.textContent('#evState')).trim().includes('报告已生成'), '切回后仍是「报告已生成」');
  ok(await page.isVisible('[data-open-report]'), '切回后报告按钮仍在（innerHTML 恢复）');
  await page.click('[data-open-report]');
  await page.waitForSelector('#rBack');
  ok(true, '委托仍生效：点报告按钮能进详情页');
  await page.click('#rBack');
  await page.waitForSelector('#evGo');
  ok((await page.textContent('#evState')).trim().includes('报告已生成'), '从详情页返回，评估结果还在');
}

console.log('\n── 11. 整页刷新 → 会话复位 ──');
// 新评估页没有独立的「重新评估」按钮（#evAgain 已随 #108 重建移除）：
// 重跑就是改 JD 再点主按钮；会话在内存里，刷新即复位。
// 报告卡 #evOutCard 是常驻卡（空态渲染 .ev-empty），复位看内容不看卡片显隐。
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#evGo');
await page.waitForTimeout(300);
ok(await page.isVisible('#evResult .ev-empty'), '结果区回到空态');
ok(!(await page.isVisible('#evResult .ev-match')), '匹配报告收起');
ok((await page.textContent('#evState')).trim() === '待评估', '状态徽标复位为「待评估」');
ok((await page.inputValue('#evJd')) === '', 'JD 输入框清空');

console.log('\n── 12. 复位后切页回来，仍是空的（复位也被持久化）──');
await to('#prep');
await page.waitForTimeout(300);
await to('#evaluate');
await page.waitForSelector('#evGo');
await page.waitForTimeout(300);
ok(await page.isVisible('#evResult .ev-empty'), '结果区仍是空态');
ok((await page.inputValue('#evJd')) === '', 'JD 仍是空的');

console.log('\n── 13. 已删除的 #pipeline 不再白屏 ──');
await page.goto(URL_BASE + '#pipeline', { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
ok(await page.isVisible('#pageTitle'), '页面正常渲染');
// 未知 hash 的兜底目标是首页（#home 是默认落地页，2026-09-23 起）
ok((await page.evaluate(() => location.hash)) === '#home', '自动回到首页：'
  + (await page.evaluate(() => location.hash)));
ok(!(await page.isVisible('#evGo')), '没有停在评估页');

console.log('\n── 14. 控制台错误 ──');
ok(errs.length === 0, '0 个控制台错误' + (errs.length ? '：' + errs.slice(0, 3).join(' | ') : ''));

await browser.close();
console.log('\n' + (fail.length ? '✗ 失败 ' + fail.length + ' 项：\n  - ' + fail.join('\n  - ') : '✓ 全部通过'));
// 用 exitCode 而不是 process.exit()：管道下 stdout 异步，process.exit() 会丢报告
process.exitCode = fail.length ? 1 : 0;
