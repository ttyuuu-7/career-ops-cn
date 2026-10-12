// ui/cv-tpl-dual.mjs —「简历1」双栏黄模板（2026-10-09）
//
// 来源：D:/workbuddy wenjian/2026-10-09-11-00-15/简历1.html
// 原文件是一份**独立可编辑页面**（整页 contenteditable + localStorage 自动存）。
// 这里搬进项目时改了本质：
//   · 内容不再由页面自己存，改为**由项目 form 驱动**（cv.md 仍是唯一事实来源）
//   · 去掉工具栏/字号调节/换头像/下载/清空 —— 那些是原页面自带的编辑壳，
//     进了控制台会与「我的简历」页的表单重复，且各存一份数据必然分叉
//   · 保留的是**版式**：A4 两栏、黄色主题、头像圆环、时间轴、技能进度条、
//     证书/奖项小节、优势特长重叠圆
//
// 为什么单独一个模块而不是塞进 cv-templates.mjs 的 base 1/2/3：
// 那三档是「同一套单栏结构换装饰」，而这是**另一套结构**（双栏 + 照片 +
// 技能条），硬塞进base 档会让 3 档 CSS 变成互斥分支，越堆越乱。
//
// 零依赖、可在浏览器与 Node 两侧 import（服务端 /api/cv/templates 也用它取字段清单）。

/** 模板元数据：与 cv-tpl-catalog.mjs 的条目同构，base 固定 '4'（= 本模块）。 */
export const DUAL_TPL = {
  id: 'dual01',
  name: '双栏黄·图文简历',
  desc: '双栏 · 照片 · 技能条',
  base: '4',
  accent: '#FCBD07',
};

/**
 * 模板的可编辑字段清单。
 *
 * 「简历编辑」页按这份清单生成表单 —— 模板有哪些槽位，表单就问哪些问题，
 * 不再让用户对着模板里没有的栏目发愁（原来表单是固定的四段，与模板无关）。
 *
 * kind 与 cv-model 的 form 结构一一对应，ensureCvField() 负责建空壳。
 */
export const DUAL_TPL_FIELDS = [
  // ── 页眉 ──
  { key: 'candidate.name', label: '姓名', kind: 'text', group: '基本信息', required: true },
  { key: 'targetRole', label: '求职意向 / 职位', kind: 'text', group: '基本信息' },
  { key: 'candidate.photo', label: '证件照', kind: 'photo', group: '基本信息',
    hint: '正方形照片效果最好；不上传也能用，只是左侧头像位空着' },
  { key: 'candidate.location', label: '工作地点', kind: 'text', group: '基本信息' },
  { key: 'candidate.phone', label: '电话号码', kind: 'text', group: '基本信息' },
  { key: 'candidate.email', label: '邮箱地址', kind: 'text', group: '基本信息' },

  // ── 左主栏 ──
  { key: 'summary', label: '关于我 · 自述', kind: 'longtext', group: '自我介绍',
    rows: 4, hint: '两三句即可：专业方向 + 擅长什么 + 性格或团队特点' },
  { key: 'summaryExtra', label: '补充说明', kind: 'longtext', group: '自我介绍', rows: 3,
    hint: '补充的自我评价、与上一段不重复的内容；没有可以留空' },
  { key: 'experience', label: '工作经验', kind: 'list', group: '经历',
    itemLabel: '一段工作', addLabel: '+ 添加一段工作',
    fields: [
      { path: 'dates', label: '起止时间', kind: 'text' },
      { path: 'company', label: '公司名称', kind: 'text' },
      { path: 'role', label: '岗位', kind: 'text' },
      { path: 'bullets', label: '工作内容', kind: 'bullets' },
    ] },
  { key: 'interests', label: '兴趣爱好', kind: 'tags', group: '经历',
    hint: '用空格或逗号分隔，渲染成斜杠分隔的一行' },

  // ── 右副栏 ──
  { key: 'skills', label: '技能水平', kind: 'skills', group: '技能',
    hint: '每项含技能名与熟练度（0–100），会画成进度条',
    fields: [
      { path: 'category', label: '软件 / 技能名称', kind: 'text' },
      { path: 'level', label: '熟练度 0-100', kind: 'number', min: 0, max: 100, def: 80 },
    ] },
  { key: 'education', label: '教育背景', kind: 'list', group: '教育',
    itemLabel: '一段教育', addLabel: '+ 添加一段教育',
    fields: [
      { path: 'year', label: '起止时间', kind: 'text' },
      { path: 'org', label: '学校', kind: 'text' },
      { path: 'title', label: '专业 · 学历', kind: 'text' },
      { path: 'description', label: '主修课程', kind: 'longtext' },
    ] },
  { key: 'certifications', label: '证书', kind: 'list', group: '教育',
    itemLabel: '一项证书', addLabel: '+ 添加证书',
    fields: [
      { path: 'title', label: '证书名称', kind: 'text' },
      { path: 'year', label: '取得时间', kind: 'text' },
    ] },
  { key: 'awards', label: '奖项', kind: 'list', group: '教育',
    itemLabel: '一项奖项', addLabel: '+ 添加奖项',
    fields: [
      { path: 'title', label: '奖项名称', kind: 'text' },
      { path: 'year', label: '获奖时间', kind: 'text' },
    ] },
  { key: 'competencies', label: '优势特长', kind: 'tags', group: '技能',
    hint: '3–4 个**短词**（如「后端开发 / 数据分析 / 学习能力强」），会排成重叠圆。'
      + '别在这里写长句——圆里只放得下 2–6 个字。' },
];

/** 按 group 顺序分组，供表单分段渲染。 */
export function dualTplGroups() {
  const out = [];
  const seen = new Set();
  for (const f of DUAL_TPL_FIELDS) {
    const g = f.group || '其他';
    if (!seen.has(g)) { seen.add(g); out.push({ name: g, fields: [] }); }
    out.find((x) => x.name === g).fields.push(f);
  }
  return out;
}

const e = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 两列黄主题的全部样式。挂.cvp-dual 之下，只在这个模板里生效。 */
export const DUAL_TPL_CSS = `
.cvp-dual{--yellow:#FCBD07;--yellow-d:#E8A800;--ink:#2b2b2b;--ink-2:#595959;--ink-3:#7F7F7F;
  --line:#E5E5E5;--grey:#EFEFEF;
  font-family:"Microsoft YaHei","微软雅黑","PingFang SC",sans-serif;
  color:var(--ink);font-size:10pt;line-height:1.7;background:#fff;}
.cvp-dual *{box-sizing:border-box;}
.cvp-dual .cols{display:flex;align-items:flex-start;gap:5mm;}
.cvp-dual .main{width:59.3%;min-width:0;}
.cvp-dual .side{width:36.7%;flex:none;}
.cvp-dual .head{display:flex;align-items:center;gap:5.5mm;margin-bottom:9mm;}
.cvp-dual .photo-wrap{position:relative;width:34mm;height:34mm;flex:none;}
.cvp-dual .photo-wrap::before{content:"";position:absolute;inset:0;border-radius:50%;
  border:1.7mm solid var(--yellow);}
.cvp-dual .photo{position:absolute;left:1.7mm;top:1.7mm;width:30.6mm;height:30.6mm;
  border-radius:50%;overflow:hidden;background:#F5F5F5;}
.cvp-dual .photo img{width:100%;height:100%;object-fit:cover;display:block;}
.cvp-dual .photo-none{width:100%;height:100%;display:flex;align-items:center;
  justify-content:center;color:#C9C9C9;font-size:8pt;}
.cvp-dual .name{font-size:22pt;font-weight:800;letter-spacing:3px;line-height:1.15;color:#1c1c1c;}
.cvp-dual .job{margin-top:3mm;font-size:11pt;color:var(--ink-2);letter-spacing:1.6px;font-weight:600;}
.cvp-dual .sec{margin-bottom:7mm;}
.cvp-dual .sec-t{display:flex;align-items:center;gap:2.2mm;font-size:12pt;font-weight:800;
  color:#1c1c1c;letter-spacing:.6px;margin-bottom:4mm;white-space:nowrap;}
.cvp-dual .sec-t .en{font-size:8.6pt;font-weight:800;color:#1c1c1c;letter-spacing:.4px;}
.cvp-dual .slashes{display:inline-flex;gap:.9mm;flex:none;}
.cvp-dual .slashes i{display:block;width:1.15mm;height:5mm;background:var(--yellow);
  transform:skewX(-13deg);border-radius:.2mm;}
.cvp-dual .body-t{font-size:10pt;line-height:1.72;color:var(--ink-2);text-align:justify;}
.cvp-dual .body-t+.body-t{margin-top:3.4mm;}
.cvp-dual .ct{display:flex;align-items:center;gap:2.6mm;margin-bottom:3.2mm;font-size:9.4pt;color:var(--ink-2);}
.cvp-dual .ct .ico{width:5mm;height:5mm;flex:none;border-radius:50%;background:var(--yellow);
  display:flex;align-items:center;justify-content:center;font-size:7pt;color:#fff;font-weight:700;}
.cvp-dual .skill{display:flex;align-items:flex-start;gap:2.6mm;margin-bottom:3.6mm;}
.cvp-dual .skill .badge{width:5.2mm;height:5.2mm;flex:none;border-radius:50%;color:#fff;
  font-size:6.6pt;font-weight:800;display:flex;align-items:center;justify-content:center;
  font-family:Arial,sans-serif;}
.cvp-dual .skill .body{flex:1;min-width:0;padding-top:.5mm;}
.cvp-dual .skill .nm{font-size:9.2pt;font-weight:700;color:#333;margin-bottom:1.6mm;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cvp-dual .bar{height:1.7mm;background:var(--grey);border-radius:1mm;overflow:hidden;}
.cvp-dual .bar .fill{display:block;height:100%;background:var(--yellow);border-radius:1mm;}
.cvp-dual .pct{flex:none;font-size:7.6pt;color:var(--ink-3);font-family:Arial,sans-serif;
  min-width:6mm;text-align:right;padding-top:.2mm;}
.cvp-dual .rule{height:.55mm;background:var(--yellow);border-radius:.3mm;margin:3.5mm 0 4.5mm;}
.cvp-dual .tl{position:relative;padding-left:6.2mm;}
.cvp-dual .tl::before{content:"";position:absolute;left:1.5mm;top:2.4mm;bottom:5mm;width:.55mm;background:var(--yellow);}
.cvp-dual .exp{position:relative;margin-bottom:5mm;}
.cvp-dual .exp::before{content:"";position:absolute;left:-6.2mm;top:1.2mm;width:3.6mm;height:3.6mm;
  border-radius:50%;background:var(--yellow);}
.cvp-dual .exp .date{font-size:9.4pt;color:var(--ink-2);margin-bottom:1.6mm;}
.cvp-dual .exp .co{font-size:11.2pt;font-weight:800;color:#1c1c1c;margin-bottom:1.8mm;}
.cvp-dual .exp .co em{font-style:normal;font-weight:700;color:var(--yellow-d);}
.cvp-dual .exp .desc{font-size:9.2pt;line-height:1.7;color:var(--ink-2);text-align:justify;}
.cvp-dual .school{margin-bottom:5.4mm;}
.cvp-dual .school .date{font-size:9.2pt;color:var(--ink-3);margin-bottom:2.2mm;}
.cvp-dual .school .nm{font-size:10.6pt;font-weight:800;color:#1c1c1c;margin-bottom:2.4mm;}
.cvp-dual .school .crs{font-size:9.2pt;line-height:1.65;color:var(--ink-2);}
.cvp-dual .sub{margin-bottom:5mm;}
.cvp-dual .sub-t{font-size:10.6pt;font-weight:800;color:#1c1c1c;padding-left:3.8mm;
  border-left:1mm solid var(--yellow);margin-bottom:3mm;}
.cvp-dual .bul{display:flex;align-items:flex-start;gap:2.6mm;margin-bottom:2.6mm;font-size:9pt;color:var(--ink-2);}
.cvp-dual .bul .dot{width:2.1mm;height:2.1mm;border-radius:50%;background:var(--yellow);flex:none;margin-top:1mm;}
.cvp-dual .words{text-align:center;font-size:10.6pt;font-weight:700;color:#2a2a2a;padding:2.6mm 0 1mm;}
.cvp-dual .words .sep{color:var(--yellow);font-weight:900;margin:0 1.8mm;}
.cvp-dual .blob{position:relative;width:38mm;height:21.5mm;margin:2.5mm auto 0;}
.cvp-dual .blob span{position:absolute;border-radius:50%;display:flex;align-items:center;
  justify-content:center;font-weight:700;text-align:center;padding:0 1mm;}
.cvp-dual .b1{left:0;top:0;width:21mm;height:21mm;background:var(--line);}
.cvp-dual .b2{left:0;top:8mm;width:13.5mm;height:13.5mm;background:#E0E0E0;font-size:8.5pt;color:#4a4a4a;}
.cvp-dual .b3{left:10mm;top:1.2mm;width:19mm;height:19mm;background:var(--yellow);font-size:12pt;
  color:#fff;letter-spacing:1px;box-shadow:0 1px 6px rgba(0,0,0,.14);}
.cvp-dual .b4{left:24.5mm;top:8mm;width:13.5mm;height:13.5mm;background:#E0E0E0;font-size:8.5pt;color:#4a4a4a;}
.cvp-dual .muted{color:var(--ink-3);}
.cvp-dual .more{font-size:7.6pt;color:var(--ink-3);line-height:1.5;margin-top:1.6mm;}
`;

/** 取技能首字母做圆角徽标上的字母（Ps / W / P…）。 */
function initials(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const words = s.split(/[\s·、,，]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).slice(0, 2);
  }
  return s.slice(0, 2);
}

/** 稳定的徽标配色：同一个技能名每次跑出同一个颜色。 */
const BADGE_COLORS = ['#31A8FF', '#2B579A', '#D24726', '#0F766E', '#7C3AED',
  '#EA580C', '#0891B2', '#B45309', '#4F46E5', '#059669'];
function badgeColor(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return BADGE_COLORS[h % BADGE_COLORS.length];
}

/**
 * 渲染：form → 双栏 HTML。与 renderCvVisual 同一职责（给预览用），
 * 差别只在版式。**不读全局状态、不发请求、纯函数**，可被 Node 侧复用。
 */
/**
 * 渲染双栏简历。
 *
 * lookAttrs（可选）来自 ui/cv-look.mjs 的 cvLookRootAttrs()：
 *   { style: '--cvp-accent:…;--cvp-fs:…', cls: 'cvp-icon cvp-longtitle' }
 * 挂到根节点上，让外观设置（主色 / 字体 / 字号 / 行高 / 间距 / 模式）也作用到
 * 这套版式。不传 = 与本改造之前完全一致的输出。
 */
export function renderDualCv(form, lookAttrs, hidden) {
  const f = form || {};
  const c = f.candidate || {};
  // 分区导航里被隐藏 / 移除的章节（2026-10-11）。这套模板的编辑区导航只列模板
  // 自己的栏目（不可排序、也没有眼睛/垃圾桶按钮），但 hidden 是**跨模板共享**的
  // 设置 —— 用户在别的模板里关掉了「证书」，切到这套来也该不显示，
  // 否则又是一次「我明明删了，预览里还在」。
  const hid = new Set(Array.isArray(hidden) ? hidden : []);
  const lk = (lookAttrs && typeof lookAttrs === 'object') ? lookAttrs : { style: '', cls: '' };
  const out = [];

  // ── 页眉：头像 + 姓名 + 求职意向 ──
  const photo = String(c.photo || '');
  out.push('<div class="head">');
  out.push('<div class="photo-wrap"><div class="photo">');
  out.push(photo
    ? '<img src="' + e(photo) + '" alt="">'
    : '<span class="photo-none">照片</span>');
  out.push('</div></div><div>');
  out.push('<div class="name">' + (c.name ? e(c.name) : '<span class="muted">（姓名）</span>') + '</div>');
  if (f.targetRole) out.push('<div class="job">' + e(f.targetRole) + '</div>');
  out.push('</div></div>');

  // 页眉（头像+姓名）在两栏**之上**通栏，.cols 从这里才开。
  // 少了这一层，.main/.side 就退化成上下堆叠 —— 看着还是模板，内容却挤成一列。
  out.push('<div class="cols">');

  // ── 左主栏 ──
  out.push('<div class="main">');

  // 关于我（两段）
  const about = [];
  if (f.summary) about.push('<div class="body-t">' + e(f.summary) + '</div>');
  if (f.summaryExtra) about.push('<div class="body-t">' + e(f.summaryExtra) + '</div>');
  if (about.length && !hid.has('summary')) {
    out.push('<div class="sec"><div class="sec-t"><span class="slashes"><i></i><i></i></span>'
      + '关于我<span class="en">ABOUT ME</span></div>' + about.join('') + '</div>');
  }

  // 核心能力（2026-10-11 补）：这套模板原版式没有这一节，用户填的「核心能力」
  // 会整段消失（与项目同理）。按「关于我」的正文样式补一节，紧跟其后。
  if (f.competencies && f.competencies.length && !hid.has('competencies')) {
    const comps = f.competencies.filter(Boolean).map(e);
    if (comps.length) {
      out.push('<div class="sec"><div class="sec-t"><span class="slashes"><i></i><i></i></span>'
        + '核心能力<span class="en">HIGHLIGHTS</span></div>'
        + '<div class="desc">' + comps.join('<br>') + '</div></div>');
    }
  }

  // 工作经验（时间轴）
  if (f.experience && f.experience.length && !hid.has('experience')) {
    out.push('<div class="sec"><div class="sec-t"><span class="slashes"><i></i><i></i></span>'
      + '工作经验<span class="en">EXPERIENCE</span></div><div class="tl">');
    for (const x of f.experience) {
      out.push('<div class="exp">');
      if (x.dates) out.push('<div class="date">' + e(x.dates) + '</div>');
      // 公司名 + 岗位（岗位用黄色 <em> 强调，视觉上区分）
      const parts = [];
      if (x.company) parts.push(e(x.company));
      if (x.role) parts.push('<em>' + e(x.role) + '</em>');
      if (parts.length) out.push('<div class="co">' + parts.join('　') + '</div>');
      if (x.bullets && x.bullets.length) {
        out.push('<div class="desc">' + x.bullets.filter(Boolean).map(e).join('<br>') + '</div>');
      }
      out.push('</div>');
    }
    out.push('</div></div>');
  }

  // 项目经历（2026-10-11 补）：这套模板的原版式里**没有项目区** —— 用户填的
  // 项目（含要点）在预览里整段消失。静默丢内容与 docx fill 那条「被裁条目
  // 必须让用户看见」的规矩相悖，所以照「工作经验」那套时间轴样式补一节出，
  // 视觉上有归属感、内容也不再丢。
  if (f.projects && f.projects.length && !hid.has('projects')) {
    out.push('<div class="sec"><div class="sec-t"><span class="slashes"><i></i><i></i></span>'
      + '项目经历<span class="en">PROJECTS</span></div><div class="tl">');
    for (const pj of f.projects) {
      out.push('<div class="exp">');
      const meta = [pj.badge, pj.tech].filter(Boolean).map(e).join('　');
      if (meta) out.push('<div class="date">' + meta + '</div>');
      if (pj.name) {
        out.push('<div class="co">' + e(pj.name)
          + (pj.url ? '　<em>' + e(pj.url) + '</em>' : '') + '</div>');
      }
      const lines = [];
      if (pj.description) lines.push(e(pj.description));
      (pj.bullets || []).filter(Boolean).forEach((b) => lines.push(e(b)));
      if (lines.length) out.push('<div class="desc">' + lines.join('<br>') + '</div>');
      out.push('</div>');
    }
    out.push('</div></div>');
  }

  // 兴趣爱好
  if (f.interests && f.interests.length && !hid.has('interests')) {
    out.push('<div class="sec" style="margin-bottom:0"><div class="sec-t">'
      + '<span class="slashes"><i></i><i></i></span>兴趣爱好<span class="en">INTEREST</span></div>'
      + '<div class="words">' + f.interests.filter(Boolean).map(e).join('<span class="sep">/</span>') + '</div></div>');
  }

  out.push('</div>'); // /main

  // ── 右副栏 ──
  out.push('<div class="side">');

  // 联系我
  const ct = [];
  if (c.location) ct.push(['地', '工作地点：' + e(c.location)]);
  if (c.phone) ct.push(['话', '电话号码：' + e(c.phone)]);
  if (c.email) ct.push(['邮', '邮箱地址：' + e(c.email)]);
  if (ct.length) {
    out.push('<div class="sec"><div class="sec-t"><span class="slashes"><i></i><i></i></span>'
      + '联系我<span class="en">CONTACT ME</span></div>');
    for (const [ico, txt] of ct) {
      out.push('<div class="ct"><span class="ico">' + ico + '</span><span>' + txt + '</span></div>');
    }
    out.push('</div>');
  }

  // 技能水平（进度条）
  // 每条技能在右栏占约 9mm 高。右栏总共约 190mm，扣掉「联系我」和「教育背景」，
  // 技能超过 6 条就会把后面的板块顶出纸面（实测 13 条时右栏高1063px、
  // 整份溢出 A4）。所以这里只画前 6 条，剩余的用一行小字提示还有多少条 ——
  // 静默丢掉会让人以为"我填了但没显示"。
  const SKILL_MAX = 6;
  if (f.skills && f.skills.length && !hid.has('skills')) {
    const shown = f.skills.slice(0, SKILL_MAX);
    out.push('<div class="sec"><div class="sec-t"><span class="slashes"><i></i><i></i></span>'
      + '技能水平<span class="en">SKILLS</span></div>');
    for (const s of shown) {
      const name = s.category || (s.items && s.items[0]) || '';
      if (!name && !(s.items || []).length) continue;
      const lv = Math.max(0, Math.min(100, Number(s.level == null ? 80 : s.level) || 0));
      // 标签要把**具体技能项**一起带出来（2026-10-11 修）：原实现只显示
      // category，表单里写在 items 里的技能（「技能标记SFE」这种）整条看不见 ——
      // 用户填了却在预览里找不到，等于内容丢了。有 category 就「分类：技能1、技能2」，
      // 没分类就直接列技能。
      const itemsTxt = (s.items || []).filter(Boolean).join('、');
      const label = (s.category && itemsTxt)
        ? s.category + '：' + itemsTxt
        : (itemsTxt || name);
      out.push('<div class="skill">'
        + '<span class="badge" style="background:' + badgeColor(label) + '">' + e(initials(label)) + '</span>'
        + '<div class="body"><div class="nm" title="' + e(label) + '">' + e(label) + '</div>'
        + '<div class="bar"><span class="fill" style="width:' + lv + '%"></span></div></div>'
        + '<span class="pct">' + lv + '</span></div>');
    }
    const rest = f.skills.length - shown.length;
    if (rest > 0) {
      // 超出右栏容量的技能**也要让用户看见**（2026-10-11）：原来只留一句
      // 「还有 N 项未显示」，内容本身却没处可看 —— 对用户就是「我填了但没了」。
      // 提示保留（解释为什么这几条没有进度条），内容按同样式列在提示下方。
      out.push('<p class="more">还有 ' + rest + ' 项技能未显示进度条'
        + '（一栏最多 ' + SKILL_MAX + ' 项，删掉不常用的或合并同类项），已列在下方：</p>');
      const restRows = f.skills.slice(SKILL_MAX).map((s) => {
        const itemsTxt = (s.items || []).filter(Boolean).join('、');
        const label = (s.category && itemsTxt)
          ? s.category + '：' + itemsTxt
          : (itemsTxt || s.category || '');
        return label ? '<div class="more-it">' + e(label) + '</div>' : '';
      }).join('');
      if (restRows) out.push('<div class="more-list">' + restRows + '</div>');
    }
    out.push('<div class="rule"></div></div>');
  }

  // 教育背景（含证书 / 奖项小节）
  const edu = hid.has('education') ? [] : (f.education || []);
  const certs = hid.has('certifications') ? [] : (f.certifications || []);
  const awards = hid.has('awards') ? [] : (f.awards || []);
  if (edu.length || certs.length || awards.length) {
    out.push('<div class="sec"><div class="sec-t"><span class="slashes"><i></i><i></i></span>'
      + '教育背景<span class="en">EDUCATION</span></div>');
    for (const x of edu) {
      out.push('<div class="school">');
      if (x.year) out.push('<div class="date">' + e(x.year) + '</div>');
      const nm = [x.title, x.org].filter(Boolean).map(e).join(' ');
      if (nm) out.push('<div class="nm">' + nm + '</div>');
      if (x.description) out.push('<div class="crs">' + e(x.description) + '</div>');
      out.push('</div>');
    }
    if (certs.length) {
      out.push('<div class="sub"><div class="sub-t">证书</div>');
      for (const x of certs) {
        const t = [x.year, x.title].filter(Boolean).map(e).join(' ');
        if (t) out.push('<div class="bul"><span class="dot"></span><span>' + t + '</span></div>');
      }
      out.push('</div>');
    }
    if (awards.length) {
      out.push('<div class="sub"><div class="sub-t">奖项</div>');
      for (const x of awards) {
        const t = [x.year, x.title].filter(Boolean).map(e).join(' ');
        if (t) out.push('<div class="bul"><span class="dot"></span><span>' + t + '</span></div>');
      }
      out.push('</div>');
    }
    out.push('</div>');
  }

  // 优势特长（重叠圆）
  // ⚠️ 圆里只放得下 2–5 个字。真实数据里这一栏常被塞进整段自述（实测 200 字），
  // 直接塞进去会把 13mm 的圆撑爆、整份简历溢出纸面。所以：
  //   ① 只取前 3 项（圆只有 3 个）；② 每项硬截到 6 字；③ 逗号句号切分取首词。
  // 这不是"丢内容"——原简历的自述在「关于我」里已经完整呈现了，这里只是提炼标签。
  const comp = String(f.competencies || '').split(/[\s,，、;；。\n]+/)
    .map((x) => String(x).trim())
    .filter(Boolean)
    .map((x) => (x.length > 6 ? x.slice(0, 6) : x))
    .slice(0, 3);
  if (comp.length && !hid.has('competencies')) {
    out.push('<div class="sec" style="margin-bottom:0"><div class="sec-t">'
      + '<span class="slashes"><i></i><i></i></span>优势特长<span class="en">EXPERTISE</span></div>'
      + '<div class="blob"><span class="b1"></span>'
      + '<span class="b2">' + e(comp[0] || '') + '</span>'
      + '<span class="b3">' + e(comp[1] || comp[0] || '') + '</span>'
      + '<span class="b4">' + e(comp[2] || comp[1] || '') + '</span>'
      + '</div></div>');
  }

  out.push('</div>');   // /side
  out.push('</div>');   // /cols
  // 样式内联在这份 HTML 里（与 ui/cv-word.mjs 的 WORD_STYLE 同一做法）：
  // 模板 CSS 只在这一套模板里生效，跟 style.css 的 .cvp-tplN 三档互不干扰，
  // 也不必为了加一套版式去改那份已经很长的 style.css。
  return '<style>' + DUAL_TPL_CSS + '</style>'
    + '<div class="cvp cvp-dual' + (lk.cls ? ' ' + lk.cls : '') + '"'
    // e() 转义：变量值里的裸引号会把 style 属性截断，后面的变量全丢
    + (lk.style ? ' style="' + e(lk.style) + '"' : '') + '>' + out.join('') + '</div>';
}
