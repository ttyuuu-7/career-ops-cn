#!/usr/bin/env node
// ui/check-cv-layout.mjs — 中文简历版式的回归（纯函数级：不启浏览器、不连服务、不写盘）
//
// 覆盖三段：
//   A. payload 层 —— 章节标题中文化、项目要点按行分段
//   B. HTML 层  —— 章节按国内应届惯例重排、注入排版覆盖样式、内容零丢失
//   C. 边界与幂等 —— 空输入 / 无标记 / 重复调用都不破坏文档
//
// 之所以能在进程内测完：cv-zh-layout.mjs 的契约就是「payload 进 → payload 出」
// 与「HTML 进 → HTML 出」，既不依赖服务端也不依赖磁盘上的模板文件。
//
// 用法：node ui/check-cv-layout.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZH_SECTION_TITLES, prepareZhCvPayload, applyZhCvLayout } from './cv-zh-layout.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

// ═══ A. payload 层 ═══════════════════════════════════════════════════
console.log('\n── A. payload 层：标题中文化 + 项目要点分行 ──');

// 中文标题的键必须覆盖 build-cv-html.mjs 的 DEFAULT_SECTION_TITLES ——
// 少一个键，那一节的标题就还是英文，而且不会有任何报错。那张表没有 export，
// 只能从源码里读。上游将来加章节时，这条断言会把缺的键直接点出来。
const builder = fs.readFileSync(path.join(ROOT, 'build-cv-html.mjs'), 'utf8');
const table = builder.match(/const DEFAULT_SECTION_TITLES = \{([\s\S]*?)\n\};/);
ok(table !== null, '能读到 build-cv-html.mjs 的 DEFAULT_SECTION_TITLES');
if (table) {
  const upstream = [...table[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
  const missing = upstream.filter((k) => !(k in ZH_SECTION_TITLES));
  ok(upstream.length >= 8, '上游章节键读全了（' + upstream.length + ' 个）');
  ok(missing.length === 0, '中文标题覆盖上游全部章节键'
    + (missing.length ? '（缺：' + missing.join('、') + '）' : ''));
}

const payload = {
  lang: 'zh-CN',
  projects: [
    { name: '有要点', bullets: ['要点一', '要点二', '要点三'] },
    { name: '自带描述', description: '自己写的一段话', bullets: ['不该被用上'] },
    { name: '无要点' },
    { name: '空要点数组', bullets: [] },
  ],
};
const out = prepareZhCvPayload(payload);
ok(out.projects[0].description === '要点一\n要点二\n要点三',
  '项目要点按行分段（不再被上游 join(\' \') 糊成一段）');
ok(out.projects[1].description === '自己写的一段话', '项目自带 description 时原样放过');
ok(out.projects[2].description === undefined, '既无要点又无描述的项目不加字段');
ok(out.projects[3].description === undefined, '要点数组为空时不生成空 description');
ok(payload.projects[0].description === undefined, '不改入参（返回的是新对象）');
ok(out.sections.summary === '个人简介' && out.sections.education === '教育背景',
  'payload.sections 注入中文标题');
ok(out.lang === 'zh-CN', '其余字段原样带过去');

// ═══ B. HTML 层 ══════════════════════════════════════════════════════
console.log('\n── B. HTML 层：章节重排 + 排版覆盖 + 内容零丢失 ──');

// 最小但结构完整的文档：标记行与 templates/cv-template.zh-minimal.html 同形，
// 每节正文用独特字串，便于验证「正文跟着自己的标题一起搬」。
const mk = (title, body) => `  <!-- ${title} -->\n  <div class="section">${body}</div>\n\n`;
const html = '<!DOCTYPE html>\n<html><head><style>.a{}</style></head>\n<body>\n<div class="page">\n'
  + mk('HEADER', '页眉正文')
  + mk('PROFESSIONAL SUMMARY', '简介正文')
  + mk('CORE COMPETENCIES', '能力正文')
  + mk('WORK EXPERIENCE', '实习正文')
  + mk('PROJECTS', '项目正文')
  + mk('EDUCATION', '教育正文')
  + mk('SKILLS', '技能正文')
  + mk('END', '')
  + '</div>\n</body></html>\n';

const fixed = applyZhCvLayout(html);
const marks = (h) => [...h.matchAll(/<!--\s+([A-Z][A-Z ]*?)\s+-->/g)].map((m) => m[1]);
const order = marks(fixed);

ok(order.join(' → ') === 'HEADER → PROFESSIONAL SUMMARY → CORE COMPETENCIES → EDUCATION'
  + ' → WORK EXPERIENCE → PROJECTS → SKILLS → END',
  '按国内应届惯例重排：教育背景提到实习与项目之前');
ok(order.length === marks(html).length, '分段数量不变（没有段落被丢掉或合并）');
ok(order[0] === 'HEADER', '页眉留在最前');
ok(order[order.length - 1] === 'END', 'END 哨兵留在最后');

const bodies = ['页眉正文', '简介正文', '能力正文', '实习正文', '项目正文', '教育正文', '技能正文'];
ok(bodies.every((b) => fixed.includes(b)), '七节正文一条不少');
ok(/<!--\s+EDUCATION\s+-->[\s\S]*?教育正文[\s\S]*?<!--\s+WORK EXPERIENCE\s+-->/.test(fixed),
  '正文跟着自己的标题一起搬（教育正文没落在原位）');
ok(/<!--\s+EDUCATION\s+-->[\s\S]*?教育正文/.test(fixed), '重排不串位');

ok(fixed.includes('中文简历版式修正'), '注入了排版覆盖样式');
ok(fixed.indexOf('中文简历版式修正') < fixed.indexOf('</style>'), '样式注入在 </style> 之前');
ok(fixed.includes('body .competency-tag'), '样式含核心能力逐条分行的规则');
ok(fixed.includes('pre-line'), '样式含项目要点保留换行的规则');
ok(fixed.startsWith('<!DOCTYPE html>'), '文档头没被动过');
ok(fixed.trimEnd().endsWith('</html>'), '文档尾没被截断');

// 只有一节可动时不重排：置换至少要两个槽位，否则会把自己搬走
const single = applyZhCvLayout('<!DOCTYPE html><html><head><style></style></head><body>\n'
  + mk('EDUCATION', '只有教育') + '</body></html>\n');
ok(single.includes('只有教育') && marks(single).join(',') === 'EDUCATION',
  '只有一个章节时保持原样');

// ═══ C. 边界与幂等 ═══════════════════════════════════════════════════
console.log('\n── C. 边界与幂等 ──');

ok(applyZhCvLayout('') === '', '空串原样返回');
const noMark = '<html><head><style></style></head><body><p>没有分段标记</p></body></html>';
const noMarkOut = applyZhCvLayout(noMark);
ok(noMarkOut.includes('没有分段标记'), '没有分段标记时正文仍在');
ok(noMarkOut.includes('中文简历版式修正'), '没有分段标记时样式照样注入（排版与重排互不牵连）');

const delta = fixed.length - html.length;
ok(delta > 0, '注入的样式确实增加了字节（+' + delta + '）');
ok(applyZhCvLayout(fixed) === fixed, '重复调用完全幂等（不重复注入、不二次重排）');

console.log('');
if (fail.length) {
  console.log('结论：未通过（' + fail.length + ' 项）');
  for (const f of fail) console.log('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('结论：全部通过');
}
