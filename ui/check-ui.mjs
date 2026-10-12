#!/usr/bin/env node
/**
 * career-ops 控制台 —— 界面回归自检
 *
 * 检查 DESIGN.md「可维护性」一节列出的回归清单：
 *   1. 40 个「分辨率 × 视图」组合下，页面不出现横向滚动、标题正常渲染
 *   2. 版面宽度：顶部导航横栏铺满视口且**菜单项不被裁切**，内容区铺满
 *      （超宽屏居中收边），两侧不留大片空白
 *   2b. 工具条 .toolbar：搜索收在一张白卡里，窄屏占满一行
 *   3. 无障碍要点齐全（跳转链接、主内容区、live region、aria-current、导航分组）
 *   4. <1024px 抽屉导航可开可关、aria-expanded 同步
 *   5. 组件画廊 /design-system.html 可访问且不溢出
 *   6. 评估报告列表每张卡都能打开对应报告（报告名解析 + Markdown 渲染）
 *
 * 用法：
 *   node ui/server.mjs --port 7317          # 先起服务
 *   node ui/check-ui.mjs                    # 默认查 http://127.0.0.1:7317
 *   node ui/check-ui.mjs http://127.0.0.1:8080
 *   node ui/check-ui.mjs --shots            # 顺带把截图写到 output/_shots/
 *
 * 依赖：playwright（项目已有，不需要额外安装）
 * 退出码：0 = 全部通过；1 = 有失败项
 */

import { chromium } from 'playwright';
import fs from 'node:fs';

const args = process.argv.slice(2);
const BASE = args.find((a) => a.startsWith('http')) || 'http://127.0.0.1:7317';
const SHOTS = args.includes('--shots');
const OUT = 'output/_shots';

// 顺序与 app.js 的 NAV_GROUPS 一致：先简历（第一步），再岗位（第二步）。
// 这个脚本会逐视图截图/体检，顺序只影响输出编号，但保持一致更省心。
// home 不在 NAV_GROUPS 里（默认落地页，靠品牌块/页脚进入），放最前面单独列出。
// overview 已于 2026-09-26 按需求整页移除（总览 → 首页 #home 承担落地）。
// security 于 2026-09-27 新增（账号安全中心，从身份胶囊的「系统设置」菜单进入）。
// templates 于 2026-09-30 新增（简历模板库，从「我的简历」的「选择模板」进入，不占导航座位）。
const VIEWS = ['home', 'help', 'cv', 'templates', 'cvkit', 'profile', 'evaluate', 'reports', 'prep', 'tools', 'autoapply', 'security'];
const VIEWPORTS = [
  { name: 'desktop-1440', w: 1440, h: 900 },
  { name: 'laptop-1180', w: 1180, h: 800 },
  { name: 'tablet-1024', w: 1024, h: 820 },
  { name: 'tablet-768', w: 768, h: 900 },
  { name: 'phone-390', w: 390, h: 844 },
];

const fails = [];
const notes = [];
let runtimeErrors = [];
// 断言收集器：定义在最前面 —— 后面的检查段落都要用它（曾经放在第 2 段前面，
// 结果新插入的段落踩了 TDZ：`Cannot access 'expect' before initialization`）。
const expect = (ok, msg) => { if (!ok) fails.push(msg); };

if (SHOTS) fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') runtimeErrors.push(m.text()); });
page.on('pageerror', (e) => runtimeErrors.push(e.message));

// ── 1. 全分辨率 × 全视图 ────────────────────────────────────────────────
for (const vp of VIEWPORTS) {
  await page.setViewportSize({ width: vp.w, height: vp.h });
  for (const v of VIEWS) {
    runtimeErrors = [];
    await page.goto(`${BASE}/#${v}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);

    const r = await page.evaluate(() => {
      const de = document.documentElement;
      return {
        hScroll: de.scrollWidth > de.clientWidth + 1,
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        title: (document.querySelector('#pageTitle') || {}).textContent || '',
      };
    });

    if (r.hScroll) fails.push(`${vp.name} #${v} 横向滚动 (${r.scrollW} > ${r.clientW})`);
    if (!r.title) fails.push(`${vp.name} #${v} 标题未渲染`);
    if (runtimeErrors.length) fails.push(`${vp.name} #${v} 运行时报错: ${runtimeErrors[0]}`);

    if (SHOTS && vp.name === 'desktop-1440') {
      await page.screenshot({ path: `${OUT}/${v}-${vp.w}.png`, fullPage: true });
    }
  }
}

// ── 1b. 版面宽度：顶栏铺满、内容区居中 ──────────────────────────────────
// 2026-10-10 换肤成「简历工坊」原型壳：旧「侧栏 + 标题条」没了，壳是
// 一条 sticky 顶栏（.topbar，内部 .topbar-in 居中、高 56px）。
// 2026-10-12 用户要求「所有页面宽度统一，按首页宽度」：内容区收边到
// --content-max（1180 = 首页 .page 的宽度），任意视口生效。
// 口径：顶栏铺满视口宽、高 56±4；5 个导航链接谁都不能被裁；
// 内容区 ≤1180 且居中（首页宽度）。
const LAYOUT = [
  { w: 1920, h: 1080 },
  { w: 1440, h: 900 },
  { w: 1180, h: 800 },
  { w: 1024, h: 820 },
];
for (const l of LAYOUT) {
  await page.setViewportSize({ width: l.w, height: l.h });
  await page.goto(`${BASE}/#help`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  const r = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const bar = q('.topbar').getBoundingClientRect();
    const box = q('.content').getBoundingClientRect();
    const first = q('#view > *');
    const fr = first ? first.getBoundingClientRect() : null;
    const items = [...document.querySelectorAll('#nav a')];
    return {
      navH: Math.round(bar.height),
      navW: Math.round(bar.width),
      boxW: Math.round(box.width),
      boxLeft: Math.round(box.left),
      boxRight: Math.round(box.right),
      vw: window.innerWidth,
      navCount: items.length,
      navClipped: items.filter((e) => {
        const b = e.getBoundingClientRect();
        return b.width < 8 || b.left < bar.left - 0.6 || b.right > bar.right + 0.6;
      }).length,
      gapL: fr ? Math.round(fr.left - box.left) : -1,
      gapR: fr ? Math.round(window.innerWidth - fr.right) : -1,
    };
  });

  expect(Math.abs(r.navH - 56) <= 4, `${l.w}px 顶栏高应 56±4，实际 ${r.navH}`);
  expect(Math.abs(r.navW - r.vw) <= 2, `${l.w}px 顶栏应铺满视口宽（${r.navW} vs ${r.vw}）`);
  expect(r.navCount === 6, `${l.w}px 导航应为 6 项（含自动投递），实际 ${r.navCount}`);
  expect(r.navClipped === 0,
    `${l.w}px 有 ${r.navClipped} 个导航项被裁掉 —— 排不下就让装饰让位，不能裁入口`);
  expect(r.boxW <= 1180 + 2 && r.boxW >= Math.min(1180, r.vw - 52) - 2,
    `${l.w}px 内容区应为首页宽度（≤1180 且尽量铺满到 1180），实际 ${r.boxW}`);
  expect(Math.abs(r.boxLeft - (r.vw - r.boxW) / 2) <= 2,
    `${l.w}px 内容区应居中/贴左（left ${r.boxLeft}，宽 ${r.boxW}）`);
  const blankL = r.boxLeft + r.gapL;
  const blankR = r.gapR;
  const capBlank = Math.max(0, (r.vw - 1180) / 2);
  expect(r.gapL >= 0 && blankL <= capBlank + 96,
    `${l.w}px 左侧留白异常（内容边距 ${r.boxLeft} + 内衬 ${r.gapL} = ${blankL}）`);
  expect(Math.abs(blankL - blankR) <= 4,
    `${l.w}px 两侧留白不对称（左 ${blankL} / 右 ${blankR}）`);
  notes.push(`${l.w}px：顶栏 ${r.navW}×${r.navH} / 内容 ${r.boxW}（左留白 ${blankL} 右留白 ${blankR}）`);
}

// ── 1c. 工具条：搜索项收进一张白卡 ─────────────────────────────────────
// 改版前搜索框是直接摊在画布上的裸控件，浮在卡片外面没有归属感，跟下面的
// 列表也拉不开从属关系。收进 .toolbar 之后它成了「这张列表的头」。
// 窄屏必须占满一行 —— 半截输入框在手机上没法用。
// 挂靠页面换成「评估报告」：台账页已撤下，报告页是现在唯一带工具条列表页。
for (const t of [{ w: 1440, h: 900, label: '宽屏' }, { w: 390, h: 844, label: '窄屏' }]) {
  await page.setViewportSize({ width: t.w, height: t.h });
  await page.goto(`${BASE}/#reports`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(420);
  const tb = await page.evaluate(() => {
    const bar = document.querySelector('#view .toolbar');
    if (!bar) return null;
    const s = document.querySelector('#rSearch');
    const bs = bar.getBoundingClientRect();
    const bss = s ? s.getBoundingClientRect() : null;
    return {
      inside: !!(bss && bss.left >= bs.left - 0.6 && bss.right <= bs.right + 0.6),
      sW: bss ? Math.round(bss.width) : 0,
      bg: getComputedStyle(bar).backgroundColor,
    };
  });
  expect(!!tb, `${t.label}（${t.w}px）报告页找不到 .toolbar：搜索没收进工具条卡`);
  if (tb) {
    expect(tb.inside, `${t.label}（${t.w}px）工具条里的控件溢出了卡片`);
    expect(tb.sW >= 80, `${t.label}（${t.w}px）搜索框被压得太窄（${tb.sW}）`);
    notes.push(`工具条 ${t.label}：搜索 ${tb.sW}px`);
  }
}

// ── 2. 无障碍要点 ───────────────────────────────────────────────────────
await page.setViewportSize({ width: 1440, height: 900 });
// 落在一个**仍在导航里**的视图（#cv）：aria-current 守卫需要当前项存在
await page.goto(`${BASE}/#cv`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(600);

const a11y = await page.evaluate(() => {
  const q = (s) => document.querySelector(s);
  // 2026-10-10 换肤：导航从 .nav-item 按钮组变成顶栏 .nav a 链接组
  const nav = [...document.querySelectorAll('#nav a')];
  // ⚠️ 必须挑一个**可聚焦**的 .btn：页面第一个 .btn 常是 disabled 的撤销，
  // 禁用元素拿不到焦点、:focus-visible 不成立，会红在「本来就不该有环」的元素上。
  const btn = q('.btn:not([disabled])');
  if (btn) btn.focus();
  const cs = btn ? getComputedStyle(btn) : null;
  return {
    skip: !!q('.skip-link'),
    main: !!q('main#view'),
    announcer: !!q('#routeAnnouncer[aria-live="polite"]'),
    toast: !!q('#toast[role="status"]'),
    navCount: nav.length,
    navOrder: nav.map((a) => (a.getAttribute('href') || '').replace('#', '')),
    current: nav.filter((a) => a.classList.contains('on')).length,
    lang: document.documentElement.lang,
    themeColor: (q('meta[name="theme-color"]') || {}).content || '',
    bodyBg: getComputedStyle(document.body).backgroundColor,
    missingTokens: ['--bg', '--card', '--sunken', '--line', '--accent', '--accent-soft',
      '--amber', '--amber-ink', '--ink', '--ink-2', '--ink-3', '--ink-faint',
      '--nm-dark', '--nm-light', '--nm-out', '--nm-in', '--sh-sm',
      '--sp-3', '--sp-5', '--r-sm', '--r-lg', '--fs-base', '--fs-3xl',
      '--dur-2', '--ease', '--font', '--nav-h', '--content-max', '--drawer-w', '--z-modal']
      .filter((k) => !getComputedStyle(document.documentElement).getPropertyValue(k).trim()),
    focusOutline: cs ? `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}` : 'n/a',
  };
});

expect(a11y.skip, '缺少跳转链接 .skip-link');
expect(a11y.main, '缺少主内容区 main#view');
expect(a11y.announcer, '缺少路由播报 live region #routeAnnouncer');
expect(a11y.toast, '缺少 toast live region #toast');
// 新导航高亮用 class="on"（原型口径），恰好 1 个
expect(a11y.current === 1, `高亮导航项应恰好 1 个，实际 ${a11y.current}`);
expect(a11y.navCount === 6, `导航应为 6 项（含自动投递），实际 ${a11y.navCount}`);
// DOM 顺序守卫（2026-10-10 换肤后的 6 项；自动投递在投递记录前面 ——
// 先发起投递、再看结果，顺序跟流程一致）：
// 工作台 → 我的简历 → 目标岗位 → 提升计划 → 自动投递 → 投递记录。
expect(a11y.navOrder.join(',') === 'home,resumes,jobs,growth,autoapply,applications',
  `导航顺序应为 工作台→简历→岗位→提升→自动投递→投递记录，实际 ${a11y.navOrder.join(' → ')}`);
// 流程顺序：必须先「我的简历」后「目标岗位」。这条断言守的是产品决策 ——
// 评估是拿简历比对岗位，简历排在后面会诱导用户在简历空白时就去评估，
// 拿到的低分会被误读成「岗位不合适」。
{
  const iCv = a11y.navOrder.indexOf('resumes');
  const iEval = a11y.navOrder.indexOf('jobs');
  expect(iCv !== -1 && iEval !== -1, '导航里找不到 resumes 或 jobs');
  expect(iCv < iEval, `「我的简历」应排在「目标岗位」之前，实际顺序 ${a11y.navOrder.join(' → ')}`);
}
expect(!!a11y.lang, 'html 缺少 lang 属性');
expect(a11y.missingTokens.length === 0,
  `:root 缺令牌（${a11y.missingTokens.length} 个）：${a11y.missingTokens.join(' ')}`);
// theme-color 必须等于画布色：否则移动端地址栏会与页面顶部断成两层色。
// 两边都用 token，所以这里只要它们"同值"即可，不写死具体色号。
{
  const m = (a11y.bodyBg || '').match(/(\d+),\s*(\d+),\s*(\d+)/);
  const hex = m ? '#' + m.slice(1, 4).map((v) => (+v).toString(16).padStart(2, '0')).join('') : '';
  expect(hex && hex.toLowerCase() === a11y.themeColor.toLowerCase(),
    `theme-color 应与画布同色，实际 theme-color=${a11y.themeColor} / body=${hex}`);
}
// 焦点环口径是「可见」（非 none、≥2px、solid）：新皮肤的环是 3px（比旧的
// 2px 更醒目）—— 数值本身不是重点，看得见才是。
expect(/none/i.test(a11y.focusOutline) === false
  && parseFloat(a11y.focusOutline) >= 2,
  `焦点环应可见（≥2px solid），实际 ${a11y.focusOutline}`);
notes.push(`焦点环 ${a11y.focusOutline}`);
notes.push(`导航 ${a11y.cols} 栏 / ${a11y.navCount} 项，theme-color ${a11y.themeColor}`);
notes.push(`栏目顺序：${a11y.navOrder.join(' | ')}`);

// ── 2b. 身份胶囊点开「系统设置」下拉（2026-09-27 最终口径）──────────────
// 用户要求：胶囊外观不变，**点头像本身**弹出菜单；退出保持独立按钮；
// 菜单顺序必须是 …→ 使用帮助 最末（老约定的延续）。
{
  // 假 token 会在启动校验时被 /api/auth/me 静默清掉（服务重启 sessions 即空），
  // 所以这里**打桩 me 接口**而不是造真会话 —— 不碰真实用户库。
  await page.route('**/api/auth/me', (r) => r.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ ok: true, role: 'user', username: 'probe', name: '探针', createdAt: '', lastLogin: '' }),
  }));
  await page.evaluate(() => {
    localStorage.setItem('lizhuo.session', JSON.stringify(
      { token: 'probe-token', role: 'user', username: 'probe', name: '探针' }));
  });
  // ⚠ 同 URL 的 goto 不触发真实导航（旧坑：同 hash goto 不重建视图），
  // 种完会话必须显式 reload。且登录后控制台有持续轮询 → 不能等 networkidle。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  const chip = await page.evaluate(() => {
    const wrap = document.querySelector('#sessionChip');
    const t = wrap && wrap.querySelector('button.chip-user[data-chip="menu"]');
    const items = wrap ? [...wrap.querySelectorAll('.chip-item[data-go]')] : [];
    return {
      toggle: !!t,
      toggleText: t ? t.textContent.trim() : '',
      logout: !!(wrap && wrap.querySelector('[data-chip="logout"]')),
      strayBtn: !!(wrap && wrap.querySelector('.btn[data-chip="menu"]')),
      menu: !!document.querySelector('.session-chip .chip-menu'),
      title: (wrap && wrap.querySelector('.chip-menu-title') || {}).textContent || '',
      order: items.map((b) => b.dataset.go),
      loginBtn: !!wrap.querySelector('.chip-login'),
    };
  });
  expect(chip.toggle, '身份胶囊应是「系统设置」菜单的触发器（button.chip-user）');
  expect(/探针/.test(chip.toggleText), `胶囊仍显示身份名（实际「${chip.toggleText}」）`);
  expect(!chip.strayBtn, '不应再有独立的「系统设置」按钮（菜单从头像进）');
  expect(chip.logout, '「退出」按钮应保持原样、独立于菜单');
  expect(!chip.loginBtn, '已登录时不应再渲染「登录」入口');
  expect(chip.menu, '胶囊下拉菜单 .chip-menu 未渲染');
  expect(chip.title === '系统设置', `菜单名应为「系统设置」，实际「${chip.title}」`);
  expect(chip.order.join(',') === 'profile,tools,security,help',
    `系统设置菜单顺序应为 求职配置→全部脚本→账号安全中心→使用帮助，实际 ${chip.order.join(' → ')}`);
  // 点开 → is-open + aria-expanded 同步；再点收起
  const toggled = await page.evaluate(() => {
    const wrap = document.querySelector('#sessionChip');
    const t = wrap && wrap.querySelector('button.chip-user[data-chip="menu"]');
    if (!wrap || !t) return { open: false, closed: false };
    t.click();
    const open = wrap.classList.contains('is-open') && t.getAttribute('aria-expanded') === 'true';
    t.click();
    const closed = !wrap.classList.contains('is-open') && t.getAttribute('aria-expanded') === 'false';
    return { open, closed };
  });
  expect(toggled.open && toggled.closed, '胶囊菜单点开/收起时 .is-open 与 aria-expanded 未正确同步');
  notes.push(`系统设置菜单：${chip.order.join(' → ')}`);
  // 用完即清：会话与打桩一起撤，别漏给后面的段落（有些段落按未登录形态断言）
  await page.unroute('**/api/auth/me');
  await page.evaluate(() => localStorage.removeItem('lizhuo.session'));
}

// ── 3. 窄屏导航可达 ─────────────────────────────────────────────────────
// 2026-10-10 换肤后没有抽屉了：新壳窄屏是「顶栏换行 + #nav 横向滚动」。
// 要守的东西没变 —— **入口在窄屏上依然全部可达**（本机铁律：绝不裁切入口），
// 只是实现从「汉堡抽屉」换成了「横向滚动」。
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/#home`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
const navNarrow = await page.evaluate(() => {
  const nav = document.querySelector('#nav');
  if (!nav) return null;
  const links = [...nav.querySelectorAll('a')];
  const nr = nav.getBoundingClientRect();
  // 每个链接都要与导航容器相交（完全滚出可视范围 = 入口丢失）
  const visible = links.filter((a) => {
    const r = a.getBoundingClientRect();
    return r.width >= 8 && r.right > nr.left - 0.6 && r.left < nr.right + 0.6;
  }).length;
  return {
    count: links.length,
    visible,
    scrollable: nav.scrollWidth >= nav.clientWidth - 1,
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
});
expect(navNarrow, '窄屏找不到 #nav');
if (navNarrow) {
  expect(navNarrow.count === 6, `窄屏导航应 6 项（含自动投递），实际 ${navNarrow.count}`);
  // 横向滚动是合法形态：可见数可以少于 5，但**初始第一项必须可见**、
  // 且容器可滚（用户能滚到后面几项）
  expect(navNarrow.visible >= 1, '窄屏第一个导航项不可见 —— 入口被裁');
  expect(navNarrow.scrollable || navNarrow.count === navNarrow.visible,
    '窄屏导航既不可滚也放不下全部入口');
  expect(!navNarrow.hScroll, '窄屏出现页面级横向滚动（应只滚 #nav 容器）');
  notes.push(`窄屏导航：${navNarrow.visible}/${navNarrow.count} 可见${navNarrow.scrollable ? '（可横滚）' : ''}`);
  if (SHOTS) await page.screenshot({ path: `${OUT}/mobile-nav-390.png` });
}

// ── 4. 组件画廊 ─────────────────────────────────────────────────────────
runtimeErrors = [];
await page.setViewportSize({ width: 1440, height: 900 });
const resp = await page.goto(`${BASE}/design-system.html`, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
const gal = await page.evaluate(() => ({
  title: document.title,
  sections: document.querySelectorAll('section').length,
  buttons: document.querySelectorAll('.btn').length,
  swatches: document.querySelectorAll('.swatches').length,
  hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  cssLoaded: getComputedStyle(document.body).getPropertyValue('--accent').trim() !== '',
}));
expect(resp.status() === 200, `画廊页 HTTP ${resp.status()}`);
expect(!gal.hScroll, '画廊页横向滚动');
expect(gal.sections > 5, `画廊区块过少 (${gal.sections})`);
expect(gal.cssLoaded, '画廊页未加载到 style.css（设计令牌缺失）');
notes.push(`画廊 ${gal.title}｜${gal.sections} 区块 / ${gal.buttons} 按钮 / ${gal.swatches} 组色板`);
if (SHOTS) await page.screenshot({ path: `${OUT}/design-system.png`, fullPage: true });

// ── 5. 报告列表 → 报告详情能打开 ───────────────────────────────────────
// 报告文件名要先经过一轮收敛（`[003](../reports/003-xxx.md)` → `003-xxx.md`）。
// 取文件名时若多带一个收尾的 `)`，服务端会按「文件名不合法」400 挡掉，
// 于是**每一张卡**都打不开——这个 bug 真实发生过（当时是从台账那一列进来的）。
// 台账页撤下后，这条链路的入口只剩「评估报告」列表，所以改从那里逐张点开。
// 报告卡片只暴露 `aria-label="查看报告：{标题}"`，没有文件名属性 —— 用下标定位。
runtimeErrors = [];
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/#reports`, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const repCount = await page.$$eval('#rList .report-item', (els) => els.length);
if (!repCount) {
  notes.push('当前没有评估报告，跳过「逐张点开」断言');
} else {
  const first = await page.evaluate(() => {
    const el = document.querySelector('#rList .report-item');
    return el ? { label: el.getAttribute('aria-label') || '', name: el.dataset.name || '' } : null;
  });
  expect(!!(first && first.label), '报告卡片缺少 aria-label（无法定位「查看报告」入口）');

  for (let i = 0; i < repCount; i++) {
    // 上一轮结束时停在报告详情页。注意：hash 相同的 goto 属于同文档跳转，
    // 不会重建视图，`#rList` 那时并不存在（会白等到超时）——所以显式 reload。
    await page.goto(`${BASE}/#reports`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.locator('#rList .report-item').nth(i).click({ timeout: 5000 });
    await page.waitForTimeout(900);
    const got = await page.evaluate(() => ({
      sub: (document.querySelector('#pageSub') || {}).textContent || '',
      body: (document.querySelector('#view .md') || {}).textContent || '',
      failed: /读取失败/.test((document.querySelector('#view') || {}).textContent || ''),
    }));
    expect(!got.failed, `报告列表第 ${i + 1} 张打不开（页面显示读取失败）`);
    expect(/^[\w.\-—\u4e00-\u9fa5]+\.md$/.test(got.sub),
      `报告页标题不是合法文件名（服务端会 400）：${JSON.stringify(got.sub)}`);
    expect(got.body.length > 40, `报告 ${got.sub} 正文过短（${got.body.length} 字），可能没读到内容`);
  }
  // 报告正文里的 `# 标题` 应当被渲染成真标题，而不是连 `#` 一起显示
  const mdOk = await page.evaluate(() => !!document.querySelector('#view .md h1, #view .md h2'));
  expect(mdOk, '报告正文未渲染出标题（Markdown 转换疑似失败）');
  notes.push(`评估报告 ${repCount} 张，逐张点开均拿到正文`);
}

await browser.close();

// ── 报告 ────────────────────────────────────────────────────────────────
console.log(`\n控制台界面回归 — ${BASE}`);
console.log(`  分辨率×视图：${VIEWPORTS.length} × ${VIEWS.length} = ${VIEWPORTS.length * VIEWS.length} 组`);
notes.forEach((n) => console.log(`  · ${n}`));
if (fails.length) {
  console.log(`\n失败 ${fails.length} 项：`);
  fails.forEach((f) => console.log(`  ✗ ${f}`));
  console.log('\n结论：未通过');
  process.exitCode = 1;
} else {
  console.log('\n结论：全部通过');
}
