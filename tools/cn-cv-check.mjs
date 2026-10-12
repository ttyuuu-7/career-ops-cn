#!/usr/bin/env node
/**
 * cn-cv-check.mjs — 中文简历规范自检（中国大陆通用：校招 / 社招 / 实习）
 *
 * 为什么需要它：项目自带的 `verify-ats.mjs` 检查的是 Greenhouse / Lever /
 * Workday 那套机器筛选规则（关键词密度、无表格、无图片、字体可解析）。
 * 国内筛选逻辑完全不同——HR 平均 10–20 秒看一份简历，判据是
 * 「一页、教育背景在前、有届次、有量化」这些版式与内容习惯。
 * 用海外的 ATS 分数评价一份中文简历，结论基本没有参考价值。
 *
 * 本脚本只读不写（除非显式加 --write），零 token，不需要 AI。
 *
 * 用法：
 *   node tools/cn-cv-check.mjs                   # 读 cv.md
 *   node tools/cn-cv-check.mjs --form data/cv-form.json
 *   node tools/cn-cv-check.mjs --json            # 机器可读
 *   node tools/cn-cv-check.mjs --write           # 另存 Markdown 报告到 output/
 *   node tools/cn-cv-check.mjs --strict          # 有「必须改」项时退出码 1
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

const JSON_OUT = flag('--json');
const WRITE = flag('--write');
const STRICT = flag('--strict');

// ── 读取简历 ────────────────────────────────────────────────────────────────

const formPath = opt('--form', null);
let cvText = '';
let source = '';

if (formPath) {
  const p = resolve(ROOT, formPath);
  if (!existsSync(p)) fail(`${formPath} 不存在`);
  const form = JSON.parse(readFileSync(p, 'utf-8'));
  cvText = formToText(form);
  source = formPath;
} else {
  const p = join(ROOT, 'cv.md');
  if (!existsSync(p)) fail('cv.md 不存在（可用 --form <data/cv-form.json> 指定）');
  cvText = readFileSync(p, 'utf-8');
  source = 'cv.md';
}

// 把「我的简历」表单的 JSON 摊平成与 cv.md 等价的文本，让下面的检查只有一套逻辑。
// 字段名与章节顺序、标题都必须与 ui/cv-model.mjs 的 cvToMarkdown() 一致 ——
// 这里产出的文本就是这条检查链上「cv.md 的替身」，差一个字，检查的就不是同一份简历。
const ZH_TITLE = {
  summary: '个人简介', competencies: '核心能力', education: '教育背景',
  experience: '实习与工作经历', projects: '项目经历', skills: '专业技能',
  certifications: '证书', awards: '荣誉奖项',
};

function formToText(form) {
  const c = form.candidate || {};
  const L = [];
  L.push('# ' + (c.name || ''));
  L.push([c.email, c.phone, c.wechat || c.location].filter(Boolean).join(' · '));
  if (form.summary) L.push('', '## ' + ZH_TITLE.summary, form.summary);
  if (Array.isArray(form.competencies) && form.competencies.length) {
    L.push('', '## ' + ZH_TITLE.competencies, ...form.competencies.map((x) => '- ' + x));
  }
  // 教育背景排在实习之前：与 cvToMarkdown() 的国内应届顺序一致，
  // 否则拿表单跑自检会永远报「教育背景没有放在前面」，而文件里其实是对的。
  if (Array.isArray(form.education) && form.education.length) {
    L.push('', '## ' + ZH_TITLE.education);
    for (const e of form.education) {
      L.push('', '### ' + (e.title || ''));
      L.push([e.org, e.location, e.year].filter(Boolean).join(' · '));
      if (e.description) L.push(e.description);
    }
  }
  if (Array.isArray(form.experience) && form.experience.length) {
    L.push('', '## ' + ZH_TITLE.experience);
    for (const e of form.experience) {
      L.push('', '### ' + [e.role, e.company].filter(Boolean).join(' — '));
      L.push('', '**' + [e.dates, e.location].filter(Boolean).join(' · ') + '**');
      for (const b of e.bullets || []) L.push('- ' + b);
    }
  }
  if (Array.isArray(form.projects) && form.projects.length) {
    L.push('', '## ' + ZH_TITLE.projects);
    for (const p of form.projects) {
      L.push('', '### ' + (p.name || '') + (p.badge ? '  _[' + p.badge + ']_' : ''));
      if (p.description) L.push(p.description);
      if (p.tech) L.push('**技术栈：** ' + p.tech);
      for (const b of p.bullets || []) L.push('- ' + b);
    }
  }
  if (Array.isArray(form.skills) && form.skills.length) {
    L.push('', '## ' + ZH_TITLE.skills);
    for (const s of form.skills) L.push('- **' + s.category + '：** ' + (s.items || []).join(', '));
  }
  if (Array.isArray(form.certifications) && form.certifications.length) {
    L.push('', '## ' + ZH_TITLE.certifications);
    for (const x of form.certifications) L.push('- ' + [x.title, x.org, x.year].filter(Boolean).join(' — '));
  }
  if (Array.isArray(form.awards) && form.awards.length) {
    L.push('', '## ' + ZH_TITLE.awards);
    for (const x of form.awards) L.push('- ' + [x.title, x.org, x.year].filter(Boolean).join(' — '));
  }
  return L.join('\n');
}

// ── 读取 profile.yml（照片、届次） ──────────────────────────────────────────

let profile = {};
try {
  // 命名导入，不能用 `.default`：本项目装的是 js-yaml 5.x（原生 ESM 构建，
  // 没有 default 导出），取 `.default` 会得到 undefined 并被误判成没装。
  const yamlMod = await import('js-yaml');
  const load = typeof yamlMod.load === 'function' ? yamlMod.load : yamlMod.default?.load;
  const yp = join(ROOT, 'config', 'profile.yml');
  if (load && existsSync(yp)) profile = load(readFileSync(yp, 'utf-8')) || {};
} catch { /* 读不到就跳过依赖它的检查项 */ }

// 简历表单是「我的简历」页的实际数据源，照片/城市以它为准（cv.md 里看不出来）
let cvForm = null;
try {
  const fp = join(ROOT, 'data', 'cv-form.json');
  if (existsSync(fp)) cvForm = JSON.parse(readFileSync(fp, 'utf-8'));
} catch { /* 忽略 */ }

// ── 解析 cv.md 的分段 ───────────────────────────────────────────────────────

/** @returns {{order: string[], bodies: Record<string,string>, head: string}} */
function parseSections(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const order = [];
  const bodies = {};
  let cur = '__head__';
  bodies[cur] = [];
  for (const ln of lines) {
    const m = ln.match(/^##\s+(.+?)\s*$/);
    if (m) { cur = m[1].trim(); order.push(cur); bodies[cur] = []; continue; }
    bodies[cur].push(ln);
  }
  const out = {};
  for (const k of Object.keys(bodies)) out[k] = bodies[k].join('\n').trim();
  return { order, bodies: out };
}

const sec = parseSections(cvText);

// ── 章节查找：按「语义」而不是按字面标题 ────────────────────────────────────
//
// 2026-09-20 起 cv.md 的章节标题改成了中文（个人简介 / 教育背景 / 实习与工作经历…），
// 而这份自检以前写的是精确英文匹配（`body('Education')`）。精确匹配在标题语种一变
// 就静默失效——`body()` 返回空串，于是依赖它的检查（毕业时间、空条目、反虚构）
// **全部走进「没这段」分支，报成 ok**。这类「越改越宽松」的失败最危险：报告全绿，
// 实际什么都没有检查。
//
// 所以这里改成按语义正则匹配，中英文标题都能命中。调用方一律传**规范 key**
// （summary / competencies / education / experience / projects / skills /
// certifications / awards），不再传显示名。
const SEC_MATCH = {
  summary: /summary|简介|概述|总结|自我评价|个人优势|自我介绍/i,
  competencies: /competenc|核心能力|核心技能|个人能力/i,
  education: /education|教育|学历/i,
  experience: /experience|实习|工作经|工作经历|职业经历/i,
  projects: /project|项目/i,
  skills: /skill|技能/i,
  certifications: /certification|certificate|证书|资质/i,
  awards: /award|honou?r|荣誉|奖项|获奖|奖励/i,
};

const body = (key) => {
  const re = SEC_MATCH[key];
  if (!re) return '';
  const hit = sec.order.find((s) => re.test(s));
  return hit ? sec.bodies[hit] : '';
};
const has = (key) => !!body(key);
const findSection = (key) => {
  const re = SEC_MATCH[key];
  return re ? sec.order.find((s) => re.test(s)) : undefined;
};

// ── 检查项 ──────────────────────────────────────────────────────────────────

const findings = [];
const add = (level, id, title, detail, fix) => findings.push({ level, id, title, detail, fix });

// 1. 一页为限 --------------------------------------------------------------
// 估算方式：中文技术简历 10.5pt / A4 大约每页 46 个视觉行、每行 42 个全角字符。
// 只是量级判断，不追求精确——它的用途是回答「是不是明显超了一页」。
function estimateLines(text) {
  let lines = 0;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const ln = raw.trim();
    if (!ln) { lines += 0.35; continue; }
    const width = [...ln].reduce((w, ch) => w + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.55), 0);
    lines += Math.max(1, Math.ceil(width / 42));
    if (/^#{2,3}\s/.test(ln)) lines += 0.6; // 标题前后的间距
  }
  return lines;
}
const estLines = estimateLines(cvText);
const estPages = estLines / 46;
if (estPages > 1.45) {
  add('bad', 'one-page', '篇幅明显超过一页',
    `估算约 ${estPages.toFixed(1)} 页（${Math.round(estLines)} 视觉行 / 每页约 46 行）。`,
    '国内简历一页是硬习惯：删掉与岗位无关的课程、把技能合并成一行、项目只留 3 条最强 bullet。');
} else if (estPages > 1.1) {
  add('warn', 'one-page', '篇幅略超一页',
    `估算约 ${estPages.toFixed(1)} 页，压一压能塞进一页。`,
    '删掉最弱的一条项目 bullet，或把「核心优势」压成 3 条短语。');
} else {
  add('ok', 'one-page', '篇幅在一页以内', `估算约 ${estPages.toFixed(1)} 页。`, '');
}

// 2. 教育背景前置 ----------------------------------------------------------
const eduIdx = sec.order.findIndex((s) => /education|教育/i.test(s));
const workIdx = sec.order.findIndex((s) => /experience|projects|实习|项目|经历/i.test(s));
if (eduIdx >= 0 && workIdx >= 0 && eduIdx > workIdx) {
  add('warn', 'edu-first', '教育背景没有放在前面',
    `当前顺序：${sec.order.join(' → ')}。国内 HR 先看学历和学校，教育背景靠后会增加筛选成本。`,
    '在 config/profile.yml 里用 cv.sections 调整段序（该字段上方有注释说明可用的段名）。');
} else if (eduIdx >= 0 && workIdx >= 0) {
  add('ok', 'edu-first', '教育背景排在经历之前', '', '');
}

// 3. 不贴照片 --------------------------------------------------------------
const photo = String(profile?.candidate?.photo || cvForm?.candidate?.photo || '').trim();
if (photo) {
  add('warn', 'no-photo', '简历里带了照片',
    `当前配置：${photo}。国内技术岗普遍不放照片（校招尤其如此），且可能引入不必要的偏见。`,
    '把 config/profile.yml 的 candidate.photo 置空，并在「我的简历」页去掉照片。');
} else {
  add('ok', 'no-photo', '没有照片', '', '');
}

// 4. 届次 / 毕业时间 --------------------------------------------------------
const gradYear = profile?.location?.graduation_year;
const eduBody = body('education');
const yearMatch = eduBody.match(/(20\d{2})\s*[-–—~至]\s*(20\d{2})/);
const gradFromCv = yearMatch ? yearMatch[2] : null;
if (!gradFromCv && !gradYear) {
  add('bad', 'grad-year', '没有明确的毕业时间 / 届次',
    '国内 JD 常按「届次」（校招）或「工作年限」（社招）卡人，简历上没有毕业时间是筛简历时的常见扣分点。',
    '教育背景里写清楚起止时间（如 2024.09–2028.06），并在 profile.yml 的 location.graduation_year 填届次年份。');
} else if (gradYear && gradFromCv && Math.abs(parseInt(gradFromCv, 10) - Number(gradYear)) > 1) {
  add('warn', 'grad-year', '简历里的毕业年份和配置不一致',
    `简历写着 ${gradFromCv}，config/profile.yml 的 graduation_year 是 ${gradYear}。`
    + '两边不一致会让资格检查按错的届次判断。',
    '改成同一个年份。注意区分入学年份和毕业年份——资格检查看的是毕业年份。');
} else {
  add('ok', 'grad-year', '毕业时间已写明',
    `毕业年份 ${gradFromCv || gradYear}，配置的届次是 ${gradYear || '（未填）'}。`, '');
}

// 5. 联系方式格式 ----------------------------------------------------------
const headLines = sec.bodies.__head__.split('\n').map((s) => s.trim()).filter(Boolean);
const contactLine = headLines.slice(1).join(' ');
const phone = (contactLine.match(/(?:\+?86[-\s]?)?1[3-9]\d{9}/) || [])[0];
const emails = contactLine.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) || [];
if (!phone) {
  add('bad', 'contact', '没有找到大陆手机号',
    '国内网申与面试通知基本走手机短信 / 电话，手机号是必需项。',
    '在姓名下一行写：邮箱 · 手机号 · 城市（或微信）。');
} else {
  add('ok', 'contact', '联系方式齐全',
    `手机 ${phone.slice(0, 3)}****${phone.slice(-2)}，邮箱 ${emails[0] || '缺失'}。`, '');
}
if (!emails.length) {
  add('bad', 'contact-email', '没有找到邮箱', '网申与 offer 邮件都走邮箱。', '补一个常用邮箱。');
} else if (/^1[3-9]\d{9}$/.test(emails[0].split('@')[0])) {
  add('warn', 'contact-email', '邮箱名是手机号',
    `当前 ${emails[0]}。手机号当邮箱名不算错，但在正式求职里显得随意。`,
    '换成「姓名拼音 + 数字」的邮箱（如 guanyu2027@163.com），或直接用 QQ 邮箱。');
}

// 城市：profile.yml 与简历页眉两处都要看，任一处不对都会出现在简历上
const CN_CITY = /承德|西安|北京|上海|深圳|杭州|成都|武汉|南京|广州|天津|重庆|苏州|合肥|长沙|郑州|济南|青岛|大连|福州|厦门|宁波|昆明|贵阳|南昌|哈尔滨|长春|沈阳|石家庄|太原|兰州|乌鲁木齐|呼和浩特|南宁|海口|银川|西宁|拉萨/;
const locRaw = String(profile?.candidate?.location || cvForm?.candidate?.location || '').trim();
if (locRaw && !CN_CITY.test(locRaw)) {
  add('warn', 'contact-city', '配置里的「城市」不是城市名',
    `config/profile.yml 的 candidate.location = "${locRaw}"。这个字段会印在简历页眉上。`,
    '改成实际所在城市（如「承德」或「西安」）。');
}
if (!CN_CITY.test(contactLine)) {
  add('warn', 'contact-city-line', '简历页眉没有城市',
    '国内 HR 会按城市判断到岗与通勤，页眉缺城市常被追问。',
    '页眉补上城市：邮箱 · 手机 · 城市。');
}

// 6. 量化成果 --------------------------------------------------------------
const itemLines = cvText.split('\n').filter((l) => /^\s*[-*]\s+/.test(l));
const metricLines = itemLines.filter((l) => /\d/.test(l));
const metricRatio = itemLines.length ? metricLines.length / itemLines.length : 0;
if (itemLines.length < 4) {
  add('warn', 'metrics', '简历要点太少',
    `只找到 ${itemLines.length} 条要点。简历的说服力全靠项目细节，要点太少看不出动手能力。`,
    '每个项目写 3 条 bullet：做了什么、用了什么技术、带来什么结果。');
} else if (metricRatio < 0.5) {
  add('warn', 'metrics', '量化成果偏少',
    `${itemLines.length} 条要点里只有 ${metricLines.length} 条含数字（${Math.round(metricRatio * 100)}%）。`,
    '把「提升了性能」改成「接口响应从 800ms 降到 120ms」这类带数字的说法，数字必须真实。');
} else {
  add('ok', 'metrics', '量化成果充足',
    `${itemLines.length} 条要点中 ${metricLines.length} 条含数字（${Math.round(metricRatio * 100)}%）。`, '');
}

// 7. 英文模板残留 / 翻译腔 ---------------------------------------------------
const EN_LEFTOVERS = [
  [/\bObjective\b/i, 'Objective', '简历不要写「Objective / 求职目标」，国内直接用一句个人简介或干脆不写'],
  [/References available upon request/i, 'References available upon request', '删掉，国内简历不写这句'],
  [/\bResponsible for\b/i, 'Responsible for', '「Responsible for」是典型翻译腔，改成「负责 / 独立完成」'],
  [/\bI am\b|\bI have\b|\bMy\b/i, '第一人称英文句式', '中文简历不用第一人称，直接写动词开头的事实'],
  [/\bCurriculum Vitae\b|\bResume\b/i, 'Resume / Curriculum Vitae 字样', '页眉不需要写「简历」两个字'],
];
for (const [re, hit, fix] of EN_LEFTOVERS) {
  if (re.test(cvText)) add('warn', 'en-leftover', '有英文模板残留', `检测到「${hit}」。`, fix);
}
if (!EN_LEFTOVERS.some(([re]) => re.test(cvText))) {
  add('ok', 'en-leftover', '没有英文模板残留', '', '');
}

// 8. 核心优势被切碎 / 与个人简介重复（真实踩过的坑） -------------------------
const comp = body('competencies');
if (comp) {
  const items = comp.split('\n').filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean);
  // 判据：条目里出现以标点结尾的碎片，或两条能拼成一句
  const frags = items.filter((x) => /[。；，]$/.test(x));
  const joined = items.join('');
  const summary = body('summary').replace(/\s+/g, '');
  const duplicated = summary.length > 40 && joined.length > 40
    && (summary.includes(items[0] || '\u0000') || joined.includes(summary.slice(0, 20)));
  if (frags.length >= 2 || duplicated) {
    add('bad', 'competencies-fragments', '「核心优势」是碎句或与个人简介重复',
      `该段有 ${items.length} 条，其中 ${frags.length} 条以标点结尾${duplicated ? '，且与 Summary 内容重复' : ''}。`
      + '典型的成因是编辑时把一段话按行拆进了多条——它会同时拖长篇幅，也会挡住 PDF 导出。',
      '「核心优势」应当是 3 条各 8–16 字的短语（如「Spring Boot 后端开发」「MySQL 调优」），'
      + '不是句子。整句陈述放进「个人简介」。');
  }
}

// 9. 空条目 ----------------------------------------------------------------
const emptyEntries = [];
for (const name of ['certifications', 'awards']) {
  const b = body(name);
  if (!b) continue;
  for (const ln of b.split('\n')) {
    if (/^\s*[-*]\s*$/.test(ln)) emptyEntries.push(name);
    else if (/^\s*[-*]\s+[—\-–\s|·]*$/.test(ln)) emptyEntries.push(name);
  }
}
if (emptyEntries.length) {
  add('bad', 'empty-entry', '有空的条目',
    `${[...new Set(emptyEntries)].join(' / ')} 段里有 ${emptyEntries.length} 条空行。空条目会让整段看起来没写完。`,
    '删掉空条目；整段没有内容就把这一整段删掉（无证书不写「证书」段是正常的）。');
} else {
  add('ok', 'empty-entry', '没有空条目', '', '');
}

// 10. 无无法证实的经历（沿用项目反虚构规则） --------------------------------
const expBody = body('experience');
if (expBody) {
  const suspicious = /员工|正式员工|全职/.test(expBody) && /20\d{2}[-–—.]/.test(expBody);
  // 「还是在校生」以简历上的毕业年份为准，其次才用配置——配置没填时
  // 不能默认成「已毕业」，否则最该拦的那一条会被静默放过。
  const gradNum = Number(gradFromCv || gradYear || 0);
  const isStudentNow = gradNum > 0 && gradNum >= new Date().getFullYear();
  if (isStudentNow && suspicious) {
    add('bad', 'no-fabrication', '「工作经历」里写着「员工」，但你还是在校生',
      '在校期间的经历必须如实写成「实习」或「兼职」。写「员工」而在读，背景调查很容易被判定为不实。'
      + '（项目自带的防虚构规则不因本地化而放宽。）',
      '改成「后端开发实习生」；若这段经历并不真实存在，直接删掉整段——应届生的项目经历本身足够撑简历。');
  } else if (isStudentNow && expBody && !/实习|兼职|intern/i.test(expBody)) {
    add('warn', 'no-fabrication', '工作经历没有标明是实习',
      '应届生填「工作经历」时，HR 会默认这是全职。',
      '岗位名写「XX 实习生」，或在公司名后标注「（实习）」。');
  } else {
    add('ok', 'no-fabrication', '经历标注与实际身份相符', '', '');
  }
}

// 11. 不写期望薪资 ---------------------------------------------------------
if (/期望薪资|薪资要求|薪资期望|月薪要求/.test(cvText)) {
  add('warn', 'no-salary', '简历里写了期望薪资',
    '校招岗位按城市 + 学历 + 岗位序列统一定级，简历写薪资通常只会提前被压价（社招的薪资在谈薪环节单独谈）。',
    '删掉薪资要求，等 HR 面再谈。');
} else {
  add('ok', 'no-salary', '没有写期望薪资', '', '');
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

const LEVEL_META = { bad: { w: 12, tag: '必须改', ord: 0 }, warn: { w: 5, tag: '建议改', ord: 1 }, ok: { w: 0, tag: '通过', ord: 2 } };
const issues = findings.filter((f) => f.level !== 'ok');
const penalty = issues.reduce((a, f) => a + LEVEL_META[f.level].w, 0);
const score = Math.max(0, 100 - penalty);

const verdict = score >= 90 ? '可以直接投递'
  : score >= 75 ? '小改后可投'
  : score >= 60 ? '需要修一轮'
  : '先补齐再投';

const result = {
  ok: true,
  source,
  score,
  verdict,
  estimatedPages: Number(estPages.toFixed(2)),
  counts: {
    bad: findings.filter((f) => f.level === 'bad').length,
    warn: findings.filter((f) => f.level === 'warn').length,
    ok: findings.filter((f) => f.level === 'ok').length,
  },
  findings: findings.sort((a, b) => LEVEL_META[a.level].ord - LEVEL_META[b.level].ord),
};

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  const L = [];
  L.push('');
  L.push('中文简历规范自检（中国大陆通用）');
  L.push('来源：' + source + '　估算篇幅：约 ' + estPages.toFixed(1) + ' 页');
  L.push('='.repeat(60));
  L.push('');
  for (const f of result.findings) {
    const mark = f.level === 'ok' ? '✅' : f.level === 'warn' ? '⚠️ ' : '❌';
    L.push(`${mark} [${LEVEL_META[f.level].tag}] ${f.title}`);
    if (f.detail) L.push('    ' + f.detail);
    if (f.fix) L.push('    → ' + f.fix);
    L.push('');
  }
  L.push('='.repeat(60));
  L.push(`评分 ${score}/100 —— ${verdict}　（必须改 ${result.counts.bad} 项 / 建议改 ${result.counts.warn} 项 / 通过 ${result.counts.ok} 项）`);
  L.push('');
  L.push('说明：这是版式与内容习惯的检查，不是 ATS 兼容检测。');
  L.push('      海外 ATS 那套规则（关键词密度、无表格）在国内投递里基本用不上，');
  L.push('      需要时另外跑 verify-ats.mjs。');
  L.push('');
  process.stdout.write(L.join('\n'));
}

if (WRITE) {
  const dir = join(ROOT, 'output');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const md = ['# 中文简历规范自检报告', '', `- 来源：\`${source}\``,
    `- 估算篇幅：约 ${estPages.toFixed(1)} 页`, `- 评分：**${score}/100** —— ${verdict}`, '',
    '## 逐项结果', '',
    ...result.findings.map((f) => `### ${f.level === 'ok' ? '✅' : f.level === 'warn' ? '⚠️' : '❌'} ${f.title}\n\n`
      + (f.detail ? f.detail + '\n\n' : '') + (f.fix ? `**怎么改：** ${f.fix}\n` : '')),
  ].join('\n');
  const out = join(dir, '中文简历自检.md');
  writeFileSync(out, md, 'utf-8');
  if (!JSON_OUT) process.stdout.write('报告已写入 output/中文简历自检.md\n');
}

if (STRICT && result.counts.bad > 0) process.exitCode = 1;

function fail(msg) { process.stderr.write('[cn-cv-check] ' + msg + '\n'); process.exit(2); }
