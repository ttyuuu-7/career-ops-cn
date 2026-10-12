#!/usr/bin/env node
// ui/check-cv-edit.mjs — 简历编辑器的增删排序回归测试
//
// 为什么单独有这个文件：/api/cv 的读写、check-ui.mjs 的布局断言、
// 解析回归都各测一段，**没人测「点添加之后条目还在不在」**，
// 于是「点添加没反应」这个 bug 活了下来。
//
// 它坏掉的方式特别隐蔽：数组 push 成功了、控制台没有报错、页面也不报错，
// 只是重画时被服务端那份旧数据覆盖回去，看上去就像按钮失灵。
//
// 全程打桩 /api/cv，所以秒级完成、不写任何文件。
//
// 前置：控制台已在 127.0.0.1:7317（只为了拿 index.html / app.js / style.css）。
// 用法：node ui/check-cv-edit.mjs
import { chromium } from 'playwright';
// 章节标题以 ui/cv-model.mjs 的 CV_SECTION_TITLES_ZH 为准。
// 不在这里写死中文字面量：标题表改了（比如「实习经历」→「实习与工作经历」），
// 写死字面量的断言会红，看着像功能坏了，其实只是断言过期 —— 那种红最浪费时间。
// 反过来更糟：如果写死的字符串恰好还成立，断言就成了「永远通过」。
import { CV_SECTION_TITLES_ZH as T } from './cv-model.mjs';

const URL_BASE = 'http://127.0.0.1:7317/';

// 服务端表单的固定快照：刻意让 education / certifications / awards 都是空数组，
// 复现「本来就空 → 添加 → 被空数组覆盖」这个真实场景。
const SERVER_FORM = {
  candidate: {
    name: '关雨', email: 'a@b.com', phone: '13800000000', wechat: '',
    location: '西安', linkedin: '', github: '', portfolio: '',
  },
  summary: '测试用简介',
  competencies: ['Python'],
  experience: [],
  projects: [{ name: '校园二手交易平台', badge: '个人', description: '', tech: '', url: '', bullets: ['x'] }],
  education: [],
  certifications: [],
  awards: [],
  skills: [{ category: '编程语言', items: ['Java'] }],
};

const stubCv = (form) => ({
  markdown: '# 关雨\n',
  form: JSON.parse(JSON.stringify(form || SERVER_FORM)),
  completeness: { percent: 60, missing: ['教育背景 Education'] },
  hasMd: true,
  hasForm: true,
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);

const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

// 先注册宽匹配的 /api/cv，再注册 /api/cv/preview —— Playwright 后注册的先匹配。
let previewCalls = 0;
let saveCalls = 0;
// ⚠️ 桩必须**记住**写进来的表单（2026-10-09 实时保存改造之后）。
//    编辑页的「草稿优先」规则只在 cvDirty 为真时生效；实时保存会把脏标记清掉，
//    之后每次路由重画都会重新拉 /api/cv —— 桩还返回那份固定快照的话，用户刚加的
//    教育背景会被"服务端"的旧数据冲掉，看着像功能坏了，其实只是桩不自洽。
let stubForm = JSON.parse(JSON.stringify(SERVER_FORM));

await page.route('**/api/cv', (route) => {
  const method = route.request().method();
  if (method === 'POST') {
    saveCalls += 1;
    try {
      const body = route.request().postDataJSON();
      if (body && body.form) stubForm = body.form;
    } catch { /* 不是 JSON 就维持原样 */ }
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, markdown: '', completeness: { percent: 75, missing: [] } }),
    });
  }
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stubCv(stubForm)) });
});

await page.route('**/api/cv/preview', (route) => {
  previewCalls += 1;
  // 完整度固定返回 75%，用来证明前端确实用了服务端算的结果，
  // 而不是自己在前端又实现了一遍规则
  return route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ completeness: { percent: 75, missing: [] } }),
  });
});

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

// 页面内小工具：定位某个区块的卡片
const HELPERS = `
  window.__card = (kind) => document.querySelector('[data-add="' + kind + '"]').closest('.card');
  window.__count = (kind) => window.__card(kind).querySelectorAll('.entry').length;
  window.__badge = (kind) => window.__card(kind).querySelector('h2 .badge').textContent.trim();
`;

const count = (kind) => page.evaluate((k) => window.__count(k), kind);
const badge = (kind) => page.evaluate((k) => window.__badge(k), kind);

// 进入某个分区。
// 2026-10-09 分区导航改造：表单一次只渲染**当前分区**（左栏导航 + 右栏单分区表单），
// 所以操作前要先切过去。断言的**口径没变**（点添加后条目必须留下），只是多了这一步。
//
// ⚠️ 等待条件必须是**该分区独有**的元素。最初写成等 `#cvForm .card` —— 每个分区
// 都有 .card，于是点击还没生效它就通过了，紧接着的 isVisible 拿到的是上一个分区
// 的快照（表现为「编辑框存在」红、「回显服务端值」绿，两条自相矛盾）。
const SEC_SEL = {
  basic: '[data-path="candidate.name"]',
  summary: '[data-path="summary"]',
  competencies: '[data-path="competencies"]',
};
async function goSec(key) {
  await page.click(`#cvNav [data-nav-go="${key}"]`);
  await page.waitForSelector(`#cvForm ${SEC_SEL[key] || `[data-add="${key}"]`}`, { timeout: 15000 });
  await page.evaluate(HELPERS);
}

// 点添加并等重画稳定（页面会重新渲染整块视图）
async function addOne(kind) {
  // 「更多内容」折叠区已删（2026-09-26），但 details 展开逻辑保留：
  // 若将来再收进折叠卡，这里不用改。
  await page.evaluate(() => {
    document.querySelectorAll('details[data-fold]').forEach((d) => { d.open = true; });
  });
  const before = await count(kind);
  await page.click(`[data-add="${kind}"]`);
  await page.waitForFunction(
    ([k, n]) => window.__count(k) === n + 1,
    [kind, before],
    { timeout: 5000 },
  ).catch(() => {});
  return [before, await count(kind)];
}

console.log('\n── 0. 前置：选中内置 CSS 模板 ──');
// docx 保真改造（2026-09-30）后，全局选中态若被探针切到 docx 模板（如 art01），
// 预览按需求③渲染 docx 原文而非表单内容，下面的预览断言会全部落空（实测踩过）。
// 自检自带前置：把选中模板固定回内置 CSS 版式 '1'，不依赖外部运行状态。
// ⚠️ 这条前置会**改掉用户的模板选择**，跑完必须还原（见文件末尾的「收尾」）——
//    自检不该在用户的配置上留痕（实测踩过：用户选的稳重03 被自检改成了内置 1）。
const prevTpl = await fetch(URL_BASE + 'api/cv/templates')
  .then((r) => r.json()).then((j) => j && j.selected).catch(() => null);
const selRes = await fetch(URL_BASE + 'api/cv/templates/select', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: '1' }),
}).then((r) => r.json()).catch(() => null);
ok(!!(selRes && selRes.ok === true && selRes.selected === '1'), '前置：选中内置模板 1（CSS 版式，预览走表单内容）');

console.log('\n── 1. 打开简历页 ──');
await page.goto(URL_BASE + '#cv', { waitUntil: 'networkidle' });
await page.waitForSelector('#cvNav');
await page.evaluate(HELPERS);
ok(await page.isVisible('#cvNav'), '简历页渲染完成（分区导航就位）');
ok(await page.isVisible('#cvForm .card'), '默认渲染出一个分区表单（不把全部章节堆一屏）');

await goSec('education');
ok((await badge('education')) === '0', '教育背景初始 0 条');
await goSec('experience');
ok((await badge('experience')) === '0', '工作经历初始 0 条');
await goSec('projects');
ok((await badge('projects')) === '1', '项目初始 1 条（来自服务端）');
await goSec('skills');
ok((await badge('skills')) === '1', '技能初始 1 条（来自服务端）');
// 个人简介 / 核心能力：编辑入口 2026-09-27 恢复（数据层一直在，入口曾随「更多内容」删除）
await goSec('summary');
ok(await page.isVisible('textarea[data-path="summary"]'), '个人简介编辑框存在');
ok((await page.inputValue('textarea[data-path="summary"]')) === '测试用简介', '个人简介回显服务端值');
await goSec('competencies');
ok(await page.isVisible('textarea[data-path="competencies"]'), '核心能力编辑框存在');
ok((await page.inputValue('textarea[data-path="competencies"]')) === 'Python', '核心能力回显服务端值（一行一条）');

console.log('\n── 2. 三个报障区块：点添加后条目必须留下 ──');
for (const [kind, label] of [
  ['education', '教育背景'],
  ['skills', '专业技能'],
  ['experience', '工作经历'],
]) {
  await goSec(kind);
  const [before, after] = await addOne(kind);
  ok(after === before + 1, label + '：' + before + ' → ' + after + ' 条');
  ok((await badge(kind)) === String(after), label + '：徽标同步为 ' + after);
}

console.log('\n── 3. 顺带覆盖其余区块 ──');
{
  await goSec('experience');
  const [before, after] = await addOne('experience');
  ok(after === before + 1, '工作经历：' + before + ' → ' + after + ' 条');
  await goSec('projects');
  const [b2, a2] = await addOne('projects');
  ok(a2 === b2 + 1, '项目：' + b2 + ' → ' + a2 + ' 条');
  await goSec('skills');
  const [b3, a3] = await addOne('skills');
  ok(a3 === b3 + 1, '技能：' + b3 + ' → ' + a3 + ' 条');
}

console.log('\n── 4. 连续添加不互相冲掉 ──');
{
  await goSec('education');
  await addOne('education');
  const n = await count('education');
  ok(n === 2, '教育背景连加两次 = 2 条，实际 ' + n);
}

console.log('\n── 5. 已输入的文字不能在结构操作后被冲掉（同一 bug 的更严重一半）──');
{
  await goSec('education');
  const first = await page.$('textarea[data-path="education.0.description"]');
  ok(!!first, '教育背景 #1 的补充说明框存在');
  await first.fill('主修课程：数据结构、数据库、机器学习');
  const typed = await page.inputValue('textarea[data-path="education.0.description"]');
  ok(typed.includes('数据结构'), '文字已输入');

  // 触发一次整页重画：切到别的分区再回来。
  // 2026-10-09 起这是最常见的重画路径，而且比原来更严 —— 表单一次只渲染一个
  // 分区，切走的那一刻这段 DOM 就被丢掉了，能回来全靠草稿模型接住。
  await goSec('skills');
  await goSec('education');

  const kept = await page.inputValue('textarea[data-path="education.0.description"]');
  ok(kept.includes('数据结构'), '切分区来回后文字仍在（实际："' + kept + '"）');

  await goSec('basic');
  const nameBox = await page.$('input[data-path="candidate.name"]');
  await nameBox.fill('关雨（测试改名）');
  await goSec('projects');
  await goSec('basic');
  ok(
    (await page.inputValue('input[data-path="candidate.name"]')).includes('测试改名'),
    '基本信息栏的改动也没被重画冲掉',
  );
}

console.log('\n── 6. 完整度由服务端算，不前端另写一套 ──');
ok(previewCalls > 0, '/api/cv/preview 被调用过 ' + previewCalls + ' 次');
ok((await page.textContent('#view')).includes('75%'), '横幅显示服务端返回的 75%');

console.log('\n── 7. 预览实时反映新增条目 ──');
{
  // 「写进 cv.md 的原文预览」折叠区已删（2026-09-26），改断右栏视觉预览：
  // 新增条目要立刻出现在成稿里，章节标题一律用 CV_SECTION_TITLES_ZH 的中文。
  const pv = await page.textContent('#cvVisual');
  // 证书/荣誉奖项的编辑入口已随「更多内容」删掉，预览只断仍有入口的段
  ok(pv.includes(T.education), '预览出现「' + T.education + '」段');
  ok(pv.includes(T.projects), '预览出现「' + T.projects + '」段');
  ok(pv.includes(T.summary), '预览出现「' + T.summary + '」段（服务端值「测试用简介」）');
  ok(pv.includes(T.competencies), '预览出现「' + T.competencies + '」段');
  // 预览的标题一律中文：混进英文标题就说明章节标题没跟上权威表
  const enHeads = await page.$$eval('#cvVisual h3', (hs) =>
    hs.filter((h) => /^[A-Za-z]/.test(h.textContent.trim())).length);
  ok(enHeads === 0, '预览章节标题没有英文残留');
}

console.log('\n── 8. 实时保存（2026-10-09：填写不再需要点保存）──');
{
  // 改造前这里断言的是「保存按钮提示有未保存改动」。那颗按钮已删 ——
  // 断言不删、改成反向：现在要证明的是**不点任何按钮也会自己落盘**。
  const before = saveCalls;
  await goSec('summary');
  await page.fill('[data-path="summary"]', '实时保存探针');
  // 防抖 800ms + 一次往返，给 2s 足够
  await page.waitForTimeout(2000);
  ok(saveCalls > before, `敲进表单后自己发了保存请求（POST ${before} → ${saveCalls}）`);
  const badge = (await page.textContent('#cvSaveState')).trim();
  ok(!badge.includes('编辑中') && !badge.includes('保存中'),
    `存完后徽标回到「已自动保存」，实际「${badge}」`);
}

console.log('\n── 9. 删除与排序 ──');
{
  await goSec('education');
  const before = await count('education');
  await page.click('#view .card [data-del="education"]');
  await page.waitForFunction((n) => window.__count('education') === n - 1, before, { timeout: 5000 })
    .catch(() => {});
  const after = await count('education');
  ok(after === before - 1, '删除生效：' + before + ' → ' + after);

  // 下移：项目第 1 条带 name=校园二手交易平台，下移后它应该在第 2 位
  await goSec('projects');
  const names = () => page.$$eval('input[data-path$=".name"]', (els) => els.map((e) => e.value));
  const b4 = await names();
  await page.click('#view .card [data-down="projects"]');
  await page.waitForFunction(
    (prev) => {
      const now = Array.from(document.querySelectorAll('input[data-path$=".name"]')).map((e) => e.value);
      return now.join('|') !== prev;
    },
    b4.join('|'),
    { timeout: 5000 },
  ).catch(() => {});
  const a4 = await names();
  ok(b4.join('|') !== a4.join('|'), '下移改变了顺序：' + b4.join(' / ') + ' → ' + a4.join(' / '));
}

console.log('\n── 10. 切走再回来，草稿仍保留 ──');
{
  await goSec('education');
  const before = await count('education');
  // ⚠️ 先等实时保存走完（防抖 800ms）：§9 的下移是一次内容改动，还没落盘就切页
  //    的话，下面那条「回来时没有待保存的改动」会踩在竞态上随机红
  //    —— 2026-10-09 实测：同一个脚本连跑两次，一次绿一次红。
  await page.waitForTimeout(1400);
  await page.evaluate(() => { location.hash = '#help'; });
  await page.waitForTimeout(600);
  await page.evaluate(() => { location.hash = '#cv'; });
  await page.waitForSelector('#cvNav');
  // 离开时停在哪个分区会保留（S.cvNavActive 是会话态），回来仍应看到教育背景
  await page.waitForFunction(() => !!document.querySelector('[data-add="education"]'), null, { timeout: 15000 });
  await page.evaluate(HELPERS);
  const after = await count('education');
  ok(after === before, '返回简历页后条目数不变：' + before + ' → ' + after);
  // ⚠️ 原来是断言「未保存标记还在」。实时保存之后这条**必然不成立** ——
  //    切页那几百毫秒足够防抖窗口走完，改动已经落盘、脏标记已经清了。
  //    改成断言「回来时确实没有待保存的改动」，这才是现在该有的状态。
  const badge = (await page.textContent('#cvSaveState')).trim();
  ok(!badge.includes('编辑中'),
    `回来时没有待保存的改动（实时保存已写盘），实际「${badge}」`);
}

console.log('\n── 11. 顶栏：主操作「导入简历」+ 单一导出（PDF，下载到本机） ──');
{
  // 口径变更（2026-10-11 用户要求「导出功能只导出 PDF，支持下载到本地」）：
  //   · 「保存并生成 Word」按钮更早就删了（实时保存改造）；
  //   · 导出下拉菜单（Word / PDF / Markdown / JSON）整条下线，顶栏只剩一颗
  //     「导出 PDF」，点了直接生成并下载 —— 所以这里改为验：
  //     按钮真的没了、导入排在导出前、菜单已不存在、导出走的是同源 PDF 那条路。
  ok((await page.$$('#cvSave')).length === 0, '「保存并生成 Word」按钮已不存在');
  ok(await page.isVisible('#cvImport'), '顶栏主操作位换成了「导入简历」');
  const order = await page.evaluate(() => [...document.querySelectorAll('#topActions button, #topActions span')]
    .map((e) => e.id).filter(Boolean));
  ok(order.indexOf('cvImport') >= 0 && order.indexOf('cvImport') < order.indexOf('cvExportBtn'),
    '「导入简历」排在「导出」前面：' + order.join(' → '));
  ok((await page.textContent('#cvExportBtn')).trim() === '导出 PDF',
    '导出按钮写明「导出 PDF」：' + (await page.textContent('#cvExportBtn')).trim());
  ok((await page.$$('#cvExportMenu')).length === 0, '导出下拉菜单已下线');
  ok((await page.$$('#topActions [data-export]')).length === 0, '菜单里的 Word/Markdown/JSON 入口都已撤掉');

  // 点一下：应打 PDF 那条接口（这里只验它**确实被调用**，不真跑 Chromium 打印）
  let asked = null;
  await page.route('**/api/cv/pdf-live', (route) => {
    asked = route.request().postDataJSON();
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, file: 'cv-测试-2026-10-11.pdf', size: 123456 }),
    });
  });
  await page.route('**/api/output?**', (route) => route.fulfill({
    status: 200, contentType: 'application/pdf', body: '%PDF-1.4 test',
  }));
  const dlPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
  await page.click('#cvExportBtn');
  const dl = await dlPromise;
  ok(!!asked, '点「导出 PDF」调用了 /api/cv/pdf-live');
  ok(asked && /cvp|cvp-wz|class="cvp/.test(String(asked.html || '')), '发给服务端的是预览渲染结果（带 .cvp 标记）');
  ok(asked && /@page\s*\{\s*size:\s*A4/.test(String(asked.html || '')), '打印 HTML 声明了 A4');
  ok(!!dl, '导出触发了浏览器下载');
  ok(dl && /^简历-.*\.pdf$/.test(dl.suggestedFilename()),
    '下载文件名是「简历-姓名-日期.pdf」：' + (dl ? dl.suggestedFilename() : '（无）'));
}

console.log('\n── 11b. Word 导入/导出（纯函数） ──');
{
  const { docxParagraphs, paragraphsToCvMarkdown, cvFormToWordHtml, docxToCvForm }
    = await import('./cv-word.mjs');

  // 段落拼 markdown：标题样式章节 + 条目 + 列表
  const paras = [
    { text: '张三', level: 0, list: false },
    { text: '13800000000 · z@x.com · 西安', level: 0, list: false },
    { text: '教育背景', level: 1, list: false },
    { text: '某某大学 — 本科', level: 2, list: false },
    { text: '2024.09 – 2028.06', level: 0, list: false },
    { text: '主修课程：数据结构', level: 0, list: false },
    { text: '专业技能', level: 1, list: false },
    { text: 'Java 基础', level: 0, list: true },
  ];
  const pm = paragraphsToCvMarkdown(paras);
  ok(/^# 张三$/m.test(pm.markdown), 'Word 段落里认出姓名');
  ok(pm.markdown.includes('## ' + T.education), '章节标题映射到权威中文标题：' + T.education);
  ok(pm.markdown.includes('## ' + T.skills), '第二个章节也认出来了：' + T.skills);
  ok(pm.markdown.includes('### 某某大学 — 本科'), '标题样式段落转条目');
  ok(/^- Java 基础$/m.test(pm.markdown), 'Word 列表转 bullet');
  ok(pm.warnings.length === 0, '规范文档无告警，实际：' + JSON.stringify(pm.warnings));

  // 没有标题样式的文档：靠「章节名单独成行」兜底切节
  const plain = paragraphsToCvMarkdown([
    { text: '李四', level: 0, list: false },
    { text: '项目经历', level: 0, list: false },
    { text: '某某管理系统', level: 0, list: false },
    { text: '负责后端开发', level: 0, list: true },
  ]);
  ok(plain.markdown.includes('## ' + T.projects), '没有标题样式也能靠章节名切节');
  ok(/^- 负责后端开发$/m.test(plain.markdown), '无标题样式时列表仍转 bullet');

  // 「个人简历」「求职意向：」这类标题行不当姓名
  const guarded = paragraphsToCvMarkdown([
    { text: '个人简历', level: 0, list: false },
    { text: '求职意向：后端开发', level: 0, list: false },
    { text: '王五', level: 0, list: false },
  ]);
  ok(/^# 王五$/m.test(guarded.markdown), '「个人简历 / 求职意向」行不冒充姓名');

  // docxToCvForm 端到端：假 zip（只有签名头）要抛错而非静默
  const fakeZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);
  let zipThrew = false;
  try { await docxToCvForm(fakeZip); } catch { zipThrew = true; }
  ok(zipThrew, '非法 docx（假 zip）会抛错而非静默');

  // Word 导出 HTML
  const html = cvFormToWordHtml(SERVER_FORM);
  ok(html.includes('xmlns:w="urn:schemas-microsoft-com:office:word"'), 'Word 导出带 Office 命名空间');
  ok(html.includes('<meta charset="utf-8">'), 'Word 导出声明 UTF-8');
  ok(html.includes('关雨'), 'Word 导出带姓名');
  ok(html.includes('校园二手交易平台'), 'Word 导出带项目条目');
  ok(html.includes('编程语言'), 'Word 导出带技能分类');
  ok(!/<script/i.test(html), 'Word 导出不含脚本');
  ok(docxParagraphs && typeof docxParagraphs === 'function', 'docx 段落解析器就位');
}

// ── 收尾：还原用户的模板选择（前置里临时改成内置 1）──
if (prevTpl && prevTpl !== '1') {
  const back = await fetch(URL_BASE + 'api/cv/templates/select', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: prevTpl }),
  }).then((r) => r.json()).catch(() => null);
  ok(!!(back && back.ok && back.selected === prevTpl),
    '收尾：把模板选择还原成用户原来的「' + prevTpl + '」');
}

console.log('\n── 12. 控制台错误 ──');
ok(errs.length === 0, '0 个控制台错误' + (errs.length ? '：' + errs.slice(0, 3).join(' | ') : ''));

await browser.close();
console.log('\n' + (fail.length ? '✗ 失败 ' + fail.length + ' 项：\n  - ' + fail.join('\n  - ') : '✓ 全部通过'));
// 用 exitCode 而不是 process.exit()：管道下 stdout 异步，process.exit() 会丢报告
process.exitCode = fail.length ? 1 : 0;
