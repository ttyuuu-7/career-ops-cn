// 中文简历版式修正 —— 只作用于「我的简历」页导出的 PDF。
//
// ── 为什么不直接改 templates/cv-template.zh-minimal.html ────────────────────
//
// templates/ 在 update-system.mjs 的 SYSTEM_PATHS 清单里（见该文件第 370 行），
// `node update-system.mjs` 会用上游版本覆盖它 —— 写在那里的中文排版规则活不过
// 一次更新。ui/ 不在那份清单里，所以中文版式的落点放这边。
//
// 同理，build-cv-html.mjs / cv-templates.mjs / generate-pdf.mjs 也在清单里，
// 所以这里不 import 它们的内部函数，只对它们产出的 payload / HTML 做后处理。
// 一旦哪天上游换了模板结构，本模块的 "标记找不到" 分支会保持原文不动作，
// 结果是「回到英文模板的样子」，而不会把简历改坏。
//
// ── 修正的四件事（模板默认行为在国内场景下暴露出来的问题） ──────────────────
//
//   1. 章节标题是英文（Professional Summary / Core Competencies / …），正文却是
//      中文。build-cv-html.mjs 的 DEFAULT_SECTION_TITLES 写死英文，但它第 630 行
//      会把 payload.sections 合并进去，所以标题走 payload 注入即可。
//
//   2. 章节顺序是模板写死的：summary → competencies → experience → projects →
//      education → certifications → awards → skills。教育背景排在项目和证书后面，
//      那是海外社招模板的习惯；国内应届简历里学校该往前站。
//      （config/profile.yml 的 cv.sections 只管 generate-pdf.mjs 那条 CLI 路径，
//       网页导出不经过它，所以顺序得在这里处理。）
//
//   3. 模板把 .competency-tag 设成 inline 并用「·」连接 —— 它假设核心能力是
//      「Python」「SQL」这样的短标签。但国内简历的写法常是
//      「后端开发：Java / Spring Boot / MyBatis，独立完成过……」这样的整句，
//      连排之后糊成一段密文，读不出条目边界。
//
//   4. build-cv-html.mjs 的 buildProjects()（第 404-405 行）把 bullets 用
//      `.join(' ')` 拼成一段文字塞进 .project-desc，三条项目战果粘成一行，
//      中间只有空格。这里在 payload 层改成换行连接，再靠 CSS 的
//      white-space: pre-line 恢复逐行 —— 不碰上游那个 join。

// 章节标题的唯一权威在 cv-model.mjs：cv.md、编辑页预览、这份 PDF 后处理共用
// 同一份 CV_SECTION_TITLES_ZH。以前这里自己抄了一份，结果是「改了 PDF 标题、
// cv.md 还是英文」—— 同一份简历在两处显示不一样。
import { CV_SECTION_TITLES_ZH } from './cv-model.mjs';

// payload.sections 覆盖 build-cv-html.mjs 的 DEFAULT_SECTION_TITLES。
// 键名必须与那份表一致，否则该键被无视、标题还是英文。
//
// 标题本体不在这里定义 —— 唯一权威是 ui/cv-model.mjs 的 CV_SECTION_TITLES_ZH
// （cv.md、编辑页预览、PDF 三处共用那一份）。这里只补 cv-model 没有的
// `interests`：结构化简历模型里没有「个人兴趣」这一节，但上游模板有，
// 一旦 payload 里带了这个键、这里却没有中文名，它就会以英文标题露出来。
export const ZH_SECTION_TITLES = {
  ...CV_SECTION_TITLES_ZH,
  interests: '个人兴趣',
};

// 目标顺序：国内应届简历惯例 —— 先亮学校和专业，再按时间倒序排实习、项目，
// 最后是技能与荣誉。上游模板把 education 排在 projects 之后、skills 收到最末，
// 那是海外社招模板的习惯。
//
// ⚠️ 这份顺序必须和 ui/cv-model.mjs 的 cvToMarkdown() 保持一致 ——
// 那边生成 cv.md（AI 读的数据源），这边重排 PDF（HR 看的成品）。
// 两边错位会让「AI 评估的那份」和「HR 看到的那份」不是同一份简历。
//
// 只列 key，不列 HTML 标记名：标记名到 key 的映射见 MARKER_KEY。
const ZH_SECTION_ORDER = [
  'summary',
  'competencies',
  'education',
  'experience',
  'projects',
  'skills',
  'certifications',
  'awards',
  'interests',
];

// 模板用全大写注释切段：`<!-- WORK EXPERIENCE -->`。
// 未列出的标记（HEADER / END，以及将来上游新增的段）不参与重排，
// 留在原槽位 —— 这样上游加一个新 section 时，它落在上游放的位置，
// 不会因为这份名单没跟上而被挤到末尾。
const MARKER_KEY = {
  'PROFESSIONAL SUMMARY': 'summary',
  'CORE COMPETENCIES': 'competencies',
  'WORK EXPERIENCE': 'experience',
  'PROJECTS': 'projects',
  'EDUCATION': 'education',
  'CERTIFICATIONS': 'certifications',
  'AWARDS': 'awards',
  'INTERESTS': 'interests',
  'SKILLS': 'skills',
};

// 行首（允许缩进）+ 独占一行的全大写标记。锚在行首是必要的：模板 <head> 里那个
// `<!-- career-ops-template` 说明块是多行小写注释，不该被当成分段标记。
const MARKER_RE = /^[ \t]*<!--\s+([A-Z][A-Z ]*?)\s+-->[ \t]*\r?\n/gm;

// 注入到 </style> 前。选择器统一带 body 前缀，压过模板里同名的中文覆盖段
// （模板用的是 `.competency-tag` 这类单类选择器，特异性 0-1-0）。
const ZH_LAYOUT_MARK = '中文简历版式修正（由 ui/cv-zh-layout.mjs 注入';

const ZH_LAYOUT_CSS = `
  /* ── ${ZH_LAYOUT_MARK}；别改 templates/） ── */

  /* 核心能力：逐条一行 + 悬挂缩进 + 圆点，替代模板的 inline 连排。 */
  body .competencies-grid {
    line-height: 1.62;
  }
  body .competency-tag {
    display: block;
    padding-left: 1.1em;
    text-indent: -1.1em;
    margin-bottom: 2.5px;
  }
  body .competency-tag::before {
    content: '•  ';
    color: #98a2b3;
  }
  body .competency-tag:not(:last-child)::after {
    content: none;
  }

  /* 项目要点：换行符来自 payload.description（见 prepareZhCvPayload），
     pre-line 让它在折行的同时仍然折叠多余空格。 */
  body .project-desc {
    margin-top: 2px;
    white-space: pre-line;
  }

  /* 技术栈／仓库链接另起一行，和正文拉开，避免粘成一段。 */
  body .project-tech {
    margin-top: 5px;
  }

  /* 实习：模板把岗位名和城市各放一个块级 div，两行只装两个短词，显散。
     改成同一行「实习生 · 杭州」，城市缺失时照旧只显示岗位名。 */
  body .job-role {
    display: inline;
    margin-bottom: 0;
  }
  body .job-location {
    display: inline;
  }
  body .job-location::before {
    content: '·';
    margin-right: 0.45em;
    color: #98a2b3;
  }

  /* 区块之间稍微透口气：内容少的简历挤在一起更显乱。 */
  body .section {
    margin-bottom: 19px;
  }
`;

/**
 * 把结构化简历 payload 调整成中文简历版本。
 * 返回新对象，不改入参（调用方可能还要拿原 payload 做别的）。
 */
export function prepareZhCvPayload(payload) {
  const out = { ...payload };
  out.sections = { ...ZH_SECTION_TITLES, ...(payload.sections || {}) };

  // 项目要点分行。已有 description 的项目原样放过 —— 那是简历里用户自己写的
  // 一段话，不该被 bullets 顶掉。字段复用 description 是有意的：上游 buildProjects()
  // 就是 `e.description || bullets.join(' ')`，塞进 description 才能绕开那个 join。
  if (Array.isArray(out.projects)) {
    out.projects = out.projects.map((p) => {
      if (p.description) return p;
      if (!Array.isArray(p.bullets) || !p.bullets.length) return p;
      return { ...p, description: p.bullets.join('\n') };
    });
  }

  return out;
}

/** 把 HTML 里的分段标记拆成 [{name, key, start, end, text}]，按出现顺序。 */
function splitMarkers(html) {
  const marks = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(html)) !== null) {
    marks.push({ name: m[1], start: m.index, head: m[0] });
  }
  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : html.length;
    return { ...mark, end, text: html.slice(mark.start, end) };
  });
}

/**
 * 按中文简历的顺序重排章节，并注入中文排版覆盖样式。
 *
 * 重排只在「已知章节」之间做置换，各章节仍占据原来的槽位 —— 与上游
 * generate-pdf.mjs 里 applySectionOrder 的策略一致（那里注释写的是
 * "the named sections are permuted among the slots they already occupy"）。
 * 少一个章节（空区块已被 build-cv-html.mjs 剥掉）就少一个槽位，顺序表里
 * 多出来的名字直接跳过，不影响其余章节。
 *
 * 找不到任何标记时原样返回：宁可退回英文模板的样子，也不能把简历改坏。
 */
export function applyZhCvLayout(html) {
  // 样式只注入一次。重复注入不改变渲染结果，但会让 HTML 越滚越大，
  // 也让「输出长度差 == CSS 长度」这种断言失效 —— 幂等是这里最省事的做法。
  const styled = html.includes(ZH_LAYOUT_MARK)
    ? html
    : html.replace('</style>', ZH_LAYOUT_CSS + '</style>');
  const marks = splitMarkers(styled);
  if (!marks.length) return styled;

  // 参与重排的段落槽位（按出现顺序），以及每个槽位原本装着哪一节。
  const slots = marks
    .map((mark, i) => ({ mark, i }))
    .filter(({ mark }) => MARKER_KEY[mark.name]);

  if (slots.length < 2) return styled;

  const ranked = slots
    .map(({ mark, i }) => ({ i, key: MARKER_KEY[mark.name] }))
    .sort((a, b) => {
      const ia = ZH_SECTION_ORDER.indexOf(a.key);
      const ib = ZH_SECTION_ORDER.indexOf(b.key);
      // 顺序表里没写的 key 排到最后（按原相对位置），避免被误判成 index -1 而顶到最前。
      return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    });

  // 目标顺序的正文按序填回原有槽位。
  const bySlot = new Map();
  slots.forEach(({ i }, n) => bySlot.set(i, ranked[n].i));

  const pieces = marks.map((mark, i) => {
    const source = bySlot.has(i) ? bySlot.get(i) : i;
    return marks[source].text;
  });

  // marks[0].start 之前的内容（<!DOCTYPE>、<head>、<div class="page"> 开标签）原样保留。
  return styled.slice(0, marks[0].start) + pieces.join('');
}
