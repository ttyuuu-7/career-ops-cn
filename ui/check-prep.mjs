#!/usr/bin/env node
// ui/check-prep.mjs — 「分析 → 面试备考建议」的回归自检
//
// 为什么需要它：这一页的每一环都可能**静默**退化，不抛错、控制台也干净：
//   · 解析不到差距 → 页面照常出，但三条建议全是空话（比报错更糟）
//   · 报告换了写法   → 知识点名变成一整句话，项目建议跟着没法读
//   · 要求与职责混了 → 正文变成抄 JD（「技术要点：负责 XX 系统的开发」）
//   · 复制 / 导出失效 → 用户拿不到结果，功能等于没做
// 靠人手点一遍发现不了，只能把断言钉住。
//
// 分两段：
//   §0 纯函数段：喂真实报告与仿真 AI 输出，不开浏览器（秒级、可离线）
//   §1–§6 页面段：真开浏览器点一遍（前置：控制台已在 127.0.0.1:7317）
//
// **不依赖 Ollama 在线**：生成一律选「本地规则版」，零 token、秒级。
// **不打桩 /api/ai-status**：引擎状态会影响页面渲染，喂错会让整块不出来。
//
// 用法：node ui/check-prep.mjs        退出码 0 = 全过

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  parseReportForPrep, diagnoseInputs, buildLocalFallback, buildPrepMarkdown,
  parsePrepOutput, prepOutputUsable, prepUnusableReason, countParts,
  gapToTopic, isLearnableRequirement, MISSING_REASONS, SECTION_TITLES,
  RESOURCE_KIND_ZH, parseReportSummary,
} from './prep-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = 'http://127.0.0.1:7317/';

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ok  ' : '  ✗   ') + msg); if (!cond) fail.push(msg); };
const section = (t) => console.log('\n── ' + t + ' ──');

// ══ §0 纯函数：报告解析 ══════════════════════════════════════════════════
section('0. 报告解析（离线）');

const reportsDir = path.join(ROOT, 'reports');
const cvText = fs.existsSync(path.join(ROOT, 'cv.md'))
  ? fs.readFileSync(path.join(ROOT, 'cv.md'), 'utf8') : '';
const reportFiles = fs.existsSync(reportsDir)
  ? fs.readdirSync(reportsDir).filter((f) => f.endsWith('.md')) : [];

ok(reportFiles.length > 0, `reports/ 里有 ${reportFiles.length} 份报告可供解析`);
ok(cvText.length > 0, `cv.md 读到 ${cvText.length} 字`);

const parsedAll = reportFiles.map((f) => ({
  file: f,
  r: parseReportForPrep(fs.readFileSync(path.join(reportsDir, f), 'utf8'), { file: f, title: f }, cvText),
}));

// 除残报告外，每份都要能解析出「要求」与「差距」——这是这一页的主输入。
const blocked = parsedAll.filter((x) => !diagnoseInputs({ report: x.r, cvText }).ok);
const usable = parsedAll.filter((x) => diagnoseInputs({ report: x.r, cvText }).ok);
ok(usable.length >= 3, `${usable.length} 份报告可用于生成备考建议（其余 ${blocked.length} 份判为数据不足）`);
for (const x of usable) {
  ok(x.r.requirements.length > 0, `${x.file}：解析出岗位要求 ${x.r.requirements.length} 条`);
  ok(x.r.gaps.length > 0, `${x.file}：解析出差距 ${x.r.gaps.length} 条`);
}

// ── 报告详情「匹配卡」的解析（2026-10-12 新增）────────────────────────
// 详情页顶部那张卡（雷达 / 综合匹配 / 三徽标 / JD 解读 / 三组）全靠这个
// 解析器。它有两个踩过的坑必须锁住：
//   ① 结论段不能把「### 六维评分」那块摘要的 markdown（| 维度 | 分 | 表）吞进来；
//   ② 短条目（「缺少高并发场景证据」9 字）不能因为「像小节标题」被滤掉。
{
  const sample = [
    '# 评估报告：样例 — 测试岗', '',
    '**Date:** 2026-10-12',
    '**Score:** 3.6/5',
    '**Legitimacy:** Proceed with Caution', '',
    '**结论：可以投。** 硬门槛全过，差在量化成果不足。',
    '',
    '### 六维评分', '',
    '| 维度 | 分 |', '|------|-----|',
    '| 专业技能 | 72 |', '| 项目经验 | 60 |', '| 学历背景 | 65 |',
    '| 软技能 | 70 |', '| 行业经验 | 45 |', '| 成果量化 | 38 |', '',
    '### 优势匹配点', '', '- JD 要求 Java 主语言，简历正好是这个栈', '',
    '### 能力短板', '', '- 缺少高并发场景证据', '',
    '### 简历优化建议', '', '- 补上慢 SQL 优化的前后 QPS 对比', '',
    '## A) 岗位概览', '', '正文。',
  ].join('\n');
  const rs = parseReportSummary(sample, {}, { threshold: 3 });
  ok(Number.isFinite(rs.score5) && rs.score100 === 72, '匹配卡：3.6/5 → 72/100（实际 ' + rs.score5 + '→' + rs.score100 + '）');
  ok(rs.tier === '值得投递' && rs.verdictOk === true, '匹配卡：档位与门槛判定（' + rs.tier + '）');
  ok(Array.isArray(rs.dims) && rs.dims.join(',') === '72,60,65,70,45,38',
    '匹配卡：六维按固定顺序取到（' + JSON.stringify(rs.dims) + '）');
  ok(rs.why.includes('可以投') && !/\|/.test(rs.why),
    '⚠️ 匹配卡：结论段不含摘要块的表 markdown（实际 «' + rs.why.slice(0, 40) + '…»）');
  ok(rs.good.length === 1 && rs.gap.length === 1 && rs.tip.length === 1,
    '⚠️ 匹配卡：三组各取到 1 条（短条目没被当标题滤掉，实际 '
    + rs.good.length + '/' + rs.gap.length + '/' + rs.tip.length + '）');

  // 硬门槛未过的报告：不给分 → 卡片必须说「资格不符」，且不画雷达
  const gated = ['# 评估报告：X — Y', '', '**Score:** — （硬门槛未通过，按覆盖规则 3 不给分）', '',
    '⛔ **资格不符：学历层次**', '', '### 能力短板', '', '- 学历不满足硕士要求', '',
    '## A) 岗位概览'].join('\n');
  const rg = parseReportSummary(gated, {}, { threshold: 3 });
  ok(rg.gated === true && rg.tier === '资格不符' && rg.score5 === null && rg.dims === null,
    '匹配卡：硬门槛未过 → 资格不符、不给分、无六维');

  // 真实报告：都得能解析出分（或明确判为不给分），不能抛错
  let realBad = 0;
  for (const x of parsedAll) {
    try {
      const rr = parseReportSummary(fs.readFileSync(path.join(reportsDir, x.file), 'utf8'), { file: x.file }, { threshold: 3 });
      if (!(rr.score5 != null) && !rr.gated) realBad++;
      if (!rr.why) realBad++;
    } catch { realBad++; }
  }
  ok(realBad === 0, `真实报告全部可解析（${parsedAll.length} 份，异常 ${realBad} 份）`);
}

// 要求与职责必须分开：职责混进要求是「正文变成抄 JD」的根因

const withDuties = usable.filter((x) => x.r.duties.length > 0);
ok(withDuties.length > 0,
  `${withDuties.length} 份报告里，「岗位职责」被单独归类（没有混进 requirements）`);
for (const x of withDuties) {
  const leaked = x.r.requirements.filter((s) => /^参与公司核心业务|^负责.{0,20}(?:系统|平台|产品).{0,10}(?:的)?(?:设计|开发|研发|维护)/.test(s));
  ok(leaked.length === 0, `${x.file}：职责性条目没有漏进岗位要求（漏了 ${leaked.length} 条）`);
}

// 知识点名要收敛成短语，不能是一整句话
for (const x of usable) {
  const topics = x.r.gaps.slice(0, 3).map(gapToTopic);
  const tooLong = topics.filter((t) => t.length > 34);
  ok(tooLong.length === 0,
    `${x.file}：知识点名已收敛（${topics.map((t) => t.length).join('/')} 字）`);
  const withTail = topics.filter((t) => /(?:经历|经验|能力|技能|功底)$/.test(t));
  ok(withTail.length === 0, `${x.file}：知识点名没有残留「…经历 / 经验」这类尾巴`);
}

// 学历 / 届别 这类补不了的条目要被判成「不可学习」
ok(!isLearnableRequirement('2027 届本科及以上学历，计算机相关专业'), '学历届别条目被判为不可学习项');
ok(isLearnableRequirement('熟悉 Java 语言基础，理解面向对象与集合'), '技能类条目被判为可学习项');
ok(!isLearnableRequirement('计算机、数学、统计学等相关专业'), '专业类条目被判为不可学习项');

// ══ §0b 纯函数：本地兜底 ═════════════════════════════════════════════════
section('0b. 本地规则版（离线）');

// ⚠️ 前提自己钉死（2026-10-12）：原来取「010 开头，没有就取第一份可用报告」——
// 用户删掉旧报告后 010 没了，取样掉到 014（比亚迪），它的差距项词典匹配不到，
// 「资源里含视频课程 / 含书籍」直接假红。兜底逻辑是纯函数，不该依赖用户当前
// 留着哪些报告：这里用一段内置桩报告，词条覆盖词典里的 JVM / MySQL / Redis。
const sample = {
  file: '（内置桩报告）',
  r: {
    file: '(stub)', title: '桩岗位', score: '2.0/5', archetype: '后端开发',
    requirements: [
      '熟悉 JVM 内存模型与垃圾回收机制',
      '熟练使用 MySQL，了解索引与查询优化',
      '熟悉 Redis 缓存的使用与常见问题',
    ],
    duties: ['负责公司核心业务系统的设计与开发'],
    gaps: [
      '**JVM 与性能调优** —— 简历里没有垃圾回收与内存模型的任何记录',
      '**MySQL 索引** —— 只写了会写 SQL，没有索引设计与执行计划的经验',
      '**Redis 缓存** —— 完全没有缓存中间件的使用经历',
      '**2027 届本科及以上学历** —— 学历类条目，补不了',
    ],
    matches: [], questions: [], hasJd: false, jd: '',
  },
};
const fb = buildLocalFallback({ report: sample.r });

ok(fb.gaps.length > 0, `生成知识点 ${fb.gaps.length} 条`);
ok(fb.gaps.every((g) => ['P0', 'P1', 'P2'].includes(g.priority)), '每条知识点都标了 P0/P1/P2');
ok(fb.gaps.every((g) => !!g.mastery), '每条知识点都有掌握程度要求');
ok(fb.projects.length > 0, `生成实践项目建议 ${fb.projects.length} 个`);
ok(fb.projects.every((p) => p.goal && p.tech && p.value), '每个项目都写了「目标 / 技术要点 / 对岗位的价值」');
ok(fb.resources.length > 0, `给出学习资源 ${fb.resources.length} 条`);
ok(fb.resources.some((r) => r.kind === 'video'), '资源里含视频课程');
ok(fb.resources.some((r) => r.kind === 'book'), '资源里含书籍');

// 项目建议只能挑「能靠写代码补」的缺口：竞赛奖项写进技术要点是明显错误
const projText = fb.projects.map((p) => p.name + p.goal + p.tech).join(' ');
ok(!/竞赛|蓝桥杯|ACM|天梯赛|奖学金|获奖/.test(projText),
  '项目建议里没有混进竞赛 / 奖项（落不成项目的东西）');
ok(!/学历|学位|届|专业/.test(fb.projects.map((p) => p.tech).join(' ')),
  '技术要点里没有混进学历 / 届别（补不了的东西）');

// 摘要不能重复列名字，条数也要按实际写
const sm = fb.summary;
ok(sm.gapCount === fb.gaps.length, `摘要缺口数与实际一致（${sm.gapCount}）`);
ok(sm.mustLearn.length <= 3 && sm.mustLearn.length > 0, `「最先要补的」有 ${sm.mustLearn.length} 项（≤3）`);
ok(!sm.mustLearn.some((n) => sm.readiness.includes(n)),
  '「一句话结论」不重复列知识点名（避免同一件事说两遍）');

// 标点：不能出现「；；」「。。」这类重标点
const allProse = fb.projects.map((p) => [p.goal, p.tech, p.value].join('')).join('')
  + fb.gaps.map((g) => g.why).join('') + sm.readiness;
ok(!/；；|。。|，，|：：|、、/.test(allProse), '正文里没有重标点（；；/ 。。 / ，，）');

// ══ §0c 纯函数：Markdown 导出与 AI 输出解析 ═════════════════════════════
section('0c. 导出与 AI 解析（离线）');

const md = buildPrepMarkdown({
  report: sample.r, parsed: fb, source: 'local', generatedAt: '2026-01-01 00:00',
});
ok(md.includes(SECTION_TITLES.gaps), 'Markdown 里有第一段标题');
ok(md.includes(SECTION_TITLES.projects), 'Markdown 里有第二段标题');
ok(md.includes(SECTION_TITLES.resources), 'Markdown 里有第三段标题');
ok(!/最先要补的三项/.test(md), '导出里没有写死「三项」这种固定数量');
ok(/# 面试备考建议/.test(md), 'Markdown 有一级标题');
ok(/本地规则版/.test(md), '本地版在导出里注明了生成方式');

// AI 输出的三种常见走样都要能解析（7B 模型实测都会出现）
const G = ['JVM 内存模型与 GC 调优', '微服务架构与 Spring Cloud', 'MySQL 索引与慢查询治理'];
const aiText = ['好的，分析如下。', '', '一、需要学习与补充的知识点', '']
  .concat(G.flatMap((n) => ['- ' + n, '  优先级：P0', '  掌握程度：能讲原理', '  为什么缺：JD 明确要求，简历未提及', '']))
  .concat(['二、可用来补全简历的实践项目建议', '',
    '- 校园二手交易平台后端（微服务版）', '  目标：把单体拆成 3 个服务',
    '  技术要点：Nacos + Gateway + Sentinel', '  对岗位的价值：回应 JD 加分项', '  工作量：约 3 周', '',
    '三、学习资源清单', ''])
  .concat(G.flatMap((n) => ['**' + n + '**', '- 视频课程：B站《' + n + ' 教程》', '- 书籍：《' + n + ' 精讲》']))
  .join('\n');

const p1 = parsePrepOutput(aiText);
ok(p1.gaps.length >= 3, `AI 输出（无标记块）解析出知识点 ${p1.gaps.length} 条`);
ok(p1.projects.length >= 1, `AI 输出解析出项目 ${p1.projects.length} 个`);
ok(p1.resources.length >= 3, `AI 输出解析出资源 ${p1.resources.length} 条`);
ok(p1.resources.every((r) => r.title && !/^（本地词典未收录）/.test(r.title)),
  'AI 资源标题没有被塞进备注文字');
ok(prepOutputUsable(p1), '三段齐全的 AI 输出被判为可用');
ok(prepUnusableReason(p1) === '', '可用时不给「不完整」的误报文案');

// 模型忘了末尾机器块 → 摘要要用正文回填，而不是留空
const p2 = parsePrepOutput(aiText);
ok(p2.summary && p2.summary.readiness, '模型没给摘要块时，摘要由正文回填');
ok(p2.summary.mustLearn.length > 0, '回填的摘要里带上了「最先要补的」');

// 残缺输出要判为不可用，并说清缺什么
const p3 = parsePrepOutput('一、需要学习与补充的知识点\n\n- JVM\n');
ok(!prepOutputUsable(p3), '只有 1 条知识点的输出被判为不可用');
ok(/知识点/.test(prepUnusableReason(p3)), '不可用时说明了缺的是哪一段');
ok(!prepOutputUsable(null), '空输入不会误判为可用');

const counts = countParts(p1);
ok(counts.gaps === p1.gaps.length && counts.projects === p1.projects.length,
  `三部分计数与解析结果一致（${counts.gaps}/${counts.projects}/${counts.resources}）`);

// ══ §1 页面：入口与控件 ══════════════════════════════════════════════════
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.setDefaultTimeout(30000);
let runtimeErrors = [];
page.on('console', (m) => { if (m.type() === 'error') runtimeErrors.push(m.text()); });
page.on('pageerror', (e) => runtimeErrors.push('pageerror: ' + e.message));

section('1. 页面入口与控件');

await page.goto(BASE + '#prep', { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

// 导航里必须能找到「进阶规划」（2026-09-23 mockup 重构改名，原名「面试备考建议」），
// 栏目同名（2026-09-26 栏目按用户截图统一命名：产品能力/简历编辑/岗位评估/进阶规划/系统）。
// 栏目名在 `.nav-col-title` 上：用 closest('.nav-col') 往上找，
// 取那个 div 的 textContent 会把徽标数字（「进阶规划6」）一起带进来。
const navInfo = await page.evaluate(() => {
  const links = [...document.querySelectorAll('#nav [data-go]')];
  const hit = links.find((a) => (a.textContent || '').includes('进阶规划'));
  const col = hit ? hit.closest('.nav-col') : null;
  const title = col ? (col.querySelector('.nav-col-title') || {}).textContent || '' : '';
  return { found: !!hit, id: hit ? (hit.dataset.go || '') : '', col: title.trim() };
});
ok(navInfo.found, '导航里有「进阶规划」入口');
ok(navInfo.id === 'prep', `入口指向 #prep（实际 ${JSON.stringify(navInfo.id)}）`);
ok(navInfo.col === '进阶规划', `入口在「进阶规划」栏目下（实际 ${JSON.stringify(navInfo.col)}）`);
ok(!/投递台账/.test(await page.textContent('#nav')), '导航里已无「投递台账」残留');

const ctl = await page.evaluate(() => ({
  sel: !!document.querySelector('#pSel'),
  eng: !!document.querySelector('#pEngine'),
  gen: !!document.querySelector('#pGen'),
  title: (document.querySelector('#pageTitle') || {}).textContent || '',
  optCount: document.querySelectorAll('#pSel option').length,
  disabled: [...document.querySelectorAll('#pSel option')].filter((o) => o.disabled).length,
}));
ok(ctl.title.includes('能力复盘与进阶规划'), `页面标题是「能力复盘与进阶规划」（实际 ${JSON.stringify(ctl.title)}）`);
ok(ctl.sel, '有岗位下拉 #pSel');
ok(!ctl.eng, '生成方式下拉已删（引擎固定「自动」，2026-10-11 用户要求）');
ok(ctl.gen, '有生成按钮 #pGen');
ok(ctl.optCount > 0, `岗位下拉里有 ${ctl.optCount} 个岗位`);
// 数据不足的岗位要灰着看得见、写明原因。**前提是确实存在数据不足的报告** ——
// 这是环境假设：§0 已离线算出 blocked 清单；哪天用户把报告全换成数据充足的
// （先例：013 删掉后 6 份全可生成），页面上没有禁用项是**正确行为**，不该报红。
if (blocked.length > 0) {
  ok(ctl.disabled > 0, `其中 ${ctl.disabled} 个岗位因数据不足被禁用（灰着但看得见）`);
  // 禁用项要写明原因，而不是只灰着
  const disOpt = await page.evaluate(() => {
    const o = [...document.querySelectorAll('#pSel option')].find((x) => x.disabled);
    return o ? o.textContent : '';
  });
  ok(/数据不足/.test(disOpt), `被禁用的岗位写明了原因（${JSON.stringify(disOpt.slice(0, 40))}）`);
} else {
  console.log('  （跳过禁用项检查：当前 ' + ctl.optCount + ' 个岗位全部数据充足，没有该灰的项）');
}

// 「还没生成」那段说明块 2026-10-11 已删。⚠️ 2026-10-12 改口径：这页现在会
// 自动显示「当前岗位**已保存**的计划」（用户从报告详情跳过来要看得见），
// 所以这里不再断言 #pMsg 整块为空，只锁「那段说明文字确实不存在」。
const intro = await page.textContent('#pMsg');
ok(!/还没生成/.test(intro), '不再显示「还没生成」说明块');

// ══ §2 无横向滚动 ════════════════════════════════════════════════════════
section('2. 横向滚动');

for (const w of [1920, 1560, 1440, 1279, 1119, 1023, 900, 767, 519, 390, 320]) {
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto(BASE + '#prep', { waitUntil: 'networkidle' });
  await page.waitForTimeout(320);
  const m = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
    view: (document.querySelector('#view') || {}).scrollWidth || 0,
    viewW: (document.querySelector('#view') || {}).clientWidth || 0,
  }));
  ok(m.doc <= m.win + 1, `${w}px：无横向滚动（doc ${m.doc}/${m.win}）`);
  ok(m.view <= m.viewW + 1, `${w}px：内容区无横向滚动（${m.view}/${m.viewW}）`);
}

// ══ §3 本地规则版生成（页面全流程）═══════════════════════════════════════
section('3. 生成与三段输出');

runtimeErrors = [];
await page.setViewportSize({ width: 1440, height: 950 });
await page.goto(BASE + '#prep', { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#pGen');

// 生成方式下拉已删：引擎经测试钩子固定为「本地规则版」（不联网、零 token，
// 自检不依赖 Ollama 在线 —— 与原来 selectOption('#pEngine','local') 等效）
await page.evaluate(() => window.__prepTest.setEngine('local'));

// 岗位要**明确指定**，不能靠默认值：默认选中的是最新一份报告，
// 而不同报告的缺口不同、词典命中情况也不同（最新那份可能一条都命不中，
// 资源就全是「官方文档」，按「必须有视频/书籍」断言会假红）。
// 优先挑 010（§0 用的同一份），拿不到就退回第一个可用项。
const picked = await page.evaluate(() => {
  const opts = [...document.querySelectorAll('#pSel option')].filter((o) => !o.disabled);
  const hit = opts.find((o) => /^010/.test(o.value)) || opts[0];
  return hit ? hit.value : '';
});
if (picked) {
  await page.selectOption('#pSel', picked);
  await page.waitForTimeout(250);
}
ok(!!picked, `选定待生成的岗位：${picked}`);

await page.click('#pGen');

// 同一份报告再向服务端要一次，用来和页面渲染结果逐条对照。
// 本地规则版是纯规则，两次结果必然一致 —— 对得上才说明页面画的是真数据。
const apiKinds = await (async () => {
  if (!picked) return [];
  const resp = await page.request.post(BASE + 'api/prep/generate', {
    data: { file: picked, engine: 'local' },
  });
  const body = await resp.json().catch(() => ({}));
  const list = (body.parsed && body.parsed.resources) || [];
  return list.map((r) => RESOURCE_KIND_ZH[r.kind] || '资源');
})();

// 生成是异步的：等到结果区出现三段标题为止（本地版通常 1–3 秒）
await page.waitForFunction(() => {
  const t = (document.querySelector('#pOut') || {}).textContent || '';
  return /需要学习与补充的知识点/.test(t);
}, { timeout: 90000 }).catch(() => {});
await page.waitForTimeout(600);

const out = await page.evaluate(() => {
  const o = document.querySelector('#pOut');
  if (!o) return null;
  const secs = [...o.querySelectorAll('.prep-sec-head h2')].map((h) => h.textContent.trim());
  return {
    sections: secs,
    gapItems: o.querySelectorAll('.prep-item').length,
    prio: [...o.querySelectorAll('.badge.p0, .badge.p1, .badge.p2, [data-prio]')].map((b) => b.textContent.trim()),
    projCards: o.querySelectorAll('.prep-proj').length,
    projGrid: !!o.querySelector('.prep-proj-grid'),
    projLabels: [...o.querySelectorAll('.prep-proj-points > li > i')].map((x) => x.textContent.trim()),
    resItems: o.querySelectorAll('.prep-res > li').length,
    kindBadges: [...o.querySelectorAll('.prep-res .badge')].map((b) => b.textContent.trim()),
    text: o.textContent,
  };
});
ok(!!out, '结果区已渲染');
if (out) {
  ok(out.sections.length === 3, `三段齐全（实际 ${out.sections.length} 段）`);
  ok(out.sections[0] === SECTION_TITLES.gaps, `第一段：${out.sections[0]}`);
  ok(out.sections[1] === SECTION_TITLES.projects, `第二段：${out.sections[1]}`);
  ok(out.sections[2] === SECTION_TITLES.resources, `第三段：${out.sections[2]}`);
  ok(out.gapItems >= 3, `渲染出 ${out.gapItems} 条知识点`);
  ok(/P0|P1|P2/.test(out.text), '知识点上带优先级标记');
  ok(/掌握程度/.test(out.text), '知识点上有「掌握程度要求」');
  ok(/了解概念|能上手用|能讲原理/.test(out.text), '掌握程度用的是三档规范说法');
  // 2026-09-26 对齐设计稿：项目建议从定义列表改成两列卡片网格
  ok(out.projGrid, '项目建议用了两列卡片网格（.prep-proj-grid）');
  ok(out.projCards >= 1, `渲染出 ${out.projCards} 张项目优化卡`);
  const wantFields = ['技术要点', '对岗位的价值', '工作量估算'];
  ok(wantFields.every((f) => out.projLabels.includes(f)),
    `项目要点带标签「${wantFields.join(' / ')}」（实际 ${JSON.stringify(out.projLabels.slice(0, 6))}）`);
  ok(out.resItems > 0, `资源清单 ${out.resItems} 条`);
  // 资源类型只验「编码 → 中文标签」的映射对不对，不要求出现某一种类型 ——
  // 出现哪种取决于所挑报告的缺口能不能命中词典，那是模型层的事（§0 已在管）。
  const known = new Set(Object.values(RESOURCE_KIND_ZH));
  ok(out.kindBadges.length === out.resItems,
    `每条资源都带一个类型徽标（${out.kindBadges.length}/${out.resItems}）`);
  ok(out.kindBadges.every((b) => known.has(b)),
    `类型徽标都是规范中文（实际 ${JSON.stringify([...new Set(out.kindBadges)])}）`);
  // 与服务端返回的 kind 序列逐条对齐：证明页面渲染的是真数据，不是兜底文案
  ok(JSON.stringify(out.kindBadges) === JSON.stringify(apiKinds),
    `徽标顺序与服务端 kind 一一对应（页面 ${out.kindBadges.length} / 接口 ${apiKinds.length}）`);
}

// 顶部操作：生成常驻 + 「返回」；复制/导出已按用户要求下线（2026-10-11）
const top = await page.$$eval('#topActions button', (bs) => bs.map((b) => b.textContent.trim()));
ok(top.some((t) => /返回/.test(t)), `顶部有「返回」键（${JSON.stringify(top)}）`);
ok(!top.some((t) => /复制|导出/.test(t)), '复制全文 / 导出 .md 已下线');

// （依据文件名与生成方式 badge 的 meta 卡已按用户要求移除；
//   可追溯性由导出 md 的生成方式注明 + 下拉下方的 pickNote 承担，见 §0c/L449。）

// ══ §5 复制/导出已下线 ══════════════════════════════════════════════════
section('5. 复制/导出已下线（2026-10-11 用户要求）');

ok((await page.$('#pCopy')) === null, '「复制全文」按钮已不存在');
ok((await page.$('#pExport')) === null, '「导出 .md」按钮已不存在');

// ══ §6 数据缺失的明确提示 ════════════════════════════════════════════════
section('6. 数据缺失提示');

// ① 服务端要挡住：直接对不可生成的报告发请求，必须 4xx 且带 missing 清单
const blockedFile = blocked.length ? blocked[0].file : '';
if (blockedFile) {
  const resp = await page.request.post(BASE + 'api/prep/generate', {
    data: { file: blockedFile, engine: 'local' },
  });
  ok(resp.status() >= 400, `对数据不足的报告返回 ${resp.status()}（4xx）`);
  const body = await resp.json().catch(() => ({}));
  ok(!body.ok, '响应体 ok 为 false');
  ok(typeof body.error === 'string' && body.error.length > 10, `给了可读的错误文案：${String(body.error).slice(0, 60)}`);
  ok(Array.isArray(body.missing) && body.missing.length > 0,
    `错误体里带 missing 清单：${JSON.stringify(body.missing)}`);
} else {
  console.log('  --  reports/ 里没有「数据不足」的报告，跳过服务端拦截断言');
}

// ② 不存在的文件也要被挡住（不能 500）
const bad = await page.request.post(BASE + 'api/prep/generate', {
  data: { file: '../../etc/passwd', engine: 'local' },
});
ok(bad.status() >= 400 && bad.status() < 500, `非法文件名被挡在 ${bad.status()}（不是 500）`);

// ③ 页面层：选到被禁用的岗位时，说明里要写清为什么不能生成
const blockNote = await page.evaluate(() => {
  const sel = document.querySelector('#pSel');
  const o = [...sel.options].find((x) => x.disabled);
  if (!o) return '';
  sel.disabled = false;
  sel.value = o.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return o.textContent;
});
if (blockNote) {
  await page.waitForTimeout(350);
  const note = await page.textContent('.prep-pick-note');
  ok(/生成不了|数据不够/.test(note), `选到数据不足的岗位时现场说明原因：${JSON.stringify(note.slice(0, 60))}`);
  const genDisabled = await page.evaluate(() => {
    const b = document.querySelector('#pGen');
    return b ? b.disabled : null;
  });
  ok(genDisabled !== false, '数据不足时生成按钮不可用（或点了会被服务端挡下）');
} else {
  console.log('  --  下拉里没有被禁用的岗位，跳过页面层断言');
}

// ══ §7 报告详情页的入口（岗位对应）═══════════════════════════════════════
section('7. 从报告详情页进来');

// 报告列表卡片上不带文件名（只有 aria-label="查看报告：{标题}"），所以按标题找。
await page.goto(BASE + '#reports', { waitUntil: 'networkidle' });
await page.waitForSelector('.report-item');
const opened = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.report-item')];
  const h = items.find((el) => /星海科技/.test(el.textContent || '')) || items[0];
  if (!h) return '';
  h.click();
  return h.getAttribute('aria-label') || '';
});
ok(!!opened, `从报告列表点开一份报告：${opened}`);
await page.waitForTimeout(800);

const hasBtn = await page.$('#rPrep');
ok(!!hasBtn, '报告详情页有「生成提升计划」按钮');
ok(hasBtn && (await page.textContent('#rPrep')).includes('生成提升计划'),
  '按钮文案是「生成提升计划」（2026-10-12 用户要求）');
if (hasBtn) {
  await page.click('#rPrep');
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => ({
    hash: location.hash,
    sel: (document.querySelector('#pSel') || {}).value || '',
    note: (document.querySelector('.prep-pick-note') || {}).textContent || '',
    disabled: !!((document.querySelector('#pGen') || {}).disabled),
    // 2026-10-12：跳过来要能立刻看到「这份岗位已有的计划」与历史列表
    hisCards: document.querySelectorAll('[data-pgopen]').length,
    curPlan: !!document.querySelector('.prep-cur-block'),
  }));
  // 2026-10-12 用户要求：先去**提升计划页**（历史计划在那儿，原来跳工作台看不到）
  ok(st.hash === '#growth', `点完跳到提升计划页（${st.hash}）`);
  ok(st.sel === picked, `岗位自动带上是那一份报告（${st.sel}）`);
  ok(!st.disabled, '可生成时按钮可用（disabled 只在生成中为真）');
  ok(st.hisCards >= 1, `历史提升计划列表可见（${st.hisCards} 份）`);
  ok(st.curPlan, '这份岗位已保存的计划直接显示在上方（不用再点「看结果」）');
  // 「依据：X 条差距项 + Y 条要求，对照你的 cv.md（N 字）」说明句已按用户
  // 要求删除（2026-10-12）—— 数据可生成时 pickNote 应为空；不能生成时的
  // 功能性提示（数据不够的原因）保留，见下面 blockedFile 分支。
  ok(st.note.trim() === '', '可生成时不再显示「依据」说明句（2026-10-12 用户要求）');
}

// 数据不足的报告也要能带过来，并**当场**说明为什么不能生成 ——
// 这一条是需求里「数据缺失时给出明确提示」的另一种入口，同样容易静默退化。
if (blockedFile) {
  await page.goto(BASE + '#reports', { waitUntil: 'networkidle' });
  await page.waitForSelector('.report-item');
  await page.evaluate((f) => {
    const items = [...document.querySelectorAll('.report-item')];
    // 报告卡不带文件名，只能按它的标题片段找；找不到就跳过
    const h = items.find((el) => f.startsWith('013') ? /未知公司/.test(el.textContent || '') : false);
    if (h) h.click();
  }, blockedFile);
  await page.waitForTimeout(800);
  if (await page.$('#rPrep')) {
    await page.click('#rPrep');
    await page.waitForTimeout(1100);
    const st2 = await page.evaluate(() => ({
      sel: (document.querySelector('#pSel') || {}).value || '',
      note: (document.querySelector('.prep-pick-note') || {}).textContent || '',
      disabled: !!((document.querySelector('#pGen') || {}).disabled),
    }));
    if (st2.sel === blockedFile) {
      ok(/生成不了|数据不够/.test(st2.note), `.数据不足的岗位带过来后当场说明原因`);
      ok(st2.disabled, '且生成按钮置灰（不是点了才报错）');
    }
  }
}

// ══ §8 控制台错误 ════════════════════════════════════════════════════════
section('8. 控制台错误');
// 前面几段里有意造过失败请求（4xx），那不会进控制台；这里只留最后一段的干净计数。
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
