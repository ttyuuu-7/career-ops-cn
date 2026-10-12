import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

/**
 * 模拟人类行为的高级抓取脚本
 * 针对 BOSS 直聘等严格反爬平台进行了优化
 *
 * 本地适配补丁（fork 自加，社区原版没有）：
 *   原版只认位置参数 `node fetch-jd-stealth.mjs <url> <site>`，单条抓取、必须手写站点名。
 *   这里补上截图里用到的命令行形式，同时保留原版位置参数：
 *     node fetch-jd-stealth.mjs --url "https://www.zhipin.com/job_detail/xxx.html"
 *     node fetch-jd-stealth.mjs --file jobs.txt --output ./jd-raw/
 *   站点（boss/liepin/51job）现在可按域名自动识别，不必手填。
 */

const COOKIE_DIR = () => path.join(process.cwd(), 'data', 'cookies');

/** 按域名识别站点；识别不出时返回 generic（抓正文全文，不做平台专用选择器）。 */
function detectSite(url) {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();
  if (host.includes('zhipin.com')) return 'boss';
  if (host.includes('liepin.com')) return 'liepin';
  if (host.includes('51job.com')) return '51job';
  return 'generic';
}

/**
 * 启动浏览器：按 [Chrome → Edge → 内置 Chromium] 回退。
 *
 * 原版写死内置 Chromium（headless），而 BOSS 直聘这类平台会识别它并把页面清成
 * about:blank。Edge/Chrome 是真浏览器内核，反爬特征更接近普通用户，优先使用。
 */
async function launchBrowser({ headless, proxy, channel }) {
  const all = {
    chrome: { label: 'Google Chrome', opts: { channel: 'chrome' } },
    msedge: { label: 'Microsoft Edge', opts: { channel: 'msedge' } },
    chromium: { label: '内置 Chromium', opts: {} },
  };
  const candidates = channel ? [all[channel]].filter(Boolean) : [all.chrome, all.msedge, all.chromium];
  const failures = [];
  for (const c of candidates) {
    try {
      const browser = await chromium.launch({
        headless,
        ...(proxy ? { proxy: { server: proxy } } : {}),
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--ignore-certificate-errors',
          '--window-size=1920,1080'
        ],
        ...c.opts
      });
      console.error(`浏览器内核: ${c.label}（headless=${headless}）`);
      return browser;
    } catch (e) {
      failures.push(`${c.label} — ${String(e.message).split('\n')[0]}`);
    }
  }
  throw new Error(`没有可用的浏览器，依次尝试的结果：\n  ${failures.join('\n  ')}`);
}

/** 平台专用选择器：尽量只取 JD 正文，避免把导航/推荐位一起抓进来。 */async function extractContent(page, siteName) {
  if (siteName === 'boss') {
    await page.waitForSelector('.job-detail', { timeout: 15000 }).catch(() => {});
    return page.evaluate(() => {
      const title = document.querySelector('.name')?.innerText || '';
      const salary = document.querySelector('.salary')?.innerText || '';
      const desc = document.querySelector('.job-sec-text')?.innerText || '';
      const company = document.querySelector('.company-info .name')?.innerText || '';
      return `职位: ${title}\n薪资: ${salary}\n公司: ${company}\n\n详情:\n${desc}`;
    });
  }
  if (siteName === 'liepin') {
    await page.waitForSelector('.job-description-main', { timeout: 15000 }).catch(() => {});
    return page.evaluate(() => {
      const title = document.querySelector('.name')?.innerText || '';
      const salary = document.querySelector('.salary')?.innerText || '';
      const desc = document.querySelector('.job-description-main')?.innerText || '';
      return `职位: ${title}\n薪资: ${salary}\n\n详情:\n${desc}`;
    });
  }
  return page.evaluate(() => document.body.innerText);
}

/**
 * 抓一条 JD。
 * @param {import('playwright').Browser} browser - 复用的浏览器实例（批量模式只启动一次）。
 * @param {string} url - 目标职位页。
 * @param {string} siteName - boss | liepin | 51job | generic。
 * @returns {Promise<{title: string, content: string}>}
 */
async function fetchOne(browser, url, siteName) {
  const cookiePath = path.join(COOKIE_DIR(), `${siteName}.json`);

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai'
  });

  try {
    // 1. 注入隐身脚本：移除 webdriver 标记，模拟真实插件环境
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // 模拟 Chrome 插件环境
      window.chrome = { runtime: {} };
      // 模拟语言偏好
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    });

    // 2. 注入 Cookie
    if (fs.existsSync(cookiePath)) {
      const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      // 过滤掉不合法的 cookie 属性
      const validCookies = cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite === 'None' ? 'None' : (c.sameSite === 'Lax' ? 'Lax' : 'Strict')
      }));
      await context.addCookies(validCookies);
      console.error(`[${siteName}] 已从本地加载 Cookie 进行鉴权`);
    } else {
      console.error(`[${siteName}] 未找到 ${cookiePath}，将匿名访问（大概率被拦，请先跑 save-cookies.mjs）`);
    }

    const page = await context.newPage();

    console.error(`正在启动隐身抓取: ${url}`);

    // 3. 随机延迟，模拟人类操作习惯
    await page.waitForTimeout(Math.floor(Math.random() * 2000) + 1000);

    // 4. 访问页面
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    if (response && response.status() === 403) {
      throw new Error('被拦截 (403 Forbidden) - 建议更新 Cookie 或更换 IP');
    }

    // 4b. 反自动化平台的常用手段：识别出 Playwright 后把页面替换成 about:blank
    if (page.url() === 'about:blank') {
      throw new Error(
        '页面被清成 about:blank —— 平台识别出了自动化浏览器，直接中断了访问。\n' +
          '     对策：先跑 save-cookies.mjs（用真实浏览器登录拿 Cookie），再重试；\n' +
          '     也可以加 --headed 或 --channel msedge 换成真浏览器内核观察。'
      );
    }

    // 5. 模拟滚动，触发懒加载和反爬验证
    //    反爬平台常在加载后立刻跳转到验证页，此时 evaluate 会因上下文销毁而抛错，
    //    这里不再直接冒泡（原来会报一句看不懂的 "Execution context was destroyed"），
    //    交给下面统一的拦截识别给结论。
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        let distance = 100;
        let timer = setInterval(() => {
          let scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    }).catch(() => {});

    // 5b. 识别安全验证 / 拦截页，给出可操作的结论
    const blocked = await page.evaluate(() => {
      const text = `${document.title || ''} ${document.body?.innerText?.slice(0, 500) || ''}`;
      return /安全验证|请完成验证|滑块|访问过于频繁|拖动滑块|Just a moment|Verify you are human|captcha/i.test(text);
    }).catch(() => false);
    if (blocked) {
      throw new Error('页面是安全验证页（触发了平台风控）——请先跑 save-cookies.mjs 登录保存 Cookie，或用 --headed 观察');
    }

    // 6. 针对不同平台的选择器优化
    const content = await extractContent(page, siteName);

    if (!content || content.trim().length < 50) {
      // 反自动化脚本往往在页面加载之后才动手，所以这里要再判一次 about:blank
      const finalUrl = page.url();
      if (finalUrl === 'about:blank') {
        throw new Error(
          '页面被清成 about:blank —— 平台识别出了自动化浏览器，直接中断了访问。\n' +
            '     对策：先跑 save-cookies.mjs（用真实浏览器登录拿 Cookie），再重试；\n' +
            '     也可以加 --headed 或 --channel msedge 换成真浏览器内核观察。'
        );
      }
      // 带上最终地址与页面标题：被风控跳到验证页/首页时，这两个信息才看得出发生了什么
      const pgTitle = await page.title().catch(() => '');
      throw new Error(
        `抓取内容过短（不到 50 字）\n     最终地址: ${finalUrl}\n     页面标题: ${pgTitle || '(空)'}\n` +
          '     多半是被风控跳转了验证页、或该页需要登录态 —— 先跑 save-cookies.mjs，再试 --headed 观察'
      );
    }

    const title = await page.title();
    console.error(`✓ 抓取成功: ${title}`);
    return { title, content };
  } finally {
    await context.close();
  }
}

/** URL → 安全的文件名片段。 */
function slugOf(url) {
  let tail = url;
  try {
    const u = new URL(url);
    tail = `${u.hostname}${u.pathname}`;
  } catch { /* 保留原始串 */ }
  const slug = tail
    .replace(/^www\./, '')
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'jd';
}

function usage() {
  console.error(`用法:
  单条:  node fetch-jd-stealth.mjs --url "https://www.zhipin.com/job_detail/xxxxx.html"
         node fetch-jd-stealth.mjs <url> [boss|liepin|51job]        # 原版位置参数形式
  批量:  node fetch-jd-stealth.mjs --file jobs.txt --output ./jd-raw/
         （jobs.txt 一行一个链接；站点按域名自动识别）
         node fetch-jd-stealth.mjs --file jobs.txt --output ./jd-raw/ --merged ./jd-batch.txt
         （--merged 额外生成一份用 --- 分隔的合并稿，可直接导入控制台「批量初筛」）

可选:  --merged <路径>             批量模式额外输出合并稿（多个岗位用单独一行的 --- 隔开）
       --site <boss|liepin|51job>  强制指定站点
       --headed                    显示浏览器窗口（排查被拦时用）
       --channel <chrome|msedge|chromium>
                                   指定浏览器内核，默认按 Chrome → Edge → 内置 Chromium 回退
       --proxy <url>               走代理，如 http://127.0.0.1:7890
                                   （Playwright 默认直连，不继承系统代理；
                                    国内站点建议直连，境外站点才需要）
       --delay <ms>                批量模式每条之间的间隔，默认 2000-5000 随机`);
}

function parseArgs(argv) {
  const opts = { url: null, file: null, output: './jd-raw/', merged: null, site: null, headed: false, delay: null, proxy: null, channel: null, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' || a === '-u') opts.url = argv[++i];
    else if (a === '--file' || a === '-f') opts.file = argv[++i];
    else if (a === '--output' || a === '-o') opts.output = argv[++i];
    else if (a === '--merged') opts.merged = argv[++i];
    else if (a === '--site' || a === '-s') opts.site = argv[++i];
    else if (a === '--delay') opts.delay = Number(argv[++i]);
    else if (a === '--proxy') opts.proxy = argv[++i];
    else if (a === '--channel') opts.channel = argv[++i];
    else if (a === '--headed') opts.headed = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else if (a.startsWith('-')) { console.error(`未知参数: ${a}`); usage(); process.exit(1); }
    else opts.positional.push(a);
  }
  // 兼容原版位置参数：node fetch-jd-stealth.mjs <url> <site>
  if (!opts.url && opts.positional[0]) opts.url = opts.positional[0];
  if (!opts.site && opts.positional[1]) opts.site = opts.positional[1];
  return opts;
}

const args = parseArgs(process.argv.slice(2));

if (!args.url && !args.file) {
  usage();
  process.exit(1);
}

const browser = await launchBrowser({
  headless: !args.headed,
  proxy: args.proxy,
  channel: args.channel,
});

try {
  if (args.url) {
    // ── 单条：JSON 写 stdout，进度写 stderr，方便直接管道给别的工具 ──
    const site = args.site || detectSite(args.url);
    const result = await fetchOne(browser, args.url, site);
    process.stdout.write(JSON.stringify(result));
  } else {
    // ── 批量：读链接清单，逐条抓取并落盘到 --output 目录 ──
    if (!fs.existsSync(args.file)) {
      console.error(`❌ 找不到链接清单: ${args.file}`);
      process.exit(1);
    }
    const urls = [...new Set(
      fs.readFileSync(args.file, 'utf-8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
    )];
    if (!urls.length) {
      console.error('❌ 清单里没有有效链接');
      process.exit(1);
    }

    fs.mkdirSync(args.output, { recursive: true });
    console.error(`共 ${urls.length} 条链接，输出目录: ${path.resolve(args.output)}`);

    let ok = 0;
    const failed = [];
    const saved = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const site = args.site || detectSite(url);
      const name = `${String(i + 1).padStart(2, '0')}-${slugOf(url)}.txt`;
      const outFile = path.join(args.output, name);
      console.error(`\n[${i + 1}/${urls.length}] ${url}`);
      try {
        const { content } = await fetchOne(browser, url, site);
        fs.writeFileSync(outFile, content.trimEnd() + '\n', 'utf-8');
        console.error(`   → 已保存 ${name}（${content.length} 字）`);
        saved.push(content.trimEnd());
        ok++;
      } catch (e) {
        console.error(`   ✗ 失败: ${e.message}`);
        failed.push({ url, reason: e.message });
      }
      if (i < urls.length - 1) {
        const wait = args.delay ?? (2000 + Math.floor(Math.random() * 3000));
        await new Promise(r => setTimeout(r, wait));
      }
    }
    console.error(`\n完成：成功 ${ok}/${urls.length}，输出在 ${path.resolve(args.output)}`);
    if (failed.length) {
      console.error('失败清单:');
      for (const f of failed) console.error(`  - ${f.url} — ${f.reason}`);
    }
    if (!ok) process.exitCode = 1;

    // ── 合并稿：一次导入控制台「批量初筛」用，块间必须是小写三个减号的独立行 ──
    // 控制台那边多选多个 .txt 虽然会自动合并，但**从第二个文件起会把文件名
    // 当前缀塞进岗位首行**，而首行是评估用来认「公司 + 岗位」的字段 —— 会污染结果。
    // 所以这里直接给一份已经合并好的单文件。
    if (args.merged && saved.length) {
      const mergedPath = path.resolve(args.merged);
      fs.mkdirSync(path.dirname(mergedPath), { recursive: true });
      fs.writeFileSync(mergedPath, saved.join('\n---\n') + '\n', 'utf-8');
      console.error(`→ 合并稿: ${mergedPath}（${saved.length} 个岗位，可直接导入控制台批量初筛）`);
      if (saved.length > 20) {
        console.error('   ⚠️ 批量初筛一次最多 20 个岗位，这份合并稿需要分次导入（或分批抓）。');
      }
    }
  }
} catch (e) {
  console.error(`❌ 抓取失败: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
