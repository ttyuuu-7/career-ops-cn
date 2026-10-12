// ui/cv-templates.mjs — 简历模板库的口径单点（零依赖，前端/服务端共用）
//
// 模板 = 一份「版式描述」，**不是**一份简历内容：
//   · base   —— 版式基底，对应 style.css 的 .cvp-tpl1/2/3 三套成稿气质；
//   · accent —— 主色（空 = 跟随系统主题 --accent）。
// 渲染时「内容永远来自当前表单」，模板只决定外观 —— 数据与外观严格分离，
// 这正是「选模板不动简历数据」这条产品约束在代码里的落点。
//
// 为什么抽成共享模块：服务端负责「库里有哪些模板、选中了谁」（/api/cv/templates*），
// 前端负责「按模板渲染预览」。两边必须认同一份内置清单和同一套校验规则，
// 否则就会出现「服务端收下了、前端渲染不出」的静默分叉。

// 主色只认 #RRGGBB。放行大小写；存储侧统一转大写，比较时就不会出幺蛾子。
export const CV_TPL_ACCENT_RE = /^#[0-9a-fA-F]{6}$/;

// 结构条目类型（文件导入的模板结构校验用；与 tpl-file-parse.mjs 的
// TPL_ITEM_KINDS 同口径 —— 一边加类型两边要同步）。
export const TPL_ITEM_KINDS = ['heading', 'field', 'placeholder', 'paragraph'];

// 套内置版式的说明（base 与 style.css 的 .cvp-tplN / cv-tpl-dual 一一对应）。
// 导入模板的「版式基底」下拉、模板库卡片副标题都用这一份。
export const CV_TPL_BASES = [
  { base: '1', label: '经典左线', desc: '标题带左侧竖线，默认版式' },
  { base: '2', label: '居中横线', desc: '页眉居中，标题改横线' },
  { base: '3', label: '紧凑无饰', desc: '字号收紧，标题去饰线' },
  // base 4 不是「另一种装饰」，而是另一套**结构**（双栏 + 照片 + 技能进度条），
  // 渲染器在 ui/cv-tpl-dual.mjs，不走 style.css 的 .cvp-tplN 三档。
  { base: '4', label: '双栏图文', desc: '两栏 + 头像 + 技能进度条', only: 'builtin' },
];

// 内置模板：id 沿用老预览切换器的 '1'/'2'/'3' —— 老用户会话里已存的
// S.cvTpl 值无缝兼容，不需要迁移。预置清单（cv-tpl-catalog.mjs，100 套
// 来自 D:/桌面/模板 的成套简历版式，2026-09-30）spread 在后 —— 对所有
// 用户（含匿名）可见，不用逐账号导入。
import { CV_TPL_CATALOG } from './cv-tpl-catalog.mjs';
import { DUAL_TPL } from './cv-tpl-dual.mjs';
// 「稳重」系列 10 套（2026-10-09）：原文件当资产、运行时 DOMParser 解析填充。
// 单向依赖 —— cv-tpl-wz.mjs 不回头 import 本文件，所以不构成循环。
import { WZ_TEMPLATES, WZ_PREFIX as WZ_BASE } from './cv-tpl-wz.mjs';
export const BUILTIN_CV_TEMPLATES = [
  { id: '1', name: '模板1', desc: '经典左线', base: '1', accent: '', source: 'builtin' },
  { id: '2', name: '模板2', desc: '居中横线', base: '2', accent: '', source: 'builtin' },
  { id: '3', name: '模板3', desc: '紧凑无饰', base: '3', accent: '', source: 'builtin' },
  { ...DUAL_TPL, source: 'builtin' },
  // 「稳重」系列 10 套（2026-10-09 接入）。base 统一 'wz'：它们不走
  // .cvp-tplN 三档色系版式，而是由 ui/tpl-wz/*.html 的原始版式经 DOMParser 填充
  // （见 ui/cv-tpl-wz.mjs）。file 字段带着原始文件名，渲染前要据此取模板源。
  ...WZ_TEMPLATES.map((t) => ({
    id: t.id, name: t.name, desc: t.hint, base: WZ_BASE,
    accent: t.accent, file: t.file, source: 'builtin',
  })),
  ...CV_TPL_CATALOG.map((t) => ({ ...t, source: 'builtin' })),
];

/** base '4' 的双栏模板走独立渲染器，不在 .cvp-tplN 三档里。 */
export const DUAL_TPL_BASE = '4';

/** 校验并归一化「导入模板」的输入（服务端落盘前、前端上传回填后共用）。
 *  返回 { ok:true, tpl:{name,base,accent,...} } 或 { ok:false, error }。
 *  文件导入时额外带 from/file/fingerprint/structure，这里做同一套校验：
 *  结构条目数与字数封顶（前端解析器也有上限 —— 两层防御），指纹只认 64 位 hex。 */
export function normalizeCvTemplateInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = String(b.name || '').trim().slice(0, 30);
  if (!name) return { ok: false, error: '模板名称不能为空（30 字以内）' };
  const base = CV_TPL_BASES.some((x) => x.base === String(b.base)) ? String(b.base) : '1';
  const accent = CV_TPL_ACCENT_RE.test(String(b.accent || '')) ? String(b.accent).toUpperCase() : '';

  const tpl = { name, base, accent };

  // —— 文件导入的附加字段（手工导入不带，全部可选）——
  const from = String(b.from || '') === 'file' ? 'file' : 'form';
  tpl.from = from;
  if (from !== 'file') return { ok: true, tpl };

  const file = b.file && typeof b.file === 'object' ? b.file : {};
  const fname = String(file.name || '').trim().slice(0, 120);
  const fkind = String(file.kind || '');
  const fsize = Number(file.size);
  if (!fname) return { ok: false, error: '缺少来源文件名' };
  // image = 图片模板（png/jpg/webp/bmp/gif，结构来自本机 OCR，文字行已在前端组装）
  if (!['pdf', 'doc', 'docx', 'image'].includes(fkind)) {
    return { ok: false, error: '来源文件类型只支持 pdf / doc / docx / 图片' };
  }
  if (!Number.isFinite(fsize) || fsize < 0 || fsize > 20 * 1024 * 1024) {
    return { ok: false, error: '来源文件大小不合法（上限 20MB）' };
  }
  tpl.file = { name: fname, kind: fkind, size: Math.round(fsize) };

  if (!/^[0-9a-fA-F]{64}$/.test(String(b.fingerprint || ''))) {
    return { ok: false, error: '缺少有效的模板内容指纹（指纹用于重复导入检测）' };
  }
  tpl.fingerprint = String(b.fingerprint).toLowerCase();

  const st = b.structure && typeof b.structure === 'object' ? b.structure : null;
  if (!st || !Array.isArray(st.sections) || !st.sections.length) {
    return { ok: false, error: '缺少解析出的模板结构（标题/字段/占位符/段落）' };
  }
  if (st.sections.length > 60) return { ok: false, error: '模板结构的小节太多（上限 60 段）' };
  const sections = [];
  let chars = 0;
  for (const s of st.sections) {
    if (!s || typeof s !== 'object') return { ok: false, error: '模板结构里有非法条目' };
    const sec = { title: String(s.title || '').trim().slice(0, 80), items: [] };
    if (!Array.isArray(s.items)) return { ok: false, error: '模板结构里有非法条目' };
    for (const it of s.items) {
      if (!it || typeof it !== 'object') return { ok: false, error: '模板结构里有非法条目' };
      if (!TPL_ITEM_KINDS.includes(String(it.kind))) return { ok: false, error: '模板结构里有不认识的条目类型（' + String(it.kind) + '）' };
      const text = String(it.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
      if (!text) continue;
      sec.items.push({ kind: String(it.kind), text });
      chars += text.length;
      if (chars > 48000) return { ok: false, error: '模板结构太大（超过 48000 字），请精简后再导入' };
      if (sections.length + 1 > 60) return { ok: false, error: '模板结构的小节太多（上限 60 段）' };
    }
    if (sec.items.length || sec.title) sections.push(sec);
  }
  if (!sections.length) return { ok: false, error: '模板结构是空的' };
  // 带壳存 { sections }：前端发送/回读（toast 的「识别 N 个小节」、模板库
  // 卡片 hint）都按 structure.sections 读，tplRowsToStructure 产出的也是这个形状。
  tpl.structure = { sections };
  return { ok: true, tpl };
}

/** 模板 id → 渲染参数 { base, accent, name, id }。
 *  自定义列表里找不到就回落内置，再不行回落模板1 —— 任何脏 id 都不会让预览崩掉。 */
export function resolveCvTplStyle(id, customItems) {
  const sid = String(id || '');
  const pool = [...BUILTIN_CV_TEMPLATES, ...(Array.isArray(customItems) ? customItems : [])];
  const hit = pool.find((t) => t && t.id === sid) || BUILTIN_CV_TEMPLATES[0];
  return { base: hit.base || '1', accent: hit.accent || '', name: hit.name || '模板1', id: hit.id };
}

/** 模板库预览用的样例简历：表单还是空白时（新注册用户）也要能看出版式的实际气质。
 *  刻意只放少量条目 —— 缩放预览卡是裁切的，样例太长也是白搭。 */
export const CV_TPL_SAMPLE_FORM = {
  candidate: { name: '王小明', email: 'wxm@example.com', phone: '138 0000 0000', location: '西安' },
  targetRole: '后端开发工程师',
  summary: '计算机专业应届生，熟悉 Java 与 Spring Boot，做过完整的 Web 项目与数据库设计。',
  competencies: ['Java / Spring Boot 后端开发', 'MySQL 数据库设计与调优'],
  education: [
    { title: '某某大学 — 计算机科学与技术（本科）', year: '2023 – 2027', org: '', description: '主修数据结构、操作系统、计算机网络。' },
  ],
  experience: [
    { role: '后端开发实习生', company: '某某科技', dates: '2026.06 – 2026.09', bullets: ['参与订单服务接口开发，交付 8 个内部接口。'] },
  ],
  projects: [
    { name: '客户流失预测系统', badge: '课程设计', description: 'Flask + 随机森林的流失预测与可视化平台。', tech: 'Python · scikit-learn · Flask', bullets: [] },
  ],
  skills: [
    { category: '语言与框架', items: ['Java', 'Spring Boot', 'Python'] },
  ],
};
