// ui/cv-word.mjs — 简历的 Word(.docx) 导入 与 Word(.doc) 导出（零依赖）
//
//   简历 .docx ──► 段落（含标题层级/列表标记）──► 伪 cv.md ──► markdownToCv ──► 表单
//   表单(form) ──► 带 Office 命名空间的 HTML ──► .doc 下载（Word/WPS 双击可开）
//
// 为什么导入走「拼 markdown 再喂 markdownToCv」而不是直接解析成表单：
//   markdownToCv 里有整套实战过的解析规则（章节别名、联系方式识别、占位符
//   过滤、looseBlocks 降级分块）。docx 里拿到的只是纯文字行，拼成 markdown
//   就能全部复用，自己重写一遍必然漏掉其中若干个坑。
//
// 为什么导出用 .doc（HTML 伪格式）而不是严格 OOXML 的 .docx：
//   浏览器端生成合法 OOXML 需要手写 zip 压缩器 + 一整套 content types，
//   而 Word 对格式细节挑剔，出错了用户拿到的是打不开的文件。HTML 包法的
//   兼容性久经考验（Word / WPS 双击直接打开、能编辑能另存），零依赖即可
//   实现 —— 「能可靠打开的 .doc」好过「可能打不开的 .docx」。
//
// ⚠️ 本模块被 app.js import（浏览器侧），**必须保持零依赖**：
//    只能 import 同为零依赖的 doc-import.mjs（unzip/decodeXml）与
//    cv-model.mjs（markdownToCv/normalizeCv），绝不能碰 node:* 或根目录
//    任何需要 fs/js-yaml 的文件，否则浏览器整条模块图失败、页面全白。

import { unzip, decodeXml } from './doc-import.mjs';
import { markdownToCv, normalizeCv, CV_SECTION_TITLES_ZH, cvLiveItems } from './cv-model.mjs';
// 转出去给 app.js 的「导出 Markdown」用：导的必须是**当前草稿**的文本，
// 不是磁盘上那份（用户可能改了一半还没保存）。
export { cvToMarkdown } from './cv-model.mjs';
// 章节顺序与显隐（分区导航）。零依赖，浏览器与 Node 两侧都能 import。
import { visibleCvSections, cvNavLabel } from './cv-nav.mjs';
// 外观设置 → Word 用的 CSS（字号、行高、字体、页边距）。零依赖。
import { cvLookWordCss } from './cv-look.mjs';
// 基本信息字段行的顺序与显隐（2026-10-09）。零依赖。
// 与预览读同一份：字段在预览里被眼睛关掉、或被拖到别的顺序，
// 导出的 Word 必须一模一样 —— 两处各排一遍顺序必然对不上。
import { cvHeaderValues, cvHeaderRole, isCvFieldHidden, isCvPhotoHidden } from './cv-fields.mjs';

/** <input accept> —— 只认新格式；.doc 旧二进制格式解析不了（见 doc-import 同款边界）。 */
export const WORD_ACCEPT = '.docx';

/** 单个文件上限，与 doc-import 的 MAX_FILE_BYTES 口径一致。 */
export const WORD_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 简历 Markdown → 表单结构（浏览器侧薄导出，2026-10-09）。
 *
 * 「简历全局优化」页的右栏要把 AI 改写稿渲染成 HTML：优化稿是 Markdown，
 * 要走和左栏**同一个** renderCvVisual 才能保证两栏版式完全一致（否则左右
 * 长得不一样，没法逐条对照）。markdownToCv 住在 cv-model.mjs（服务端也在用），
 * 这个重导出让 app.js 不用直接依赖 cv-model —— 少一条模块边就少一处分叉。
 */
export { markdownToCv };

// ── .docx → 段落 ─────────────────────────────────────────────────────────

const utf8Dec = new TextDecoder('utf-8');

/** 段落内取纯文字：<w:t> 连接，<w:tab>/<w:br> 折成空格。 */
function paraText(inner) {
  let s = '';
  const re = /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(inner))) {
    if (m[1] !== undefined) s += decodeXml(m[1]);
    else s += ' ';                       // tab / br 都当空格，行内不换行
  }
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * .docx → 段落数组 [{ text, level, list }]。
 *  - level：大纲级别 1–6（w:outlineLvl 优先，pStyle 的 Heading/标题/Titre/纯数字其次）；
 *    0 = 普通段落。
 *  - list：带编号/项目符号（w:numPr 且 numId 非 0）。
 * 全局扫 <w:p>，表格单元格里的段落天然按文档顺序混入 —— 简历套表格排版也不丢内容。
 */
export async function docxParagraphs(bytes) {
  const zip = await unzip(bytes);
  const main = await zip.read('word/document.xml');
  if (!main) {
    throw Object.assign(new Error('这个 .docx 里没有正文（可能是损坏的文件，或只是个模板）'), { code: 'NO_BODY' });
  }
  const xml = utf8Dec.decode(main);
  const bodyStart = xml.indexOf('<w:body');
  const body = bodyStart >= 0 ? xml.slice(bodyStart) : xml;

  const re = /<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
  const paras = [];
  let m;
  while ((m = re.exec(body))) {
    const inner = m[1] || '';
    const text = paraText(inner);
    if (!text) continue;

    let level = 0;
    const ol = inner.match(/<w:outlineLvl\s+w:val="(\d+)"/);
    const ps = inner.match(/<w:pStyle\s+w:val="([^"]+)"/);
    if (ol) {
      level = Math.min(6, Number(ol[1]) + 1);
    } else if (ps) {
      const pm = ps[1].match(/(?:heading|titre|标题)[\s_-]*(\d+)/i) || ps[1].match(/^([1-6])$/);
      if (pm) level = Number(pm[1]);
    }
    const list = /<w:numPr>/.test(inner) && !/<w:numId\s+w:val="0"\s*\/>/.test(inner);
    paras.push({ text, level, list });
  }
  return paras;
}

// ── 段落 → 伪 cv.md ──────────────────────────────────────────────────────

// 章节名识别：**全匹配**（含可选冒号），不做 includes —— 正文里一句
// 「负责项目管理工作」不能被切成新章节。顺序即匹配顺序。
const SECTION_MATCHERS = [
  ['summary', /^(个人简介|个人总结|简介|自我评价|关于我|summary|profile)[：:。]?$/i],
  ['competencies', /^(核心能力|个人能力|技能特长|专业能力|competencies|competence)[：:。]?$/i],
  ['education', /^(教育背景|教育经历|教育|学历|education)[：:。]?$/i],
  ['experience', /^(实习与工作经历|实习经历|工作经历|工作经验|实践经历|实习|工作|experience|employment|work experience)[：:。]?$/i],
  ['projects', /^(项目经历|项目经验|项目实践|项目|projects?)[：:。]?$/i],
  ['skills', /^(专业技能|技能证书|技能|技术栈|it技能|skills)[：:。]?$/i],
  ['certifications', /^(证书与资质|证书资质|证书|资质证书|资格证|资格证书|certifications?)[：:。]?$/i],
  ['awards', /^(荣誉奖项|荣誉|奖项|获奖情况|获奖|荣誉与奖项|awards?|honou?rs)[：:。]?$/i],
];

function matchSection(t) {
  if (!t || t.length > 16) return null;
  for (const [key, re] of SECTION_MATCHERS) if (re.test(t)) return key;
  return null;
}

/**
 * 段落 → 伪 cv.md 文本。
 * 规则（按优先级）：
 *   1. 文字命中章节别名（无论有没有标题样式）→ `## 标准中文标题`
 *   2. 第一个非空段落 → 姓名 `# 姓名`
 *   3. 其余标题样式段落 → 条目 `### 文字`
 *   4. 列表段落 → `- 文字`
 *   5. 其余普通段落 → 原样透传（markdownToCv 的 looseBlocks 会兜底分块，
 *      时间行/标签行自动归到上一条，一个字都不会丢）
 */
export function paragraphsToCvMarkdown(paras) {
  const out = [];
  const warnings = [];
  const T = CV_SECTION_TITLES_ZH;
  let nameDone = false;
  let section = null;
  let anySection = false;
  let headingCount = 0;

  for (const p of paras || []) {
    const t = String(p && p.text || '').trim();
    if (!t) continue;
    const isHead = (p.level || 0) > 0;
    if (isHead) headingCount += 1;

    const secKey = matchSection(t);
    if (secKey) {
      out.push('', '## ' + (T[secKey] || t), '');
      section = secKey;
      anySection = true;
      continue;
    }
    if (!nameDone) {
      // 第一个非空段落当姓名 —— 真简历的第一行几乎总是姓名/「XX的简历」。
      // 「个人简历」「求职意向：xx」这类标题行不是姓名，跳过等下一段。
      const nm = t.match(/^([\u4e00-\u9fa5]{2,4})的?简历$/);
      if (nm && !/^(个人|我的)$/.test(nm[1])) {
        out.push('# ' + nm[1], ''); nameDone = true; continue;
      }
      if (/^(个人|我的)?简历$/.test(t)) continue;
      if (/^(求职意向|意向岗位|目标岗位|应聘岗位)[：:]/.test(t)) continue;
      out.push('# ' + t, '');
      nameDone = true;
      continue;
    }
    if (isHead) {
      out.push('### ' + t, '');
      continue;
    }
    if (p.list) {
      out.push('- ' + t);
      continue;
    }
    // 普通段落：姓名与第一个章节之间的行当联系方式区（markdownToCv 只吃 4 行，
    // 超出的行拼进去也会被忽略 —— 这里照常拼，由解析层决定去留）。
    if (!section) out.push(t);
    else out.push(t);
  }

  if (!paras || !paras.some((p) => String(p && p.text || '').trim())) {
    warnings.push('文档里没读到文字（内容可能在图片或文本框里）。');
  } else if (!anySection) {
    warnings.push('没认出章节名（如「教育背景」「项目经历」），内容没有按章节拆开 —— '
      + '在 Word 里给章节标题套用「标题 1」样式，或把章节名单独成行，识别率会高很多。');
  }
  if (headingCount === 0 && paras && paras.length) {
    warnings.push('文档没有使用标题样式：条目按「顶格行 = 条目名」猜测切分，导完请核对一遍。');
  }
  return { markdown: out.join('\n'), warnings };
}

// ── .docx → 表单 ─────────────────────────────────────────────────────────

/**
 * .docx 字节 → { form, warnings }。form 可直接喂给编辑页表单 / POST /api/cv。
 * 解析不出任何实义内容时 warnings 首条会给出人话原因。
 */
export async function docxToCvForm(bytes) {
  const paras = await docxParagraphs(bytes);
  const { markdown, warnings } = paragraphsToCvMarkdown(paras);
  const cv = normalizeCv(markdownToCv(markdown));
  const hasContent = String(cv.candidate.name || '').trim()
    || cv.education.length || cv.experience.length || cv.projects.length
    || cv.skills.length || cv.certifications.length || cv.awards.length
    || String(cv.summary || '').trim();
  if (!hasContent) {
    warnings.unshift('没从文档里解析出简历内容 —— 请确认选的是简历 .docx（旧版 .doc / PDF / 图片都不支持）。');
  }
  return { form: cv, warnings };
}

// ── 表单 → Word(.doc) 导出 ───────────────────────────────────────────────

const W_ESC = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const WORD_STYLE = `
body { font-family: '微软雅黑','Microsoft YaHei',sans-serif; font-size: 10.5pt; color: #26292c; line-height: 1.55; }
h1 { font-size: 19pt; text-align: center; margin: 0 0 2pt; }
p.role, p.contact { text-align: center; color: #565b60; margin: 2pt 0; font-size: 10pt; }
h2 { font-size: 12.5pt; color: #233043; border-bottom: 1.2pt solid #2f6b52; margin: 13pt 0 5pt; padding-bottom: 2pt; }
table.ih { width: 100%; border-collapse: collapse; margin: 3pt 0 1pt; }
table.ih td { padding: 0; font-size: 10.5pt; }
table.ih td.r { text-align: right; color: #565b60; }
p.meta { color: #565b60; margin: 1pt 0 3pt; font-size: 9.5pt; }
ul { margin: 2pt 0 6pt 20pt; padding: 0; }
li { margin: 1.5pt 0; }
p { margin: 3pt 0; }
`.trim();

/** 条目标题行：左标题右日期用表格实现（Word 对 float 支持不稳）。 */
function wItemHead(title, right) {
  return '<table class="ih"><tr><td><b>' + W_ESC(title) + '</b></td>'
    + (right ? '<td class="r">' + W_ESC(right) + '</td>' : '')
    + '</tr></table>';
}

function wUl(arr) {
  return '<ul>' + (arr || []).map((x) => '<li>' + W_ESC(x) + '</li>').join('') + '</ul>';
}

/**
 * 表单 → 完整 Word HTML（.doc）。结构与编辑页预览（renderCvVisual）同构，
 * 但样式内联在文件里，不依赖控制台的 style.css。
 *
 * nav（可选）= 分区导航的 { order, hidden }。传了它就按用户排的顺序输出、
 * 跳过被隐藏的章节 —— **预览里看不到的，导出的 Word 里也不能有**。
 * 不传 = 默认顺序、全部显示，行为与从前一字不差（老调用点不用改）。
 * 隐藏不动 cv.md：这里只是不输出，素材原地保留。
 */
export function cvFormToWordHtml(form, nav, look, photoSrc, fields) {
  const f = form || {};
  const c = f.candidate || {};
  const out = [];
  // 哪些条目该输出（跳过全空占位）—— 与预览读同一份口径，见 cv-model.mjs。
  const live = cvLiveItems(f);

  // 头像（2026-10-09）。photoSrc 优先：调用方会把 /api/cv/asset/xxx 抓下来
  // 转成 dataURL 再传进来 —— 导出的 .doc 是要被带走、离线打开的，
  // 里面留一条本机路径等于一张裂图。转换在 downloadCvWord 里做。
  //
  // 判据只看「用户是不是用眼睛把头像关掉了」：photoSrc 是调用方**已经准备好**
  // 的图源，不该再被「表单里现在有没有 photo 路径」否决一遍（那样传了图源也会
  // 静默丢图 —— 2026-10-09 探针抓到过这条）。关掉时连 photoSrc 一起丢掉。
  const photo = isCvPhotoHidden(fields) ? '' : String(photoSrc || c.photo || '');
  if (photo) out.push('<p class="photo"><img src="' + W_ESC(photo) + '" alt=""></p>');

  // 姓名 / 求职意向 / 信息行：组成与顺序全部来自 ui/cv-fields.mjs 的三个纯函数
  //（与预览同一份）。默认设置下这里输出 phone · email · location，
  // 与本改造之前一字不差。
  if (!isCvFieldHidden(fields, 'name')) {
    out.push('<h1>' + W_ESC(c.name || '（未填写姓名）') + '</h1>');
  }
  const role = cvHeaderRole(c, f.targetRole, fields);
  if (role) out.push('<p class="role">求职意向：' + W_ESC(role) + '</p>');
  const contact = cvHeaderValues(c, fields);
  if (contact.length) out.push('<p class="contact">' + contact.map(W_ESC).join(' · ') + '</p>');

  const sec = (title, body) => { if (body) out.push('<h2>' + title + '</h2>' + body); };

  // 章节渲染表：key → 该节的 HTML（空串 = 这一节没内容，不输出）。
  //
  // ⚠️ **顺序不写在这张表里** —— 由分区导航的 order 决定（ui/cv-nav.mjs）。
  // 编辑页预览（app.js 的 renderCvVisual）用同一份 key、同一套顺序：
  // 两处各写一份，迟早出现「预览里有、导出的 Word 里没有」这种静默不一致。
  const bodies = {
    summary: () => (f.summary ? '<p>' + W_ESC(f.summary) + '</p>' : ''),

    // 「不是全空的条目」口径与预览同一处（cv-model.mjs 的 cvLiveItems）——
    // 用户点了「+ 添加荣誉奖项」还没填时，不该导出一个带标题的空章节。
    competencies: () => (live.competencies.length ? wUl(live.competencies) : ''),

    education: () => (live.education.length ? live.education.map((e) => {
      const meta = [e.org, e.location].filter(Boolean).join(' · ');
      return wItemHead(e.title || '（未填写）', e.year || '')
        + (meta ? '<p class="meta">' + W_ESC(meta) + '</p>' : '')
        + (e.description ? '<p>' + W_ESC(e.description) + '</p>' : '');
    }).join('') : ''),

    experience: () => (live.experience.length ? live.experience.map((e) => {
      const title = [e.role, e.company].filter(Boolean).join(' — ') || '（未填写）';
      const meta = [e.dates, e.location].filter(Boolean).join(' · ');
      return wItemHead(title, e.dates || '')
        + (meta && meta !== e.dates ? '<p class="meta">' + W_ESC(meta) + '</p>' : '')
        + (e.bullets && e.bullets.length ? wUl(e.bullets) : '');
    }).join('') : ''),

    projects: () => (live.projects.length ? live.projects.map((p) => wItemHead(p.name || '（未填写）', p.badge || '')
      + (p.description ? '<p>' + W_ESC(p.description) + '</p>' : '')
      + (p.tech ? '<p class="meta">技术栈：' + W_ESC(p.tech) + '</p>' : '')
      + (p.bullets && p.bullets.length ? wUl(p.bullets) : '')
      + (p.url ? '<p class="meta">' + W_ESC(p.url) + '</p>' : '')
    ).join('') : ''),

    skills: () => (live.skills.length ? '<ul>' + live.skills.map((s) => '<li>'
      + (s.category ? '<b>' + W_ESC(s.category) + '：</b>' : '')
      + W_ESC((s.items || []).join('、')) + '</li>').join('') + '</ul>' : ''),

    certifications: () => (live.certifications.length ? '<ul>' + live.certifications.map((e) => '<li>' + W_ESC(e.title)
      + ([e.org, e.year].filter(Boolean).length
        ? ' — ' + W_ESC([e.org, e.year].filter(Boolean).join(' · ')) : '')
      + '</li>').join('') + '</ul>' : ''),

    awards: () => (live.awards.length ? '<ul>' + live.awards.map((e) => '<li>' + W_ESC(e.title)
      + ([e.org, e.year].filter(Boolean).length
        ? ' — ' + W_ESC([e.org, e.year].filter(Boolean).join(' · ')) : '')
      + '</li>').join('') + '</ul>' : ''),
  };

  for (const k of visibleCvSections(nav)) {
    const build = bodies[k];
    const body = build ? build() : '';
    if (body) sec(cvNavLabel(k), body);
  }

  return '<html xmlns:o="urn:schemas-microsoft-com:office:office"'
    + ' xmlns:w="urn:schemas-microsoft-com:office:word"'
    + ' xmlns="http://www.w3.org/TR/REC-html40">'
    + '<head><meta charset="utf-8"><title>简历</title>'
    + '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->'
    + '<style>' + WORD_STYLE + '.photo{margin:0 0 10pt;text-align:right}'
    + '.photo img{width:26mm;height:34mm;object-fit:cover}'
    // 外观设置（主题色 / 字体 / 字号 / 行高 / 间距 / 页边距）。
    // 放在 WORD_STYLE **之后** —— 同权重时后面的赢，用户调过的值必须压过默认值。
    + cvLookWordCss(look) + '</style></head>'
    + '<body lang="zh-CN">' + out.join('') + '</body></html>';
}

/** 导出文件名：简历-姓名-YYYYMMDD.doc。 */
export function wordFileName(form) {
  const name = String((form && form.candidate && form.candidate.name) || '').trim() || '未命名';
  const d = new Date();
  const stamp = d.getFullYear()
    + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  return '简历-' + name + '-' + stamp + '.doc';
}

/**
 * 浏览器侧：生成 .doc 并触发下载。返回文件名（给 toast 用）。
 * 仅能在浏览器里调用（依赖 Blob/URL/document/fetch）。
 *
 * nav / look / fields 见 cvFormToWordHtml —— 让导出的章节顺序、字段顺序与显隐、
 * 以及排版跟预览一致。
 * 是 async 的原因只有一个：**头像要转成 dataURL 内联**。留一条 /api/cv/asset/xxx
 * 的本机路径，用户把文件拷到别的机器上打开就是一张裂图。
 */
export async function downloadCvWord(form, nav, look, fields) {
  const src = String((form && form.candidate && form.candidate.photo) || '');
  let photo = '';
  if (src) {
    if (/^data:image\//i.test(src)) {
      photo = src;
    } else {
      try {
        const r = await fetch(src, { credentials: 'same-origin' });
        if (r.ok) {
          const blob = await r.blob();
          photo = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result || ''));
            fr.onerror = () => rej(new Error('读取头像失败'));
            fr.readAsDataURL(blob);
          });
        }
      } catch {
        // 取不到图不算导出失败：正文都还在，只是少一张头像。
        // 静默降级会让人以为「我明明传了头像」—— 所以让调用方 toast 里说明。
        photo = '';
      }
    }
  }
  const html = cvFormToWordHtml(form, nav, look, photo, fields);
  const blob = new Blob(['\ufeff', html], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = wordFileName(form);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return a.download;
}
