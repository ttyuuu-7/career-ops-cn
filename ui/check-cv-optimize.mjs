#!/usr/bin/env node
// ui/check-cv-optimize.mjs — 「AI 优化简历」的解析层 + 流程回归
//
// 覆盖两段：
//   A. 解析（纯离线，秒级）—— ui/cv-optimize-parse.mjs
//      模型输出的措辞完全不受控，而解析坏掉的方式是**静默降级**：
//      问题清单渲染成空、改写稿少一段，页面看起来「跑成功了」。
//      所以这里把见过的畸形输出一个个钉住。
//   B. 流程（打桩，秒级）—— 面板接线、切页不丢结果、写回前必须确认
//
// 唯一的真实写操作是最后一步「写回 cv.md」。它**会动真文件**，
// 所以那一步前后各快照一次 cv.md 与 data/cv-form.json，跑完原样还原、
// 并删掉本次产生的备份文件。不这样做，跑一次自检就把用户的简历改掉了。
//
// 前置：控制台已在 127.0.0.1:7317（服务端要已是新代码，含 /api/cv/optimize）。
// 用法：
//   node ui/check-cv-optimize.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCvOptimize } from './cv-optimize-parse.mjs';
import { markdownToCv, normalizeCv, auditCvMarkdown } from './cv-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CV_MD = path.join(ROOT, 'cv.md');
const CV_FORM = path.join(ROOT, 'data', 'cv-form.json');
const CV_TPL = path.join(ROOT, 'data', 'cv-templates.json');
const BACKUP_DIR = path.join(ROOT, 'data');
const URL_BASE = 'http://127.0.0.1:7317/';

// 打桩延迟：给「请求还在飞的时候切走」留一个可测试的窗口，而不是靠运气抢时机
const DELAY = 800;

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

// ══ A. 解析层 ════════════════════════════════════════════════════════════
console.log('\n── A. 解析：AI 输出 → 结构化字段 ──');

const CANON = [
  'SUMMARY: 结构完整，但项目经历缺量化、教育背景偏后。',
  '',
  '### 问题清单',
  '1. [高] 项目经历没有量化结果 —— 「参与了客户流失预测」应改成「用随机森林做到 AUC 0.86」。',
  '- **中** 教育背景放在最后：国内校招应挪到个人信息下面。',
  '- [低] 技能分类太笼统。',
  '',
  '### 改写稿',
  '```markdown',
  '# 张明',
  '138-0000-0000 · 承德',
  '',
  '## 教育背景',
  '某某大学 · 计算机科学与技术 · 本科 2023-2027',
  '',
  '## 项目经历',
  '- 用随机森林建模预测电信客户流失，AUC 0.86，较基线提升 12 个百分点。',
  '```',
].join('\n');

{
  const r = parseCvOptimize(CANON);
  console.log('  总评：' + r.summary);
  ok(r.summary.includes('教育背景偏后'), '解析出 SUMMARY 总评');
  ok(r.issues.length === 3, '解析出 3 条问题，实际 ' + r.issues.length);
  ok(r.issues[0].level === '高', '严重度 [高] 正确');
  ok(r.issues[1].level === '中', '严重度 **中**（markdown 加粗包裹）正确');
  ok(r.issues[2].level === '低', '严重度 [低] 正确');
  ok(r.issues[0].title === '项目经历没有量化结果', '标题与说明按 `——` 切开：' + r.issues[0].title);
  ok(r.issues[0].detail.includes('AUC 0.86'), '说明取到分隔符之后的部分');
  ok(r.draft.startsWith('# 张明'), '改写稿取到代码块内容');
  ok(!r.parseError, '没有 parseError');
}

{
  // 小标题被整体加粗：`#### **问题清单**`
  const r = parseCvOptimize([
    '**SUMMARY:** 还行。',
    '#### **问题清单**',
    '* [高] 没有量化 —— 补数字。',
    '#### **改写稿**',
    '```md',
    '# '.padEnd(2) + '李四',
    'x'.repeat(120),
    '```',
  ].join('\n'));
  ok(r.issues.length === 1 && r.issues[0].level === '高', '加粗小标题 + `*` 列表项仍能解析');
  ok(r.draft.length >= 100, '加粗小标题后的代码块取到了');
}

{
  // 围栏忘了闭合——模型常犯。必须拿到稿子，而不是空字符串。
  const r = parseCvOptimize([
    'SUMMARY: 一般。', '', '### 问题清单', '- [高] 太短 —— 展开。',
    '', '### 改写稿', '```markdown', '# 王五', 'y'.repeat(150),
  ].join('\n'));
  ok(r.draft.startsWith('# 王五') && r.draft.length > 100, '围栏未闭合时取到文本末尾');
}

{
  // 连「改写稿」小标题都省了：退而取整段输出里最长的代码块
  const r = parseCvOptimize([
    'SUMMARY: 一般。', '', '### 问题清单', '- [中] 顺序 —— 教育前置。',
    '```', '# 赵六', 'z'.repeat(160), '```',
  ].join('\n'));
  ok(r.draft.startsWith('# 赵六'), '没有改写稿小标题时取最长代码块');
}

{
  // 只有问题清单、没稿子：必须明确报「没拿到」，不能把清单当简历
  const r = parseCvOptimize('SUMMARY: 问题不少。\n### 问题清单\n1. [高] 没有量化 —— 补。\n');
  ok(r.draft === '', '没有稿子时 draft 为空（不会误当简历）');
  ok(!!r.parseError, '并给出 parseError：' + r.parseError);
}

{
  // 稿子太短：丢弃。这拦住的是「模型回了一句『已优化』」这种假成功。
  const r = parseCvOptimize('### 改写稿\n```\n已优化\n```\n');
  ok(r.draft === '', '少于 100 字符的稿子被丢弃');
}

{
  // 列表项被折成两行：第二行没有列表符号，但它属于上一条。
  // 不合并的话标题会被截成半句（实测见过「1. [高] 「员工 / 腾讯」经历无法自洽 —— …」）。
  const r = parseCvOptimize([
    'SUMMARY: 有一段经历对不上。', '', '### 问题清单',
    '1. [高] 「员工',
    '腾讯」经历无法自洽 —— 在校生写「员工」会被面试官追问。',
    '2. [低] 技能太笼统。',
    '', '### 改写稿', '```', '# 钱七', 'q'.repeat(150), '```',
  ].join('\n'));
  ok(r.issues.length === 2, '折行项没有被拆成两条，实际 ' + r.issues.length);
  ok(r.issues[0].title.includes('腾讯'), '折行的下半句并回了标题：' + r.issues[0].title);
  ok(r.issues[0].detail.includes('面试官'), '说明也没丢');
}

{
  const r = parseCvOptimize('');
  ok(r.draft === '' && !!r.parseError, '空输入安全返回：' + r.parseError);
}

{
  // CRLF
  const r = parseCvOptimize(CANON.replace(/\n/g, '\r\n'));
  ok(r.issues.length === 3 && r.draft.startsWith('# 张明'), 'CRLF 输入同样能解析');
}

// ── A2. 改写稿 → 表单：一行解析错，整节内容就没了 ─────────────────────────
//
// 这段是 2026-09-18 事故的回归防线。事故链条：
//   AI 把 `## 实习经历` 写成了解析器当时不认识的标题、把教育背景写成没有
//   `###` 的裸行 → markdownToCv 解析出 0 条 → cv-form.json 里那两节变空 →
//   用户打开「我的简历」看到的是一片空白，以为信息被删光了。
// 所以「AI 常见的中文写法必须全部解析得出条目」是硬要求，不是锦上添花。
console.log('\n── A2. 改写稿 → 表单：中文标题与裸排版都不能丢节 ──');

{
  // 这是事故当天真实落进 cv.md 的那种排版
  const AI_STYLE = [
    '# 关雨',
    '',
    '17749854838 · 11749854838@163.com · GitHub：【待补充：GitHub/Gitee 链接（如有）】',
    '',
    '**求职意向：** Java 后端开发工程师（2028 届校招）',
    '',
    '## 个人简介',
    '',
    '河北民族师范学院人工智能专业本科生，方向 Java 后端开发。',
    '',
    '## 教育背景',
    '',
    '**河北民族师范学院** · 本科 · 人工智能专业 · 承德',
    '2024.09 – 2028.06（2028 届）',
    '主修课程：数据结构、数据库原理',
    '',
    '## 实习经历',
    '',
    '### 实习生 — 腾讯　杭州',
    '2025.06 – 2026.06',
    '',
    '- 参与后端接口开发与联调，累计交付 30+ 接口',
    '',
    '## 项目经历',
    '',
    '### 校园二手交易平台 —— 后端负责人　2025.03 – 2025.06',
    '',
    '**技术栈：** Java、Spring Boot、MySQL、Redis',
    '',
    '- 用 Redis 缓存热门商品列表，首页加载从 1.2s 降到 280ms',
    '',
    '## 专业技能',
    '',
    '- **编程语言：** Java（熟练）、SQL（熟练）',
    '',
    '## 荣誉奖项',
    '',
    '- 省三好学生（省级）— 河北省教育厅 · 2025',
  ].join('\n');

  const f = markdownToCv(AI_STYLE);
  ok(f.education.length === 1, '教育背景（无 ### 的裸排版）解析出条目，实际 ' + f.education.length);
  ok(f.education[0].org.includes('河北民族师范学院'), '教育：学校取到了 — ' + f.education[0].org);
  ok(f.education[0].location === '承德', '教育：城市从同一行里分出来了');
  ok(/2024/.test(f.education[0].year), '教育：起止时间带上了 — ' + f.education[0].year);
  ok(f.education[0].description.includes('数据结构'), '教育：主修课程归到说明里');

  ok(f.experience.length === 1, '`## 实习经历` 被识别（别名表里有它）');
  ok(f.experience[0].company === '腾讯', '实习：公司 — ' + f.experience[0].company);
  ok(f.experience[0].location === '杭州', '实习：全角空格后的城市拆出来了');
  ok(f.experience[0].bullets.length === 1, '实习：要点保留');

  ok(f.awards.length === 1, '`## 荣誉奖项` 被识别（别名表里有它）');
  ok(f.awards[0].title === '省三好学生（省级）', '荣誉：标题与颁发单位按「）—」切开');
  ok(f.awards[0].org === '河北省教育厅', '荣誉：颁发单位 — ' + f.awards[0].org);

  ok(f.candidate.location === '', '【待补充】占位符没有污染「城市」字段');
  ok(f.candidate.github === '', '占位符没有当成 GitHub 账号存下来');
  ok(!auditCvMarkdown(AI_STYLE).broken.length,
    '结构体检无异常：' + JSON.stringify(auditCvMarkdown(AI_STYLE).broken));
}

{
  // 章节名换了说法（AI 爱干的事）也要认
  const VARIANTS = {
    实习经历: 'experience', 工作经历: 'experience', 工作经验: 'experience',
    荣誉奖项: 'awards', 获奖情况: 'awards', 奖项与荣誉: 'awards',
    项目经验: 'projects', 教育经历: 'education', 技能特长: 'skills',
  };
  for (const [title, key] of Object.entries(VARIANTS)) {
    const md = ['# 甲', '', `## ${title}`, '', '- 一条内容'].join('\n');
    const a = auditCvMarkdown(md);
    ok(a.sections[0].key === key, `章节名「${title}」→ ${key}`);
  }
}

{
  // 体检必须能抓出「有内容却解析不出条目」——守卫靠它工作。
  // 这一节的内容全是不被识别的标题（`####` 四级标题），一行都排不进条目，
  // 报出来才对——否则这节在表单里是空的，下次保存就从 cv.md 里消失了。
  const BAD = ['# 甲', '', '## Education', '', '#### 某某大学', '', '#### 某某学院'].join('\n');
  const a = auditCvMarkdown(BAD);
  ok(a.broken.includes('Education'), '体检抓出解析不出条目的 Education：' + JSON.stringify(a.broken));
  const GOOD = ['# 甲', '', '## Education', '', '### 本科 计算机', '', '某某大学 · 承德 · 2024-2028'].join('\n');
  ok(!auditCvMarkdown(GOOD).broken.length, '正常排版不会被误报');
  // 整节只有列表项：结构会退化，但不许整节消失
  const BULLETS = ['# 甲', '', '## Projects', '', '- 甲项目：做了 A', '- 乙项目：做了 B'].join('\n');
  ok(!auditCvMarkdown(BULLETS).broken.length, '整节只有列表项也不算解析失败');
  ok(markdownToCv(BULLETS).projects.length === 1
    && markdownToCv(BULLETS).projects[0].bullets.length === 1,
  '只有列表项的项目节：内容被收进一个条目，不会丢');
}

{
  // 空列表项残留（`## Certifications` 下面孤零零一个 `- `）不算「有内容」，
  // 否则每次保存都会被守卫拦下来问一次，很快就会被当成噪音。
  const md = ['# 甲', '', '## Education', '', '### 本科 计算机', '', '某某大学 · 承德 · 2024-2028',
    '', '## Certifications', '', '- '].join('\n');
  const a = auditCvMarkdown(md);
  ok(!a.broken.length, '空的证书章节不被当成丢失：' + JSON.stringify(a.broken));
  ok(markdownToCv(md).certifications.length === 0, '空条目不会变成一条空证书');
}

// ══ B. 流程层（打桩） ════════════════════════════════════════════════════
// 2026-10-09：打桩稿改成与磁盘上cv.md **同结构**（同样 6 个模块、同样条目数），
// 只换措辞 —— 这才是「只优化措辞、不增删内容」下AI 应有的输出。
// 原来这份稿只有 3 个模块，和左栏 6 个对不上：B3 断言「左右模块数一致」
// 只能靠改断言去迁就打桩数据（等于把规则测没了），不如把桩修对。
const STUB_DRAFT = [
  '# 张三',
  '1774985444 · zhangsan@163.com · 北京',
  '',
  '## 个人简介',
  '本人为计算机专业在读本科生，具备扎实的计算机理论基础与较强的实践能力，',
  '熟悉 Java 后端与数据分析方向。',
  '',
  '## 核心能力',
  '- 后端服务开发与接口设计，按时序图拆分模块，优雅集成第三方服务。',
  '- 数据分析与建模，通过数据清洗、特征提取和算法分析等步骤，',
  '  提升数据质量与模型效果。',
  '- 团队协作与项目推动，配合团队推进项目落地，具备良好的沟通协调能力。',
  '',
  '## 教育背景',
  '### 本科（在读）',
  '北京大学 · 计算机科学与技术 · 2023-09 ~ 至今',
  '',
  '## 实习与工作经历',
  '### 实习生 — 腾讯',
  '2025-07 ~ 2025-09 · 深圳',
  '- 负责后端接口开发与数据库设计，按时序图拆分模块，优雅集成第三方服务。',
  '- 参与数据报表模块建设，处理业务逻辑与数据流转。',
  '',
  '## 项目经历',
  '### 一、基于SpringBoot的校园图书管理系统（个人项目）',
  '**技术栈：** Java, SpringBoot, MySQL, MyBatis-Plus',
  '- 使用SpringBoot 框架开发，实现注册登录、图书入库、分类查询、'
  + '借阅归还等功能。',
  '- 使用 MyBatis-Plus 简化数据访问层，提高开发效率与代码可维护性。',
  '',
  '### 二、基于Python的学生成绩数据分析系统（小组项目）',
  '**技术栈：** Python, Pandas, Matplotlib',
  '- 使用 Python 处理原始数据，清理重复记录、异常值，统一多数据格式。',
  '- 通过 Pandas 与 Matplotlib 进行数据可视化交互，'
  + '分析学生成绩分布与相关性。',
  '- 构建预测模型，评估模型性能与准确性。',
  '',
  '## 专业技能',
  '- **编程语言：** 熟练掌握Java、Python，熟悉C/C++、JavaScript基础语法与工具。',
  '- **数据库与工具：** 掌握MySQL数据库、Git、IntelliJ IDEA、Visual Studio Code。',
  '- **计算机基础：** 熟悉TCP/IP、HTTP协议，了解JVM内存与多线程基础。',
  '- **算法与后端：** 掌握常见算法与后端框架如SpringBoot、MyBatis-Plus。',
  '- **其他技能：** 英语四级CET-4、2023-2024学年校级二等奖学金。',
].join('\n');

const STUB = {
  ok: true, mode: 'general', cli: 'stub', ms: 4200, code: 0, timeout: false, retried: false,
  output: CANON,
  stderr: '', friendly: '',
  parsed: {
    summary: '结构完整，但项目经历缺量化、教育背景偏后。',
    issues: [
      { level: '高', title: '项目经历没有量化结果', detail: '补上 AUC、提升幅度这类数字。' },
      { level: '中', title: '教育背景放在最后', detail: '国内校招应前置到个人信息下面。' },
    ],
    draft: STUB_DRAFT,
    parseError: '',
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(30000);
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

let postedBody = null;
await page.route(/\/api\/cv\/optimize$/, async (route) => {
  postedBody = route.request().postDataJSON() || {};
  await new Promise((r) => setTimeout(r, DELAY));
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STUB) });
});

const to = (hash) => page.evaluate((h) => { window.location.hash = h; }, hash);

// 写回那一步会动真文件，先把现场记下来
const snap = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const beforeMd = snap(CV_MD);
const beforeForm = snap(CV_FORM);
const beforeTpl = snap(CV_TPL);
const backupsBefore = new Set(fs.readdirSync(BACKUP_DIR).filter((f) => /^cv\.backup-\d+\.md$/.test(f)));

// ⚠️ 临时把选中模板钉到内置 '1'（色系版式），跑完还原。
//    为什么必须钉：这一页断言的是「左右两栏用同一套版式、结构未被增删」，
//    计数用的是 **.cvp-sec** ——那是色系渲染器的产物。2026-10-09 接入「稳重」
//    模板（wz01–wz10，走 renderWzCv）后，用户若正好选着 wz06，
//    这些断言会**跟着用户的选择一起变红**（实测 7 条红），而那与本自检
//    验证的东西毫无关系。与其把断言改成「两种渲染器都成立」（等于放宽），
//    不如把前置条件固定下来 —— 自检的前提应该是确定的。
try {
  const t = beforeTpl ? JSON.parse(beforeTpl) : { selected: '', items: [] };
  t.selected = '1';
  fs.writeFileSync(CV_TPL, JSON.stringify(t, null, 2), 'utf8');
} catch (e) {
  console.log('（钉模板失败：' + e.message + '，继续）');
}

// ⚠️ 同理，简历数据也要钉成与 STUB_DRAFT **同模块**的固定内容（跑完还原，
//    beforeForm 快照在上面已经有了）。为什么：B3「左右模块数一致」拿右栏
//    （打桩稿，模块数固定）对比左栏（服务端返回的表单）。**左栏读的优先级
//    是 data/cv-form.json（表单缓存），cv.md 只是没有缓存时才兜底** ——
//    所以钉的是 CV_FORM 而不是 CV_MD（2026-10-09 第一版钉错了对象，
//    红灯没消）。打桩稿当初是照当时的简历抄的 6 个模块，用户后来加了
//    「荣誉奖项」，左栏变 7 个，断言就跟着用户的简历一起红（实测 7 vs 6）。
//    钉成「STUB_DRAFT 解析出的 form」最稳：左右同源同构，「结构未被增删」
//    这个要验证的东西一点没放宽。
try {
  // STUB_DRAFT 本身就是 .join('\n') 过的**字符串**（不是数组 —— 2026-10-09
  // 第一版在这里又调了一次 .join，TypeError 被下面的 catch 吞掉只打了一行
  // 「钉 cv-form 失败」，钉入整个没生效，左栏继续拿用户真实数据渲染 → 7 vs 6）。
  const pin = normalizeCv(markdownToCv(STUB_DRAFT));
  fs.writeFileSync(CV_FORM, JSON.stringify(pin, null, 2), 'utf8');
} catch (e) {
  // 钉不进去就直接退出，**不要「继续」**：前提不成立时，后面的每一条断言
  // 都在拿用户的真实数据跑 —— 红了看不出为什么、绿了也是碰巧（这次就是教训）。
  console.log('（钉 cv-form 失败，自检中止：' + e.message + '）');
  process.exit(1);
}
// B7「cv-form.json 未被改动」的比较基准 = **钉入后**的那份快照（beforeForm
// 是用户的原文件，自检自己刚把它换成了钉入内容 —— 拿它当基准必红）。
const pinnedForm = fs.readFileSync(CV_FORM, 'utf8');

let wrote = false;
try {
  console.log('\n── B1. 独立页面就位（2026-10-09 由简历页内嵌折叠卡改独立页）──');
  await page.goto(URL_BASE + '#cv', { waitUntil: 'networkidle' });
  // 简历页现在只留一个入口按钮，优化面板整体搬到 /#cvopt：
  // 双预览对照要整页宽度，右栏 1/2 屏放不下两张简历。
  ok((await page.$('#cvOptEntry')) !== null, '简历页有「下一步」入口按钮（跳简历优化页）');
  ok((await page.$('#cvOptCard')) === null, '旧的内嵌折叠卡已撤下（不是删功能，是换了位置）');
  await page.click('#cvOptEntry');
  await page.waitForSelector('#cvOptGo', { timeout: 15000 });
  ok(page.url().indexOf('#cvopt') > 0, '点入口跳到 #cvopt，实际 ' + page.url().split('#')[1]);
  // 2026-10-10 换肤：这一页的标题从「简历全局优化」改成「AI 定向优化」
  //（对齐原型命名；页面职责没变 —— 左原简历右优化稿）。
  ok((await page.textContent('#pageTitle')).trim() === 'AI 定向优化', '页面标题是「AI 定向优化」');

  console.log('\n── B1b. 双预览框并排且都是 HTML ──');
  const dual = await page.evaluate(() => {
    const d = document.querySelector('.cvopt-dual');
    const L = document.querySelector('#cvOptLeft');
    const R = document.querySelector('#cvOptRight');
    return {
      cols: d ? getComputedStyle(d).gridTemplateColumns : '',
      lCvp: !!(L && L.querySelector('.cvp')),
      // ⚠️ 排除 .cvp-photo：这条断言的本意是「预览是 HTML 渲染，不是一张合成大图」，
      //    而头像是用户传的**真图片**，本来就应该是一个 <img>。不排除的话，
      //    只要简历设了头像这条就红 —— 红的是「有头像」，不是「预览退化成了图片」。
      lImgs: L ? L.querySelectorAll('img:not(.cvp-photo)').length : -1,
      rEmpty: !!(R && R.querySelector('.cvopt-empty')),
      lH: L ? Math.round(L.getBoundingClientRect().height) : 0,
      rH: R ? Math.round(R.getBoundingClientRect().height) : 0,
    };
  });
  ok(dual.cols.split(' ').length === 2, '两栏并排（grid: ' + dual.cols + '）');
  ok(dual.lCvp, '左栏是 HTML 简历（.cvp）');
  ok(dual.lImgs === 0, '左栏没有 <img> —— 预览是 HTML 不是图片');  ok(dual.rEmpty, '未优化时右栏显示占位说明，不是一片空白');
  ok(Math.abs(dual.lH - dual.rH) <= 2,
    '两栏等高（' + dual.lH + ' vs ' + dual.rH + '）—— 同步滚动的前提');
  ok(await page.isVisible('#cvOptGo'), '主操作区有「AI 优化」按钮');
  // 2026-10-12 用户要求：删掉「引擎：自动」与「未开始」两颗胶囊，并把
  // 「AI 优化」挪到「下一步」旁边。状态反馈改由按钮文案承担。
  ok(!(await page.$('#cvOptState')), '「未开始」状态胶囊已移除');
  ok(!(await page.$('#cvOptEngine')), '「引擎：自动」胶囊已移除');
  const barOrder = await page.evaluate(() => {
    const bar = document.querySelector('.cvopt-bar');
    if (!bar) return null;
    const kids = [...bar.children].map((c) => (c.id || c.className || '').trim());
    const go = document.querySelector('#cvOptGo').getBoundingClientRect();
    const next = document.querySelector('#cvOptNext').getBoundingClientRect();
    return { kids, gap: Math.round(next.left - go.right), goLeft: Math.round(go.left), nextRight: Math.round(next.right), barRight: Math.round(bar.getBoundingClientRect().right) };
  });
  ok(barOrder && barOrder.gap >= 0 && barOrder.gap < 120,
    '「AI 优化」紧挨「下一步」（间距 ' + (barOrder ? barOrder.gap : '?') + 'px）');
  ok(barOrder && Math.abs(barOrder.nextRight - barOrder.barRight) < 40,
    '两颗按钮都靠右（「下一步」右缘贴操作条右缘）');
  // 2026-10-09 用户要求：去掉「优化对象」下拉与「目标岗位 JD」输入，
  // 这一页只做通用语句优化。断言反过来锁「确实没有」，防有人又把控件加回来。
  ok(!(await page.$('#cvOptJd')), '「目标岗位 JD」输入框已移除');
  ok(!(await page.$('#cvOptTarget')), '「优化对象」下拉已移除');
  // 简历页预览也必须是 HTML：这条锁的是「模板预览不再走图片合成」
  await to('#cv');
  await page.waitForTimeout(600);
  const cvPrev = await page.evaluate(() => {
    const b = document.querySelector('#cvVisual');
    // 同上：头像是真图片，不该被算进「预览是不是一张大图」这条断言里
    return b ? { cvp: !!b.querySelector('.cvp'), imgs: b.querySelectorAll('img:not(.cvp-photo)').length } : null;
  });
  ok(cvPrev && cvPrev.cvp && cvPrev.imgs === 0, '简历页实时预览也是 HTML（无 <img>）');

  await to('#cvopt');
  await page.waitForSelector('#cvOptGo');

  console.log('\n── B2. 跑一次优化（打桩，' + DELAY + 'ms） ──');
  await page.click('#cvOptGo');
  await page.waitForTimeout(150);
  // 状态胶囊已删（2026-10-12）：运行中的反馈改由按钮承担
  const running = await page.evaluate(() => {
    const b = document.querySelector('#cvOptGo');
    return { txt: (b.textContent || '').trim(), disabled: !!b.disabled };
  });
  ok(/优化中/.test(running.txt) && running.disabled,
    '运行中：按钮显示「优化中…」且禁用（实际「' + running.txt + '」）');
  // 2026-10-09 用户要求删掉日志框：进度改写进 hint 文案
  ok(!(await page.$('#cvOptLog')), '进度日志框已移除');
  ok((await page.textContent('#cvOptHint')).length > 0, '等待提示改由 hint 文案承担');

  await page.waitForFunction(
    () => { const b = document.querySelector('#cvOptGo'); return b && !b.disabled; },
    null, { timeout: 15000 },
  );
  ok(/重新优化/.test((await page.textContent('#cvOptGo')).trim()),
    '跑完：按钮变为「重新优化」');
  ok(postedBody && postedBody.jd === '', '请求体不带 JD（恒为通用优化），实际 ' + JSON.stringify(postedBody.jd));
  ok(postedBody && postedBody.target === 'base', '请求体 target=base（恒优化原版）');
  ok(postedBody && postedBody.engine === 'cli',
    '请求体锁定 engine=cli（不读 data/ai-engine.json，避免被换成 Ollama）');
  ok(!(await page.textContent('#view')).includes('按 JD 定向'), '界面不再提「按 JD 定向」（这一页只做通用优化）');

  console.log('\n── B3. 结果渲染进右栏（HTML，不是纯文本）──');
  const DBG = !!process.env.CVCHK_DEBUG;
  const r = await page.evaluate((dbg) => {
    const R = document.querySelector('#cvOptRight');
    const L = document.querySelector('#cvOptLeft');
    return {
      cvp: !!R.querySelector('.cvp'),
      imgs: R.querySelectorAll('img:not(.cvp-photo)').length,
      txt: (R.textContent || '').replace(/\s+/g, ' '),
      sameTpl: (L.querySelector('.cvp') || {}).className === (R.querySelector('.cvp') || {}).className,
      lSecs: L.querySelectorAll('.cvp-sec').length,
      rSecs: R.querySelectorAll('.cvp-sec').length,
      // 红灯时能直接看出左栏多的是哪个模块（标题在 h3，不是 h2）
      lHeads: dbg ? [...L.querySelectorAll('.cvp-sec h3')].map((x) => x.textContent.trim()) : [],
    };
  }, DBG);
  if (DBG) console.log('  左栏模块:', JSON.stringify(r.lHeads));
  ok(r.cvp, '右栏把改写稿渲染成 HTML 简历（.cvp）');
  ok(r.imgs === 0, '右栏也没有 <img>');
  ok(r.txt.includes('腾讯') && r.txt.includes('校园图书管理系统'), '改写稿正文已渲染进右栏');
  ok(r.sameTpl, '左右用同一套版式（否则没法逐条对照）');
  // 规则要求「不增删内容、保留模块结构」——打桩稿与原简历模块数相同，
  // 这里锁的是「渲染出来的模块数与左栏一致」，不是「=6」这种硬编码。
  ok(r.lSecs === r.rSecs && r.rSecs > 0,
    '左右模块数一致（' + r.lSecs + ' vs ' + r.rSecs + '）—— 结构未被增删');

  // 2026-10-09 用户要求删掉的三块，改成**反向断言**（元素数为 0 + 正文无字样），
  // 不能只把断言删掉 —— 否则以后有人把这块加回来也没人拦。
  const gone = await page.evaluate(() => ({
    summary: document.querySelectorAll('#cvOptSummary').length,
    note: document.querySelectorAll('.cvopt-note').length,
    raw: (document.querySelector('#view').textContent || '').includes('查看 AI 原始输出'),
    judge: (document.querySelector('#view').textContent || '').includes('AI 总评'),
    issues: (document.querySelector('#view').textContent || '').includes('问题清单'),
    doneHint: (document.querySelector('#cvOptHint').textContent || '').trim(),
  }));
  ok(gone.summary === 0, '摘要区 #cvOptSummary 已删除（实际 ' + gone.summary + ' 个）');
  ok(gone.note === 0, '降级提示条 .cvopt-note 已删除（实际 ' + gone.note + ' 个）');
  ok(!gone.raw && !gone.judge && !gone.issues,
    '正文里没有「查看 AI 原始输出 / AI 总评 / 问题清单」这些字样');
  ok(gone.doneHint === '',
    '成功后提示行为空（结果本身就在右栏，不再加一句重复说明），实际「'
      + gone.doneHint.slice(0, 30) + '」');
  // 引擎徽标已按用户要求从操作条删除（2026-10-12）—— 反向锁住，防有人加回来
  ok(!(await page.$('#cvOptEngine')), '引擎徽标已移除（用户要求，不再占操作条）');

  console.log('\n── B4. 两栏滚动同步 ──');
  const sync = await page.evaluate(async () => {
    const L = document.querySelector('#cvOptLeft');
    const R = document.querySelector('#cvOptRight');
    const lCan = L.scrollHeight > L.clientHeight;
    const rCan = R.scrollHeight > R.clientHeight;
    if (!lCan || !rCan) return { skip: true, lCan, rCan };
    L.scrollTop = 120;
    await new Promise((r2) => setTimeout(r2, 350));
    const afterL = { l: L.scrollTop, r: R.scrollTop };
    R.scrollTop = 999999;
    await new Promise((r2) => setTimeout(r2, 400));
    const lm = L.scrollHeight - L.clientHeight, rm = R.scrollHeight - R.clientHeight;
    return {
      skip: false, lCan, rCan, afterL,
      lPct: lm > 0 ? L.scrollTop / lm : -1,
      rPct: rm > 0 ? R.scrollTop / rm : -1,
    };
  });
  if (sync.skip) {
    ok(false, '两栏内容太短，测不到滚动同步（内容不足，lCan=' + sync.lCan + ' rCan=' + sync.rCan + '）');
  } else {
    ok(sync.afterL.r > 0, '滚左栏带动右栏（L=' + sync.afterL.l + ' R=' + sync.afterL.r + '）');
    ok(Math.abs(sync.lPct - sync.rPct) < 0.06,
      '两栏滚动比例一致（L=' + sync.lPct.toFixed(3) + ' R=' + sync.rPct.toFixed(3) + '）');
  }

  console.log('\n── B5. 切页不丢结果 ──');
  // 跳板用 #prep（真实存在的视图）。原来用 #tracker，那个路由撤下后 goto 会
  // 静默落到兜底页 —— 断言照样过，但「切页重建视图」这个前提就没被真正验证到。
  await to('#prep');
  await page.waitForTimeout(500);
  await to('#cvopt');
  await page.waitForSelector('#cvOptGo');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({
    btn: (document.querySelector('#cvOptGo').textContent || '').trim(),
    right: (document.querySelector('#cvOptRight').textContent || '').replace(/\s+/g, ' '),
  }));
  ok(/重新优化/.test(back.btn), '切回来后「已有稿」的状态仍在（按钮=重新优化）');
  ok(back.right.includes('校园图书管理系统'), '切回来后右栏结果仍在');

  console.log('\n── B6. 运行中切走不报错 ──');
  errs.length = 0;
  await page.click('#cvOptGo');          // 重新优化，请求要飞 DELAY 毫秒
  await page.waitForTimeout(100);
  await to('#cv');
  await page.waitForTimeout(DELAY + 1200);   // 等请求在别的页面上落地
  ok(errs.length === 0, '运行中切走没有控制台报错' + (errs.length ? '：' + errs[0] : ''));
  await to('#cvopt');
  await page.waitForSelector('#cvOptGo');
  await page.waitForTimeout(300);
  const afterAway = await page.evaluate(() =>
    (document.querySelector('#cvOptRight').textContent || '').replace(/\s+/g, ' '));
  ok(afterAway.includes('校园图书管理系统'),
    '切回来后结果由会话补上（回调只写会话、不写 DOM）');

  console.log('\n── B6b. 空结果不出现「无结果」，必须给可执行的下一步 ──');
  // 用户要求：不能出现「无结果」这种死胡同状态。
  // 这里让接口返回空输出（模拟 CLI 静默失败/ 登录态过期），验证三件事：
  //   ① 会自动重试；② 状态不是「无结果」；③ 页面明确告诉用户下一步做什么。
  let attempts = 0;
  await page.unroute(/\/api\/cv\/optimize$/);
  await page.route(/\/api\/cv\/optimize$/, async (route) => {
    attempts++;
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        ok: false, mode: 'general', cli: 'CodeBuddy Code', ms: 300, code: 0,
        timeout: false, retried: false, authFailed: true,
        output: '', stderr: 'Authentication required. Please use /login command',
        friendly: '登录态过期',
        parsed: { summary: '', issues: [], draft: '', parseError: '' },
      }),
    });
  });
  errs.length = 0;
  await page.click('#cvOptGo');
  // 状态胶囊已删：等「这一轮跑完」的信号改成**按钮重新可用**
  await page.waitForFunction(
    () => { const b = document.querySelector('#cvOptGo'); return b && !b.disabled; },
    null, { timeout: 40000 },
  );
  await page.waitForTimeout(600);
  const emptyCase = await page.evaluate(() => ({
    btn: (document.querySelector('#cvOptGo').textContent || '').trim(),
    hint: (document.querySelector('#cvOptHint').textContent || '').trim(),
    rightEmpty: !!document.querySelector('#cvOptRight .cvopt-empty'),
    viewText: document.querySelector('#view').textContent || '',
  }));
  console.log('  按钮=' + emptyCase.btn + ' | 提示=' + emptyCase.hint.slice(0, 46));
  ok(attempts >= 2, '拿不到稿时自动重试（实际请求 ' + attempts + ' 次）');
  ok(!/无结果/.test(emptyCase.viewText), '页面上不出现「无结果」字样');
  ok(/登录CodeBuddy/.test(emptyCase.hint),
    '页面给出可执行的下一步（提示重新登录），实际：' + emptyCase.hint.slice(0, 40));
  ok(emptyCase.rightEmpty, '右栏回到占位说明，不是空白或假内容');
  ok(errs.length === 0, '空结果路径没有控制台报错' + (errs.length ? '：' + errs[0] : ''));

  console.log('\n── B7. 这一页只看不改：不写回 cv.md ──');
  // 2026-10-09 职责收窄：优化页只负责左右对照，写回要去「简历工具」的版本卡。
  // 所以这里断言的是**页面上没有写回入口**，且真的没动过文件。
  const noWrite = await page.evaluate(() => ({
    apply: !!document.querySelector('#cvOptApply'),
    copy: !!document.querySelector('#cvOptCopy'),
    mode: !!document.querySelector('#cvOptApplyMode'),
  }));
  ok(!noWrite.apply && !noWrite.copy && !noWrite.mode,
    '页面不提供写回/另存入口（写回走版本卡，职责不重复）');
  ok(snap(CV_MD) === beforeMd, '整轮跑完 cv.md 未被改动（这一页不碰文件）');
  // 基准是 pinnedForm（钉入后那份），不是 beforeForm —— 自检自己刚把文件
  // 换成了钉入内容；这条断言要抓的是「页面在跑的过程中写回了它」。
  ok(snap(CV_FORM) === pinnedForm, 'cv-form.json 也未被改动');

  console.log('\n── B8. 控制台错误 ──');
  ok(errs.length === 0, errs.length ? '出现控制台错误：' + errs[0] : '0 个控制台错误');
} finally {
  await browser.close();

  // ── 现场还原：自检绝不能留下痕迹 ──────────────────────────────────
  if (beforeMd !== null) fs.writeFileSync(CV_MD, beforeMd, 'utf8');
  if (beforeForm !== null) fs.writeFileSync(CV_FORM, beforeForm, 'utf8');
  if (beforeTpl !== null) fs.writeFileSync(CV_TPL, beforeTpl, 'utf8');

  // 删掉本次产生的备份文件。这一步**不能让它把整个自检搞崩**：
  // 本机（以及很多受管控的环境）会给 fs 删除操作加一道保护，
  // 一次性删太多会直接抛错——第一次撞上时，报错发生在 finally 里，
  // 于是「结论」那行永远打不出来，看起来像自检挂了，其实全部通过。
  //
  // 所以删不掉就**重试几次**，仍不行就明确告诉用户去删哪个文件。
  // 这里原来写的是 `renameSync(full, os.tmpdir() + …)` —— 那条兜底在本机**永远失败**：
  // 临时目录在 C: 而项目在 D:，跨盘 rename 直接抛 EXDEV。而 unlink 失败的真实原因
  // 通常是「文件刚写完被瞬时占用」，几十毫秒就自愈，重试才是对症的。
  const leftovers = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^cv\.backup-\d+\.md$/.test(f) && !backupsBefore.has(f));
  const stuck = [];
  let removed = 0;
  for (const f of leftovers) {
    const full = path.join(BACKUP_DIR, f);
    let done = false;
    for (let i = 0; i < 5 && !done; i++) {
      try { fs.unlinkSync(full); done = true; } catch (e) {
        if (e && e.code === 'ENOENT') { done = true; break; }
        await new Promise((r) => { setTimeout(r, 60 * (i + 1)); });
      }
    }
    if (done) removed++; else stuck.push(full);
  }

  if (wrote) {
    console.log('\n  已还原 cv.md 与 cv-form.json，并清理本次产生的 '
      + removed + ' 个备份文件');
  }
  if (stuck.length) {
    console.log('\n  ⚠ 有文件没能清掉（请手工删除）：');
    stuck.forEach((f) => console.log('    ' + f));
  }
}

console.log('\n结论：' + (fail.length ? '未通过（' + fail.length + ' 项）' : '全部通过'));
if (fail.length) { fail.forEach((f) => console.log('  ✗ ' + f)); process.exitCode = 1; }
