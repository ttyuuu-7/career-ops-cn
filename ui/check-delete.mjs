#!/usr/bin/env node
// ui/check-delete.mjs — 「删除记录」的回归：投递台账删行 + 评估报告删文件
//
// 覆盖四段：
//   A. 参数校验（不打桩、不写盘）—— 非法文件名、路径穿越、不存在的行号都必须被挡
//   B. 真删一条台账行（会动真文件，跑完还原）
//   C. 真删一份报告 → 连带删掉引用它的台账行（同样会还原）
//   D. 前端流程（全部打桩，不碰真数据）—— 按钮在不在、点删除会不会顺手把报告打开、
//      取消时不能发请求
//
// 三条不能破的底线，逐条都有断言：
//   1. **可恢复**：删除前原件必须已经落在 data/trash/ 里，且内容含被删的那一行
//   2. **不静默**：确认框必须点名「会有哪些台账行被连带删掉」
//   3. **不越界**：文件名不能翻出 reports/，台账行号必须是数字
//
// B、C 会临时往真台账追加自检行（编号 998 / 999），并在 finally 里把
// applications.md 完整还原。还原失败会把控制台里的备份路径打出来 —— 宁可吵，
// 也不要留一条假记录在用户的台账里。
//
// 前置：控制台已在 127.0.0.1:7317（服务端要已是新代码，含两个 delete 接口）。
// 用法：
//   node ui/check-delete.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TRACKER = path.join(ROOT, 'data', 'applications.md');
const REPORTS_DIR = path.join(ROOT, 'reports');
const TRASH_DIR = path.join(ROOT, 'data', 'trash');
const BASE = process.env.BASE || 'http://127.0.0.1:7317';
const URL_BASE = BASE + '/';

const ROW_A = 998;                 // B 段用的自检行
const ROW_B = 999;                 // C 段用的自检行
const FAKE_REPORT = '999-selftest-delete.md';

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

const api = async (p, opts) => {
  const r = await fetch(BASE + p, opts);
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON 就当没有 */ }
  return { status: r.status, body };
};
const post = (p, data) => api(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

/** 取台账 Report 列里的文件名 —— 与前后端 reportNameFromCell() 同一套规则 */
function reportNameOf(cell) {
  const s = String(cell || '').trim();
  if (!s) return '';
  const link = s.match(/\]\(([^)]+)\)/);
  const raw = (link ? link[1] : s).split('#')[0].split('?')[0].trim();
  const base = raw.replace(/^["'`]+|["'`]+$/g, '').split(/[\\/]/).pop().trim();
  return /\.md$/i.test(base) ? base : '';
}

/** 往真台账末尾追加一行自检记录（表格最后一行之后） */
function appendRow(num, reportCell) {
  const md = fs.readFileSync(TRACKER, 'utf8');
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  let last = -1;
  lines.forEach((l, i) => { if (l.trim().startsWith('|')) last = i; });
  const cells = [String(num), '2026-09-18', '自检假公司', '自检假岗位', '3.0/5',
    'Evaluated', '❌', reportCell || '—', '自检脚本临时行，跑完会被还原'];
  lines.splice(last + 1, 0, '| ' + cells.join(' | ') + ' |');
  fs.writeFileSync(TRACKER, lines.join(eol), 'utf8');
}

const trashList = () => (fs.existsSync(TRASH_DIR) ? fs.readdirSync(TRASH_DIR) : []);

// ── 现场快照（跑之前就存好，出任何事都能回来）────────────────────────────
const beforeMd = fs.readFileSync(TRACKER, 'utf8');
const beforeTrash = new Set(trashList());
const beforeReports = new Set(fs.existsSync(REPORTS_DIR) ? fs.readdirSync(REPORTS_DIR) : []);
// 第二道保险放在项目外，避免自检崩在还原之前就彻底回不去了
const SAFETY = path.join(os.tmpdir(), 'career-ops-tracker-before-check-delete.md');
fs.writeFileSync(SAFETY, beforeMd, 'utf8');

let browser = null;
let mutated = false;

try {
  // ══ A. 参数校验 ══════════════════════════════════════════════════════════
  console.log('\n── A. 参数校验：坏输入必须被挡住，且什么文件都不动 ──');
  {
    const a1 = await post('/api/tracker/delete', {});
    ok(a1.status === 400, '缺 num → 400（实际 ' + a1.status + '）');

    const a2 = await post('/api/tracker/delete', { num: '1a' });
    ok(a2.status === 400, 'num 不是数字 → 400（实际 ' + a2.status + '）');

    const a3 = await post('/api/tracker/delete', { num: '99999' });
    ok(a3.status === 404, '行号不存在 → 404（实际 ' + a3.status + '）');

    const a4 = await post('/api/report/delete', {});
    ok(a4.status === 400, '报告名为空 → 400（实际 ' + a4.status + '）');

    const a5 = await post('/api/report/delete', { file: '../cv.md' });
    const cvIntact = fs.existsSync(path.join(ROOT, 'cv.md'));
    ok(a5.status === 404 && cvIntact,
      '路径穿越 ../cv.md 被收敛到 reports/ 内且 cv.md 毫发无损（实际 ' + a5.status + '）');

    const a6 = await post('/api/report/delete', { file: '没有这份-2026-09-18.md' });
    ok(a6.status === 404, '报告不存在 → 404（实际 ' + a6.status + '）');

    ok(fs.readFileSync(TRACKER, 'utf8') === beforeMd, 'A 段结束后台账字节未变');
  }

  // ══ B. 真删一条台账行 ════════════════════════════════════════════════════
  console.log('\n── B. 删除台账行：可恢复、且真的从台账里消失 ──');
  {
    const rowsBefore = (await api('/api/tracker')).body.rows.length;
    appendRow(ROW_A, '');
    mutated = true;

    const added = (await api('/api/tracker')).body.rows.some((r) => String(r.num) === String(ROW_A));
    ok(added, '自检行 ' + ROW_A + ' 已追加进台账');

    const r = await post('/api/tracker/delete', { num: String(ROW_A) });
    ok(r.status === 200 && r.body.ok, '删除请求成功（实际 ' + r.status + '）');
    ok(r.body.removed && String(r.body.removed.num) === String(ROW_A),
      '响应回报了被删的行号：' + JSON.stringify(r.body.removed));

    const after = (await api('/api/tracker')).body.rows;
    ok(!after.some((x) => String(x.num) === String(ROW_A)), '台账里不再有 ' + ROW_A);
    ok(after.length === rowsBefore, '行数回到删除前（' + rowsBefore + '）');

    const snap = String(r.body.trash || '');
    ok(snap.startsWith('data/trash/'), '返回了回收目录路径：' + snap);
    const snapFull = path.join(ROOT, snap);
    ok(fs.existsSync(snapFull), '快照文件真的存在，可恢复');
    ok(fs.existsSync(snapFull) && fs.readFileSync(snapFull, 'utf8').includes('自检假公司'),
      '快照里含被删的那一行（恢复它＝恢复这一行）');
  }

  // ══ C. 真删一份报告 → 连带删掉引用它的台账行 ═══════════════════════════
  console.log('\n── C. 删除报告：文件进回收目录，引用它的台账行一并删掉 ──');
  {
    fs.writeFileSync(path.join(REPORTS_DIR, FAKE_REPORT), [
      '# Evaluation: 自检假报告', '',
      '**Date:** 2026-09-18', '**Score:** 3.0/5', '**Archetype:** selftest', '',
      '本文件由 ui/check-delete.mjs 生成，跑完即被删除。',
    ].join('\n'), 'utf8');
    appendRow(ROW_B, '[' + ROW_B + '](../reports/' + FAKE_REPORT + ')');

    const listed = (await api('/api/reports')).body.some((x) => x.file === FAKE_REPORT);
    ok(listed, '假报告已出现在报告列表里');

    const r = await post('/api/report/delete', { file: FAKE_REPORT });
    ok(r.status === 200 && r.body.ok, '删除报告成功（实际 ' + r.status + '）');
    ok(!r.body.failedRows || r.body.failedRows.length === 0,
      '没有台账行删除失败：' + JSON.stringify(r.body.failedRows || []));
    ok((r.body.removedRows || []).some((x) => String(x.num) === String(ROW_B)),
      '响应点名了被连带删掉的台账行：' + JSON.stringify(r.body.removedRows));
    ok(Array.isArray(r.body.trash) && r.body.trash.length === 2,
      '回收目录里既有报告本体也有台账快照：' + JSON.stringify(r.body.trash));

    ok(!fs.existsSync(path.join(REPORTS_DIR, FAKE_REPORT)), '报告文件已不在 reports/');
    const inTrash = trashList().some((f) => f.endsWith(FAKE_REPORT));
    ok(inTrash, '报告本体出现在 data/trash/ 里（可恢复）');

    const rows = (await api('/api/tracker')).body.rows;
    ok(!rows.some((x) => String(x.num) === String(ROW_B)), '引用它的台账行 ' + ROW_B + ' 也没了');
    ok(!(await api('/api/reports')).body.some((x) => x.file === FAKE_REPORT), '报告列表里不再有它');
  }

  // ══ D. 前端流程（全部打桩，不碰真数据）══════════════════════════════════
  console.log('\n── D. 前端：按钮、确认框、取消不发请求 ──');
  {
    const calls = { tracker: [], report: [] };
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    // 两个删除接口都打桩：这一段只验接线，绝不能让点按钮真的删掉用户的数据
    await page.route('**/api/tracker/delete', async (rt) => {
      calls.tracker.push(JSON.parse(rt.request().postData() || '{}'));
      await rt.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, trash: 'data/trash/stub.md', removed: { num: '1' } }),
      });
    });
    await page.route('**/api/report/delete', async (rt) => {
      calls.report.push(JSON.parse(rt.request().postData() || '{}'));
      await rt.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, trash: ['data/trash/stub.md'], removedRows: [], failedRows: [] }),
      });
    });

    // ── D1~D4：投递台账的单行删除 ────────────────────────────────────────
    //
    // 2026-09-22「投递台账」页撤下界面入口后，行内那个「删除」按钮**没有宿主了**。
    // 所以这里不写死 '#tracker'：那个路由已不在 `VIEWS` 里，`goto` 会静默落到兜底页，
    // 然后等 `#tBody tr` 等到超时 —— 看起来像删除功能坏了，其实是页面没了。
    // 改成扫一遍所有视图找「台账式表格 + 行内删除按钮」：找到就测，找不到就响亮跳过。
    const ROW_HOSTS = ['overview', 'cv', 'cvkit', 'profile', 'evaluate', 'reports', 'prep', 'tools', 'help'];
    let rowHost = '';
    for (const v of ROW_HOSTS) {
      await page.goto(URL_BASE + '#' + v, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(260);
      if (await page.$('#tBody [data-delrow]')) { rowHost = v; break; }
    }

    if (!rowHost) {
      console.log('\n── D1~D4：跳过（台账行内删除按钮当前没有宿主页面）──');
      console.log('  ⚠️  「投递台账」页撤下后行内「删除」按钮不再渲染，这几条界面断言无从跑起。');
      console.log('      这是**已知缺口**，不是通过。接口层没有降级 —— /api/tracker/delete 的');
      console.log('      参数校验与「真删一行」由上方服务端段直接打过，仍然全跑。');
      console.log('      眼下删单行走 CLI：node tracker.mjs delete --num N。');
      console.log('      把行内按钮接回任意视图后，本段自动恢复。');
    } else {
    await page.goto(URL_BASE + '#' + rowHost, { waitUntil: 'networkidle' });
    await page.waitForSelector('#tBody tr');

    const rowCount = await page.locator('#tBody tr').count();
    const delCount = await page.locator('#tBody [data-delrow]').count();
    ok(delCount > 0 && delCount === rowCount,
      '每行都有「删除」按钮（' + delCount + ' / ' + rowCount + ' 行）');

    const firstNum = (await page.locator('#tBody tr').first().locator('td.num').first().textContent()).trim();
    const firstCompany = (await page.locator('#tBody tr').first().locator('td').nth(2).textContent()).trim();

    await page.locator('#tBody [data-delrow]').first().click();
    await page.waitForSelector('.modal-mask');
    const tTitle = await page.textContent('.modal-mask .modal-head h3');
    const tDesc = await page.textContent('.modal-mask p.hint');
    ok(tTitle.includes(firstNum), '确认框标题点名了行号：' + tTitle);
    ok(tDesc.includes(firstCompany), '确认框正文点名了公司：' + firstCompany);
    ok(tDesc.includes('data/trash'), '确认框说明了可恢复（data/trash）');

    await page.click('#cfNo');
    await page.waitForSelector('.modal-mask', { state: 'detached' });
    await page.waitForTimeout(250);
    ok(calls.tracker.length === 0, '点「取消」不发出任何删除请求');
    ok((await page.locator('#tBody tr').count()) === rowCount, '取消后台账行数不变');

    await page.locator('#tBody [data-delrow]').first().click();
    await page.waitForSelector('.modal-mask');
    await page.click('#cfYes');
    await page.waitForTimeout(500);
    ok(calls.tracker.length === 1, '点「删除记录」发出 1 次请求（实际 ' + calls.tracker.length + '）');
    ok(String((calls.tracker[0] || {}).num) === firstNum,
      '请求带的行号正确：' + JSON.stringify(calls.tracker[0]));
    } // ── D1~D4 结束（找不到宿主页面时整段跳过）──

    // ── D5~D9：评估报告 ──────────────────────────────────────────────────
    await page.goto(URL_BASE + '#reports', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-delrep]');

    const cardCount = await page.locator('.report-item').count();
    ok((await page.locator('[data-delrep]').count()) === cardCount,
      '每张报告卡都有「删除」按钮（' + cardCount + ' 张）');

    // 挑一份台账里真的有引用的报告 —— 这样才能验「连带删除」有没有被说清楚
    const trackerRows = (await api('/api/tracker')).body.rows;
    const hit = (await api('/api/reports')).body.find((rep) => trackerRows.some((r) => reportNameOf(r.report) === rep.file));
    ok(!!hit, '找到一份被台账引用的报告用于测试：' + (hit ? hit.file : '（没找到）'));

    if (hit) {
      const expected = trackerRows.filter((r) => reportNameOf(r.report) === hit.file);
      await page.click('[data-delrep="' + hit.file + '"]');
      await page.waitForSelector('.modal-mask');

      ok((await page.textContent('#pageTitle')).trim() === '评估报告',
        '点删除按钮不会顺手打开报告（页面仍是「评估报告」）');
      ok((await page.locator('.report-item').count()) === cardCount, '点删除不会让列表少一张卡');

      const desc = await page.textContent('.modal-mask p.hint');
      ok(expected.every((r) => desc.includes('第' + r.num + '行')),
        '确认框点名了会被连带删掉的台账行（第' + expected.map((r) => r.num).join('、') + '行）');
      ok(desc.includes('一并删除'), '确认框写明了「一并删除」，不是静默改台账');

      await page.click('#cfNo');
      await page.waitForSelector('.modal-mask', { state: 'detached' });
      await page.waitForTimeout(250);
      ok(calls.report.length === 0, '取消后不发报告删除请求');
    }

    // 详情页顶栏也要有删除入口
    const someFile = (await api('/api/reports')).body[0].file;
    await page.click('.report-item');
    await page.waitForTimeout(600);
    ok(await page.isVisible('#rDel'), '报告详情页顶栏有「删除这份报告」');

    await page.close();
  }
} finally {
  // ── E. 还原现场：自检绝不能留下痕迹 ─────────────────────────────────────
  if (browser) { try { await browser.close(); } catch { /* 已经关了 */ } }

  let restored = true;
  try {
    fs.writeFileSync(TRACKER, beforeMd, 'utf8');
    restored = fs.readFileSync(TRACKER, 'utf8') === beforeMd;
  } catch { restored = false; }

  // 清掉本次产生的回收条目（只删本次新增的，别人早先的备份一律不动）
  const stuck = [];
  for (const f of trashList()) {
    if (beforeTrash.has(f)) continue;
    const full = path.join(TRASH_DIR, f);
    try { fs.unlinkSync(full); continue; } catch { /* 删除被拦，试移走 */ }
    try { fs.renameSync(full, path.join(os.tmpdir(), 'career-ops-check-delete-' + f)); }
    catch { stuck.push(full); }
  }
  // 假报告按说不该还在 reports/，万一在就收进回收目录，不留垃圾
  if (!beforeReports.has(FAKE_REPORT) && fs.existsSync(path.join(REPORTS_DIR, FAKE_REPORT))) {
    try { fs.unlinkSync(path.join(REPORTS_DIR, FAKE_REPORT)); } catch { /* 上面已经报过 */ }
  }
  try { fs.unlinkSync(SAFETY); } catch { /* tmp 里的东西，留着无害 */ }

  console.log('\n  台账已还原为跑之前那一份：' + (restored ? '是' : '否 ⚠'));
  if (!restored) {
    console.log('  ⚠ data/applications.md 没能还原，请用这份备份覆盖它：');
    console.log('    ' + SAFETY);
  }
  if (mutated && restored) console.log('  已清掉本次产生的回收目录条目，现场干净');
  if (stuck.length) {
    console.log('\n  ⚠ 有文件没能清掉（删除被环境拦截，请手工删除）：');
    stuck.forEach((f) => console.log('    ' + f));
  }
}

console.log('\n结论：' + (fail.length ? '未通过（' + fail.length + ' 项）' : '全部通过'));
if (fail.length) { fail.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
