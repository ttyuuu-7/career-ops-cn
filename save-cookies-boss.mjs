// save-cookies-boss.mjs — BOSS 直聘登录态保存（专版）
//
// 为什么不用根目录那个 save-cookies.mjs：它打开 BOSS 首页会**白屏**，
// 已知的两个诱因它都占了：
//   1. `--disable-web-security` —— 关掉同源策略，BOSS 这种 SPA 直接渲染不出来
//      （还常伴一条「您使用的是不受支持的命令行标记」黄条）；
//   2. `waitUntil: 'commit'` —— 只等连接建立就交还控制权，SPA 还没渲染，
//      用户看到的就是一片白，然后以为坏了。
// 另外它把 UA 伪装成 Mac（platform=MacIntel），和本机 Windows 不一致，
// 属于「画蛇添足的反检测」，反而更容易触发风控。
//
// ⚠️ 原 save-cookies.mjs 在根目录、属于系统层（`node update-system.mjs` 会还原），
//    所以**不改它**，另开这一个文件。用法完全一致：
//
//   node save-cookies-boss.mjs                 # 一次性，登录完存 cookie
//   node save-cookies-boss.mjs --persist       # ★推荐：复用浏览器 profile，
//                                              #   第一次登录，以后再跑直接就是已登录态
//   node save-cookies-boss.mjs --persist --chromium  # ★窗口被挡住/打不开时用这个
//   node save-cookies-boss.mjs --persist --edge      # 浏览器起不来时，强制用系统 Edge
//
// ⚠️ **cmd 窗口不是浏览器**（这是最容易踩的一个判断错误）：
//    跑起来后会有**两个**窗口叠在一起 ——
//      · 黑色/白色的 cmd 窗口，标题是「Microsoft Windows [版本 10.0.xxxxx]」，里面全是命令行
//      · 浏览器窗口，标题才是 zhipin.com / BOSS直聘
//    如果你盯着 cmd 窗口看，看到的就是"一片白/一片黑"，会以为登录页白屏了 —— 其实
//    登录页在**后面那个窗口**里。脚本会自动把浏览器窗口顶到最前（bringToFront +
//    Windows 标题匹配置顶），万一还是被挡住，手动 Alt+Tab 切一下即可。
//
// 排查顺口溜：先看它打印的「地址 / 正文长度」——
//   · 地址是 about:blank  → **多半是被限流了**，等 5 分钟再来，别连着刷
//   · 标题含「验证」「安全」→ 风控拦住了，手动在窗口里过验证
//   · 正文 0 但地址对了    → 页面还在渲染，不影响登录，照常按回车
// 还不行就加 --chromium（换内置 Chromium，排除 Edge 自身的干扰）。
// 还有一种「点了没反应」：黑窗口报「没有可用的浏览器」= 上一个浏览器窗口
// 没关、把持久化 profile 锁死了（浏览器自己会打一行「正在另一个浏览器会话中
// 打开」然后退出，Playwright 只看到 "browser has been closed"）。
// 现在脚本会**自动清掉遗留进程并重试**；实在不行降级成一次性窗口，照样能登录保存。
//
// ── 这一版是怎么调出来的（都是实测，别凭感觉改回去）────────────────
// 用户连续四轮报"白屏"，最后靠对照实验逐个排除，真凶有四个：
//  1. **死代理**（最致命）：脚本原本无条件读 `http_proxy` 给浏览器挂代理，
//     而本机那个端口早就不在了（curl 过去返回 000）→ 请求全失败 → about:blank。
//     现在**默认强制直连**（还显式加 `--no-proxy-server`，因为光不传 proxy
//     不够，Chromium 还会去读 Windows 的系统代理）。要代理请加 --proxy。
//  2. **BOSS 的频率限制**：短时间内反复开登录页，它不报错、不弹验证，
//     直接把页面跳成空白。实测连开十几次后同样的代码全部漂走，
//     **干等 100 秒再单次打开，一次就成功**。所以重试从 4 轮砍到 **2 轮**，
//     而且一看到 about:blank 就**停手**（再刷只会让限流更狠）。
//  3. **"反检测"脚本反而招来封杀**：`window.chrome` 伪造 + JS 覆盖
//     `navigator.webdriver` 那两行，在对照实验里**带着它们的全都没打开，
//     去掉的那组一次到站**。现在一处都不注入（靠启动参数原生去标志）。
//  4. **系统级窗口置顶会把页面弄丢**：调 ShowWindow/SetForegroundWindow 抢前台，
//     页面第 1 轮明明到站了，置顶完回头就变 about:blank。
//     现在**默认不做**置顶（真要就加 --raise），代价只是用户自己 Alt+Tab 一下。
// 另外两个"看着像原因其实不是"的：persistent profile 无辜（换全新目录一样漂）、
// 有头/无头不是主因（关键是上面四条）。
//
// 登录后按回车即保存到 data/cookies/boss.json。
// **保存时会当场校验有没有真的登录**（有没有 bst / wt2 / zp_at / geek_zp_token），
// 没登录会直接告诉你，而不是像以前那样安静地存一份匿名 cookie。
//
// 关于「一登录就跳回首页」：这是**正常的**，BOSS 登录成功后就是跳首页。
// 判断成败只看首页右上角——显示头像/昵称就是成了，还显示「登录/注册」才是没成。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { LOGIN_COOKIES, hasLoginCookie } from './ui/auto-apply.mjs';

// ⚠️ 为什么默认开 **login.zhipin.com** 而不是 www.zhipin.com：实测过 6 个入口
// （`output/_diag-boss-login-url.mjs`），结论很硬：
//   · https://login.zhipin.com/                  → HTTP 200，真的是登录页（手机号框 + 验证码框）
//   · https://www.zhipin.com/web/user/?ka=...    → 同上（同一个页面）
//   · https://www.zhipin.com/login               → 404，跳「安全验证」（被风控）
//   · https://www.zhipin.com/web/geek/job/       → 跳「安全验证」（geetest 拦）
//   · https://www.zhipin.com/                    → 首页会**按城市再跳一次**，中途容易撞上空白
// 所以「一键登录」就直奔登录页，既少一次跳转，也不碰风控页。
// 想看首页（比如登录后确认有没有头像）就加 --home。
const LOGIN_URL = 'https://login.zhipin.com/';
const HOME_URL = 'https://www.zhipin.com/';
const OUT_DIR = path.join(process.cwd(), 'data', 'cookies');
const OUT_PATH = path.join(OUT_DIR, 'boss.json');
// ⚠️ 代理是**白屏的头号元凶**，这里默认**强制直连**。
// 踩过：脚本原本无条件读 `process.env.http_proxy` 给浏览器挂代理，而本机那个
// 代理端口早就不在了（curl 直连过去返回 000）→ 浏览器所有请求走死代理 →
// 页面停在 `about:blank` → 用户看到的就是"白屏"，而且怎么刷新都没用。
// BOSS 是国内站点，实测直连 HTTP 200 正常，所以默认直连最稳。
// 确实需要代理的人加 `--proxy`（这时才去读环境变量）。
const ENV_PROXY = process.env.http_proxy || process.env.HTTP_PROXY
  || process.env.https_proxy || process.env.HTTPS_PROXY || '';
const WANT_PROXY = process.argv.includes('--proxy');
const PROXY = WANT_PROXY ? ENV_PROXY : '';
const PERSIST = process.argv.includes('--persist');
// `--edge`：强制用系统 Microsoft Edge。用途是**排查**——如果内置 Chromium 起不来
// 或渲染不出来，换真 Edge 常常就好了（真浏览器指纹 + 本机已装、启动最快）。
const FORCE_EDGE = process.argv.includes('--edge');
// `--chromium`：反过来，强制用 Playwright 内置的 Chromium。
// 什么时候要它：Edge 会带上自己的插件与**会话恢复**（实测它会额外弹一个
// `about:blank` 的无标签栏小窗，正好盖在真正的页面上 —— 用户看到的就是"白屏"，
// 而终端却报"正文 2881 字符，已就绪"）。内置 Chromium 是干净 profile，没这一出。
const FORCE_CHROMIUM = process.argv.includes('--chromium');
const PROFILE_DIR = path.join(process.cwd(), 'data', 'browser-profile', 'boss');
// `--home`：不看登录页，直接开首页（登录后确认头像用）
const USE_HOME = process.argv.includes('--home');
// `--check`：体检模式 —— 只打开页面看能不能通，不登录、不保存、不等回车，看完就关。
// 排查「打不开 / 一直白」时先用它，几秒出结论，不用走完整流程。
const CHECK_ONLY = process.argv.includes('--check');
// `--raise`：额外用 Windows API 把浏览器窗口硬顶到最前。
// ⚠️ 默认**不开** —— 实测它会让 BOSS 登录页漂到 about:blank（见 main 里的说明）。
const DO_RAISE = process.argv.includes('--raise');

// ── 遗留窗口 = 第二大「看起来还是白屏」的元凶（2026-09-27 实锤）──────────
// 现象：用户报「还是白屏」，截图里是上一轮留下的 about:blank Edge 窗口；
// 实际上这一轮的浏览器**根本没起来** —— 上一个窗口还开着，把持久化 profile
// 目录锁死了（Chromium 的 ProcessSingleton 机制），新进程一碰就退，
// Playwright 报 "Target page, context or browser has been closed"。
// 黑窗口里那句「没有可用的浏览器」一闪而过，用户看到的永远是旧窗口。
//
// 处置：按**命令行**精准点名 —— 只杀「命令行里含 browser-profile 且路径带 boss
// 的 msedge/chrome/chromium 进程」，绝不清用户自己开着的浏览器。
let LIVE_CTX = null;
let LIVE_BR = null;
function killStaleBrowsers() {
  if (process.platform !== 'win32') return false;
  const ps = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*browser-profile*boss*'"
    + " -and ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe' -or $_.Name -like 'chromium*'"
    + " -or $_.Name -like 'headless_shell*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  try {
    // spawnSync 直连（不走 cmd.exe）：更快，也少一层 shell 对引号/管道的再解释
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'ignore', timeout: 20000, windowsHide: true });
    return !r.error && r.status === 0;
  } catch { return false; }
}
// 黑窗口被关掉/按 Ctrl+C 时，尽力把浏览器也带上 —— 不然 Edge 变孤儿，
// profile 锁死，下一轮就「怎么点都白屏」（这次就是这么踩的）。
// Windows 关窗口只给 ~5 秒宽限，close 是尽力而为，不恋战。
for (const sig of ['SIGINT', 'SIGHUP', 'SIGBREAK', 'SIGTERM']) {
  try {
    process.on(sig, () => {
      try { if (LIVE_CTX) LIVE_CTX.close().catch(() => {}); } catch { /* 忽略 */ }
      try { if (LIVE_BR) LIVE_BR.close().catch(() => {}); } catch { /* 忽略 */ }
      setTimeout(() => process.exit(0), 1500);
    });
  } catch { /* 平台不支持该信号就算了 */ }
}

// 浏览器回退链（本机没装 Chrome，优先 Edge —— 同为 Chromium 内核，指纹更像真浏览器）
const CANDIDATES = FORCE_EDGE
  ? [{ label: 'Microsoft Edge（--edge 指定）', opts: { channel: 'msedge' } }]
  : FORCE_CHROMIUM
    ? [{ label: '内置 Chromium（--chromium 指定）', opts: {} }]
    : [
      { label: 'Google Chrome', opts: { channel: 'chrome' } },
      { label: 'Microsoft Edge', opts: { channel: 'msedge' } },
      { label: '内置 Chromium', opts: {} },
    ];

// ⚠️ 刻意**不加** --disable-web-security / --disable-features=IsolateOrigins
//    —— 那两个是白屏的主因。
// ⚠️ 也**不带** --no-sandbox / --disable-setuid-sandbox / --ignore-certificate-errors /
//    --disable-infobars —— 它们本身就是自动化特征（--no-sandbox 尤其），
//    还会让 Chrome 弹「不受支持的命令行标志」黄条（用户截图里那条就是）。
//    参数对齐 get_jobs PlaywrightManager 的实测口径，一条不多一条不少。
const ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-proxy-server',
  '--proxy-bypass-list=*',
  '--test-type',                        // 抑制上面那条黄条
  '--disable-session-crashed-bubble',   // 崩溃恢复弹窗会挂死所有 CDP 操作
  '--hide-crash-restore-bubble',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1440,900',
];

/**
 * 启动参数。关键点：**不代理的时候要显式加 `--no-proxy-server`** ——
 * 光不传 proxy 不够，Chromium 还会去读 Windows 的系统代理设置（IE 代理），
 * 那个要是也是死的，照样 about:blank。
 */
function argsFor(useProxy) {
  return useProxy ? ARGS : ARGS.concat(['--no-proxy-server']);
}
const proxyOpts = (useProxy) => (useProxy && PROXY ? { proxy: { server: PROXY } } : {});
const modeTag = (useProxy) => (useProxy ? '（走代理 ' + PROXY + '）' : '（直连）');

async function launchBrowser(useProxy) {
  const failures = [];
  for (const c of CANDIDATES) {
    try {
      const b = await chromium.launch({
        headless: false, args: argsFor(useProxy),
        ...proxyOpts(useProxy),
        ...c.opts,
      });
      console.log('✓ 已启动浏览器：' + c.label + modeTag(useProxy));
      return b;
    } catch (e) {
      failures.push(c.label + ' — ' + String(e.message).split('\n')[0]);
    }
  }
  throw new Error('没有可用的浏览器，依次尝试的结果：\n  ' + failures.join('\n  '));
}

/**
 * 持久化 profile：把整个浏览器用户目录存到 data/browser-profile/boss。
 * 好处是**登录一次管很久** —— cookie 会过期（几周就得重登一次），
 * 而 profile 里存的是完整的登录会话，下次跑直接就是已登录状态，
 * 也省掉每次都要扫码。风控也更信任一个"用过很久"的 profile。
 */
async function launchPersistent(useProxy) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  // 返回 { context, browser }：browser 非 null = 一次性兜底窗口（关的时候要连带关进程）
  const errors = [];
  const tryCandidates = async () => {
    for (const c of CANDIDATES) {
      try {
        const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
          headless: false, args: argsFor(useProxy),
          // ⚠️ viewport 传 **null**（=不做设备模拟），窗口大小交给 `--window-size`。
          // 实测：传 `{width:1440,height:900}` 的那几组全部漂到 about:blank，
          // 传 null 的能正常到站。Playwright 传了 viewport 就会走 CDP 的
          // Emulation.setDeviceMetricsOverride，那会让 `window.inner*` 与
          // `screen.*` 对不上 —— 恰好是反爬爱查的一条。
          viewport: null,
          locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
          ...proxyOpts(useProxy),
          ...c.opts,
        });
        console.log('✓ 已启动浏览器：' + c.label + modeTag(useProxy) + '（持久化 profile）');
        return { context: ctx, browser: null };
      } catch (e) {
        errors.push({ label: c.label, msg: String((e && e.message) || e) });
      }
    }
    return null;
  };

  let r = await tryCandidates();

  // ★ 自愈：起不来十有八九是**上次的浏览器窗口还开着**、锁着 profile
  //   （报错特征 "Target page, context or browser has been closed"：浏览器进程
  //   发现 profile 被占就自己退了，Playwright 只看到「它关了」）。
  //   按命令行精准清理遗留进程后重试一次 —— 用户不用知道这些。
  if (!r && errors.some((e) => /has been closed|ProcessSingleton|SingletonLock|singleton/i.test(e.msg))) {
    console.log('⚠ 上一次打开的浏览器窗口还开着，把登录 profile 锁住了（多半就是那个空白窗口）。');
    console.log('  正在自动清掉它并重试……');
    killStaleBrowsers();
    await new Promise((s) => setTimeout(s, 1500));
    r = await tryCandidates();
  }

  // 还不行就降级成**一次性窗口**：登录后照样保存 cookie 文件（自动投递只认
  // data/cookies/boss.json），只是这个会话不留在 profile 里，下次可能要重登。
  if (!r) {
    console.log('⚠ 持久化 profile 还是起不来，改用一次性窗口（登录后照样保存 cookie 文件）。');
    const seen = new Set();
    for (const e of errors) {
      const line = e.msg.split('\n')[0];
      if (seen.has(line)) continue;          // 两轮候选的错误多半一样，去重再打
      seen.add(line);
      console.log('  · ' + e.label + ' — ' + line);
    }
    const br = await launchBrowser(useProxy);
    const ctx = await br.newContext({
      viewport: null, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', ...proxyOpts(useProxy),
    });
    return { context: ctx, browser: br };
  }
  return r;
}

// ⚠️ **整个脚本不注入任何 stealth 脚本** —— 这是实测出来的结论，别再改回去。
//
// 以前这里有两行"反检测"：
//   Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
//   window.chrome = { runtime:{}, loadTimes(){}, csi(){}, app:{} };
// 结果对照实验（output/_diag-boss-headed.mjs 的 D/E/F/G 四组）里，
// **带着这两行的一次都没打开，去掉的那组一次就到站**。原因不难猜：
//   · `loadTimes` / `csi` 在现代 Chrome 里早被移除了，硬塞进去等于自己贴"我是假的"；
//   · 用 JS 改 `navigator.webdriver` 会留下 descriptor 痕迹，反爬专门查这个；
//   · 而启动参数里的 `--disable-blink-features=AutomationControlled` 是**原生**去标志的，
//     不留痕迹 —— 有它就够了。
// 想看得更真，靠的是「不画蛇添足」，不是「多贴几层伪装」。

/**
 * 把提示直接**写进浏览器页面**里。
 * 为什么要它：导航失败时用户眼前就是一个哑巴 about:blank，黑窗口里的解释
 * 看不见/看不懂（踩了四轮「白屏」就是这个死循环）。把下一步该干什么写在
 * 页面上，用户不需要 Alt+Tab 也能自救。零 CDN，全内联样式。
 */
async function showNote(page, title, bodyHtml) {
  try {
    await page.setContent('<!doctype html><html><head><meta charset="utf-8">'
      + '<title>BOSS 登录助手 - career-ops</title></head>'
      + '<body style="margin:0;background:#f5f7fa;min-height:100vh">'
      + '<div style="font:15px/1.8 system-ui,\'Microsoft YaHei\',sans-serif;max-width:560px;'
      + 'margin:14vh auto 0;padding:26px 30px;background:#fff;border:1px solid #e4e7ec;'
      + 'border-radius:12px;color:#1d2939">'
      + '<h2 style="margin:0 0 10px;font-size:19px">' + title + '</h2>'
      + bodyHtml + '</div></body></html>');
  } catch { /* 页面马上要跳走了，写不进去就算了 */ }
}

const NOTE_FAIL = '<p>多半是 <b>BOSS 限流</b>：短时间内打开太多次，它不报错、'
  + '直接把页面跳成空白（这个窗口停在 about:blank 就是证据）。</p>'
  + '<ol style="padding-left:22px;margin:8px 0 0">'
  + '<li>等 <b>1～2 分钟</b>，在上方地址栏手动输入 <b>login.zhipin.com</b> 回车；</li>'
  + '<li>或者<b>关掉本窗口和黑色命令行窗口</b>，等 5 分钟，重新双击「登录BOSS.cmd」；</li>'
  + '<li>手动打开的登录页一样算数：登录完回黑窗口按回车保存。</li></ol>';

/**
 * 打开页面并等到真的渲染出内容。
 *
 * ⚠️⚠️ **重试只做 2 轮，这是刻意的**（以前是 4 轮）。
 * BOSS 有**频率限制**：短时间内反复打开登录页，它不弹验证、也不报错，
 * 而是**静默把页面跳到 `about:blank`** —— 你看到的就是一片白。
 * 实测（`output/_diag-boss-once.mjs`）：连开十几次之后，同样的配置、同样的代码
 * 全部漂到 about:blank；**干等 100 秒再单次打开，一次就成功**。
 * 所以 4 轮 reload 不是在"重试"，是在**给自己上刑** —— 每刷一次限流就更狠一层。
 * 正确的做法是：失败就停手，告诉用户等几分钟再来。
 *
 * 每轮都把「状态码 / 当前地址 / 标题 / 正文长度」打出来 —— 白屏时这几行就是证据，
 * 不用再靠猜（踩过：只打「第 N 次渲染为空」，什么原因都看不出来）。
 */
async function openAndSettle(page, url) {
  await showNote(page, '正在打开 BOSS 登录页…',
    '<p>马上就好。若长时间停在这里，看黑色命令行窗口里的进度。</p>');
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let status = '?';
    try {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      status = r ? r.status() : 'null(可能被重定向走了)';
    } catch (e) {
      console.log('  · 第 ' + attempt + ' 轮：打开超时（' + String(e.message).split('\n')[0].slice(0, 70) + '）');
      continue;
    }

    // ⚠️ 判「到站了」唯一可靠的依据是**当前地址里有 zhipin.com**。
    // 不能用"正文够长 / 有输入框"当判据：页面停在 `about:blank` 的时候，
    // 这两条都可能偶然成立（实测就出现过「正文 15 字符，已就绪」的假绿），
    // 于是脚本欢快地报告成功，用户眼前却是一片空白 —— 白折腾好几轮就是这么来的。
    // 地址对了才算到站；地址不对一律重试。
    //
    // 另外 goto 完先立刻看一眼地址：停在 about:blank 就不用再等 15 秒了
    // （代理死掉时每轮都会卡满 timeout，4 轮就是一分钟，用户早跑了）。
    const reached = /zhipin\.com/.test(page.url());
    const ok = reached
      ? await page.waitForFunction(
        () => {
          const b = document.body;
          return !!b && ((b.innerText || '').trim().length > 50
            || b.querySelectorAll('input').length > 0);
        },
        null, { timeout: 15000 },
      ).then(() => true).catch(() => false)
      : false;

    if (ok) {
      const len = await page.evaluate(() => (document.body.innerText || '').length);
      console.log('  · 第 ' + attempt + ' 轮：HTTP ' + status + '，地址 ' + page.url()
        + '，正文 ' + len + ' 字符 → 到站');
      return true;
    }

    // 没到站 —— 把现场打出来（这几行就是诊断依据）
    const now = page.url();
    const title = await page.title().catch(() => '');
    const len = await page.evaluate(() => (document.body && document.body.innerText || '').length).catch(() => 0);
    const blank = /^about:blank/.test(now);
    console.log('  · 第 ' + attempt + ' 轮：HTTP ' + status + '，地址 ' + now
      + '，标题「' + (title || '空') + '」，正文 ' + len + ' 字符'
      + (blank ? ' → 漂到了 about:blank' : ' → 没到站'));
    if (blank) {
      // 停在 about:blank 就别再刷了 —— 刷一次限流狠一层，参见上面那段说明
      console.log('    ⚠ 多半是 **BOSS 限流了**（短时间内开太多次），'
        + '它不报错、直接把页面跳成空白。再刷只会更糟。');
      await showNote(page, '登录页没打开（about:blank）', NOTE_FAIL);
      return false;
    }
    await page.waitForTimeout(5000);
  }
  await showNote(page, '登录页没打开', NOTE_FAIL);
  return false;
}

const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); resolve(a); });
});

/**
 * 把浏览器窗口在**操作系统层面**顶到最前。
 *
 * 为什么光靠 Playwright 的 page.bringToFront() 不够：那个只在浏览器内部切标签页，
 * 管不到「另一个进程的窗口盖在浏览器上面」这种情况 —— 而这里恰好就有一个：
 * 跑脚本的 cmd 窗口。用户盯着 cmd 看到的是命令行，以为"白屏"，实际登录页在后面。
 *
 * 做法：写一个临时 .ps1，枚举所有顶层窗口，挑标题像 BOSS 的，调 user32 的
 * ShowWindow + SetForegroundWindow。全部失败也不影响主流程（纯锦上添花）。
 */
const PS_SRC = [
  '$ErrorActionPreference="SilentlyContinue"',
  'Add-Type @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public class W {',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
  '}',
  '"@',
  '$ps = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -match "msedge|chrome|chromium" }',
  '$hit = $ps | Where-Object { $_.MainWindowTitle -match "zhipin|BOSS|直聘" }',
  'if (-not $hit) { $hit = $ps }',
  'foreach ($p in $hit) { [W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }',
  'Write-Output ("foreground: " + ($hit | ForEach-Object { $_.MainWindowTitle }) -join " | ")',
].join('\n');

function raiseBrowserWindow() {
  return new Promise((resolve) => {
    const tmp = path.join(process.cwd(), 'data', '_raise-window.ps1');
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      fs.writeFileSync(tmp, PS_SRC, 'utf8');
    } catch { resolve(''); return; }
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        try { fs.rmSync(tmp, { force: true }); } catch { /* 删不掉就算了，下次覆盖 */ }
        resolve(err ? '' : String(stdout || '').trim());
      });
  });
}

async function main() {
  console.log('\nBOSS 直聘登录态保存');
  console.log('─'.repeat(50));
  console.log('1. 会弹出一个浏览器窗口，打开 BOSS 首页');
  console.log('2. 在窗口里**登录**（扫码或手机号），登录到能看到自己头像/昵称');
  console.log('3. 回到这个终端，按 [回车] 保存');
  console.log('4. 没登录就按回车的话，脚本会当场告诉你 —— 不会静默存一份没用的');
  console.log('─'.repeat(50) + '\n');

  if (fs.existsSync(OUT_PATH)) {
    const old = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    if (!hasLoginCookie(old)) {
      console.log('⚠ 现有的 data/cookies/boss.json 是**匿名态**（缺 '
        + LOGIN_COOKIES.join(' / ') + '），这次要真的登录再保存。\n');
    }
  }

  const target = USE_HOME ? HOME_URL : LOGIN_URL;

  /**
   * 开一次浏览器并尝试打开目标页。
   * 为什么要能重复调用：**先直连、不行再换代理** —— 本机那个 http_proxy 端口
   * 经常是死的，走它就必然 about:blank；而有些网络又必须走代理。
   * 两种都试一遍，比让用户自己去猜"我到底要不要挂代理"强。
   */
  async function attempt(useProxy) {
    let ctx;
    let br = null;             // 一次性模式下要连带关掉浏览器进程，否则进程挂着不退出
    if (PERSIST) {
      const pr = await launchPersistent(useProxy);
      ctx = pr.context;
      br = pr.browser;
    } else {
      br = await launchBrowser(useProxy);
      ctx = await br.newContext({
        // 用本机真实环境：Windows + 中文 + 上海时区，不伪造
        viewport: null,          // 同 launchPersistent：不做设备模拟，见那里的说明
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
      });
    }
    LIVE_CTX = ctx;              // 给信号兜底用：黑窗口被关时尽力带上浏览器
    LIVE_BR = br;
    // ⚠️ 刻意**不加** addInitScript —— 见上面 STEALTH 那段注释。
    // ⚠️ 复用 persistent context 启动时已有的那个页面：实测直接 newPage() 的
    //    那几组会漂到 about:blank，`pages()[0]` 的能正常到站。
    const pg = ctx.pages()[0] || await ctx.newPage();
    // ⚠️ 把页面窗口顶到最前（浏览器内部切标签页）
    await pg.bringToFront().catch(() => {});
    console.log('\n正在打开：' + target + (USE_HOME ? '（首页，--home）' : '（登录页）'));
    const good = await openAndSettle(pg, target);
    return { context: ctx, browser: br, page: pg, ok: good };
  }

  async function closeAttempt(r) {
    await r.context.close().catch(() => {});
    if (r.browser) await r.browser.close().catch(() => {});
  }

  let r = await attempt(false);                 // ① 先直连（默认，最稳）
  if (!r.ok && ENV_PROXY) {                     // ② 直连不通且配了代理 → 换代理再来一次
    console.log('\n直连打不开。本机环境变量里配了代理（' + ENV_PROXY + '），换它重试一次…');
    await closeAttempt(r);
    r = await attempt(true);
  }
  const context = r.context;
  const browser = r.browser;
  const page = r.page;
  const ok = r.ok;

  // ⚠️ 第二层保险：在**操作系统层面**把浏览器窗口顶到最前
  //    （对付「cmd 窗口盖在浏览器上」—— 用户盯着 cmd 看到命令行，
  //     就以为登录页白屏了，其实页面在后面好好的）。
  await page.bringToFront().catch(() => {});
  // ⚠️ 默认**不做**系统级窗口置顶 —— 实测它会把 BOSS 的登录页弄丢：
  // 开着它，页面第 1 轮明明已经到站（地址 = login.zhipin.com），
  // 等置顶完回头一看就变成了 `about:blank`，输入框 0 个；
  // 关掉它（NO_RAISE=1）同一时刻、同一份代码，一次就正常到站。
  // 怀疑是 ShowWindow/SetForegroundWindow 打断了这个 SPA 的首屏渲染，
  // 具体机制不必深究 —— 反正代价是"用户得自己 Alt+Tab 一下"，
  // 收益是"页面不会白"，这笔账很清楚。真想要置顶就加 --raise。
  const raised = DO_RAISE ? await raiseBrowserWindow() : '';

  if (raised) console.log('  （已尝试把浏览器窗口置顶：' + raised.slice(0, 100) + '）');

  // 体检模式：看一眼就走，不登录、不保存、不等回车
  if (CHECK_ONLY) {
    const nowUrl = page.url();
    const nInput = await page.evaluate(() => document.querySelectorAll('input').length).catch(() => 0);
    const logged = hasLoginCookie(await context.cookies());
    console.log('\n' + '─'.repeat(50));
    console.log(ok ? '✓ 页面能打开' : '✗ 页面没渲染出来（看上面那几轮的「地址/标题/正文长度」）');
    console.log('  当前地址：' + nowUrl);
    console.log('  输入框个数：' + nInput + (nInput > 0 ? '（有 → 这就是登录页）' : '（没有 → 可能没到登录页）'));
    console.log('  登录态：' + (logged ? '已有 ✓' : '还没有'));
    console.log('─'.repeat(50));
    console.log(ok
      ? '\n能打开就说明这条链路是通的。正式登录去掉 --check 再跑一次即可。'
      : '\n打不开：**先等 5 分钟再试**（BOSS 限流会在几分钟后自己放开，越急着刷越打不开）。');
    console.log('─'.repeat(50) + '\n');
    await context.close();
    if (browser) await browser.close().catch(() => {});
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (!ok) {
    console.log('\n⚠ 没打开登录页（上面那几轮的「地址 / 正文长度」就是现场）。');
    console.log('  按可能性排序：');
    console.log('  ① **被限流了**（最常见）：短时间内开太多次，BOSS 不报错，')
    console.log('     直接把页面跳成 about:blank。**等 5 分钟再来**，别连着刷。');
    console.log('  ② 被风控弹了验证：在浏览器窗口里手动过验证，或手动输入');
    console.log('     https://login.zhipin.com/ 回车，登录完照样回这里按回车保存。');
    console.log('  ③ 网络问题：确认浏览器能正常打开 https://login.zhipin.com/ 。');
    console.log('  手动弄出来的页面一样能保存，不影响结果 —— 下面照样等你按回车。');
  } else {
    console.log('\n✓ 登录页已打开，请在浏览器里登录 BOSS。');
    console.log('  ⚠ 找不到窗口？找**标题带 zhipin / BOSS 的那个**，它可能被这个黑窗口压住了。');
    console.log('    这个黑窗口（标题「Microsoft Windows [版本 10.0.xxxxx]」）里面全是命令行 ——');
    console.log('    看到它不叫白屏，那只是命令行。按 Alt+Tab 切到浏览器即可。');
    console.log('    （脚本刻意不用系统 API 去抢前台：实测那样会把登录页弄成空白。）');
  }

  // 持久化目录里可能**已经是登录态**了（上次登录过）：先查一次，
  // 是的话直接告诉用户不用再登 —— 免得白扫一次码。
  const already = hasLoginCookie(await context.cookies());
  if (already) {
    console.log('\n★ 检测到**已经是登录态**了（profile 里存着上次的会话）。');
    console.log('  不用再登录，直接按回车保存即可。');
    console.log('  （如果首页右上角确实是你的头像，那就确认无误。）');
  }

  await ask('登录完成后按回车保存…');

  const all = await context.cookies();
  // 只留 BOSS 自己的 cookie：持久化 profile 里会混进一堆别的站（Edge 遥测、广告联盟…），
  // 全存进去既占地方又会让「cookie 数量」这个指标失真。
  // 保险起见：万一筛完是空的（域名写法变了），就退回全量，绝不存空文件。
  const isZhipin = (c) => /(^|\.)zhipin\.com$/i.test(String(c.domain || '').replace(/^\./, ''))
    || LOGIN_COOKIES.includes(c.name);
  const filtered = all.filter(isZhipin);
  const cookies = filtered.length ? filtered : all;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(cookies, null, 2), 'utf8');

  const logged = hasLoginCookie(cookies);
  console.log('\n' + '─'.repeat(50));
  console.log('已保存 ' + cookies.length + ' 条 cookie → data/cookies/boss.json'
    + (filtered.length && filtered.length !== all.length ? '（已滤掉 ' + (all.length - filtered.length) + ' 条非 BOSS 的）' : ''));
  if (logged) {
    console.log('✓ 检测到登录态（' + LOGIN_COOKIES.filter((n) => cookies.some((c) => c.name === n)).join(' / ')
      + '）—— 现在可以去跑「自动投递」了。');
  } else {
    console.log('✗ **没有检测到登录态**（缺 ' + LOGIN_COOKIES.join(' / ') + '）');
    console.log('  多半是刚才没真的登录进去（扫码后没点确认 / 被风控弹了验证 / 跳回首页但右上角还是「登录」）。');
    console.log('  重跑一次：node save-cookies-boss.mjs' + (PERSIST ? ' --persist' : ' --persist ← 建议加这个'));
    console.log('  这次确认浏览器右上角显示的是你的头像/昵称，再回来按回车。');
  }
  if (!PERSIST) {
    console.log('  提示：下次可以用 node save-cookies-boss.mjs --persist，'
      + '把登录会话存进浏览器 profile，过期后不用重新扫码。');
  }
  console.log('─'.repeat(50) + '\n');

  await context.close();
  if (browser) await browser.close().catch(() => {});
  process.exitCode = logged ? 0 : 1;
}

main().catch((e) => { console.error('✗ ' + e.message); process.exitCode = 1; });
