// auto-apply-run.mjs — BOSS 直聘自动投递执行器（Node 侧，Playwright）
//
// 业务逻辑移植自 get_jobs（Java/Spring）的 Boss.java，按本项目零依赖风格重写。
// 纯规则（过滤/去重/限流）在 ui/auto-apply.mjs，本文件只做「开浏览器 + 走页面」。
//
// ⚠️ 会真实操作你的 BOSS 账号，因此闸门按「默认什么都不发」设计：
//   --dry-run（默认）  只遍历、应用过滤、生成计划，**不点任何沟通/发送按钮**
//   --confirm          真正发送（还必须显式带这个参数，缺它一律当 dry-run）
//   --cap N            单次最多发 N 个，默认 20，硬上限 150（平台侧上限）
//
// 用法：
//   node auto-apply-run.mjs --keyword "Java 后端" --city 100010000 --dry-run
//   node auto-apply-run.mjs --keyword "Java 后端" --confirm --cap 10
//
// 进度写 stdout（JSONL，一行一条），台账写 data/auto-apply/log.jsonl。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium as pwChromium } from 'playwright';

// 优先用 **patchright**（Playwright 的去自动化补丁版 driver，get_jobs 实际靠它过 BOSS 风控）。
// 没装就退回原版 playwright —— 能跑，但 www.zhipin.com 的页面大概率被甩 about:blank。
let chromium = pwChromium;
let USING_PATCHRIGHT = false;
try {
  ({ chromium } = await import('patchright'));
  USING_PATCHRIGHT = true;
} catch { /* 没装 patchright，用原版 */ }

import {
  PLATFORM, SAFE_DEFAULTS, PLATFORM_DAILY_CAP, ITEM_STATE,
  LOGIN_COOKIES, hasLoginCookie, resolveCity, CITY_ALL,
  buildSearchUrl, filterJob, dedupeKey, isSecurityCheckUrl, nextIntervalSec, logEntry,
} from './ui/auto-apply.mjs';

// ── 参数 ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);

const CFG = {
  keyword: arg('keyword', ''),
  city: arg('city', '100010000'),
  cap: Math.min(PLATFORM_DAILY_CAP, Number(arg('cap', SAFE_DEFAULTS.dailyCap)) || SAFE_DEFAULTS.dailyCap),
  minIntervalSec: Number(arg('min', SAFE_DEFAULTS.minIntervalSec)),
  maxIntervalSec: Number(arg('max', SAFE_DEFAULTS.maxIntervalSec)),
  sayHi: arg('say-hi', SAFE_DEFAULTS.sayHi),
  filterDeadHr: !has('keep-dead-hr'),
  dryRun: !has('confirm'),           // 没写 --confirm 就只做计划
};

const DATA_DIR = path.join(process.cwd(), 'data', 'auto-apply');
const LOG_PATH = path.join(DATA_DIR, 'log.jsonl');
const COOKIE_PATH = path.join(process.cwd(), 'data', 'cookies', PLATFORM + '.json');

const out = (obj) => { process.stdout.write(JSON.stringify(obj) + '\n'); };

// ── 台账（去重依据）─────────────────────────────────────────────────────

function loadAppliedKeys() {
  const keys = new Set();
  try {
    if (!fs.existsSync(LOG_PATH)) return keys;
    const lines = fs.readFileSync(LOG_PATH, 'utf-8').split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (e && e.state === ITEM_STATE.sent && e.key) keys.add(e.key);
      } catch { /* 坏行跳过，不能因为一行坏日志就整个跑不起来 */ }
    }
  } catch { /* 读不到就当没投过 */ }
  return keys;
}

function appendLog(item, state, extra) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, logEntry(item, state, extra) + '\n', 'utf-8');
  } catch (e) {
    out({ type: 'warn', message: '台账写入失败：' + e.message });
  }
}

// ── 浏览器 ──────────────────────────────────────────────────────────────
// 优先**复用登录用的持久化 profile**（data/browser-profile/boss，登录会话就活在那里），
// 起不来再退回「一次性窗口 + cookie 导入」。
// 依据：get_jobs PlaywrightManager 也是持久化上下文 + 真实会话；把 cookie 塞进
// 一个全新的一次性 context，指纹与会话对不上，实测搜索页直接被甩 about:blank。

const PROFILE_DIR = path.join(process.cwd(), 'data', 'browser-profile', 'boss');
const HEADLESS = has('headless');          // 默认有头 —— 无头必被检测（get_jobs 同款结论）

// 参数对齐 get_jobs（实测口径，别乱加乱减）：
// · **不带** --no-sandbox / --disable-setuid-sandbox —— 它们本身就是自动化特征，
//   还会让 Chrome 弹「不受支持的命令行标志」黄条（用户截图里那条就是）；
// · --test-type 专门压那条黄条；
// · 崩溃恢复弹窗会挂死所有 CDP 操作（navigate 永不返回、连超时都不触发），必须压掉；
// · 强制直连 —— 本机系统代理常是死的，走它所有请求静默失败。
const BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-proxy-server',
  '--proxy-bypass-list=*',
  '--test-type',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1440,900',
];

// 上一次的浏览器窗口没关会锁死 profile（报 "browser has been closed"）。
// 按命令行精准点名遗留进程（只杀占用本 profile 的浏览器），不碰用户自己的浏览器。
function killStaleBrowsers() {
  if (process.platform !== 'win32') return false;
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*browser-profile*boss*'"
    + " -and ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe' -or $_.Name -like 'chromium*'"
    + " -or $_.Name -like 'headless_shell*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'ignore', timeout: 20000, windowsHide: true });
    return !r.error && r.status === 0;
  } catch { return false; }
}

const LAUNCH_CANDIDATES = [
  { label: 'Google Chrome', opts: { channel: 'chrome' } },
  { label: 'Microsoft Edge', opts: { channel: 'msedge' } },
  { label: '内置 Chromium', opts: {} },
];

/** 持久化 profile 启动（含自愈）。返回 { context, browser }，browser 非 null = 一次性兜底。 */
async function launchContext() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const errors = [];
  const tryAll = async () => {
    for (const c of LAUNCH_CANDIDATES) {
      try {
        const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
          headless: HEADLESS, args: BROWSER_ARGS,
          viewport: null, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
          ...c.opts,
        });
        out({ type: 'info', message: '浏览器已启动：' + c.label + '（持久化登录会话）' });
        return { context: ctx, browser: null };
      } catch (e) {
        errors.push({ label: c.label, msg: String((e && e.message) || e) });
      }
    }
    return null;
  };

  let r = await tryAll();
  if (!r && errors.some((e) => /has been closed|ProcessSingleton|SingletonLock|singleton/i.test(e.msg))) {
    out({ type: 'warn', message: '上一次的浏览器窗口还开着、锁住了登录 profile，自动清掉重试……' });
    killStaleBrowsers();
    await new Promise((s) => setTimeout(s, 1500));
    r = await tryAll();
  }
  if (r) return r;

  // 兜底：一次性窗口 + cookie 导入（只喂 BOSS 自己的，某条不合规也不能整批炸）
  out({ type: 'warn', message: '持久化 profile 起不来，改用一次性窗口 + cookie 导入。' });
  const seen = new Set();
  for (const e of errors) {
    const line = e.msg.split('\n')[0];
    if (seen.has(line)) continue;
    seen.add(line);
    out({ type: 'warn', message: '  · ' + e.label + ' — ' + line });
  }
  const br = await chromium.launch({ headless: HEADLESS, args: BROWSER_ARGS });
  const ctx = await br.newContext({ viewport: null, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  if (fs.existsSync(COOKIE_PATH)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8'));
      const zhipin = cookies.filter((c) => String(c.domain || '').includes('zhipin.com')
        || LOGIN_COOKIES.includes(c.name));
      const use = zhipin.length ? zhipin : cookies;
      await ctx.addCookies(use.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        expires: c.expires || -1, httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: c.sameSite || 'Lax',
      })));
      out({ type: 'info', message: '已载入 BOSS cookie（' + use.length + ' 条，一次性窗口）' });
    } catch (e) {
      out({ type: 'warn', message: 'cookie 载入失败（' + e.message + '）——本次按匿名继续。' });
    }
  } else {
    out({ type: 'warn', message: '没找到 BOSS cookie，将匿名访问（大概率被拦）。先跑：node save-cookies-boss.mjs --persist' });
  }
  return { context: ctx, browser: br };
}

// ── 主流程 ──────────────────────────────────────────────────────────────

const CARD_XPATH = "//ul[contains(@class, 'rec-job-list')]//li[contains(@class, 'job-card-box')]";
const LIST_SELECTORS = 'ul.rec-job-list, ul.job-list-box, .job-list-box, .search-job-result, li.job-card-box, li.job-card-wrapper';

async function main() {
  if (!CFG.keyword) {
    out({ type: 'error', message: '缺少 --keyword（搜索关键词）' });
    process.exit(2);
  }
  out({ type: 'start', dryRun: CFG.dryRun, cap: CFG.cap, keyword: CFG.keyword, city: CFG.city,
    driver: USING_PATCHRIGHT ? 'patchright' : 'playwright' });
  out({ type: 'info', message: USING_PATCHRIGHT
    ? '驱动：patchright（去自动化补丁版，过风控的关键）'
    : '驱动：playwright 原版（未装 patchright，搜索页大概率被拦）' });

  const appliedKeys = loadAppliedKeys();
  const blacklists = { companies: [], jobs: [], recruiters: [] };
  try {
    const blPath = path.join(DATA_DIR, 'blacklist.json');
    if (fs.existsSync(blPath)) Object.assign(blacklists, JSON.parse(fs.readFileSync(blPath, 'utf-8')));
  } catch { /* 没黑名单就不过滤黑名单 */ }

  const { context, browser } = await launchContext();
  const closeAll = async () => {
    await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  };

  // 页面来源按 driver 区分（都是实测教训，别统一）：
  // · patchright：**不能复用**持久化上下文自带的启动页 —— 它会永远停在加载中，
  //   evaluate/locator 无限阻塞（get_jobs PlaywrightManager.java:348-355，卡 160 秒实测）。
  //   必须 newPage，再把启动页关掉。
  // · 原版 playwright：恰恰相反，newPage 容易漂 about:blank，pages()[0] 能到站。
  let page;
  if (USING_PATCHRIGHT) {
    const startup = context.pages()[0];
    page = await context.newPage();
    if (startup) await startup.close().catch(() => {});
  } else {
    page = context.pages()[0] || await context.newPage();
  }

  const url = buildSearchUrl(CFG, CFG.city);
  // 城市支持直接写名称（北京 / 上海市 / 承德…）：认不出来就回落全国并明说
  const cityCode = resolveCity(CFG.city);
  if (CFG.city && !cityCode) {
    out({ type: 'warn', message: '城市「' + CFG.city + '」没认出来（对照表只收录了主要城市），'
      + '本次按「全国」搜索。可以用「西安 / 杭州」这类名称，或直接写 101010100 这类城市码。' });
  } else {
    out({ type: 'info', message: '城市：' + (cityCode || CITY_ALL)
      + (/^\d+$/.test(CFG.city || '') || !CFG.city ? '' : '（' + CFG.city + '）') });
  }
  out({ type: 'info', message: '打开搜索页：' + url });

  // ⚠️ 绝不等 networkidle/load —— BOSS 是 SPA + 长连接，永远等不到（get_jobs 踩过）
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => {
    out({ type: 'warn', message: '导航超时，继续尝试：' + e.message });
  });
  await page.waitForTimeout(4000);

  // ⚠️ 落在 about:blank = BOSS 把页面甩空白了（频率限制/风控）。
  // 这是实测过的行为：短时间反复打开，它不报错、直接 blank。此时**立刻停**，
  // 再刷一次限流就狠一层（save-cookies-boss.mjs 里有一模一样的教训）。
  if (/^about:blank/.test(page.url())) {
    await closeAll();
    out({ type: 'error', message: '页面被 BOSS 甩成了 about:blank —— 频率限制或风控。'
      + '等 5～10 分钟再跑；如果刚连续跑过几次，几乎可以肯定是限流，越等越好。' });
    process.exit(4);
  }
  if (isSecurityCheckUrl(page.url())) {
    await closeAll();
    out({ type: 'error', message: '触发了平台安全验证（滑块）。已停止，请手动打开 BOSS 过一次验证再试。' });
    process.exit(3);
  }

  /** 等列表渲染 + 滚动加载，返回读到的卡片数（get_jobs：连续 8 轮无新增就停）。 */
  const readList = async () => {
    await page.waitForSelector(LIST_SELECTORS, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    let lastCount = 0;
    let stable = 0;
    for (let r = 0; r < 300; r += 1) {
      const n = await page.locator('xpath=' + CARD_XPATH).count().catch(() => 0);
      if (n === lastCount) stable += 1; else stable = 0;
      lastCount = n;
      // 读够就收手：滚得越多风控上脸越快（实测滚到 ~300 张时 URL 开始带 _security_check）
      if (n >= 80) break;
      if (stable >= 8) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5)).catch(() => {});
      await page.waitForTimeout(600);
    }
    if (/_security_check/.test(page.url())) {
      out({ type: 'info', message: 'BOSS 开始插入安全验证信号，读到 ' + lastCount + ' 个就先收手（够用了）。' });
    }
    return lastCount;
  };

  /**
   * 首页 UI 搜索（get_jobs Boss.java:706-738 同款）：回首页 → 搜索框逐字输入 →
   * 点搜索按钮。热会话 + 同源 referer，和冷启动直闯列表页不是一回事。
   * 任何一步失败都返回 false，不影响主流程。
   */
  const searchFromHomePage = async (keyword) => {
    try {
      if (!/zhipin\.com/.test(page.url()) || page.url().includes('/web/geek/')) {
        await page.goto('https://www.zhipin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(6000);   // 首页会按城市再跳一次，等它跳完
      }
      if (/^about:blank/.test(page.url())) return false;
      const input = page.locator('input.ipt-search').first();
      await input.waitFor({ timeout: 10000 });
      await input.click();
      await input.fill('');
      // 逐字输入：一次性 fill 在输入行为层面太干净了（get_jobs 同款 130ms 节奏）
      await input.pressSequentially(keyword, { delay: 130, timeout: 20000 });
      await page.waitForTimeout(800);
      const btn = page.locator('button.btn-search').first();
      if (await btn.count() > 0) await btn.click({ timeout: 8000 });
      else await input.press('Enter');
      await page.waitForURL('**/web/geek/job**', { timeout: 15000 });
      await page.waitForTimeout(3000);
      out({ type: 'info', message: '已通过首页搜索进入列表：' + page.url() });
      return true;
    } catch (e) {
      out({ type: 'warn', message: '首页 UI 搜索没走通（' + String(e.message).split('\n')[0] + '）。' });
      return false;
    }
  };

  let lastCount = await readList();
  if (lastCount === 0) {
    // 页面活着但没读到卡片：不一定是真没有 —— 可能是直闯被拦成空壳。
    // 换真人路径（首页搜索）再试最后一次，还不行才下结论。
    out({ type: 'info', message: '直连搜索页没读到岗位，换首页 UI 搜索（真人路径）再试一次…' });
    if (await searchFromHomePage(CFG.keyword)) {
      if (isSecurityCheckUrl(page.url())) {
        await closeAll();
        out({ type: 'error', message: '触发了平台安全验证（滑块）。已停止，请手动打开 BOSS 过一次验证再试。' });
        process.exit(3);
      }
      lastCount = await readList();
    }
  }
  out({ type: 'info', message: '列表加载完成，共 ' + lastCount + ' 个岗位' });

  // 读到 0 个几乎不可能是「真的没有岗位」，九成是限流/风控/没登录。
  // 不点明的话，用户会以为这功能跑通了、只是今天没岗位 —— 静默失败最坑人。
  if (lastCount === 0) {
    out({ type: 'warn', message: '一个岗位都没读到，通常是下面几种情况之一：'
      + '① BOSS 频率限制（刚才连续跑过？页面看着正常但其实没内容 —— 等 5～10 分钟再跑）；'
      + '② 登录态失效（重跑 node save-cookies-boss.mjs --persist 重新登录）；'
      + '③ 被风控拦了（浏览器里手动打开 zhipin.com 看看是否正常）；'
      + '④ 关键词+城市确实没结果（换个关键词试试）。'
      + '本次到此为止，不会发送任何消息。' });
    await closeAll();
    out({ type: 'done', dryRun: CFG.dryRun, total: 0, sent: 0, plan: [] });
    return;
  }

  const total = Math.min(lastCount, 60); // 一次最多处理 60 个，防止长时间挂在页面上
  const plan = [];
  let sent = 0;

  for (let i = 0; i < total; i += 1) {
    const card = page.locator('xpath=' + CARD_XPATH).nth(i);
    let item = null;
    try {
      // 点卡片 → 拦 detail.json 拿结构化数据（get_jobs 同款做法，比抓 DOM 稳）
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url().includes('/wapi/zpgeek/job/detail.json'), { timeout: 8000 }).catch(() => null),
        card.click({ timeout: 5000 }).catch(() => {}),
      ]);
      if (resp) {
        const body = await resp.text().catch(() => '');
        try {
          const json = JSON.parse(body);
          const zp = (json && json.zpData) || {};
          const info = zp.jobInfo || zp.jobCard || {};
          const brand = zp.brandComInfo || {};
          const boss = zp.bossInfo || {};
          item = {
            encryptId: String(info.encryptId || zp.encryptJobId || ''),
            jobName: String(info.jobName || info.title || ''),
            salary: String(info.salaryDesc || ''),
            company: String(brand.brandName || info.brandName || ''),
            hrName: String(boss.name || ''),
            hrTitle: String(boss.title || ''),
            hrActive: String(boss.activeTimeDesc || ''),
            url: page.url(),
          };
        } catch { /* JSON 解析失败不算致命，跳过这个岗位 */ }
      }
      if (!item || !item.jobName) {
        // 接口没拿到就退回 DOM 抓标题，至少让用户看见「列表里有什么」
        const t = await card.locator('.job-name, .job-title').first().textContent().catch(() => '');
        item = { jobName: String(t || '').trim() || '（未取到标题）', url: page.url(), encryptId: '', salary: '', company: '', hrActive: '' };
      }
    } catch (e) {
      out({ type: 'warn', message: '第 ' + (i + 1) + ' 个岗位读取失败，跳过：' + String(e.message).split('\n')[0] });
      continue;
    }

    const verdict = filterJob(item, CFG, blacklists, appliedKeys);
    if (!verdict.pass) {
      plan.push({ ...item, state: ITEM_STATE.skipped, reason: verdict.reason });
      out({ type: 'item', index: i + 1, ...item, state: ITEM_STATE.skipped, reason: verdict.reason });
      continue;
    }

    if (CFG.dryRun) {
      plan.push({ ...item, state: ITEM_STATE.pending });
      out({ type: 'item', index: i + 1, ...item, state: ITEM_STATE.pending });
      continue;
    }

    // ── 真实发送 ────────────────────────────────────────────────────
    if (sent >= CFG.cap) {
      plan.push({ ...item, state: ITEM_STATE.skipped, reason: 'reachedCap' });
      out({ type: 'info', message: '已达到本次上限 ' + CFG.cap + ' 个，停止发送。' });
      break;
    }
    try {
      const moreHref = await page.locator('a.more-job-btn').first().getAttribute('href').catch(() => null);
      const detailUrl = moreHref && moreHref.startsWith('/job_detail/')
        ? 'https://www.zhipin.com' + moreHref : page.url();
      const p2 = await context.newPage();
      await p2.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await p2.waitForTimeout(1200);
      if (isSecurityCheckUrl(p2.url())) {
        await p2.close();
        out({ type: 'error', message: '触发安全验证，立即停止（已投 ' + sent + ' 个）。' });
        break;
      }
      const chat = p2.locator('a.btn-startchat, a.op-btn-chat').first();
      await chat.click({ timeout: 8000 });
      await p2.waitForTimeout(1500);
      const input = p2.locator("div#chat-input.chat-input[contenteditable='true'], textarea.input-area").first();
      await input.evaluate((el, msg) => {
        if (el.tagName && el.tagName.toLowerCase() === 'textarea') { el.value = msg; el.dispatchEvent(new Event('input', { bubbles: true })); }
        else { el.innerText = msg; el.dispatchEvent(new Event('input', { bubbles: true })); }
      }, CFG.sayHi).catch(() => {});
      await p2.waitForTimeout(600);
      await p2.locator('div.send-message, button[type="send"].btn-send, button.btn-send').first()
        .click({ timeout: 8000 });
      await p2.waitForTimeout(1000);
      await p2.locator('i.icon-close').first().click({ timeout: 4000 }).catch(() => {});
      await p2.close();
      sent += 1;
      appendLog(item, ITEM_STATE.sent, { note: 'sayHi 已发送' });
      appliedKeys.add(dedupeKey(item));
      plan.push({ ...item, state: ITEM_STATE.sent });
      out({ type: 'item', index: i + 1, ...item, state: ITEM_STATE.sent });
    } catch (e) {
      appendLog(item, ITEM_STATE.failed, { note: String(e.message).split('\n')[0] });
      plan.push({ ...item, state: ITEM_STATE.failed, reason: String(e.message).split('\n')[0] });
      out({ type: 'item', index: i + 1, ...item, state: ITEM_STATE.failed, reason: String(e.message).split('\n')[0] });
    }

    const gap = nextIntervalSec(CFG);
    out({ type: 'info', message: '停顿 ' + gap + ' 秒（随机间隔，降低风控风险）' });
    await page.waitForTimeout(gap * 1000);
  }

  await closeAll();
  out({ type: 'done', dryRun: CFG.dryRun, total: plan.length, sent, plan });
}

main().catch((e) => {
  out({ type: 'error', message: String(e.message) });
  process.exit(1);
});
