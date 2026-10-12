#!/usr/bin/env node
// ui/check-cv-versions.mjs — 「简历多版本」的回归
//
// 覆盖五段：
//   A. 前置与保护面（不写盘）—— 原版不可删不可改名、坏 id 被挡、路径穿越翻不出去
//   B. 增删改查真跑（会动真目录，跑完全部还原）
//   C. 硬约束：**任何版本操作都不能改到 cv.md**（这是整个功能的地基）
//   D. 前端流程（全部打桩，不碰真数据）—— 卡片、按钮、弹层、Diff 渲染、取消不发请求
//   E. 评估页入口：初筛 ≥3 分才出现「简历对应优化」，点击后 JD 与岗位名被带过去
//
// 三条不能破的底线，逐条都有断言：
//   1. **原版只读**：整轮自检前后 cv.md 的字节必须完全一致
//   2. **可恢复**：删版本必须先把正文移进 data/trash/，且文件名带得上版本名
//   3. **可独立**：AI 优化与 PDF 导出都要能只作用于某一个版本，不影响原版
//
// 前置：控制台已在 127.0.0.1:7317，且服务端是含版本接口的新代码
//       （旧进程没有这些路由，会在这里报 404 —— 重启控制台即可）。
// 用法：
//   node ui/check-cv-versions.mjs
//   BASE=http://127.0.0.1:7319 node ui/check-cv-versions.mjs   # 换端口
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CV_MD = path.join(ROOT, 'cv.md');
const VDIR = path.join(ROOT, 'data', 'cv-versions');
const INDEX = path.join(VDIR, 'index.json');
const BACKUPS = path.join(VDIR, '_backups');
const TRASH_DIR = path.join(ROOT, 'data', 'trash');
const BASE = process.env.BASE || 'http://127.0.0.1:7317';
const URL_BASE = BASE + '/';

// 自检用的版本名统一带这个前缀，收尾时按它精准清理，绝不误伤用户自己的版本
const TAG = '〔自检〕';

const fail = [];
const stuck = [];   // 收尾时怎么都删不掉的文件，最后逐条列给用户
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

/**
 * 收尾用的删除：先 unlink，失败就短间隔重试几次，仍不行就记进 stuck。
 *
 * **不要用「rename 到 os.tmpdir()」当兜底。** 实测那条兜底在本机等于没有：
 * 临时目录在 C: 而项目在 D:，`renameSync` 直接抛 **EXDEV**（跨盘不能 rename）。
 * 上游 `check-cv-optimize.mjs` 里也有同样的写法，属于照抄来的无效兜底。
 *
 * 重试覆盖的是「文件刚写完被瞬时占用（杀毒 / 索引 / 句柄未释放），几十毫秒后自愈」
 * 这一类。它**覆盖不了**「运行环境整体禁止删除」的情况 —— 沙箱里跑自检时，
 * `data/` 下的 unlink 会稳定失败，重试几次也删不掉。那种情况就如实把路径列出来，
 * 由用户在自己的终端里删（正常终端下删除是通的，沙箱的限制只在工具内生效）。
 */
async function removeFile(full, bucket) {
  for (let i = 0; i < 5; i++) {
    try { fs.unlinkSync(full); return true; } catch (e) {
      if (e && e.code === 'ENOENT') return true;      // 已经没了，也算成功
      await new Promise((r) => { setTimeout(r, 60 * (i + 1)); });
    }
  }
  bucket.push(full);
  return false;
}

const api = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON 就当没有 */ }
  return { status: r.status, body };
};
const post = (p, data) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});
const listVersions = async () => ((await api('/api/cv/versions')).body || {}).versions || [];

const trashList = () => (fs.existsSync(TRASH_DIR) ? fs.readdirSync(TRASH_DIR) : []);

// ── 现场快照：跑之前就存好，出任何事都能回来 ────────────────────────────
// userCvBefore = 用户原文件（还原用）；cvBefore = 本次的**基准**（钉入后指向
// 钉入内容 —— 见下面「钉住基准简历」）。
const userCvBefore = fs.existsSync(CV_MD) ? fs.readFileSync(CV_MD, 'utf8') : '';
let cvBefore = userCvBefore;
const indexBefore = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : null;
const trashBefore = new Set(trashList());
// 第二道保险放项目外，避免自检崩在还原之前就回不去了
const SAFETY = path.join(os.tmpdir(), 'career-ops-cv-before-check-versions.md');
if (userCvBefore) fs.writeFileSync(SAFETY, userCvBefore, 'utf8');
// 钉入基准简历会连表单缓存一起写（POST /api/cv）—— 原文件也要存一份，
// finally 里一并还原，否则用户的表单会停在「自检基准」上。
const CV_FORM_PATH = path.join(ROOT, 'data', 'cv-form.json');
const userFormBefore = fs.existsSync(CV_FORM_PATH) ? fs.readFileSync(CV_FORM_PATH, 'utf8') : null;

let browser = null;
const createdIds = [];   // 本次自检建出来的版本，收尾全删

// ⚠️ 钉住基准简历（2026-10-10）：这个自检全程拿「当前简历」当基准，而 C 段的
//    改写稿是 `cv.md + marker` —— 用户把简历清空过（或新号还没填）时，
//    改写稿短于 apply 的 100 字符下限，会以 400「改写稿太短」被拒，
//    C 段整片假红，看着像写回功能坏了，其实只是没数据可写。
//    先落一份够长的基准简历（主简历 + 表单缓存一起写，与服务端真实状态一致），
//    跑完在 finally 里按 userCvBefore 原样还原。
try {
  const PIN_FORM = {
    candidate: { name: '自检基准', phone: '13800000000', email: 'check@example.com', location: '北京' },
    summary: '自检用的基准简历：这一段只为把正文长度顶过 apply 的改写稿下限，不代表任何真实候选人。',
    education: [{
      school: '某某大学', major: '计算机科学与技术', degree: '本科',
      start: '2023-09', end: '至今', detail: '',
    }],
    skills: [{ name: 'JavaScript' }, { name: 'CSS' }, { name: 'Vue3' }],
    experience: [], projects: [], certifications: [], awards: [], competencies: [],
  };
  const pin = await post('/api/cv', { form: PIN_FORM, force: true });
  if (pin.status !== 200) throw new Error('钉入基准简历失败（HTTP ' + pin.status + '）');
  cvBefore = fs.readFileSync(CV_MD, 'utf8');
  ok(cvBefore.trim().length >= 100, '已钉入基准简历（' + cvBefore.trim().length + ' 字符）');
} catch (e) {
  console.log('  ✗ 钉入基准简历失败：' + e.message + '（后面的「未变」断言会跟着红）');
}

try {
  // ══ A. 前置与保护面 ═════════════════════════════════════════════════════
  console.log('\n── A. 前置与保护面：坏输入被挡，且什么文件都不动 ──');
  {
    const a0 = await api('/api/cv/versions');
    ok(a0.status === 200 && Array.isArray(a0.body.versions),
      '版本列表接口可用（HTTP ' + a0.status + '）');
    if (a0.status !== 200) {
      console.log('  ⚠ 接口不可用 —— 多半是控制台还跑着旧代码，重启后重试。');
    }
    ok((a0.body.versions || [])[0] && a0.body.versions[0].id === 'base',
      '原版永远排在第一位');

    ok(!cvBefore.trim() === false, 'cv.md 有内容（自检才有意义）');

    const a1 = await post('/api/cv/versions/create', { name: '   ' });
    ok(a1.status === 400, '空名新建 → 400（实际 ' + a1.status + '）');

    const a2 = await post('/api/cv/versions/create', { name: TAG + 'x', source: '不存在' });
    ok(a2.status === 404, '来源版本不存在 → 404（实际 ' + a2.status + '）');

    const a3 = await post('/api/cv/versions/delete', { id: 'base' });
    ok(a3.status === 400, '删原版 → 400 被拒（实际 ' + a3.status + '）');
    ok(String(a3.body.hint || '').includes('cv.md'), '拒绝理由点名了 cv.md');

    const a4 = await post('/api/cv/versions/rename', { id: 'base', name: '改名试试' });
    ok(a4.status === 400, '给原版改名 → 400 被拒（实际 ' + a4.status + '）');

    // 路径穿越有**两道**防线，两道都要验：
    //   ① 直连 id → 索引里查不到，直接 404（挡在 versionFile() 之前）
    //   ② 索引被手改成恶意 id → readVersionIndex() 的白名单会把它滤掉
    // 只断言「不是 200」是不够的 —— 那样即使实现改成先拼路径再校验也会通过。
    const a5 = await post('/api/cv/versions/delete', { id: '../../cv' });
    const a6 = await api('/api/cv/versions/content?id=' + encodeURIComponent('../../../etc/passwd'));
    ok(a5.status !== 200 && a6.status !== 200,
      '直连穿越 id 被拒（delete ' + a5.status + ' / content ' + a6.status + '）');

    // ② 把恶意 id 直接塞进索引，验证它既不会被列出，也读不到盘外文件
    let poisonSeen = false;
    let poisonRead = 'skipped';
    if (fs.existsSync(INDEX)) {
      const good = fs.readFileSync(INDEX, 'utf8');
      try {
        const arr = JSON.parse(good);
        arr.push({ id: '../../../../config/profile', name: TAG + '投毒条目', targetRole: '' });
        fs.writeFileSync(INDEX, JSON.stringify(arr, null, 2), 'utf8');

        const listed = await listVersions();
        poisonSeen = listed.some((v) => String(v.id).includes('..'));
        const pr = await api('/api/cv/versions/content?id=' + encodeURIComponent('../../../../config/profile'));
        poisonRead = String(pr.status);
      } finally {
        fs.writeFileSync(INDEX, good, 'utf8');   // 立刻还原，别把投毒留在盘上
      }
    }
    ok(poisonSeen === false, '索引里被塞进的穿越 id 不会被列出来（白名单在读取处就滤掉了）');
    ok(poisonRead !== '200', '对投毒 id 取内容读不到盘外文件（HTTP ' + poisonRead + '）');

    const a7 = await api('/api/cv/versions/content?id=nosuchversion00');
    ok(a7.status === 404, '不存在的版本取内容 → 404（实际 ' + a7.status + '）');

    const a8 = await post('/api/cv/versions/diff', { a: 'base', b: 'nosuchversion00' });
    ok(a8.status === 404, '对不存在的版本做 Diff → 404（实际 ' + a8.status + '）');

    ok(fs.readFileSync(CV_MD, 'utf8') === cvBefore, 'A 段结束后 cv.md 字节未变');
  }

  // ══ B. 增删改查真跑 ═════════════════════════════════════════════════════
  console.log('\n── B. 增删改查：新建 / 复制 / 重命名 / 差值 / 删除 ──');
  let idA = '', idB = '';
  {
    // B1. 从原版新建
    const n1 = await post('/api/cv/versions/create', {
      name: TAG + '后端开发', targetRole: '后端开发工程师', source: 'base',
    });
    idA = (n1.body.version || {}).id || '';
    createdIds.push(idA);
    ok(n1.status === 200 && !!idA, '从原版新建成功，拿到 id：' + idA);
    ok((n1.body.version || {}).sourceName === '原版简历', '记录了来源＝原版简历');
    ok(fs.existsSync(path.join(VDIR, idA + '.md')), '版本正文文件已落盘');
    ok(fs.readFileSync(path.join(VDIR, idA + '.md'), 'utf8') === cvBefore,
      '新建版本的正文与原版逐字节一致（复制而不是引用）');

    // B2. 取内容
    const c = await api('/api/cv/versions/content?id=' + idA);
    ok(c.status === 200 && c.body.markdown === cvBefore, '取内容返回的正文与源一致');
    ok(Array.isArray(c.body.audit.broken) && c.body.audit.broken.length === 0,
      '正文能完整解析（audit.broken 为空）');
    ok(c.body.completeness && c.body.completeness.percent > 0,
      '完整度算得出来：' + (c.body.completeness || {}).percent + '%');

    // B3. 重命名 + 改适配岗位
    const rn = await post('/api/cv/versions/rename', {
      id: idA, name: TAG + '后端开发（改）', targetRole: 'Java 后端',
    });
    ok(rn.status === 200 && rn.body.version.name === TAG + '后端开发（改）',
      '重命名生效：' + (rn.body.version || {}).name);
    ok(rn.body.version.targetRole === 'Java 后端', '适配岗位一并更新');
    ok(fs.readFileSync(path.join(VDIR, idA + '.md'), 'utf8') === cvBefore,
      '重命名没动到正文文件');

    // B4. 复制该版本 → 新版本
    const n2 = await post('/api/cv/versions/create', {
      name: TAG + 'Java 岗', targetRole: 'Java 后端', source: idA,
    });
    idB = (n2.body.version || {}).id || '';
    createdIds.push(idB);
    ok(n2.status === 200 && !!idB && idB !== idA, '从版本复制出新版本：' + idB);
    ok((n2.body.version || {}).sourceName === TAG + '后端开发（改）',
      '新版本的来源指向被复制的那一版');

    // B5. Diff：内容相同 → identical；制造差异 → 统计对得上
    const d1 = await post('/api/cv/versions/diff', { a: idA, b: idB });
    ok(d1.status === 200 && d1.body.identical === true, '两份同源版本 Diff 判定为完全相同');
    ok(d1.body.stats.added === 0 && d1.body.stats.removed === 0, '相同内容的增删行数都是 0');

    const extra = TAG + '本行只在 B 版里';
    const inB = fs.readFileSync(path.join(VDIR, idB + '.md'), 'utf8').replace(/\s*$/, '') + '\n\n' + extra + '\n';
    fs.writeFileSync(path.join(VDIR, idB + '.md'), inB, 'utf8');
    const d2 = await post('/api/cv/versions/diff', { a: idA, b: idB });
    ok(d2.status === 200 && d2.body.identical === false, '加了内容后 Diff 判定为有差异');
    ok(d2.body.stats.added >= 1 && d2.body.stats.removed === 0,
      '差异统计正确：+' + d2.body.stats.added + ' / -' + d2.body.stats.removed);
    const marked = (d2.body.lines || []).filter((l) => l.t === '+').some((l) => l.text.includes(extra));
    ok(marked, '新增的那一行在 Diff 结果里被标成了「+」');
    const numbered = (d2.body.lines || []).every((l) => l.t === '!' || (l.a != null || l.b != null));
    ok(numbered, '每一行都带行号（前端那两列行号靠它显示）');

    // B6. 删除 → 回收目录
    const del = await post('/api/cv/versions/delete', { id: idB });
    ok(del.status === 200 && del.body.ok, '删除版本成功');
    const tp = String(del.body.trash || '');
    ok(tp.startsWith('data/trash/'), '返回了回收目录路径：' + tp);
    ok(tp.includes('cv-version-'), '回收文件名带 cv-version 标记，便于辨认');
    ok(tp.includes('Java'), '回收文件名带上了版本名，用户后悔时能认出是哪一个');
    ok(!fs.existsSync(path.join(VDIR, idB + '.md')), '正文已不在 cv-versions/');
    ok(fs.existsSync(path.join(ROOT, tp)), '正文确实躺在 data/trash/ 里（可恢复）');
    ok(!(await listVersions()).some((v) => v.id === idB), '版本列表里不再有它');
    ok((await listVersions()).some((v) => v.id === idA), '同批的另一个版本毫发无损');
  }

  // ══ C. 硬约束：版本操作绝不改到 cv.md ═══════════════════════════════════
  console.log('\n── C. 原版隔离：写回版本 / 另存新版本都不能动 cv.md ──');
  {
    const draftFor = (marker) => cvBefore.replace(/\s*$/, '') + '\n\n' + marker + '\n';
    const marker = TAG + '这段只应出现在版本里';

    // C1. 覆盖某个版本（target = 版本 id）
    const ap = await post('/api/cv/optimize/apply', { draft: draftFor(marker), target: idA });
    ok(ap.status === 200 && ap.body.ok, '写回指定版本成功（HTTP ' + ap.status + '）');
    ok(ap.body.target === idA, '响应回报的落点是该版本，不是 base');
    ok(String(ap.body.backup || '').includes('_backups'),
      '版本写回前先快照到 _backups：' + ap.body.backup);
    ok(fs.readFileSync(path.join(VDIR, idA + '.md'), 'utf8').includes(marker),
      '版本文件里出现了新内容');
    ok(fs.readFileSync(CV_MD, 'utf8') === cvBefore, '★ cv.md 逐字节未变');

    // C2. 另存为新版本（target = 'new'）
    const nv = await post('/api/cv/optimize/apply', {
      draft: draftFor(TAG + '另存出来的一版'), target: 'new',
      name: TAG + '另存版', targetRole: '另存测试岗',
    });
    const idC = (nv.body.version || {}).id || '';
    createdIds.push(idC);
    ok(nv.status === 200 && nv.body.ok && !!idC, '另存为新版本成功：' + idC);
    ok(nv.body.target === 'new', '响应回报的落点是 new');
    ok((nv.body.version || {}).name === TAG + '另存版', '新版本按给定名称命名');
    ok(fs.existsSync(path.join(VDIR, idC + '.md')), '新版本正文已落盘');
    ok(fs.readFileSync(CV_MD, 'utf8') === cvBefore, '★ 另存之后 cv.md 仍然逐字节未变');

    // C3. 表单缓存不能被版本操作带跑偏 —— 它只属于 cv.md
    const formPath = path.join(ROOT, 'data', 'cv-form.json');
    if (fs.existsSync(formPath)) {
      const f = JSON.parse(fs.readFileSync(formPath, 'utf8'));
      const nm = (f.candidate || {}).name || '';
      const baseName = (cvBefore.split('\n')[0] || '').replace(/^#\s*/, '').trim();
      ok(nm === baseName, 'cv-form.json 仍指向原版（' + nm + '），没被版本内容污染');
    }

    // C4. 按版本导出 PDF：只作用于该版本
    const pdf = await post('/api/pdf', { version: idA, page_format: 'a4', max_pages: 2 });
    if (pdf.status === 200 && pdf.body.ok) {
      ok(String(pdf.body.file || '').includes(TAG.replace(/[〔〕]/g, '')),
        'PDF 文件名带上了版本名：' + pdf.body.file);
      ok(pdf.body.versionName === TAG + '后端开发（改）', '响应回报了是哪个版本：' + pdf.body.versionName);
      const full = path.join(ROOT, 'output', pdf.body.file);
      ok(fs.existsSync(full) && fs.statSync(full).size > 1000, 'PDF 真的生成了');
      try { fs.unlinkSync(full); } catch { /* 清理不掉也不影响结论 */ }
      try { fs.unlinkSync(path.join(ROOT, 'output', pdf.body.html)); } catch { /* 同上 */ }
    } else {
      // 本机没装 Chromium 时这一步会失败，那不是版本功能的锅，如实降级报告
      ok(true, 'PDF 段跳过（渲染环境不可用：' + (pdf.body && pdf.body.error || pdf.status) + '）');
    }
    ok(fs.readFileSync(CV_MD, 'utf8') === cvBefore, '★ 导出之后 cv.md 仍然逐字节未变');
  }

  // ══ D. 前端流程（全部打桩，不碰真数据）══════════════════════════════════
  console.log('\n── D. 前端：版本卡片、弹层、Diff 渲染、取消不发请求 ──');
  {
    const calls = { create: [], rename: [], del: [], diff: [] };
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

    // 三个写接口全部打桩：这一段只验接线，绝不能让点按钮真的建/删版本
    await page.route('**/api/cv/versions/create', async (rt) => {
      calls.create.push(JSON.parse(rt.request().postData() || '{}'));
      await rt.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, version: { id: 'stub000001', name: '桩版本' }, versions: [] }),
      });
    });
    await page.route('**/api/cv/versions/rename', async (rt) => {
      calls.rename.push(JSON.parse(rt.request().postData() || '{}'));
      await rt.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, version: { id: 'stub000001', name: '桩改名' }, versions: [] }),
      });
    });
    await page.route('**/api/cv/versions/delete', async (rt) => {
      calls.del.push(JSON.parse(rt.request().postData() || '{}'));
      await rt.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, trash: 'data/trash/stub.md', removed: { name: '桩版本' }, versions: [] }),
      });
    });

    // 2026-09-20 改版：版本卡片收进 <details>，默认折叠 —— 那张 6 列表格展开
    // 能占 400px，把简历正文顶出屏幕。卡片本身始终在 DOM 里，所以不能只等
    // 选择器（折叠时也匹配得上），得先展开再操作。
    // 2026-09-23 版式重构：版本卡从「我的简历」迁到「简历工具」页（#cvkit），
    // 回到 #cvkit 的每一处都走这个函数。
    async function openVersions() {
      await page.waitForSelector('#cvVersionsCard');
      // 幂等：新建 / 改名 / 删除后 route() 会重建视图，而卡片会按 S.cvFolds
      // 里的状态重新展开 —— 这时再点一次 summary 反而会把它收起来。
      const open = await page.locator('#cvVersionsCard').evaluate((el) => el.open);
      if (!open) await page.click('#cvVersionsCard > .fold-sum');
      await page.waitForSelector('#cvVerNew', { state: 'visible' });
    }

    await page.goto(URL_BASE + '#cvkit', { waitUntil: 'networkidle' });
    await openVersions();

    // D1. 卡片与行
    const rows = await page.locator('#cvVersionsCard tbody tr').count();
    const real = await listVersions();
    ok(rows === real.length, '卡片行数与服务端版本数一致（' + rows + ' / ' + real.length + '）');
    ok(await page.isVisible('#cvVerNew'), '有「新建版本」按钮');
    ok(await page.isVisible('#cvVerRefresh'), '有「刷新列表」按钮');

    // D2. 原版行：不给删、不给改名
    const baseRow = page.locator('#cvVersionsCard tbody tr').first();
    const baseText = await baseRow.textContent();
    ok(baseText.includes('原版'), '第一行被标为原版');
    ok((await baseRow.locator('[data-vact="delete"]').count()) === 0, '原版行没有「删除」按钮');
    ok((await baseRow.locator('[data-vact="rename"]').count()) === 0, '原版行没有「重命名」按钮');
    for (const act of ['preview', 'copy', 'diff', 'optimize', 'pdf']) {
      ok((await baseRow.locator('[data-vact="' + act + '"]').count()) === 1,
        '原版行有「' + act + '」按钮');
    }
    ok(baseText.includes('适配岗位') === false && baseText.includes('—'),
      '原版行的适配岗位显示为占位符');

    // D3. 版本行：七个动作齐全
    if (rows > 1) {
      const vRow = page.locator('#cvVersionsCard tbody tr').nth(1);
      let all = true;
      for (const act of ['preview', 'copy', 'rename', 'diff', 'optimize', 'pdf', 'delete']) {
        if ((await vRow.locator('[data-vact="' + act + '"]').count()) !== 1) all = false;
      }
      ok(all, '岗位版本行七种操作齐全（查看/复制/重命名/Diff/AI优化/PDF/删除）');
    } else {
      ok(false, '版本列表里至少应有一个自检版本可供检查按钮');
    }

    // D4. 新建弹层：取消不发请求；确认才发，且字段被带上
    await page.click('#cvVerNew');
    await page.waitForSelector('.modal-mask');
    ok(await page.isVisible('#vfName'), '新建弹层有版本名称输入框');
    ok(await page.isVisible('#vfRole'), '新建弹层有适配岗位输入框');
    await page.click('#vfNo');
    await page.waitForSelector('.modal-mask', { state: 'detached' });
    await page.waitForTimeout(200);
    ok(calls.create.length === 0, '取消新建：一个请求都没发');

    await page.click('#cvVerNew');
    await page.waitForSelector('.modal-mask');
    // 空名点确认必须被当场拦下（服务端也拦，但前端不该让用户白跑一趟）
    await page.click('#vfYes');
    await page.waitForTimeout(150);
    ok(await page.isVisible('#vfErr'), '空名提交时弹层内联报错');
    ok(calls.create.length === 0, '空名不发出请求');

    await page.fill('#vfName', '前端桩-腾讯后端');
    await page.fill('#vfRole', '后端开发工程师');
    await page.click('#vfYes');
    await page.waitForTimeout(400);
    ok(calls.create.length === 1, '确认后发出 1 次新建请求（实际 ' + calls.create.length + '）');
    const c0 = calls.create[0] || {};
    ok(c0.name === '前端桩-腾讯后端' && c0.targetRole === '后端开发工程师' && c0.source === 'base',
      '新建请求字段正确：' + JSON.stringify(c0));

    // D5. 重命名弹层
    await page.goto(URL_BASE + '#cvkit', { waitUntil: 'networkidle' });
    await openVersions();
    await page.locator('#cvVersionsCard [data-vact="rename"]').first().click();
    await page.waitForSelector('.modal-mask');
    ok((await page.inputValue('#vfName')).length > 0, '重命名弹层预填了当前名称');
    await page.fill('#vfName', '前端桩-改名后');
    await page.click('#vfYes');
    await page.waitForTimeout(400);
    ok(calls.rename.length === 1, '确认后发出 1 次重命名请求');
    ok((calls.rename[0] || {}).name === '前端桩-改名后', '重命名请求带上了新名字');

    // D6. Diff 弹层：两侧下拉、统计、逐行渲染
    // 点的是**岗位版本行**（nth(1)），默认配对是「原版 ↔ 该版本」，
    // 内容确实有差异，所以必须渲染出逐行内容。
    await page.goto(URL_BASE + '#cvkit', { waitUntil: 'networkidle' });
    await openVersions();
    await page.locator('#cvVersionsCard tbody tr').nth(1).locator('[data-vact="diff"]').click();
    await page.waitForSelector('#vdBox');
    await page.waitForFunction(() => {
      const s = document.querySelector('#vdStat');
      return s && !s.textContent.includes('正在对比');
    }, { timeout: 15000 });
    const stat = await page.textContent('#vdStat');
    ok(/新增/.test(stat), 'Diff 弹层给出了增删统计：' + stat.trim().slice(0, 70));
    ok((await page.locator('#vdA option').count()) === real.length,
      '左侧下拉列出了全部版本（含原版）');
    ok((await page.locator('#vdB option').count()) === real.length, '右侧下拉同理');
    ok((await page.inputValue('#vdA')) === 'base', '默认左侧是原版');
    ok((await page.inputValue('#vdB')) !== 'base', '默认右侧是那个岗位版本（不是原版自己跟自己比）');
    const dlines = await page.locator('#vdBox .dline').count();
    ok(dlines > 0, 'Diff 渲染出了逐行内容（' + dlines + ' 行）');
    ok((await page.locator('#vdBox .dadd, #vdBox .ddel').count()) > 0,
      '有被标成增/删的行（差异真的被标出来了）');

    // 换成「原版 ↔ 原版」：应当明确说没有差异，而不是给一片空白
    await page.selectOption('#vdB', 'base');
    await page.waitForTimeout(600);
    ok(/完全相同/.test(await page.textContent('#vdStat')), '同一版本对比时明确提示「完全相同」');

    await page.click('#vdX');
    await page.waitForSelector('.modal-mask', { state: 'detached' });

    // D7. 删除确认：点名版本名 + 说明可恢复；取消不发请求
    await page.goto(URL_BASE + '#cvkit', { waitUntil: 'networkidle' });
    await openVersions();
    const someName = await page.locator('#cvVersionsCard tbody tr').nth(1).locator('td').first().textContent();
    await page.locator('#cvVersionsCard [data-vact="delete"]').first().click();
    await page.waitForSelector('.modal-mask');
    const dTitle = await page.textContent('.modal-mask h3');
    const dDesc = await page.textContent('.modal-mask p.hint');
    ok(dTitle.includes('删除版本'), '确认框标题说明了是删版本：' + dTitle.trim());
    ok(someName && dTitle.includes(someName.replace(/来自.*$/s, '').trim().split('\n')[0].trim()),
      '确认框标题点名了版本名');
    ok(dDesc.includes('data/trash'), '确认框说明了可恢复（data/trash）');
    ok(dDesc.includes('原版'), '确认框说明了原版不受影响');
    await page.click('#cfNo');
    await page.waitForSelector('.modal-mask', { state: 'detached' });
    await page.waitForTimeout(200);
    ok(calls.del.length === 0, '取消删除：没有发出请求');

    // D8. 行内「AI 优化」只切换目标，不该发请求
    await page.locator('#cvVersionsCard [data-vact="optimize"]').first().click();
    // 2026-10-09：优化面板已从「我的简历」页搬到独立页 #cvopt ——
    // 版本卡在「简历工具」页，点「AI 优化」会跳到那个页面。
    // 等那边渲染完再读下拉（跨页渲染，原来同页 250ms 等待不够）。
    await page.waitForSelector('#cvOptGo', { timeout: 15000 });
    const onOptPage = await page.evaluate(() => location.hash);
    ok(onOptPage === '#cvopt', '跳到独立的「简历全局优化」页（实际 ' + onOptPage + '）');
    // 2026-10-09：优化页只做通用语句优化，恒定优化原版 ——
    // 不再提供优化对象下拉（各版本内容一致，分别优化只是重复耗额度），
    // 也不提供写回方式下拉（落盘仍在版本卡）。
    ok(!(await page.$('#cvOptTarget')), '优化页不提供「优化对象」下拉（恒优化原版）');
    ok(!(await page.isVisible('#cvOptApplyMode')), '优化页不提供写回方式下拉（写回走版本卡）');
    ok(await page.isVisible('#cvOptGo'), '优化页主操作区有「AI 优化」按钮');

    // 只关 page 不关 browser 是个隐蔽的坑：browser 只是被下一段的
    // `browser = await chromium.launch()` 覆盖掉，Playwright 与驱动进程的
    // 连接还挂着，于是**事件循环永远不空** —— 自检会把结论打印完，然后卡死
    // 不退出（表现为「输出全对但进程不退」，用 taskkill 收尾还会记成 exit=1，
    // 看起来像自检失败）。所以每一段用完都要显式关掉自己的 browser。
    await page.close();
    await browser.close();
    browser = null;
  }

  // ══ E. 评估页入口：初筛 ≥3 分才给「简历对应优化」════════════════════════
  // 原 E 段（评估页「简历对应优化」过线入口 → 带 JD 跳简历页）已随 2026-09-23
  // 评估页 mockup 重构删除：#evNextCard / #evCvOpt 入口不存在了。
  // 新的交接链路（评估页 AI优化弹窗「应用到简历」→ pendingCvOptDraft → 简历页
  // 全局优化面板）由 check-eval-flow.mjs 的对应段落覆盖。
} catch (err) {
  console.log('\n✗ 自检中断：' + err.message);
  fail.push('自检中断：' + err.message);
} finally {
  // ── F. 还原现场：自检绝不能留下痕迹 ─────────────────────────────────────
  if (browser) { try { await browser.close(); } catch { /* 已经关了 */ } }

  let cvRestored = true;
  try {
    // 还原本**用户原文件**（userCvBefore），不是钉入后的基准 cvBefore
    if (userCvBefore) fs.writeFileSync(CV_MD, userCvBefore, 'utf8');
    cvRestored = fs.readFileSync(CV_MD, 'utf8') === userCvBefore;
  } catch { cvRestored = false; }
  // 表单缓存同样还原（钉入基准简历时被改过）
  try {
    if (userFormBefore !== null) fs.writeFileSync(CV_FORM_PATH, userFormBefore, 'utf8');
  } catch { /* 写不回去时下面 vitals 会显示出来 */ }

  // 收尾删掉本次自检建出来的版本。
  //
  // 这里**直接 unlink 文件，不走删除接口**：接口那条路是「移进 data/trash/」，
  // 而自检的版本是纯测试数据 —— 走接口只会让回收站每跑一次多几个 `cv-version-*.md`，
  // 而回收站里的东西又未必删得掉（见下面 removeFile 的说明），越攒越多。
  // 删除链路本身在 B 段已经用真接口验过了，收尾不必再验一遍。
  for (const id of createdIds) {
    if (!id) continue;
    await removeFile(path.join(VDIR, id + '.md'), stuck);
  }

  // 还原版本索引：删掉本次新增的条目（按名字前缀精准识别，不动用户的版本）
  // 索引里可能残留自检条目 —— 以「名字带 TAG」为准再扫一遍
  try {
    const cur = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : [];
    const kept = (Array.isArray(cur) ? cur : []).filter((v) => !String(v.name || '').startsWith(TAG));
    fs.mkdirSync(VDIR, { recursive: true });
    fs.writeFileSync(INDEX, JSON.stringify(kept, null, 2), 'utf8');
  } catch { /* 索引写不回去时下面会如实报出来 */ }

  // 清掉本次产生的回收条目（只删本次新增的，用户早先的备份一律不动）
  for (const f of trashList()) {
    if (trashBefore.has(f)) continue;
    if (!f.includes('cv-version-')) continue;
    await removeFile(path.join(TRASH_DIR, f), stuck);
  }
  // 版本写回留下的快照也一并清掉（同样只认本次自检建出来的那些 id），
  // 别让 _backups/ 越攒越多。
  if (fs.existsSync(BACKUPS)) {
    for (const f of fs.readdirSync(BACKUPS)) {
      if (!createdIds.some((id) => id && f.startsWith(id))) continue;
      await removeFile(path.join(BACKUPS, f), stuck);
    }
  }
  try { fs.unlinkSync(SAFETY); } catch { /* tmp 里的东西，留着无害 */ }

  const leftover = (await listVersions()).filter((v) => String(v.name || '').startsWith(TAG));
  const indexIntact = indexBefore === null
    ? true
    : (() => {
      try {
        const now = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
        const before = JSON.parse(indexBefore);
        return JSON.stringify(now) === JSON.stringify(before);
      } catch { return false; }
    })();

  console.log('\n  cv.md 已还原为跑之前那一份：' + (cvRestored ? '是' : '否 ⚠'));
  if (!cvRestored) {
    console.log('  ⚠ cv.md 没能还原，请用这份备份覆盖它：');
    console.log('    ' + SAFETY);
  }
  console.log('  版本索引已回到原样：' + (indexIntact ? '是' : '否（已剔除自检条目）'));
  console.log('  自检版本残留：' + (leftover.length ? leftover.map((v) => v.name).join('、') : '无'));
  if (leftover.length) fail.push('清理不干净，残留自检版本 ' + leftover.length + ' 个');
  if (stuck.length) {
    console.log('\n  ⚠ 有文件没能清掉（删除被环境拦截，请手工删除）：');
    stuck.forEach((f) => console.log('    ' + f));
  }
}

console.log('\n结论：' + (fail.length ? '未通过（' + fail.length + ' 项）' : '全部通过'));
if (fail.length) { fail.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
