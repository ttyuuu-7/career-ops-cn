#!/usr/bin/env node
// ui/check-cn-states.mjs — 国内求职阶段的显示回归
//
// 为什么单独有它：状态表把投递阶段从中段的粗粒度（Evaluated / Responded /
// Interview）换成了国内求职阶段（待投递 / 已投递 / 简历筛选 / 笔试测评 /
// 初试 / 复试 / 终面 / 谈薪 / 无回应）。换的是**展示层**，
// 投递记录文件里仍然写规范英文值。
//
// ⚠️ 2026-09-22 「投递台账」页撤下界面入口后，本脚本的第 1–3 段（徽标 / 筛选
// 下拉 / 改状态弹层）失去了宿主页面。保留的是**不依赖页面**的那几条契约：
//   · /api/states 必须每个状态都带 cn 中文显示名（§0）
//   · 中文只用于显示，存储值仍是英文 id（由 templates/states.yml 与
//     set-status.mjs 保证，§0 的 byId 映射就是这条契约的投影）
// 页面级的徽标渲染断言暂缺 —— 等「面试备考建议」页的岗位状态展示定下来再补，
// 不要为了跑通而把断言改到别的页面上，那样等于没测。
//
// 状态表不打桩：直接读服务端真实的 /api/states（它读 templates/states.yml），
// 这样 states.yml 一改，测试立刻能看出界面有没有跟上。
//
// 前置：控制台已在 127.0.0.1:7317。
// 用法：node ui/check-cn-states.mjs
import { chromium } from 'playwright';

const URL_BASE = 'http://127.0.0.1:7317/';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);

const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

// ── 0. 接口契约：/api/states 必须带 cn ─────────────────────────────────────
console.log('\n── 0. /api/states 返回中文显示名 ──');
const api = await page.request.get(URL_BASE + 'api/states');
const states = await api.json();
ok(Array.isArray(states) && states.length >= 16, `状态数量 ${states.length}（应为 16）`);
const missingCn = states.filter((s) => !s.cn);
ok(missingCn.length === 0,
  missingCn.length ? `有 ${missingCn.length} 个状态缺 cn：${missingCn.map((s) => s.id).join(', ')}` : '每个状态都有 cn 中文显示名');

const byId = Object.fromEntries(states.map((s) => [s.id, s]));
for (const [id, cn] of [
  ['applied', '已投递'], ['screening', '简历筛选'], ['written_test', '笔试 / 测评'],
  ['first_interview', '初试'], ['second_interview', '复试'], ['final_interview', '终面'],
  ['salary_negotiation', '谈薪 / HR 沟通'], ['no_response', '无回应'],
]) {
  ok(byId[id] && byId[id].cn === cn, `${id} → 「${cn}」`);
}

// 显示名必须都是中文（或含中文），不能悄悄变回英文 label
const asciiOnlyStates = states.filter((s) => s.cn && !/[\u4e00-\u9fa5]/.test(s.cn));
ok(asciiOnlyStates.length === 0,
  asciiOnlyStates.length ? `这些状态的 cn 不含中文：${asciiOnlyStates.map((s) => s.id).join(', ')}`
    : '每个 cn 都含中文（没有悄悄回落到英文）');

// ── 1. 页面可访问性：撤下台账页后不能留下死链 ───────────────────────────────
console.log('\n── 1. 导航里不再有投递台账入口 ──');
await page.goto(URL_BASE + '#overview', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const navText = await page.textContent('#nav').catch(() => '');
ok(!/投递台账/.test(navText || ''), '导航里已无「投递台账」入口');
// 2026-10-10 换肤：导航 5 项 = 工作台/我的简历/目标岗位/提升计划/投递记录。
// 台账页（#tracker）依旧不在导航里 —— 这条断言守的东西没变。
ok(/提升计划/.test(navText || ''), '导航含「提升计划」');
const navCount = await page.$$eval('#nav a', (els) => els.length).catch(() => 0);
ok(navCount === 6, `导航应为 6 项（新皮肤顶栏，含自动投递），实际 ${navCount}`);

// 旧 hash 直连不能白屏：app.js 对未知视图有兜底（route 会回落总览）
await page.goto(URL_BASE + '#tracker', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
const legacy = await page.evaluate(() => ({
  title: (document.querySelector('#pageTitle') || {}).textContent || '',
  hash: location.hash,
  blank: !(document.querySelector('#view') || {}).textContent.trim(),
}));
ok(!legacy.blank, '#tracker 旧链接不白屏（页面有内容）');

// ── 5. 控制台错误 ─────────────────────────────────────────────────────────
console.log('\n── 5. 控制台错误 ──');
ok(errs.length === 0, errs.length ? `${errs.length} 个错误：${errs[0]}` : '0 个控制台错误');

await browser.close();

console.log('');
if (fail.length) {
  console.log(`✗ ${fail.length} 项未通过`);
  fail.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
} else {
  console.log('✓ 全部通过');
}
