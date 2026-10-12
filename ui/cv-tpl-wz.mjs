// ui/cv-tpl-wz.mjs —「稳重」系列简历模板（10 套，2026-10-09 接入）
//
// 来源：D:\桌面\稳重模板HTML\稳重01–10.html（10 份独立成品的 A4 版式）。
//
// ── 为什么是「原文件 + 运行时解析」，而不是把版式抄进 JS ──────────────
// 每份模板 210–230 行，装饰细节极多（斜角、时间轴、进度条、兴趣图标、
// 角标、切角色块）。手抄 10 套 = 两千多行转录，改一处就要同步两处，必然漂。
// 所以这里把**原始 HTML 当资产**（ui/tpl-wz/*.html，经一次性预处理去掉了
// base64 头像与 <script>），运行时用 DOMParser 解析、按简历数据填内容。
// 版式永远等于原设计，而内容来自用户的简历。
//
// ── 字段是怎么认出来的 ────────────────────────────────────────────────
// 模板里的 contenteditable 元素没有 data-path，靠两样东西定位：
//   ① 它**前面的标签**：01 的 `<b>性　　别：</b><span>女</span>`
//      —— 先找前一个元素兄弟的文本，去掉空格与冒号后查词典。
//   ② 它的 **data-ph 占位提示**：09 的 `data-ph="生日"`。
// data-ph 有时填的是**示例值**而不是标签（01 的 data-ph="女"/"1990/12/8"），
// 所以 ① 优先、② 兜底，两条都查不到就留空（不猜 —— 猜错会让内容串位）。
//
// ── 条目（教育/工作/项目…）怎么分组 ──────────────────────────────────
// 靠「主键字段」+「最外层合格祖先」两条规则，10 套模板共用一套逻辑：
//   · 祖先的**直接子**里有 ≥2 个待填字段
//   · 它后代里含该列表的主键（学校 / 公司 / 单位 / 组织 / 项目 / 荣誉 / 证书）
// 取满足条件的最外层那个祖先作为「一条」。
// 这样 01 的 `.jb`、04 的 `.sec4`（章节与条目同层）、09 的 `.nd` 都能各自认对，
// 而 09 那个「教育背景的 4 行技能」也会跟着同一条教育走，不会并到工作里去。
//
// ⚠️ 本模块**零依赖**、只在浏览器里跑（用 DOMParser），server.mjs 也 import 它
//    来做字段清单自检 —— 两边都不碰 node:* 与 fs。

/** 10 套模板的元信息。file 与 ui/tpl-wz/ 下的文件名一一对应。 */
export const WZ_TEMPLATES = [
  { id: 'wz01', name: '稳重01 · 深蓝资料栏', file: '稳重01-深蓝资料栏.html', accent: '#2D3E50', hint: '左侧资料栏 + 技能进度条' },
  { id: 'wz02', name: '稳重02 · 青蓝侧栏', file: '稳重02-青蓝侧栏.html', accent: '#2E6E8E', hint: '单栏青蓝，学历带成绩' },
  { id: 'wz03', name: '稳重03 · 深色左栏', file: '稳重03-深色左栏.html', accent: '#1F3B54', hint: '深色左栏，含证书与荣誉' },
  { id: 'wz04', name: '稳重04 · 亮蓝斜角', file: '稳重04-亮蓝斜角.html', accent: '#2B6CB0', hint: '斜角页眉 + 侧边信息' },
  { id: 'wz05', name: '稳重05 · 深蓝兴趣栏', file: '稳重05-深蓝兴趣栏.html', accent: '#27496D', hint: '兴趣图标栏 + 技能进度条' },
  { id: 'wz06', name: '稳重06 · 斜角标题条', file: '稳重06-斜角标题条.html', accent: '#24527E', hint: '斜角标题条，含项目经历' },
  { id: 'wz07', name: '稳重07 · 顶部横头条', file: '稳重07-顶部横头条.html', accent: '#31688E', hint: '顶部横条，双栏证书与荣誉' },
  { id: 'wz08', name: '稳重08 · 亮蓝斜标签', file: '稳重08-亮蓝斜标签.html', accent: '#2C7DA0', hint: '斜切标签，含交换项目' },
  { id: 'wz09', name: '稳重09 · 时间轴', file: '稳重09-时间轴.html', accent: '#33556E', hint: '左右分栏 + 工作时间轴' },
  { id: 'wz10', name: '稳重10 · 灰蓝装饰块', file: '稳重10-灰蓝装饰块.html', accent: '#3A506B', hint: '灰蓝装饰块' },
];

export const WZ_BY_ID = new Map(WZ_TEMPLATES.map((t) => [t.id, t]));

// 章节标题的权威中文名（cv-model 是唯一来源，别在渲染器里另写字面量）
import { CV_SECTION_TITLES_ZH } from './cv-model.mjs';

/** 这批模板的 id 前缀。renderCvVisual 用它决定走哪个渲染器。 */
export const WZ_PREFIX = 'wz';

// ── 字段词典 ────────────────────────────────────────────────────────────
// 只认表里有的：认不出就留空。往字段里塞看不懂的东西，比空着更难排查
// （2026-09-18 就出过「GitHub：【待补充：…】」被当成城市名的案子）。
const SCALARS = [
  [/^(姓名|名字)$/, 'candidate.name'],
  [/^(求职意向|求职方向|意向岗位|应聘岗位|应聘职位|期望职位|目标岗位)$/, 'candidate.intent'],
  [/^(年龄)/, 'candidate.age'],
  [/^(性别)/, 'candidate.gender'],
  [/^(生日|出生年月|出生日期)/, 'candidate.birthday'],
  [/^(籍贯)/, 'candidate.native'],
  [/^(政治面貌)/, 'candidate.political'],
  [/^(身高)/, 'candidate.height'],
  [/^(城市|现居|现居地|住址|地址|所在地)/, 'candidate.location'],
  [/^(电话|手机|手机号|联系电话)/, 'candidate.phone'],
  [/^(邮箱|电子邮箱|email)/, 'candidate.email'],
  [/^(微信|wechat)/, 'candidate.wechat'],
  [/^(微博)/, ''],                       // cv.md 没有这个字段 → 留空
  [/^(学历|学位|最高学历)$/, 'candidate.degree'],
  [/^(专业)$/, 'candidate.major'],      // 条目内的「专业」另有归属，见 LIST_FIELDS
  [/^(自我介绍|自我评价|个人简介|个人介绍)$/, 'summary'],
];

/**
 * 条目内的字段 → { 字段名, 是否可多值 }。
 * 归属哪个列表由**条目容器**决定，不由这里决定 —— 同一个「时间」在教育条目里
 * 是 year、在工作条目里也是 year，但「公司」只可能出现在工作/项目条目里。
 */
const LIST_FIELDS = {
  '学校': { key: 'org' },
  '专业': { key: 'title' },
  '专业 学历': { key: 'title' },
  '学历': { key: 'title', onlyIfNoDegree: true },
  '主修课程': { key: 'description' },
  '成绩': { key: 'gpa' },
  '时间': { key: 'year' },
  '起止时间': { key: 'year' },
  '年份': { key: 'year' },
  '公司': { key: 'company' },
  '单位': { key: 'company' },
  '组织': { key: 'company' },
  '职位': { key: 'role' },
  '职位：公司': { key: 'role' },
  '工作内容': { key: 'bullets', multi: true },
  '工作描述': { key: 'bullets', multi: true },
  '主要职责': { key: 'bullets', multi: true },
  '内容': { key: 'bullets', multi: true },
  '项目': { key: 'name' },
  '项目名称': { key: 'name' },
  '荣誉': { key: 'title' },
  '奖项': { key: 'title' },
  '证书': { key: 'title' },
  '技能': { key: 'bullets', multi: true },
  '技能类别': { key: 'category' },
  '交换项目': { key: 'name' },
};

/** 各列表的主键字段：条目容器靠它认定「这一块属于哪个列表」。 */
const LIST_KEYS = {
  education: ['学校'],
  experience: ['公司', '单位', '组织'],
  projects: ['项目', '项目名称', '交换项目'],
  awards: ['荣誉', '奖项'],
  certifications: ['证书'],
  skills: ['技能类别'],
};

/** 归一化标签文本：去空白、全角冒号、去尾部冒号。 */
function normLabel(s) {
  return String(s == null ? '' : s)
    .replace(/[\s　]/g, '')
    .replace(/[:：]+$/, '')
    .trim();
}

/** 从词典里查标量字段；data-ph 可能是「年龄 城市」这种合并写法，取首个命中的词。 */
function lookupScalar(label) {
  const hit = (t) => {
    const n = normLabel(t);
    for (const [re, path] of SCALARS) if (re.test(n)) return path;
    return null;
  };
  const direct = hit(label);
  if (direct !== null) return direct;
  // 合并写法：「年龄 城市」这类，按分隔符拆开再逐个试
  const parts = String(label || '').split(/[\s　·|/]+/).filter(Boolean);
  for (const p of parts) {
    const v = hit(p);
    if (v) return v;
  }
  return '';
}

/** 从词典里查条目字段名；查不到返回 null。 */
function lookupListField(label) {
  const n = normLabel(label);
  if (LIST_FIELDS[n]) return { ...LIST_FIELDS[n], raw: n };
  const parts = String(label || '').split(/[\s　·|/]+/).filter(Boolean);
  for (const p of parts) {
    if (LIST_FIELDS[normLabel(p)]) return { ...LIST_FIELDS[normLabel(p)], raw: normLabel(p) };
  }
  return null;
}

/**
 * slot 前面那个**真标签**元素的文本。
 *
 * ⚠️ 只认紧挨着的**前一个元素兄弟**，且它自己不是 slot：
 *   · 01 的资料栏是 `<div><b>性　　别：</b><span slot>女</span></div>` → 命中 ✅
 *   · 01 的教育行是 `<span slot>起止时间</span><span slot>学校</span>` → 前一个是 slot
 *     → 不是标签（否则第二格会把第一格的**值**当标签，10 套里有 6 套列表全空）。
 *
 * ⚠️ **不要**再加「parent 的前一个兄弟」兜底：01 教育行第一格的前面是章节标题
 *    「教育背景」，兜底会把整段当成标签，于是「起止时间」认不出来、留着一行示例
 *    数据在简历上（2026-10-09 实测：年份永远显示 2008.8-2012.5）。
 *    宁可返回空 —— 空了就退回 data-ph，而 data-ph 是模板作者写的，正确。
 */
function labelBefore(el) {
  const prev = el.previousElementSibling;
  if (!prev) return '';
  if (prev.hasAttribute && prev.hasAttribute('data-ph')) return '';
  return normLabel(prev.textContent) ? prev.textContent : '';
}

/**
 * 一个 slot 到底对应哪个字段。
 *
 * **有真标签就听标签的，没标签才听 data-ph** —— 这一条顺序不能反：
 *   01 的资料栏 `<b>专　　业：</b><span slot>专业</span>`：标签与 data-ph 都是「专业」，
 *     但前者指 candidate.major，后者（教育条目里的）指 education.title。
 *     先查 list 会把资料栏那个判成教育条目字段，预览抬头就多出一行专业。
 *   教育行 `<span slot data-ph="起止时间">`：没有标签 → 走 data-ph ✅
 */
function resolveSlot(page, el) {
  const ph = el.getAttribute('data-ph') || '';
  const lbl = labelBefore(el);
  if (lbl) {
    const p = lookupScalar(lbl);
    if (p) return { kind: 'scalar', path: p };
    const lf = lookupListField(lbl);
    if (lf) return asList(page, el, lf);
  }
  const lf = lookupListField(ph);
  if (lf) return asList(page, el, lf);
  const p = lookupScalar(ph);
  if (p) return { kind: 'scalar', path: p };
  return null;
}

function asList(page, el, lf) {
  const list = listForSlot(page, el, lf);
  if (!list) return null;
  // 容器为 null 也**照样返回**：列表自明的字段（主修课程 / 荣誉 / 证书…）
  // 常常挂在一个同时装着别的列表的章节里，找不到「恰好只有一个列表」的祖先
  // 是正常的（09 教育下面那四行技能就在含三个列表的 .m9 里）。
  // 这种兜底出来的容器标 follow=true —— 下面编号时它**不开启新的一条**，
  // 否则那四行会被算成四条空的教育记录（早先版本直接返回 null，
  // 结果是那一格保留着模板示例数据「掌握 Java 编程语言…」印在简历上）。
  const box = itemContainerOf(page, el);
  return {
    kind: 'list', list, field: lf.key, multi: !!lf.multi,
    box: box || el.parentElement, follow: !box,
  };
}

function readPath(obj, path) {
  return path.split('.').reduce((a, k) => (a == null ? '' : a[k]), obj);
}

/** 从模板 DOM 里读出所有可识别的字段（驱动表单用）。 */
export function wzTemplateFields(src) {
  const doc = new DOMParser().parseFromString(src, 'text/html');
  const page = doc.getElementById('page');
  const scalars = new Set();
  const lists = new Set();
  if (!page) return { scalars: [], lists: [] };
  for (const el of page.querySelectorAll('[contenteditable][data-ph]')) {
    const r = resolveSlot(page, el);
    if (!r) continue;
    if (r.kind === 'list') { if (r.list) lists.add(r.list); } else scalars.add(r.path);
  }
  return {
    scalars: [...scalars],
    lists: [...lists].filter(Boolean),
  };
}

/** 这个祖先的子树里出现了哪几个列表的主键字段。 */
function listNamesIn(anc) {
  const names = slotLabels(anc);
  return Object.keys(LIST_KEYS).filter((k) => LIST_KEYS[k].some((key) => names.includes(key)));
}

function slotLabels(scope) {
  return [...scope.querySelectorAll('[contenteditable][data-ph]')]
    .map((s) => normLabel(labelBefore(s) || s.getAttribute('data-ph') || ''));
}

/**
 * 条目容器：祖先链上「恰好只涉及一个列表」的**最外层**那个。
 *
 * ⚠️ 为什么不能看「直接子里有几个 slot」：01 的 .jb 里装的是 .hd / .rl / .tx
 *    三个**容器**，它们自己都不带 data-ph —— 那个条件下三个祖先都数不出 slot，
 *    结果一套模板都认不出条目（2026-10-09 实测：10 套的 lists 全是空的）。
 *    「子树里只涉及一个列表」才是不依赖嵌套形状的判据。
 *
 * 为什么取**最外层**：01 的 .hd（时间/公司）与 .jb（职位/工作内容）都是候选，
 * 只有认成同一个 .jb，两边才会拿到同一条数据 —— 认成两个就会各数各的，
 * 第 2 段的「公司」会拿到第 1 条记录的内容。
 */
function itemContainerOf(page, el) {
  // 最**内层**的「恰好只涉及一个列表」的祖先。取内层而不是外层：
  //   01 的荣誉三个 .li 各自就是一个条目（外层 .sec 把三条又包成了一坨）；
  //   01 的工作 .hd（时间/公司）与 .jb（职位/工作内容）是同一���的两半 ——
  //   拆成两个容器也���，因为下面按容器编号时 .jb 不含主键、会自动跟随 .hd。
  for (let n = el.parentElement; n && n !== page; n = n.parentElement) {
    if (listNamesIn(n).length === 1) return n;
  }
  return null;
}

/**
 * 这个 slot 属于哪个列表。
 *
 * ① 字段名自带语义的（学校 / 公司 / 荣誉 / 证书…）直接定，不问容器 ——
 *    05 把「奖项」和「证书」放在**同一个** .blk 里，靠容器是分不开的。
 * ② 「时间 / 专业 / 工作内容 / 技能」这类通用字段才跟条目容器走。
 */
function listForSlot(page, el, lf) {
  const ph = normLabel((lf && lf.raw) || labelBefore(el) || el.getAttribute('data-ph') || '');
  if (LIST_KEYS.awards.some((k) => ph === k)) return 'awards';
  if (LIST_KEYS.certifications.some((k) => ph === k)) return 'certifications';
  if (LIST_KEYS.projects.some((k) => ph === k)) return 'projects';
  if (ph === '学校' || ph === '主修课程' || ph === '成绩') return 'education';
  if (ph === '公司' || ph === '单位' || ph === '组织' || ph === '职位' || ph === '职位：公司'
    || ph === '主要职责' || ph === '工作描述') return 'experience';
  const box = itemContainerOf(page, el);
  return box ? (listNamesIn(box)[0] || '') : '';
}

/** 这个 slot 是不是该列表的主键（主键 slot 出现 = 一条开始）。 */
function isPrimarySlot(el, list) {
  const ph = normLabel(labelBefore(el) || el.getAttribute('data-ph') || '');
  return (LIST_KEYS[list] || []).includes(ph);
}

/** 从 <style> 里剥掉「编辑器外壳」那部分：工具条、提示条、编辑态、打印、页面底色。 */
export function wzExtractCss(src) {
  const doc = new DOMParser().parseFromString(src, 'text/html');
  const raw = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  return raw
    .replace(/@media\s+print\s*\{[\s\S]*?\n\}/g, '')   // 打印分支整套丢掉（里面的选择器是扁平的）
    .replace(/@page\s*\{[^}]*\}/g, '')
    .replace(/[^{}]*#bar[^{}]*\{[^}]*\}/g, '')
    .replace(/[^{}]*#toast[^{}]*\{[^}]*\}/g, '')
    .replace(/[^{}]*body\.edit[^{}]*\{[^}]*\}/g, '')
    .replace(/[^{}]*contenteditable[^{}]*\{[^}]*\}/g, '')
    .replace(/(^|\})\s*(html|body)\s*[,{][^{}]*(\{[^}]*\})?/g, '$1')
    .replace(/[^{}]*\.stage[^{}]*\{[^}]*\}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 模板 id（'wz01'）→ 元信息；不是稳重模板则返回 null。 */
export function wzTpl(id) {
  return WZ_BY_ID.get(String(id || '')) || null;
}

export { normLabel, lookupScalar, lookupListField, labelBefore, readPath, itemContainerOf, LIST_KEYS };

/**
 * 条目里某字段的第 n 个值（bullets 之类支持一格多值）。
 *
 * ⚠️ `list` 不能省：同一个 data-ph（「技能」）在 09 里出现在两种地方 ——
 *    教育条目下是「这学期掌握了什么」（→ education.bullets），技能分类下是
 *    「Java / Python / …」（→ skills.items）。都当 bullets 处理的话，
 *    用户的技能清单会整块空掉（2026-10-09 实测）。
 */
function itemValue(item, field, ord, list) {
  if (!item) return '';
  const v = item[field];
  if (field === 'bullets' || field === 'items') {
    const arr = list === 'skills'
      ? (Array.isArray(item.items) ? item.items : [])
      : (Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]));
    return String(arr[(ord || 1) - 1] == null ? '' : arr[(ord || 1) - 1]).trim();
  }
  if (field === 'title' && item.degree && !v) return '';   // 标题空就空，别拿学历顶
  return String(v == null ? '' : v).trim();
}

/** 「这条有没有内容」—— 全空的条目不该在简历上占一整块。 */
function itemAlive(item, fields) {
  if (!item) return false;
  return fields.some((f) => {
    const v = item[f.field];
    if (f.multi) return (Array.isArray(v) ? v : []).some((x) => String(x || '').trim());
    return String(v == null ? '' : v).trim();
  });
}

/**
 * 用简历数据填这套模板，产出可直接放进 .cvp 的 HTML。
 *
 * @param {object} form     简历表单（草稿或服务端那份）
 * @param {string} src      模板原始 HTML（ui/tpl-wz/<file> 的内容）
 * @param {string} photoSrc 头像地址（可空）
 * @param {object} attrs    外观 root attrs（{style, cls}，来自 cv-look.mjs）
 */
export function renderWzCv(form, src, photoSrc, attrs, hidden) {
  const doc = new DOMParser().parseFromString(src, 'text/html');
  const page = doc.getElementById('page');
  if (!page) return '<div class="cvp-empty">这份模板解析失败了，换一套试试。</div>';

  const f = form || {};
  const c = f.candidate || {};
  const lk = attrs || {};
  const cls = lk.cls ? ' ' + lk.cls : '';
  // 分区导航里被「移除 / 眼睛关掉」的章节 key（ui/cv-nav.mjs 的 hidden）。
  // 模板版式固定，藏一节的做法是渲染收尾时把对应章节从 DOM 里摘掉；补录
  // （wzMergeMissing）也要跳过它们，否则刚摘掉的章节又被补回来。
  const hid = Array.isArray(hidden) ? hidden : [];

  // ── 1. 头像 ───────────────────────────────────────────────────────────
  // 预处理把 base64 换成了占位 dataURL，这里换成用户自己的头像；
  // 没传就把 src 摘掉 —— 浏览器会显示一个裂图标，比空着更难看。
  const phImg = page.querySelector('img');
  if (phImg) {
    if (photoSrc) phImg.setAttribute('src', String(photoSrc));
    else phImg.removeAttribute('src');
  }

  // ── 2. 把 slot 分成「标量」与「条目」两类 ─────────────────────────────
  const scalars = [];
  const boxes = [];              // { box, list, slots: [] }
  for (const el of page.querySelectorAll('[contenteditable][data-ph]')) {
    const r = resolveSlot(page, el);
    // ⚠️ 认不出来就**清空**，不能原样留着：模板示例（「掌握 Java 编程语言…」
    //    「连续 2 年荣获校三等奖学金」）印在用户简历上，比空着糟糕得多。
    if (!r) { el.textContent = ''; continue; }
    if (r.kind === 'scalar') { scalars.push({ el, path: r.path }); continue; }
    if (!r.box) continue;                            // 认不出容器就留空，不猜
    // ⚠️ key 必须是「容器 + 列表」而不是容器本身：05 把奖项和证书塞进
    //    **同一个** .blk 里，按容器归会把两个列表搅在一起。
    let rec = boxes.find((b) => b.box === r.box && b.list === r.list);
    if (!rec) { rec = { box: r.box, list: r.list, follow: r.follow, slots: [] }; boxes.push(rec); }
    rec.slots.push({ el, field: r.field, multi: r.multi });
  }

  // ── 3. 标量字段：填值 / 清空 ──────────────────────────────────────────
  // ⚠️ 长文本（个人简介/自我评价）**只填第一个槽位**：模板示例里常摆 2~3 个
  //    同名字段装着示例段落（wz04 的「自我评价」就是 3 个），逐个都填会把
  //    用户的同一段话在简历上印三遍 —— 观感上像内容重复的 bug。
  //    短字段（姓名/电话/邮箱）保留「多处都填」：页眉与侧栏各印一次是版式需要。
  let summaryFilled = false;
  for (const s of scalars) {
    const isLong = s.path === 'summary';
    if (isLong && summaryFilled) { s.el.textContent = ''; continue; }
    const v = isLong ? f.summary : readPath(f, s.path);
    s.el.textContent = String(v == null ? '' : v).trim();
    if (isLong) summaryFilled = true;
  }

  // ── 4. 条目：按「列表 + 容器父元素」分组，主键 slot 推进条目游标 ────────
  //
  // 为什么不用「容器在文档里的第几个」当条目序号：01 的一个条目由 .hd（时间/公司）
  // 与 .jb 本身（职位/工作内容）**两个**容器共同组成，按容器序号数会各数各的，
  // 第 2 段的「公司」会拿到第 1 条数据。
  //
  // 分组键 = 列表 + 条目容器的**父元素**：
  //   · 同一列表的相邻条目容器（01 的两个 .jb）父元素相同 → 共享游标 ✅
  //   · 两个互相独立的名誉区（父不同）各数各的 → 不会串到下一块去 ✅
  //   · 05 把奖项与证书塞在同一个 .blk 里 → 列表不同，游标天然分开 ✅
  const pos = new WeakMap();
  let seq = 0;
  for (const el of page.querySelectorAll('*')) pos.set(el, seq++);

  // 分组锚点 = 「该列表全部容器的最近公共祖先」。
  //
  // ⚠️ 早先用「容器自己的 parent」当锚点，05 就串了：它的 .hd5b（时间/学校/专业）
  //    嵌在 .blk 里，两者的 parent 不同 → 「主修课程」被分到另一组，
  //    于是两条教育各拿一份序号、都填上第一条的数据，预览里教育背景出现两遍。
  //    LCA 把「同一列表的容器」重新聚到一起，哪怕它们隔了两层。
  const lcaOf = (nodes) => {
    let cur = nodes[0];
    while (cur && !nodes.every((n) => cur.contains(n))) cur = cur.parentElement;
    return cur;
  };
  const boxesByList = new Map();
  for (const rec of boxes) {
    if (!boxesByList.has(rec.list)) boxesByList.set(rec.list, []);
    boxesByList.get(rec.list).push(rec.box);
  }
  const anchorOf = new Map();
  for (const [list, nodes] of boxesByList) {
    const n = nodes.length ? lcaOf(nodes) : null;
    anchorOf.set(list, n || page);
  }

  const ordMap = new Map();       // group|field -> 该字段在条目内是第几格
  const buckets = new Map();      // group -> 该组的**容器**（按文档顺序编号）
  for (const rec of boxes) {
    const anchor = anchorOf.get(rec.list) || page;
    const group = rec.list + '@' + pos.get(anchor);
    if (!buckets.has(group)) buckets.set(group, []);
    for (const s of rec.slots) {
      const key = group + '|' + s.field;
      const n = (ordMap.get(key) || 0) + 1;
      ordMap.set(key, n);
      // ⚠️ list / follow 必须带进每个 slot：下面要靠 slot.list 去 f[slot.list] 取
      //    真正的数据（漏了会得到 undefined，于是整份简历被清空 —— 而且探针
      //    只报「模板示例已替换」，看上去像成功）。按 s.follow 判断则要用 s0.follow。
      // ⚠️ ord（该字段在条目内是第几格）与 box（所属容器）**都必须带进对象**：
      //    ord 漏了 → 全部退回取第一个值（三条工作内容一模一样）；
      //    box 漏了 → 所有 slot 归到同一个 undefined 容器，条目序号只推进一次
      //    （六个技能分类全填成第一条）。两个都在 2026-10-09 实测踩过。
      buckets.get(group).push({
        ...s, ord: n, group, box: rec.box, list: rec.list, follow: rec.follow,
      });
    }
  }

  // ⚠️ **按容器编号**，而不是「主键 slot 推进游标」。
  //    两条数据的边界在不同模板里长得很不一样：
  //      · 01 的工作条目 = .hd（时间/公司）+ .jb（职位/工作内容）**两个容器**，
  //        而「时间」还排在「公司」前面 —— 按 slot 推进游标会把后半段算到下一条。
  //      · 09 的技能分类 = .tx9（技能类别 + 技能）**一个容器**，两个 slot 同属一条。
  //    容器级编号对两者都对：含主键的容器开启新的一条，不含主键的容器跟随上一条。
  const all = [];
  for (const [group, list] of buckets) {
    // 先按容器归拢，再按容器编号 —— **遍历的粒度必须是容器，不是 slot**。
    //   01 的一个工作条目横跨 .jb 里的 4 个 slot：若按 slot 逐个判断主键，
    //   「时间」（非主键，在「公司」前面）会被算成上一条，「公司」又把它推走。
    const byBox = new Map();
    for (const s of list) {
      if (!byBox.has(s.box)) byBox.set(s.box, []);
      byBox.get(s.box).push(s);
    }
    const order = [...byBox.keys()].sort((a, b) => pos.get(a) - pos.get(b));
    const isKeyBox = (b) => !byBox.get(b)[0].follow
      && byBox.get(b).some((s) => isPrimarySlot(s.el, s.list));

    // ⚠️ **父容器要跟随它子树里那条记录，而不是「上一个含主键的容器」**。
    //    05 的结构是 .blk（父）里套 .hd5b（子，含学校/公司）：父容器在文档序上
    //    **更靠前**，按「上一个」找会挂到上一条去 —— 结果两条教育各拿到一份
    //    数据，预览里教育背景出现两遍（2026-10-09 靠 __wzDebug 那张表定位到的）。
    const idxOf = new Map();
    let lastKeyIdx = -1;
    // ⚠️ **先给「含主键的容器」编号**，再按文档序处理（2026-10-11 修 NaN 事故）。
    //    父容器（03 的 .jb3 包着 .hd）在文档序上**排在子容器前面**：原来的写法要等
    //    遍历到子容器才把序号登记进 idxOf，父容器那一刻查 `idxOf.get(inner)` 得到
    //    undefined → `Math.max(0, undefined)` = **NaN** → 那一组槽位全部填成空串。
    //    症状很隐蔽：模板的「工作经历」区只剩公司名（其它槽位空）→ 空盒被清掉 →
    //    兜底补录再把正文补到页尾（用户看到的就是「工作经历跑到自我评价下边」）。
    //    编号与遍历顺序解耦之后，父容器拿到的一定是它子树里那条记录的序号。
    const keyBoxIdx = new Map();
    order.filter(isKeyBox).forEach((b, i) => keyBoxIdx.set(b, i));
    for (const box of order) {
      const slots = byBox.get(box);
      let at;
      if (keyBoxIdx.has(box)) {
        at = keyBoxIdx.get(box);
        lastKeyIdx = at;
      } else {
        const inner = order.find((k) => k !== box && box.contains(k) && isKeyBox(k));
        at = (inner && keyBoxIdx.has(inner)) ? keyBoxIdx.get(inner) : lastKeyIdx;
      }
      // 兜底：序号必须是个有限数，NaN 一旦漏出去就是「静默填空」
      if (!Number.isFinite(at)) at = Math.max(0, lastKeyIdx);
      idxOf.set(box, at);
      for (const s of slots) s.idx = Math.max(0, at);
      all.push(...slots);
    }
  }

  const rows = new Map();          // group#idx -> 这一条记录的全部字段
  for (const s of all) {
    const k = s.group + '#' + s.idx;
    if (!rows.has(k)) rows.set(k, []);
    rows.get(k).push(s);
  }
  const byGroup = new Map();
  for (const groupSlots of rows.values()) {
    const s0 = groupSlots[0];
    const item = (f[s0.list] || [])[s0.idx];
    for (const s of groupSlots) {
      s.el.textContent = itemAlive(item, groupSlots) ? itemValue(item, s.field, s.ord, s.list) : '';
    }
    const g = s0.group;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(groupSlots);
  }

  // 调试钩子：把「每个 group#idx 拿到第几条数据、几个字段」摊出来。
  // 条目错位（重复、串位）在成品里表现为「预览里教育出现两遍」，光看图很难
  // 判断是分组错了还是取数错了 —— 有了这张表一眼就能定位。留着不碍事。
  try {
    globalThis.__wzDebug = [...rows.entries()].map(
      ([k, v]) => k + ' → 库里有 ' + ((f[v[0].list] || []).length) + ' 条 / 本组 ' + v.length + ' 字段');
  } catch { /* 非浏览器环境忽略 */ }

  // 数据条目比模板示例多 → 克隆原型容器补上（模板通常只给 1–3 条示例）
  for (const [, lists] of byGroup) {
    const s0 = lists[0][0];
    const src = f[s0.list] || [];
    const maxIdx = Math.max(...lists.map((l) => l[0].idx));
    const proto = lists[lists.length - 1];
    const box = proto[proto.length - 1].box;
    if (!box || !box.parentElement) continue;
    const fields = proto.map((s) => ({ field: s.field, multi: s.multi }));
    for (let i = maxIdx + 1; i < src.length; i++) {
      if (!itemAlive(src[i], fields)) continue;
      const clone = box.cloneNode(true);
      cloneSlots(clone, proto, src[i]);     // 克隆后引用失效，按 data-ph + 标签重新对位
      // ⚠️ 必须插在原型**后面**，不是父容器末尾：09 的 .tx9 直接挂在 .m9 下，
      //    追加到父容器末尾会把第 4 个技能分类甩到「自我评价」底下
      //    （2026-10-09 实测：自我评价后面凭空多出四行同一条技能）。
      if (typeof box.after === 'function') box.after(clone);
      else box.parentElement.appendChild(clone);
    }
  }

  // ── 4.5 空条目整块删掉：模板只给几条示例，用户可能一条都没填 ──────────
  for (const box of new Set(boxes.map((b) => b.box))) {
    const els = [...box.querySelectorAll('[contenteditable][data-ph]')];
    if (els.length && els.every((x) => !x.textContent.trim())) box.remove();
  }

  // ── 4.6 清掉「整块空」的壳 ──────────────────────────────────────────
  // 认不出字段的 slot 已经被清空，但它的壳还在（09 教育下面四个空 bullet、
  // 荣誉区四个空点）—— 空壳比留示例更糟：用户会以为那儿本来该有内容。
  // 判据是「这个元素自己管着的那几个 slot 全空」。
  const shellHosts = new Set();
  for (const el of page.querySelectorAll('[data-ph]')) {
    const host = el.parentElement;
    if (host && host !== page) shellHosts.add(host);
  }
  for (const host of shellHosts) {
    const inner = [...host.querySelectorAll('[data-ph]')];
    if (inner.length && inner.every((x) => !x.textContent.trim())) host.remove();
  }

  // ── 5. 技能进度条（data-skill）────────────────────────────────────────
  fillSkillBars(page, f);

  // ── 6. 清掉编辑态痕迹 ────────────────────────────────────────────────
  // contenteditable 与 body.edit 那套高亮样式留着没意义，还会干扰选中。
  page.querySelectorAll('[contenteditable]').forEach((el) => {
    el.removeAttribute('contenteditable');
    el.classList.remove('slot');
  });

  // ── 6.3 给「已进版面」的元素打上章节标记（2026-10-11）───────────────────
  // 用途：分区导航把某一节隐藏/移除时，要精确知道哪些 DOM 属于它。
  //   只靠「章节标题」定位不够 —— 多数 wz 模板的证书 / 荣誉 / 技能**没有小节
  //   标题**（是侧栏里的点列表、进度条），照标题找等于找不到，用户点了删除
  //   预览也纹丝不动。标记打在两处：
  //     ① 标量 slot 本身（summary / 自我评价）；
  //     ② 每个**条目容器**（s.box，一条记录一块，含主键与要点）。
  //   属性只在 DOM 上、不进文字，所以 wzDropDuplicateText / wzMergeMissing 的
  //   文字判定完全不受影响。
  const tagEl = (el, key) => { if (el && el.setAttribute) el.setAttribute('data-wz-sec', key); };
  for (const s of scalars) {
    if (s.path === 'summary') tagEl(s.el, 'summary');
  }
  // 条目容器：**独占**（这个容器里的字段全属于同一个列表）才整块标记 ——
  // 整块摘掉会把标签也带走（「通用技能证书：」这种行首标签），最干净。
  // 一个容器装着两个章节的内容时（wz06 的 .hd6 = 项目名称 + 奖项）只逐个
  // 标槽位：整块摘会把另一半的内容也带走（实测隐藏项目经历连荣誉一起没了）。
  const boxKeys = new Map();
  for (const s of all) {
    if (!s.box) continue;
    if (!boxKeys.has(s.box)) boxKeys.set(s.box, new Set());
    boxKeys.get(s.box).add(s.list);
  }
  for (const [box, keys] of boxKeys) {
    if (keys.size === 1) { tagEl(box, [...keys][0]); continue; }
    for (const s of all) {
      if (s.box !== box) continue;
      const li = s.field === 'bullets' && s.el.closest ? s.el.closest('li') : null;
      tagEl(li || s.el, s.list);
    }
  }
  // ⚠️ 技能条标记**进度条本身**，不是它的父容器：wz01 的技能条直接挂在 .aside 下，
  //    标父容器 = 「隐藏技能」摘掉整个侧栏（实测误伤教育/证书/荣誉）。
  for (const bar of page.querySelectorAll('[data-skill]')) tagEl(bar, 'skills');
  for (const cat of page.querySelectorAll('[data-ph="分类"]')) tagEl(cat, 'skills');

  // ── 6.4 同一字段被模板摆成多份的，去重（2026-10-11）────────────────────
  // 先做去重再判「缺什么」：判定基准必须是用户最终看到的那份文字，
  // 否则刚被清掉的副本会被当成「没进版面」又补一遍（越补越重复）。
  wzDropDuplicateText(page);

  // ── 6.5 把模板没版位的内容插回对应章节（2026-10-11）────────────────────
  // 放在清编辑态之后：这时 page.textContent 就是「用户最终看到的文字」，
  // 拿它判断哪些内容没进版面最准。插入位置由章节顺序决定（不是堆在页尾）。
  wzMergeMissing(page, f, hid);

  // ── 6.6 摘掉被隐藏/移除的章节（2026-10-11）─────────────────────────────
  // ⚠️ 必须在补录**之后**：先摘会让「这一节不见了」被判成缺内容，补录又把
  //    它补回来（用户点了删除、预览里却复活）。顺序：去重 → 补录 → 摘除。
  wzRemoveHidden(page, hid);

  // ── 6.7 没内容的章节不留标题（2026-10-11）───────────────────────────────
  // 放在最后：补录可能刚给某一节补上内容，那时标题不该被当成「空标题」摘掉。
  wzDropEmptySectionHeads(page);

  const css = wzExtractCss(src);
  return '<style>' + css + '</style>'
    + '<div class="cvp cvp-wz' + cls + '"' + (lk.style ? ' style="' + lk.style + '"' : '') + '>'
    + page.innerHTML
    + '</div>';
}

/**
 * 同一页面上重复的长文本：只保留**文档序第一处**（2026-10-11）。
 *
 * 为什么需要：模板常把同一个字段摆好几个槽位 ——
 *   · wz02 的工作条目里「主要职责」(.lead) 与多个「工作内容」(.li2) 都映射到
 *     bullets，于是同一条要点被印两遍；
 *   · wz04 的「自我评价」摆了 3 个槽位，同一段简介印三遍。
 * 逐个模板打补丁改不完（还有 10 套 + 以后新增的），所以在渲染收尾统一去重：
 * 归一化后完全相同的**长文本**只留第一处，后出现的清空（列表行连壳一起摘掉）。
 *
 * ⚠️ 只对 ≥12 字的文本去重：姓名 / 电话 / 城市这些短字段在页眉与侧栏各印一次
 *    是版式需要，去重会把名字抹掉。归一化要连零宽字符一起去掉，否则看不出重。
 */
function wzDropDuplicateText(page) {
  const flat = (s) => String(s || '').replace(/[\s\u200b-\u200d\ufeff]+/g, '');
  const seen = new Set();
  for (const el of [...page.querySelectorAll('*')]) {
    if (el.children.length) continue;                     // 只看叶子
    const raw = String(el.textContent || '').trim();
    const key = flat(raw);
    if (key.length < 12) continue;                        // 短文本允许多处展示
    if (seen.has(key)) {
      const li = el.tagName === 'LI' ? el : el.closest('li');
      el.textContent = '';
      // 重复的那条如果是列表行，整行摘掉 —— 只清文字会留一个空项目符号
      if (li && !flat(li.textContent)) li.remove();
    } else {
      seen.add(key);
    }
  }
}

// ── 章节识别：模板标题写法 → cv-model 的章节 key ──────────────────────
// 「插到哪一节」全靠这张别名表。模板里的标题写法五花八门（工作经历 / 工作经验 /
// 实习经历…），统一归一到 key 之后，才能按简历的章节顺序决定插入位置。
const WZ_TITLE_ALIAS = {
  summary: ['个人介绍', '自我介绍', '自我评价', '个人简介', '个人简述', '自我描述'],
  competencies: ['核心能力', '个人能力', '能力清单', '核心技能', '能力特长'],
  education: ['教育背景', '教育经历', '学历背景', '学历', '教育'],
  // 「实践」这一类标题按**各区里的槽位**判归属，不按字面猜（2026-10-11 实测 10 套）：
  //   03/04/06/07 的 校内/校外/实习实践 区里放的是「时间/单位|组织/职位/工作内容」
  //   → experience；02 的「实践经历」区里是「项目名称/时间/成绩/工作内容」→ projects。
  //   不补这些别名，模板自己的标题就成了「没有内容的空标题」留在简历上。
  experience: ['工作经历', '实习经历', '工作经验', '实习与工作经历', '工作与实习经历',
    '相关经历', '实习经历与项目', '实习实践', '校内实践', '校外实践'],
  projects: ['项目经历', '项目经验', '项目实践', '主要项目', '项目', '实践经历'],
  skills: ['掌握技能', '专业技能', '技能特长', '技能水平', 'IT技能', '技能'],
  certifications: ['资格证书', '所获证书', '证书与资质', '证书', '技能证书', '证书奖励'],
  awards: ['个人荣誉', '荣誉奖项', '获奖情况', '所获荣誉', '奖项', '荣誉',
    '荣誉奖励', '获得荣誉', '奖项荣誉'],
  interests: ['兴趣爱好', '个人兴趣', '爱好', '兴趣'],
};

/** 章节的**权威顺序**（与 cv-model 的 cvToMarkdown 一致）—— 插入位置按它定。 */
const WZ_SEC_ORDER = ['summary', 'competencies', 'education', 'experience',
  'projects', 'skills', 'certifications', 'awards', 'interests'];

/** 把模板里所有「章节标题节点」找出来，按文档序返回 [{ key, el }]。 */
/**
 * 找出模板里的章节标题节点。
 * @param {boolean} [all] 默认按 key 去重（同一章节只认第一个 —— 补录要往「那一节」里插，
 *   只能有一个落点）；`all: true` 返回**全部**标题（同名多块也要），用于「空标题清理」：
 *   03 的「工作经历」和「校内实践」都是 experience 区，用户只有一条经历时第二个区是空的，
 *   它的标题必须能单独被摘掉。
 */
function wzSectionHeads(page, all) {
  const findKey = (t) => {
    for (const k of Object.keys(WZ_TITLE_ALIAS)) {
      if (WZ_TITLE_ALIAS[k].includes(t)) return k;
    }
    return '';
  };
  const out = [];
  const seen = new Set();
  for (const el of page.querySelectorAll('h1,h2,h3,h4,h5,div,span,p,b,strong,td')) {
    const t = (el.textContent || '').replace(/[\s\u200b-\u200d\ufeff]+/g, '').trim();
    if (!t || t.length > 8) continue;                   // 章节标题是短词
    // 字段标签不是章节标题：「学历：本科」「电话：138…」都带冒号/数字，排掉
    if (/[：:0-9（(]/.test(t)) continue;
    const k = findKey(t);
    if (!k || (!all && seen.has(k))) continue;          // 默认模式：同一章节只认第一个
    const inner = [...el.querySelectorAll('*')].some(
      (x) => (x.textContent || '').replace(/[\s\u200b-\u200d\ufeff]+/g, '').trim() === t);
    if (inner) continue;                                // 内部还有同样的字 = 包裹层
    seen.add(k);
    out.push({ key: k, el });
  }
  return out;
}

/** 标题样式原型（tagName + class）—— 让补出来的标题跟模板一致。 */
function wzTitleProto(heads) {
  const h = (heads || []).find((x) => x.el.className || x.el.tagName !== 'DIV');
  if (h) return { tag: h.el.tagName.toLowerCase(), cls: h.el.className || '' };
  return null;
}

/**
 * 「本节范围的末尾」参照物：本节标题之后、文档序上最近的另一个章节标题。
 *
 * 用来决定补录块插在哪 —— 见 wzMergeMissing 里 `own` 分支的注释。
 * 要点：
 *   · 参照物可能包在更深的一层里（如 `工作经历` 与 `校内实践` 各在自己的
 *     `.sec` 里），要逐层往上爬到**与本节点同父**的那一层，insertBefore 才合法；
 *   · 若下一个标题根本不在同一父容器下（比如落在左栏资料区），跳过它继续找 ——
 *     找不到就返回 null，调用方退回 appendChild（那时本节确实延伸到容器末尾）。
 *
 * @param {{key:string, el:Element}} own 本节标题（heads 里的一项）
 * @param {Array<{key:string, el:Element}>} heads 全部章节标题（文档序不限）
 * @returns {Element|null} 插到它**前面**的那个兄弟节点
 */
function wzSectionTailRef(own, heads) {
  if (!own || !own.el || !own.el.parentNode) return null;
  const home = own.el.parentNode;
  const ordered = [...(heads || [])].sort((a, b) => (
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  // ⚠️ 按 **DOM 元素**找下标，不能 `indexOf(own)` —— heads 与传入的 allHeads 是
  //    两次独立调用产出的**不同对象**（同一个标题，两个包装对象），比引用必然
  //    找不到，于是永远退回落点错误的 appendChild（改完没生效就是在踩这个）。
  const i = ordered.findIndex((h) => h.el === own.el);
  if (i < 0) return null;
  for (let k = i + 1; k < ordered.length; k++) {
    let ref = ordered[k].el;
    let guard = 0;
    // 爬到与本节标题同父的那一层（40 层足够深；防呆避免死循环）
    while (ref.parentNode && ref.parentNode !== home && guard++ < 40) ref = ref.parentNode;
    if (ref.parentNode === home) return ref;
  }
  return null;
}

/**
 * 按分区导航的**显隐**把章节从渲染结果里摘掉（2026-10-11）。
 *
 * 背景（用户报的 bug）：wz 这类「版式固定」模板的渲染器原来**完全没读 nav.hidden** ——
 * 用户在左边列表点垃圾桶把「证书」拿掉、确认框也说「已从简历中移除」，预览里
 * 证书却纹丝不动（默认那三套色系模板是读 nav 的，只有模板渲染这条路漏了）。
 *
 * 摘掉分三步（顺序不能换）：
 *   ① **标记槽位**：渲染时每个「条目容器 / 自我评价 / 技能条」都盖了
 *      data-wz-sec="<key>"，这里把对应元素整块摘掉。证书 / 荣誉 / 技能这类
 *      在多数模板里**没有小节标题**，只能靠这个标记找到（这也是第一版
 *      「按标题找」在 10 套模板里只对 1 套生效的原因）。
 *   ② **章节标题**：模板自带或补录加的小节标题（「个人荣誉」「教育背景」…）
 *      按别名表定位后一并摘掉 —— 光摘内容会留一个孤零零的标题。
 *   ③ **收壳**：把因此变空的容器一并收掉，否则留下一道空框，看着像渲染坏了。
 *      收壳有边界：只收「没有文字、没有图片、不含其它章节标题」的容器，
 *      且绝不动 page 自身（页眉、资料栏这些还有内容的东西不会被牵连）。
 */
function wzRemoveHidden(page, hidden) {
  if (!Array.isArray(hidden) || !hidden.length) return;
  const flat = (s) => String(s || '').replace(/[\s\u200b-\u200d\ufeff]+/g, '');
  const sel = (k) => '[data-wz-sec="' + k + '"]';

  for (const key of hidden) {
    const roots = [];                                     // 收壳的起点（摘掉前的父节点）

    // ① 标记过的槽位 / 条目容器（含补录块 —— 它带 data-wz-merge）
    const targets = [...page.querySelectorAll(sel(key)),
      ...page.querySelectorAll('[data-wz-merge="' + key + '"]')];
    for (const el of targets) {
      if (!el.parentNode) continue;
      // 先把**别的章节**的东西抢救出来：补录块可能被塞进了别的章节的容器里
      // （wz07 的 competencies 块落在 .sec7[education] 内，直接摘会把两节一起带走）。
      for (const d of [...el.querySelectorAll('[data-wz-sec],[data-wz-merge]')]) {
        const k = d.getAttribute('data-wz-sec') || d.getAttribute('data-wz-merge');
        if (k === key || !d.parentNode) continue;
        roots.push(el.parentNode);
        el.parentNode.insertBefore(d, el);
      }
      roots.push(el.parentNode);
      el.remove();
    }

    // ② 章节标题（别名表定位；模板没有这个标题就跳过）
    const heads = wzSectionHeads(page);
    const h = heads.find((x) => x.key === key);
    if (h && h.el.parentNode) {
      const parent = h.el.parentNode;
      const others = heads.filter((x) => x.key !== key);
      roots.push(parent);
      if (!others.some((x) => parent.contains(x.el))) {
        // 父容器里只有这一节 → 整个容器就是该节（01 的 .sec 是这种）
        parent.remove();
      } else {
        // 平铺结构：标题 + 后续同级节点（到下一个章节标题为止）。
        // 先在**未改动**的兄弟列表里算好要摘哪几个，再一次性摘 ——
        // 边摘边数会自我污染（本机铁律：COM 侧 fill 也踩过同一个坑）。
        const kids = [...parent.children];
        const stopEls = others.map((x) => x.el);
        // 「别的章节的标题」之外，**别的章节的内容块**（渲染时打的 data-wz-sec /
        // data-wz-merge 标记）同样是硬边界：证书 / 荣誉这类在多数模板里没有小节
        // 标题，若只按「下一个标题」收，隐藏上一节会把它们一起摘掉（实测 wz03）。
        const foreign = (x) => {
          const own = (e) => e.getAttribute && (e.getAttribute('data-wz-sec') || e.getAttribute('data-wz-merge') || '');
          if (own(x) && own(x) !== key) return true;
          return [...x.querySelectorAll('[data-wz-sec],[data-wz-merge]')].some((e) => own(e) !== key);
        };
        const isStop = (x) => stopEls.some((s) => x === s || x.contains(s) || s.contains(x)) || foreign(x);
        const i0 = kids.indexOf(h.el);
        const start = i0 >= 0 ? i0 : kids.findIndex((x) => x.contains(h.el));
        const picked = [];
        for (let i = start; i >= 0 && i < kids.length; i++) {
          const x = kids[i];
          if (i > start && isStop(x)) break;
          picked.push(x);
        }
        for (const x of picked) x.remove();
      }
    }

    // ③ 收壳：从每个摘除点的父容器往上，把「空了」的容器一并收掉
    for (const root of roots) {
      let cur = root;
      while (cur && cur !== page && cur.parentNode) {
        const hasText = flat(cur.textContent).length > 0;
        const hasImg = !!cur.querySelector('img');
        const hasHead = wzSectionHeads(page).some((x) => x.key !== key && cur.contains(x.el));
        if (hasText || hasImg || hasHead) break;
        const up = cur.parentNode;
        cur.remove();
        cur = up;
      }
    }
  }
}

/**
 * 没有内容的章节不留标题（2026-10-11）。
 *
 * 模板的章节标题是**设计的一部分**（写死在版式里），所以用户没填内容时，
 * 标题会孤零零地留在简历上 —— 「教育背景」下面一片空白，看着像渲染坏了。
 * 早先只清了「空的条目盒 / 空壳」，标题本身不在清理范围里。
 *
 * 判空的两种版式形态：
 *   · 平铺（03 的 MAIN 里一串 .se3）→ 看标题与**下一个章节标题之间**的兄弟
 *     有没有文字 / 图片；
 *   · 独立容器（01 的 .sec）→ 父容器里只有标题本身。
 * 只摘标题；空盒子前面几步已经清过了，这里不动别的。
 */
function wzDropEmptySectionHeads(page) {
  const flat = (s) => String(s || '').replace(/[\s\u200b-\u200d\ufeff]+/g, '');
  const heads = wzSectionHeads(page, true);             // 完整列表：同名多块都要判
  if (!heads.length) return;
  for (const h of heads) {
    const el = h.el;
    const parent = el.parentNode;
    if (!parent) continue;
    // 独立容器形态：父容器里只有这个标题 → 这一节是空的
    if (flat(parent.textContent) === flat(el.textContent)) { el.remove(); continue; }
    // 平铺形态：标题 → 下一个章节标题之间的兄弟有没有内容
    const stopEls = heads.filter((x) => x !== h).map((x) => x.el);
    const kids = [...parent.children];
    const i0 = kids.indexOf(el);
    if (i0 < 0) continue;
    let hasContent = false;
    for (let i = i0 + 1; i < kids.length; i++) {
      const x = kids[i];
      if (stopEls.some((s) => x === s || x.contains(s) || s.contains(x))) break;
      if (flat(x.textContent).length) { hasContent = true; break; }
      if (x.querySelector && x.querySelector('img')) { hasContent = true; break; }
    }
    if (!hasContent) el.remove();
  }
}

/**
 * 把「模板没有版位」的内容**插回模板的对应位置**（2026-10-11，二次改口径）。
 *
 * 第一版把补录内容堆在页尾；用户明确要求「不要补到下边，要在原简历模板上改」，
 * 所以改成按章节插回：
 *   · 缺整个小节（如模板没有「项目经历」）→ 按章节顺序插到**正确的位置**
 *     （工作在技能上面，项目就插在工作与技能之间），标题沿用模板标题样式；
 *   · 章节在、条目或要点缺 → 同样补一个条目，但插在**该章节的范围内**
 *     （紧跟原生条目之后、下一个章节标题之前），不再是页尾。
 * 判据只用主键与长文本，比对前去掉全部空白 —— 模板会把日期重排
 * （2023-09 → 2023.09），拿日期比对会误报成缺失而重复输出。
 */
function wzMergeMissing(page, form, hidden) {
  // 归一化：去掉所有空白**以及零宽字符**。模板注入的文字里可能混入 U+200B 这类
  // 不可见字符（复制粘贴带进来的），`\s` 不匹配它们 —— 只去空白的话，页面上明明
  // 有的文本会因为看不见的字符而整串对不上，被判成「缺失」并再补一遍（重复）。
  const flat = (s) => String(s == null ? '' : s).replace(/[\s\u200b-\u200d\ufeff]+/g, '');
  const pageTxt = flat(page.textContent || '');
  /**
   * 「这段内容进版面了吗？」
   *
   * ⚠️ 不能只做 `pageTxt.includes(值)`（2026-10-11 踩到）：模板渲染出的文字
   *    可能混入不可见字符或轻微改写（实测 wz02 的要点在 DIV.lead 里明明有，
   *    整串 includes 却是 false），判定成「缺失」就会**再补一遍 → 页面上出现
   *    重复内容**。长文本改用**滑窗片段命中率**：按 8 字一段取样，过半命中
   *    就认为已经渲染过了 —— 抗噪且不会把「真的没进版面」放过。
   *    短文本（≤12 字）仍要求全等（「甲公司」这种词一旦放宽就会误判）。
   */
  const appears = (v) => {
    const s = flat(v);
    if (!s) return true;                            // 空值不算缺失
    if (pageTxt.includes(s)) return true;
    if (s.length <= 12) return false;
    let hit = 0; let total = 0;
    for (let i = 0; i + 8 <= s.length; i += 8) {
      total += 1;
      if (pageTxt.includes(s.slice(i, i + 8))) hit += 1;
    }
    return total > 0 && hit / total >= 0.5;
  };
  const gone = (v) => { const s = flat(v); return !!s && !appears(s); };
  const T = CV_SECTION_TITLES_ZH;
  const f = form || {};
  const groups = {};                                     // key → [{ h, ul }]
  const push = (key, it) => { (groups[key] = groups[key] || []).push(it); };

  // 个人简介 / 核心能力（整段式）
  const sum = String(f.summary || '').trim();
  if (sum && gone(sum)) push('summary', { h: sum });
  const comps = (f.competencies || []).map((x) => String(x || '').trim()).filter((x) => x && gone(x));
  if (comps.length) push('competencies', { h: comps.join('；') });

  // 教育背景（主键 = 学校 / 学位；描述单独补 → 行首标出来源）
  for (const x of (f.education || [])) {
    const key = x.org || x.title;
    if (!String(key || '').trim()) continue;
    const desc = String(x.description || '').trim();
    if (gone(key)) {
      push('education', { h: [x.org, x.title, x.year].filter(Boolean).join('　'),
        ul: (desc && gone(desc)) ? [desc] : [] });
    } else if (desc && gone(desc)) {
      push('education', { h: [x.org, x.title].filter(Boolean).join('　'), ul: [desc] });
    }
  }

  // 实习与工作经历（主键 = 公司 / 职位；要点逐条补）
  for (const x of (f.experience || [])) {
    const key = x.company || x.role;
    if (!String(key || '').trim()) continue;
    const bullets = (x.bullets || []).filter(Boolean);
    const missBl = bullets.filter((b) => gone(b));
    if (gone(key)) {
      // 只带**没进版面**的要点：公司/职位没槽位被整条补时，已经填进模板的
      // 要点不能再印一遍（实测 wz02 因此出现重复的一行）。
      push('experience', {
        h: [x.company, x.role, x.dates].filter(Boolean).join('　'),
        ul: missBl,
      });
    } else if (missBl.length) {
      push('experience', { h: [x.company, x.role].filter(Boolean).join('　') + '（要点）', ul: missBl });
    }
  }

  // 项目经历
  for (const x of (f.projects || [])) {
    const key = x.name;
    if (!String(key || '').trim()) continue;
    const desc = String(x.description || '').trim();
    const bullets = (x.bullets || []).filter(Boolean);
    const missBl = bullets.filter((b) => gone(b));
    if (gone(key)) {
      push('projects', {
        h: [x.name, x.badge, x.tech].filter(Boolean).join('　'),
        ul: (desc && gone(desc) ? [desc] : []).concat(missBl),
      });
    } else if (missBl.length || (desc && gone(desc))) {
      push('projects', {
        h: [x.name, x.tech].filter(Boolean).join('　') + '（要点）',
        ul: (desc && gone(desc) ? [desc] : []).concat(missBl),
      });
    }
  }

  // 专业技能（进度条放不下的、类别对不上的都落这里）
  for (const s of (f.skills || [])) {
    const cat = String(s.category || '').trim();
    const items = (s.items || []).map((x) => String(x || '').trim()).filter(Boolean);
    const missItems = items.filter((x) => gone(x));
    if (!missItems.length && (!cat || !gone(cat))) continue;
    push('skills', { h: (cat ? cat + '：' : '') + (missItems.length ? missItems.join('、') : items.join('、')) });
  }

  // 证书 / 荣誉奖项
  for (const pair of [['certifications', f.certifications], ['awards', f.awards]]) {
    for (const x of (pair[1] || [])) {
      if (!String((x && x.title) || '').trim()) continue;
      if (gone(x.title)) push(pair[0], { h: [x.title, x.org, x.year].filter(Boolean).join('　') });
    }
  }

  // 被用户「移除 / 隐藏」的章节不参与补录（2026-10-11）：
  // 补录的使命是把**该显示却没进版面**的内容补上；用户主动关掉的章节本来就
  // 不该显示，补上去等于和垃圾桶按钮对着干（点了删除，预览里又被补回来）。
  if (Array.isArray(hidden)) {
    for (const k of hidden) delete groups[k];
  }

  const keys = Object.keys(groups);
  if (!keys.length) return false;

  const heads = wzSectionHeads(page);
  // 「本节范围」要按**全部**标题算落点（同名多块也算）：03 的「工作经历」与
  // 「校内实践」同属 experience 区，补工作经历要点时要停在「校内实践」之前。
  // 必须在任何插入之前先取好快照（插入的补块自己也可能带标题）。
  const allHeads = wzSectionHeads(page, true);
  const proto = wzTitleProto(heads);
  const esc1 = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const docOrder = (arr) => [...arr].sort((a, b) => (
    a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  // 缺失章节按章节顺序插入。
  //
  // ⚠️ 两栏模板（左栏资料/技能、右栏经历）的「文档序 ≠ 视觉序」：照文档序找
  //    anchor 会把补块插到原生章节**前面**去（实测 wz04 的 [projects] 跑到
  //    projects 之前）。所以分两种走法：
  //      · 本节原生已存在（模板有这个标题）→ 直接插进**该章节自己的容器**末尾，
  //        视觉上紧跟原生条目，最自然；
  //      · 本节原生不存在 → 才按文档序找「章节序更靠后」的标题当 anchor。
  for (const key of keys.sort((a, b) => WZ_SEC_ORDER.indexOf(a) - WZ_SEC_ORDER.indexOf(b))) {
    const myIdx = WZ_SEC_ORDER.indexOf(key);
    const own = heads.find((h) => h.key === key);
    const anchor = own ? null : docOrder(heads).find((h) => WZ_SEC_ORDER.indexOf(h.key) > myIdx);

    let h = '<div class="wz-merge-sec" data-wz-merge="' + key + '">';
    // 章节标题只在该章节**原生不存在**时才补：模板已有「教育背景」标题时
    // 再补一个，页面上就会出现两个同名小节（用户反馈过「内容重复」的观感）。
    // 原生存在 → 这批内容就是那一节的延续，直接接在原生条目后面。
    if (!own) {
      h += proto
        ? '<' + proto.tag + ' class="' + proto.cls + '">' + esc1(T[key] || key) + '</' + proto.tag + '>'
        : '<div class="wz-ap-t">' + esc1(T[key] || key) + '</div>';
    }
    for (const it of groups[key]) {
      h += '<div class="wz-ap-item">';
      if (it.h) h += '<div class="wz-ap-h">' + esc1(it.h) + '</div>';
      if (it.ul && it.ul.length) {
        h += '<ul>' + it.ul.map((x) => '<li>' + esc1(x) + '</li>').join('') + '</ul>';
      }
      h += '</div>';
    }
    h += '</div>';

    const holder = document.createElement('div');
    holder.innerHTML = h;
    const node = holder.firstElementChild;
    if (own) {
      // 本节原生存在 → 接在**本节范围的末尾**（原生条目之后、下一个章节标题之前）。
      //
      // ⚠️ 2026-10-12 修：原来直接 `own.el.parentNode.appendChild(node)`，前提是
      //    「标题与内容是同一个容器」—— 多数模板确实如此，但 **wz03 不是**：
      //    它的「工作经历 / 校内实践 / 证书奖励 / 自我评价」都是 MAIN.m3 的
      //    直接子元素。父容器横跨整栏，appendChild 就等于甩到**整栏最后**，
      //    于是「工作经历的要点」出现在自我评价下面 —— 用户报成
      //    「自我评价里多了一段工作经历」。同栏里还有更靠后的章节时，
      //    必须按文档序找本节之后的第一个标题当参照物。
      const ref = wzSectionTailRef(own, allHeads);
      if (ref) own.el.parentNode.insertBefore(node, ref);
      else own.el.parentNode.appendChild(node);
    } else if (anchor) {
      anchor.el.parentNode.insertBefore(node, anchor.el);
    } else {
      // 本节排在最后 → 挂到最后一个章节标题的同一个容器末尾
      const last = docOrder(heads).pop();
      if (last) last.el.parentNode.appendChild(node);
      else page.appendChild(node);
    }
  }
  return true;
}

/** 克隆出来的容器按同样的判定重新对上字段再填值。 */
function cloneSlots(clone, origSlots, item) {
  const all = [...clone.querySelectorAll('[contenteditable][data-ph]')];
  const ord = new Map();
  for (const s of origSlots) {
    const n = (ord.get(s.field) || 0) + 1;
    ord.set(s.field, n);
    // 原容器里的第 n 个同字段 slot → 克隆体里的第 n 个（判定口径与渲染时完全一致）
    const cands = all.filter((x) => {
      const r = resolveSlot(clone, x);
      return r && r.kind === 'list' && r.field === s.field;
    });
    const target = cands[n - 1];
    if (target) target.textContent = itemValue(item, s.field, n, s.list);
  }
}

/**
 * 技能进度条。模板里的技能名有两处写法：01 是 `<div class="t">Word：<span class="pct">90</span>`
 * （名字在文本里），05 是 `<div class="nm">Word</div>`。两种都收。
 * 映射到 skills[i].items —— 分类 slot（data-ph="分类"）决定它属于哪个分类。
 */
function fillSkillBars(page, form) {
  const bars = [...page.querySelectorAll('[data-skill]')];
  if (!bars.length) return;
  const cats = [...page.querySelectorAll('[contenteditable][data-ph="分类"]')];
  const skills = (form.skills || []).filter((x) => x);

  // 每个进度条归属到它前面最近的「分类」slot
  const bucket = new Map();
  for (const bar of bars) {
    let cat = '';
    for (const c of cats) {
      if (!(c.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      cat = c.textContent.trim();
    }
    if (!bucket.has(cat)) bucket.set(cat, []);
    bucket.get(cat).push(bar);
  }

  let k = 0;
  for (const [cat, list] of bucket) {
    const src = skills[k] || {};
    k++;
    // 分类名也是模板示例（「软件」「语言」）→ 一律换成用户填的分类
    cats.filter((c) => c.textContent.trim() === cat).forEach((c) => {
      c.textContent = String(src.category || '');
    });
    list.forEach((bar, i) => {
      const name = skillNameOf(bar);
      const item = (src.items || [])[i];
      setBarText(bar, name, String(item == null ? '' : item).trim());
    });
    // 数据里的技能多于模板里的条数 → 克隆最后一条
    const extra = (src.items || []).slice(list.length);
    for (const it of extra) {
      const clone = list[list.length - 1].cloneNode(true);
      setBarText(clone, skillNameOf(list[list.length - 1]), String(it).trim());
      list[list.length - 1].parentElement.appendChild(clone);
    }
  }
}

/**
 * 从进度条里读出技能名。填值时**以用户数据为准**，这个名字只是「用户没填时
 * 至少显示点什么」的兜底 —— 模板示例技能（Word/Excel/PPT）不该留在简历上，
 * 所以上层只在拿到用户技能时才调 setBarText。
 */
function skillNameOf(bar) {
  const nm = bar.querySelector('.nm');
  if (nm) return nm.textContent.trim();
  const t = bar.querySelector('.t');
  return t ? String(t.textContent).replace(/[\d\s%：:]+$/, '').trim() : '';
}

function setBarText(bar, origName, value) {
  const t = bar.querySelector('.t');
  if (t) {
    // ⚠️ `pct` 里那个百分比是**模板示例**，而简历模型里技能没有熟练度字段。
    //    留着它等于在用户的简历上凭空断言「他 Java 90 分」—— 整段摘掉，
    //    只剩技能名（进度条本身保留，它是版式的一部分）。
    t.textContent = value || origName;
    return;
  }
  const nm = bar.querySelector('.nm');
  if (nm) nm.textContent = value || origName;
}

/** 简历里有没有内容（空的时候显示占位，而不是画一张白纸）。 */
export function wzHasContent(form) {
  const f = form || {};
  if ((f.candidate || {}).name || (f.candidate || {}).phone || (f.candidate || {}).email) return true;
  if (f.summary) return true;
  return ['education', 'experience', 'projects', 'awards', 'certifications', 'skills']
    .some((k) => (f[k] || []).length);
}