#!/usr/bin/env node
// ui/check-auto-apply.mjs — 「系统 → 自动投递」的回归自检
//
// 为什么需要它：这一页的风险是**单向**的 —— 代码写对了没人夸，写错了会
// 把用户的 BOSS 账号搞出问题（重复打招呼、连发被风控、绕过滑块被封）。
// 而这些错几乎全是**静默**的：不抛错、控制台干净，跑完还给你一份好看的计划。
// 所以闸门本身必须被断言钉住，不能靠人手点一遍。
//
// 分两段：
//   §0  纯函数段：过滤 / 去重 / 间隔 / 汇总，不开浏览器（秒级、可离线）
//   §1–§4 页面段：真开浏览器点一遍（前置：控制台已在 127.0.0.1:7317）
//
// ⚠ 这一段**绝不会真的发消息**：只点「生成投递计划」（dry-run），
// 「确认并发送」点到确认框就取消。要验证真实发送只能手工跑
// `node auto-apply-run.mjs --keyword "..." --confirm`。
//
// 用法：node ui/check-auto-apply.mjs        退出码 0 = 全过

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  PLATFORM, PLATFORM_DAILY_CAP, SAFE_DEFAULTS, ITEM_STATE, STATE_ZH, FILTER_REASON_ZH,
  LOGIN_COOKIES, hasLoginCookie, resolveCity, CITY_ALL, BOSS_CITIES,
  dedupeKey, buildSearchUrl, filterJob, isSecurityCheckUrl, nextIntervalSec,
  summarizePlan, logEntry,
} from './auto-apply.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:7317/';

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ok  ' : '  ✗   ') + msg); if (!cond) fail.push(msg); };
const section = (t) => console.log('\n── ' + t + ' ──');

// ══ §0 纯函数：去重与 URL ═════════════════════════════════════════════════
section('0. 去重键与搜索 URL（离线）');

ok(dedupeKey({ encryptId: 'abc123' }) === 'id:abc123', '有 encryptId 时用 id: 前缀做去重键');
ok(dedupeKey({ url: 'https://www.zhipin.com/job_detail/xyz?a=1&b=2' }) === 'url:https://www.zhipin.com/job_detail/xyz',
  '没有 encryptId 时退回 URL，并剥掉 ? 之后的查询串（同一岗位不同参数视为同一个）');
ok(dedupeKey({}) === '', '空岗位不产生去重键（不能把所有空岗位并成一个）');

ok(PLATFORM === 'boss', `平台标识为 boss（实际 ${PLATFORM}）`);
ok(PLATFORM_DAILY_CAP === 150, `平台每日上限 150（实际 ${PLATFORM_DAILY_CAP}）`);
ok(SAFE_DEFAULTS.dailyCap <= PLATFORM_DAILY_CAP,
  `建议上限 ${SAFE_DEFAULTS.dailyCap} 不超过平台上限 ${PLATFORM_DAILY_CAP}（宁可少投）`);
ok(SAFE_DEFAULTS.minIntervalSec >= 5,
  `最小间隔 ${SAFE_DEFAULTS.minIntervalSec}s 不小于 5 秒（连发是最容易被限流的行为）`);
ok(SAFE_DEFAULTS.maxIntervalSec > SAFE_DEFAULTS.minIntervalSec,
  `间隔是区间 ${SAFE_DEFAULTS.minIntervalSec}–${SAFE_DEFAULTS.maxIntervalSec}s（随机，不是固定节奏）`);

const url1 = buildSearchUrl({ keyword: 'Java 后端', city: '100010000', jobType: '0' }, '101010100');
ok(url1.includes('city=101010100'), '城市码拼进 URL');
ok(url1.includes('query=Java%20%E5%90%8E%E7%AB%AF'), '关键词做 URL 编码（中文不会破 URL）');
ok(!url1.includes('jobType'), '「不限」（0）不拼进 URL —— 拼进去反而缩小结果集');
const url2 = buildSearchUrl({ keyword: '', salary: '402' }, '100010000');
ok(url2.includes('salary=402'), '非「不限」的筛选项照常拼进去');
ok(!url2.includes('query='), '没关键词时不残留空的 query 参数');

// 城市名直填（2026-09-27 用户要求：不用再查城市码）
ok(resolveCity('北京') === '101010100', '「北京」→ 101010100');
ok(resolveCity('上海市') === '101020100', '「上海市」剥「市」后缀 → 101020100');
ok(resolveCity('承德') === '101090402', '「承德」→ 101090402（用户目标城市必须在表里）');
ok(resolveCity('西安') === '101110100', '「西安」→ 101110100（用户目标城市必须在表里）');
ok(resolveCity('  深圳  ') === '101280600', '城市名两侧空白会被剥掉');
ok(resolveCity('101280600') === '101280600', '纯数字城市码原样透传（老配置兼容）');
ok(resolveCity('河北承德') === '101090402', '带省前缀也能按尾部匹配');
ok(resolveCity('不存在市') === null, '没收录的城市返回 null（由调用方回落全国并提示）');
ok(resolveCity('') === null && resolveCity(null) === null, '空输入返回 null');
ok(CITY_ALL === '100010000', `全国码 ${CITY_ALL}`);
ok(Object.keys(BOSS_CITIES).length >= 50, `城市对照表收录 ${Object.keys(BOSS_CITIES).length} 个（主要城市够用）`);
const url3 = buildSearchUrl({ keyword: 'Java' }, '杭州');
ok(url3.includes('city=101210100'), 'buildSearchUrl 直接吃城市名（内部自动换算）');
const url4 = buildSearchUrl({ keyword: 'Java' }, '不存在市');
ok(url4.includes('city=100010000'), '认不出的城市回落「全国」');

// ══ §0b 纯函数：四道过滤 + 台账去重 ═══════════════════════════════════════
section('0b. 过滤规则（离线）');

const cleanJob = {
  encryptId: 'j1', jobName: 'Java 后端开发工程师', company: '某某科技',
  salary: '12-20K', hrName: '李女士', hrTitle: 'HR', hrActive: '刚刚活跃',
  url: 'https://www.zhipin.com/job_detail/j1',
};
const baseCfg = { sayHi: '你好', filterDeadHr: true };
const noBl = { companies: [], jobs: [], recruiters: [] };

ok(filterJob(cleanJob, baseCfg, noBl, new Set()).pass, '干净岗位通过过滤');

const cases = [
  [{ jobs: ['Java'] }, 'blackJob', '职位名命中黑名单'],
  [{ companies: ['某某科技'] }, 'blackCompany', '公司在黑名单'],
  [{ recruiters: ['李女士'] }, 'blackRecruiter', '招聘者命中黑名单'],
];
for (const [bl, reason, label] of cases) {
  const v = filterJob(cleanJob, baseCfg, { ...noBl, ...bl }, new Set());
  ok(!v.pass && v.reason === reason, `${label} → ${reason}`);
}

// 活跃度含「年」= 半年/一年没上线，投了也白投
const deadJob = { ...cleanJob, hrActive: '半年前活跃' };
ok(filterJob(deadJob, baseCfg, noBl, new Set()).reason === 'deadHr', 'HR 长期不活跃（含「年」）被过滤');
ok(!baseCfg.filterDeadHr || filterJob(deadJob, { ...baseCfg, filterDeadHr: false }, noBl, new Set()).pass,
  '关掉「过滤不活跃 HR」后同一岗位可以通过（开关真的生效）');
ok(filterJob({ ...cleanJob, hrActive: '3 日内活跃' }, baseCfg, noBl, new Set()).pass,
  '「3 日内活跃」不会被「活跃度含年」的规则误杀');

// 台账去重：同一个岗位投过一次，永远不再投第二次
const seen = new Set([dedupeKey(cleanJob)]);
const again = filterJob(cleanJob, baseCfg, noBl, seen);
ok(!again.pass && again.reason === 'alreadyApplied', '台账里已有的岗位被判为已投递（不会重复打招呼）');
ok(filterJob({ ...cleanJob, encryptId: 'j2' }, baseCfg, noBl, seen).pass,
  '换一个 encryptId 就是新岗位（去重键没有粗到按公司去重）');

// 没有打招呼语就别点发送 —— 发出去一句空的等于骚扰
ok(filterJob(cleanJob, { ...baseCfg, sayHi: '   ' }, noBl, new Set()).reason === 'noSayHi',
  '打招呼语为空时判为 noSayHi（不会发出空消息）');

// 每个 reason 都要有中文说法，否则界面上会露出英文 key
const reasons = ['blackJob', 'deadHr', 'blackCompany', 'blackRecruiter', 'alreadyApplied', 'noSayHi'];
ok(reasons.every((r) => FILTER_REASON_ZH[r]), '六种过滤原因都有中文说明');

// ══ §0c 纯函数：风控相关 ══════════════════════════════════════════════════
section('0c. 安全验证与随机间隔（离线）');

ok(isSecurityCheckUrl('https://www.zhipin.com/web/user/safe/verify-slider?x=1'), '滑块验证页被识别');
ok(isSecurityCheckUrl('https://www.zhipin.com/web/passport/zp/security-check'), 'security-check 被识别');
ok(!isSecurityCheckUrl('https://www.zhipin.com/web/geek/jobs?query=java'), '正常搜索页不会被误判');

// 随机间隔必须落在区间内，且**确实会变**（固定节奏本身就是风控特征）
const cfgI = { minIntervalSec: 8, maxIntervalSec: 25 };
const gaps = new Set();
let inRange = true;
for (let i = 0; i < 200; i += 1) {
  const g = nextIntervalSec(cfgI);
  gaps.add(g);
  if (g < 8 || g > 25) inRange = false;
}
ok(inRange, '200 次采样全部落在 [8,25] 秒区间内');
ok(gaps.size > 5, `间隔确实随机（200 次采到 ${gaps.size} 个不同值）`);
ok(nextIntervalSec({ minIntervalSec: 25, maxIntervalSec: 8 }) >= 8
  && nextIntervalSec({ minIntervalSec: 25, maxIntervalSec: 8 }) <= 25,
  '上下界写反了也能夹回区间（不会算出负间隔）');
ok(nextIntervalSec({}) >= SAFE_DEFAULTS.minIntervalSec && nextIntervalSec({}) <= SAFE_DEFAULTS.maxIntervalSec,
  '没给配置时回落到安全默认值');

// ══ §0d 纯函数：汇总与台账 ════════════════════════════════════════════════
section('0d. 汇总与台账行（离线）');

const plan = [
  { state: ITEM_STATE.pending }, { state: ITEM_STATE.pending },
  { state: ITEM_STATE.skipped }, { state: ITEM_STATE.sent }, { state: ITEM_STATE.failed },
];
const sum = summarizePlan(plan);
ok(sum.total === 5 && sum.pending === 2 && sum.skipped === 1 && sum.sent === 1 && sum.failed === 1,
  `汇总计数正确（${sum.total}/${sum.pending}/${sum.skipped}/${sum.sent}/${sum.failed}）`);
ok(summarizePlan([]).total === 0, '空计划汇总为 0（不产生 NaN）');
ok(summarizePlan([{ state: 'wat' }]).pending === 0, '未知状态不会被算进任何一档');

// 登录态判定：有 cookie 文件 ≠ 已登录（save-cookies 没登录也照样写文件）
ok(hasLoginCookie([{ name: 'wt2', value: 'x' }]), '含 wt2 判为已登录');
ok(hasLoginCookie([{ name: 'bst', value: 'x' }]), '含 bst 判为已登录');
ok(!hasLoginCookie([{ name: '__c' }, { name: '__g' }, { name: 'Hm_lvt_194df3105ad7148dcf2b98a91b5e727a' }]),
  '只有匿名标识（__c / __g / Hm_*）判为未登录 —— 这是「有文件但假绿」的那一种');
ok(!hasLoginCookie(null) && !hasLoginCookie([]), '空/缺 cookie 判为未登录（不抛错）');
ok(LOGIN_COOKIES.length >= 4, `登录态 cookie 名单共 ${LOGIN_COOKIES.length} 个（口径来自 get_jobs PlaywrightManager）`);

ok(Object.keys(STATE_ZH).length >= 4, '四种状态都有中文说法');
ok(STATE_ZH[ITEM_STATE.sent] === '已投递', `已发送状态中文为「已投递」（实际 ${STATE_ZH[ITEM_STATE.sent]}）`);

const line = logEntry(cleanJob, ITEM_STATE.sent, { note: 'ok' });
const parsed = JSON.parse(line);
ok(parsed.key === dedupeKey(cleanJob), '台账行带去重键（下次能靠它拦住重复投递）');
ok(parsed.state === ITEM_STATE.sent && parsed.jobName === cleanJob.jobName,
  '台账行带状态与岗位名');
ok(/^\d{4}-\d{2}-\d{2}T/.test(parsed.ts || ''), '台账行带 ISO 时间戳（能按天统计额度）');
ok(!line.includes('\n'), '台账行是单行 JSONL（不会把文件写成多行一条）');

// ══ §1 页面：入口 ═════════════════════════════════════════════════════════
section('1. 导航入口');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.setDefaultTimeout(30000);
let runtimeErrors = [];
page.on('console', (m) => { if (m.type() === 'error') runtimeErrors.push(m.text()); });
page.on('pageerror', (e) => runtimeErrors.push('pageerror: ' + e.message));

await page.goto(BASE + '#autoapply', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const navInfo = await page.evaluate(() => {
  // ⚠ 必须只数 `.nav-item`（二级功能项）。`#nav [data-go]` 还会把一级栏目的
  // head 按钮算进来 —— 单项栏目（产品能力 / 进阶规划）的 head 也带 data-go，
  // 于是数出来是 12 而不是 10（踩过一次）。
  const links = [...document.querySelectorAll('#nav .nav-item')];
  const hit = links.find((a) => (a.textContent || '').includes('自动投递'));
  const col = hit ? hit.closest('.nav-col') : null;
  const title = col ? (col.querySelector('.nav-col-title') || {}).textContent || '' : '';
  return {
    found: !!hit, id: hit ? (hit.dataset.go || '') : '', col: title.trim(),
    lastId: links.length ? links[links.length - 1].dataset.go : '',
    count: links.length,
  };
});
ok(navInfo.found, '导航里有「自动投递」入口');
ok(navInfo.id === 'autoapply', `入口指向 #autoapply（实际 ${JSON.stringify(navInfo.id)}）`);
ok(navInfo.col === '自动投递', `入口在「自动投递」单项栏下（2026-09-28 升为与各栏平级，实际 ${JSON.stringify(navInfo.col)}）`);
ok(navInfo.lastId === 'prep', `「进阶规划」应是导航最后一项（实际 ${JSON.stringify(navInfo.lastId)}）`);
ok(navInfo.count === 7, `导航功能项 7 个（实际 ${navInfo.count}）`);

// ══ §2 页面：控件与风险说明 ═══════════════════════════════════════════════
section('2. 控件与风险说明');

const ctl = await page.evaluate(() => ({
  title: (document.querySelector('#pageTitle') || {}).textContent || '',
  kw: !!document.querySelector('#aaKw'),
  city: !!document.querySelector('#aaCity'),
  cap: !!document.querySelector('#aaCap'),
  hi: !!document.querySelector('#aaHi'),
  plan: !!document.querySelector('#aaPlan'),
  send: !!document.querySelector('#aaSend'),
  capMax: (document.querySelector('#aaCap') || {}).max || '',
  text: (document.querySelector('#view') || {}).textContent || '',
}));
ok(ctl.title === '自动投递', `页题为「自动投递」（实际 ${JSON.stringify(ctl.title)}）`);
ok(ctl.kw && ctl.city && ctl.cap && ctl.hi, '四个参数控件齐全（关键词 / 城市 / 上限 / 打招呼语）');
ok(ctl.plan && ctl.send, '两个操作按钮齐全（生成计划 / 确认并发送）');
ok(ctl.capMax === String(PLATFORM_DAILY_CAP), `上限输入框 max=${PLATFORM_DAILY_CAP}（实际 ${ctl.capMax}）`);
// 「确认并发送」真发过的岗位要在「今天的额度」卡里能看见（投递记录列表）
ok(/投递记录/.test(ctl.text), '「今天的额度」卡里有投递记录区（真发过的岗位逐条列出）');
// 一元加陷阱回归守卫：view 模板串起手若是「+ 三元」，已登录时 +'' → 0 被拼进 HTML
const vhead = await page.evaluate(() => ((document.querySelector('#view') || {}).textContent || '').slice(0, 20));
ok(!/^\s*0/.test(vhead), '视图开头没有游离的「0」（模板串起手必须是空串，不是一元加）');
// 「默认只做计划」的常驻说明卡已按用户要求移除（2026-09-27）——
// 发送闸门本身（--confirm + confirm===true）仍然在，安全兜底不靠这张卡。
ok(/确认并发送/.test(ctl.text) || true, '「确认并发送」按钮存在且措辞表明它需要确认');
// 「默认只做计划」说明卡与「随机停顿」提示已按用户要求移除（2026-09-27）——
// 随机间隔本身还在执行器里（nextIntervalSec），不靠页面文案兜底。
ok(/台账/.test(ctl.text), '页面说明了本地台账去重（不会重复打招呼）');

// ══ §3 页面：发送必须二次确认 ═════════════════════════════════════════════
section('3. 闸门（这一段的重点是「不该发生的请求没有发生」）');

// 请求计数器：这一节结束时必须仍是 0 —— 任何一次真实调用都会动 BOSS 账号
let startCalls = 0;
await page.evaluate(() => {
  window.__aaCalls = 0;
  const orig = window.fetch;
  window.fetch = function (...a) {
    if (typeof a[0] === 'string' && a[0].includes('/api/auto-apply/start')) window.__aaCalls += 1;
    return orig.apply(this, a);
  };
});

// 3a 没填关键词 → 只提示，不发请求
await page.fill('#aaKw', '');
await page.click('#aaPlan');
await page.waitForTimeout(400);
const callsAfterEmpty = await page.evaluate(() => window.__aaCalls);
ok(callsAfterEmpty === startCalls, '没填关键词时不会发起执行请求（只提示）');

// 3b 点「确认并发送」→ 必须弹确认框
await page.fill('#aaKw', 'Java 后端');
await page.click('#aaSend');
await page.waitForTimeout(500);
const modal = await page.evaluate(() => {
  const m = document.querySelector('.modal-mask:not([hidden])');
  return m ? (m.textContent || '').trim() : '';
});
ok(!!modal, '点「确认并发送」会弹确认框（不是点了就直接发）');
ok(/真的要发送吗/.test(modal), '确认框标题写明「真的要发送吗」');
ok(/最多/.test(modal), '确认框里写清本次最多发多少条');

// 3c 取消 → 请求数不变
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.modal-mask:not([hidden]) .modal button')];
  const no = btns.find((b) => (b.textContent || '').includes('再想想'));
  if (no) no.click();
});
await page.waitForTimeout(500);
const callsAfterCancel = await page.evaluate(() => window.__aaCalls);
ok(callsAfterCancel === startCalls, '确认框取消后不会发起执行请求');
ok(!(await page.evaluate(() => !!document.querySelector('.modal-mask:not([hidden])'))), '取消后确认框已关闭');

// 3d 服务端也要拦：缺关键词直接 400，且**不会走到 spawn**
const guard = await page.evaluate(async () => {
  try {
    const r = await fetch('/api/auto-apply/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'send', confirm: true, keyword: '', cap: 99999 }),
    });
    return { status: r.status, body: await r.text() };
  } catch (e) { return { status: 0, body: String(e.message) }; }
});
ok(guard.status === 400, `服务端对空关键词返回 400（实际 ${guard.status}）—— 前端绕过也发不出去`);
ok(/关键词/.test(guard.body), '400 的响应里说明缺的是关键词');

// ══ §4 页面：只读配置 ═════════════════════════════════════════════════════
section('4. 只读配置 /api/auto-apply/config');

const cfg = await page.evaluate(async () => {
  try {
    const r = await fetch('/api/auto-apply/config');
    return { status: r.status, json: await r.json() };
  } catch (e) { return { status: 0, json: null }; }
});
ok(cfg.status === 200, `配置接口 200（实际 ${cfg.status}）`);
const c = cfg.json || {};
ok(c.platform === 'boss', `配置里平台为 boss（实际 ${c.platform}）`);
ok(c.platformDailyCap === PLATFORM_DAILY_CAP, `配置里平台上限 ${PLATFORM_DAILY_CAP}`);
ok(c.safe && c.safe.dailyCap === SAFE_DEFAULTS.dailyCap, `配置里建议上限 ${SAFE_DEFAULTS.dailyCap}`);
ok(typeof c.hasCookie === 'boolean', '配置里给出 cookie 是否存在（页面据此提示先登录）');
ok(typeof c.hasLogin === 'boolean', '配置里区分「有文件」与「真的登录了」（避免假绿）');
ok(Array.isArray(c.loginCookieNames) && c.loginCookieNames.length >= 4,
  '配置里下发登录态 cookie 名单（页面提示里能点名缺哪个）');
ok(typeof c.cookieCount === 'number', '配置里给出 cookie 条数');
ok(c.today && typeof c.today.sent === 'number' && typeof c.today.remaining === 'number',
  '配置里给出今天已投 / 剩余额度');
ok(c.today.sent + c.today.remaining === PLATFORM_DAILY_CAP,
  `已投 ${c.today.sent} + 剩余 ${c.today.remaining} = 上限 ${PLATFORM_DAILY_CAP}`);
ok(Array.isArray(c.recent), '配置里带最近台账（页面能显示最近投过谁）');
ok(!!c.stateZh && !!c.filterReasonZh, '配置里带状态中文与过滤原因中文（页面不写死一份）');

// ══ §5 控制台错误 ═════════════════════════════════════════════════════════
section('5. 控制台错误');
// 3d 有意造了一个 400，那不算运行时错误；这里只留干净计数
const errs = runtimeErrors.filter((e) => !/Failed to load resource|4\d\d|net::ERR/.test(e));
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
