#!/usr/bin/env node
// ui/check-cover.mjs — 「生成求职信」这条链路的回归
//
// 覆盖什么：简历工具页那块卡片（#clCard）能不能把输入送对、把稿子显示对。
// 求职信是**只出稿**的任务（没有写回、没有落盘），所以这里不需要管文件副作用，
// 要守的是三件事：
//   1. 没有 JD 就发请求 —— 生成出来的通用信正是要避免的东西，必须挡在本地；
//   2. 请求体字段对不对（target / company / role / question 少一个，稿子就不贴岗）；
//   3. 生成的稿子能不能留在页面上（切页回来还在）—— 状态挂 S.cover，不挂 DOM。
//
// 默认打桩：拦截 /api/cover 返回固定稿子，秒级、零 token。
// 加 --live 才真调一次 AI（会消耗额度，本地模型也要几十秒）。
//
// 前置：控制台已在 127.0.0.1:7317。
// 用法：node ui/check-cover.mjs [--live]
import { chromium } from 'playwright';

const URL_BASE = 'http://127.0.0.1:7317/';
const LIVE = process.argv.includes('--live');

// 桩稿子：刻意用 Markdown 结构，验证渲染走的是 mrToHtml 那条路（不是当纯文本贴出来）
const STUB_LETTER = [
  'SUBJECT: 应聘后端开发工程师 —— 承德某某科技',
  '',
  '# 尊敬的招聘负责人',
  '',
  '我是河北某高校 2027 届计算机专业学生，关注贵司的后端开发工程师岗位。',
  '',
  '- 熟悉 Java 与 MySQL',
  '- 有课程项目经历',
].join('\n');

// 引擎桩：CLI 可用 → 卡片按钮应可点。
// （不打这个桩的话，档位停在本地模型且服务没起时按钮是禁用的，测试会假红。）
const STUB_STATUS = {
  available: true, choice: 'cli', active: 'cli', activeLabel: 'CodeBuddy Code（桩）',
  unavailableText: '', writeCapable: true, writeBlockedText: '桩',
  engines: [
    { id: 'auto', label: '自动', desc: '桩', available: true, writeCapable: true },
    { id: 'cli', label: 'CodeBuddy', desc: '桩', available: true, writeCapable: true },
    { id: 'ollama', label: '本地模型', desc: '桩', available: true, writeCapable: false },
  ],
  cli: 'CodeBuddy Code（桩）', entry: 'stub', cliAvailable: true,
  ollama: { alive: true, base: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', models: [], error: '' },
  port: '桩', threshold: 3, autoPdf: 4,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(LIVE ? 900000 : 30000);

const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

// 打桩状态下发出去的请求体都记下来（断言字段有没有送对）
const postedBodies = [];
// 让桩可以在「成功」和「失败」之间切换，用来测失败提示那条分支
let stubFail = false;

if (!LIVE) {
  await page.route('**/api/cover', async (route) => {
    postedBodies.push(route.request().postDataJSON() || {});
    await new Promise((r) => setTimeout(r, 300));
    const payload = stubFail
      ? { ok: false, code: -1, ms: 1200, cli: '桩', output: '', stderr: '桩：模拟引擎报错', friendly: '桩：AI 没有返回任何内容。' }
      : { ok: true, code: 0, ms: 4100, cli: '桩', output: STUB_LETTER, stderr: '', friendly: '', cvLabel: '原版 cv.md' };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route(/\/api\/ai-(status|engine)/, (route) => {
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

console.log('\n模式：' + (LIVE ? '真实 AI（会消耗额度）' : '打桩（秒级）'));

console.log('\n── 1. 打开简历工具页 ──');
await page.goto(URL_BASE + '#cvkit', { waitUntil: 'networkidle' });
await page.waitForSelector('#clCard');
ok(await page.isVisible('#clCard'), '求职信卡片存在');
ok(await page.isVisible('#clJd'), 'JD 输入框存在');
ok(await page.isVisible('#clTarget'), '简历版本选择器存在');
ok((await page.inputValue('#clTarget')) === 'base', '默认用原版简历');
ok(!(await page.isVisible('#clCopy')), '还没生成时「复制正文」隐藏');

console.log('\n── 2. 没有 JD 就点生成：本地拦住，不发请求 ──');
const before = postedBodies.length;
await page.click('#clGo');
await page.waitForTimeout(400);
ok(postedBodies.length === before, '没有发出请求');
ok((await page.textContent('#clHint')).includes('先把 JD 粘进来'), '提示说清了为什么需要 JD');

console.log('\n── 3. 填全输入 → 生成' + (LIVE ? '（真跑）' : '（打桩）') + ' ──');
await page.fill('#clCompany', '承德某某科技');
await page.fill('#clRole', '后端开发工程师');
await page.fill('#clJd', '岗位职责：负责服务端开发。任职要求：2027 届本科，熟悉 Java、MySQL。');
await page.fill('#clQuestion', '为什么选择我们公司？');
await page.click('#clGo');
await page.waitForFunction(
  () => !!document.querySelector('#clOut .md'),
  null, { timeout: LIVE ? 900000 : 30000 },
);
ok(true, '生成完成并渲染出结果区');

if (!LIVE) {
  const body = postedBodies[postedBodies.length - 1] || {};
  ok(String(body.jd).includes('2027 届'), '请求体带上 JD');
  ok(body.company === '承德某某科技', '请求体带上公司名：' + body.company);
  ok(body.role === '后端开发工程师', '请求体带上岗位名：' + body.role);
  ok(body.question === '为什么选择我们公司？', '请求体带上开放题');
  ok(body.target === 'base', '请求体带上简历版本（默认 base）');
}

const outHtml = await page.innerHTML('#clOut');
ok(/<h1|<h2|<p|<li/.test(outHtml), '稿子按 Markdown 渲染（不是一整块纯文本）');
ok((await page.textContent('#clOut')).includes('SUBJECT'), '邮件主题行也显示出来了');
ok(await page.isVisible('#clCopy'), '有稿子后「复制正文」出现');
ok((await page.textContent('#clHint')).includes('写好了'), '状态提示说生成完成');

console.log('\n── 4. 切走再切回：稿子不该丢 ──');
await to('#overview');
await page.waitForTimeout(300);
ok(!(await page.isVisible('#clCard')), '离开后卡片不在（视图被重建）');
await to('#cvkit');
await page.waitForSelector('#clCard');
await page.waitForTimeout(300);
ok(await page.isVisible('#clOut .md'), '切回后稿子仍在（状态挂在 S.cover）');
ok((await page.inputValue('#clJd')).includes('2027 届'), '切回后 JD 还在');
ok((await page.inputValue('#clCompany')) === '承德某某科技', '切回后公司名还在');
ok(await page.isVisible('#clCopy'), '切回后复制按钮仍在');

if (!LIVE) {
  console.log('\n── 5. 失败分支：友好文案 + 原始输出 ──');
  stubFail = true;
  await page.click('#clClear');
  await page.waitForTimeout(200);
  await page.fill('#clJd', '岗位职责：测试失败分支。');
  const beforeFail = postedBodies.length;
  await page.click('#clGo');
  await page.waitForFunction(
    () => /没有返回任何内容|未完成|失败/.test(document.querySelector('#clHint').textContent),
    null, { timeout: 20000 },
  );
  ok(postedBodies.length === beforeFail + 1, '确实发了请求');
  ok((await page.textContent('#clHint')).includes('没有返回任何内容'),
    '显示服务端给的友好文案，而不是裸退出码');
  ok(await page.isVisible('#clLog'), '原始输出/报错展开给用户看');
  ok(!(await page.isVisible('#clCopy')), '失败时复制按钮不出现');
  stubFail = false;
}

console.log('\n── 6. 清空复位 ──');
await page.click('#clClear');
await page.waitForTimeout(300);
ok((await page.inputValue('#clJd')) === '', 'JD 已清空');
ok((await page.inputValue('#clCompany')) === '', '公司名已清空');
ok(!(await page.isVisible('#clOut .md')), '结果区收起');
ok(!(await page.isVisible('#clCopy')), '复制按钮隐藏');
ok(!(await page.isVisible('#clLog')), '日志收起');

console.log('\n── 7. 控制台错误 ──');
ok(errs.length === 0, '0 个控制台错误' + (errs.length ? '：' + errs.slice(0, 2).join(' | ') : ''));

await browser.close();
console.log('\n' + (fail.length ? '✗ 失败 ' + fail.length + ' 项：\n  - ' + fail.join('\n  - ') : '✓ 全部通过'));
process.exitCode = fail.length ? 1 : 0;
