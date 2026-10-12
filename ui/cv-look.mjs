// ui/cv-look.mjs — 简历「外观」设置（主题色 / 排版 / 间距 / 模式）
//
// 接入来源：魔方简历（magicv.art）工作台左栏的那几张设置卡
// （布局 / 主题色 / 排版 / 间距 / 模式）。只搬**功能与参数口径**，代码全部重写
// —— 那边是 Vite + React，本项目是零依赖浏览器模块，没有可复用的形态。
//
// 与「模板」（ui/cv-templates.mjs）的分工：
//   模板 = 版式的**结构**（单栏/双栏、标题画线还是画框），换模板像换一副骨架；
//   外观 = 骨架之上的**样式数值**（主色、字体、字号、行高、间距）。
// 所以两者分开存、分别生效、互不覆盖 —— 换模板不该把调好的字号冲掉，
// 调字号也不该把选好的模板改掉。
//
// 三处共读一份（与 ui/cv-nav.mjs 同一个理由）：
//   ① 编辑页左栏的设置卡  ② HTML 预览 renderCvVisual  ③ Word 导出 cvFormToWordHtml
// 任何一处自己再解释一遍这些数字，导出的 Word 迟早和预览长得不一样。
//
// ⚠️ 全部走 CSS 变量，且**默认值恰好等于改造前的现值**：没调过的项不产出变量，
//    渲染结果与本改造之前逐像素一致（这条是回归安全网，别随手改默认值）。

/** 外观设置的全量默认值。0 / '' / false = 用模板与页面自带的样式。 */
export const CV_LOOK_DEFAULTS = {
  accent: '',        // 主色；'' = 跟随模板/系统
  font: '',          // 字体 id（见 CV_LOOK_FONTS）；'' = 默认
  lineHeight: 0,     // 行高倍数；0 = 默认（1.7）
  baseSize: 0,       // 正文字号 px；0 = 默认
  titleSize: 0,      // 模块标题字号 px；0 = 默认
  itemTitleSize: 0,  // 模块项一级标题字号 px；0 = 默认
  margin: 0,         // 页边距 px；0 = 用纸自带的留白
  moduleGap: 0,      // 模块间距 px；0 = 默认
  paraGap: 0,        // 段落间距 px；0 = 默认
  // ⚠️ 下面三个字段的**界面入口已于 2026-10-09 按用户要求删掉**（左栏那张「模式」卡）。
  //    字段本身留着：老简历的 data/cv-look.json 里可能已经开了其中一个，预览与导出
  //    还得照着渲染 —— 删字段会让那些简历的外观**静默变化**。
  //    与「微信 / LinkedIn 从表单撤下、模型层保留」是同一个做法。
  iconMode: false,   // 图标模式：模块标题前加一个小方块
  subCenter: false,  // 副标题居中：求职意向一行居中
  longTitle: false,  // 长标题模式：条目标题与时间各占一行
  // 页眉布局 = 证件照的位置。**字段保留、入口已删**（2026-10-09）：
  //   ''  = 头像在右（默认 = 改造前的现状，见文件头的回归安全网）
  //   'left'   = 头像在左，姓名与联系方式靠右
  //   'center' = 头像在姓名上方居中
  // 表单上那个三选一按钮组已按用户要求撤下 —— 但用户之前若设过 left/center，
  // 预览和 Word 导出仍按这个值渲染，所以字段和下面 cvp-hl-* 的渲染逻辑都留着。
  headerLayout: '',
};

/** 主题色色板（对齐截图：两行共 10 个）。 */
export const CV_LOOK_ACCENTS = [
  '#111827', '#374151', '#6B7280', '#9CA3AF', '#D1D5DB',
  '#2563EB', '#DC2626', '#EA580C', '#7C3AED', '#059669',
];

/**
 * 可选字体。
 *
 * ⚠️ 只列「国内 Windows / macOS 上大概率已装」的字体，**不引任何 CDN**（项目铁律：
 * 零 CDN，否则断网/内网就掉字体）。装了的用上，没装的由 stack 里的后备项接管，
 * 不会渲染成方块。参考站用的是自带 webfont 的「阿里巴巴普惠体 / MiSans」，
 * 那需要打包字体文件，本机没有授权文件，所以不列。
 */
// ⚠️ 字体名**一律不加引号**：CSS 本来就允许无引号的多词字体名
// （`font-family: Microsoft YaHei, sans-serif` 是合法写法），而带引号会把值里
// 塞进 `"`。这些值最终要内联进 `style="--cvp-font:…"` 这个 **HTML 属性**，
// 一个裸引号就会把属性提前截断 —— 后面的变量（行高、字号、间距）全部静默丢失，
// 而前面那些看着还好好的，是极难定位的一类 bug（2026-10-09 实测踩过）。
export const CV_LOOK_FONTS = [
  { id: '', label: '默认（系统无衬线）', stack: '' },
  { id: 'yahei', label: '微软雅黑', stack: 'Microsoft YaHei,PingFang SC,Hiragino Sans GB,sans-serif' },
  { id: 'source', label: '思源黑体 / 苹方', stack: 'Source Han Sans SC,Noto Sans CJK SC,PingFang SC,Microsoft YaHei,sans-serif' },
  { id: 'hei', label: '黑体', stack: 'SimHei,Heiti SC,Microsoft YaHei,sans-serif' },
  { id: 'song', label: '宋体', stack: 'SimSun,Songti SC,serif' },
  { id: 'kai', label: '楷体', stack: 'KaiTi,Kaiti SC,serif' },
  { id: 'times', label: 'Times New Roman（西文为主）', stack: 'Times New Roman,Times,Microsoft YaHei,serif' },
];

const FONT_BY_ID = new Map(CV_LOOK_FONTS.map((f) => [f.id, f]));
export const cvLookFontStack = (id) => (FONT_BY_ID.get(String(id || '')) || FONT_BY_ID.get('')).stack;
export const cvLookFontLabel = (id) => (FONT_BY_ID.get(String(id || '')) || FONT_BY_ID.get('')).label;

/** 数值收敛：0 一律保留为「未设置」；非 0 时夹到 [min,max] 并取整。 */
function num(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}
/** 行高保留一位小数（1.4 / 1.8 这种）。 */
function lh(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 0;
  return Math.min(2.6, Math.max(1.2, Math.round(n * 10) / 10));
}

/**
 * 容错归一化：脏值一律回落到默认，不抛错。
 * 关键是**不要把非法值改成"一个看起来合理的数"** —— 用户看到预览突然变了
 * 却不知道为什么，比看到设置被重置更难排查。
 */
export function normalizeCvLook(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    accent: /^#[0-9a-fA-F]{6}$/.test(String(s.accent || '')) ? String(s.accent).toUpperCase() : '',
    font: FONT_BY_ID.has(String(s.font || '')) ? String(s.font || '') : '',
    lineHeight: lh(s.lineHeight),
    baseSize: num(s.baseSize, 10, 20),
    titleSize: num(s.titleSize, 12, 28),
    itemTitleSize: num(s.itemTitleSize, 11, 24),
    margin: num(s.margin, 0, 60),
    moduleGap: num(s.moduleGap, 0, 40),
    paraGap: num(s.paraGap, 0, 24),
    iconMode: !!s.iconMode,
    subCenter: !!s.subCenter,
    longTitle: !!s.longTitle,
    headerLayout: ['left', 'center'].includes(String(s.headerLayout || ''))
      ? String(s.headerLayout) : '',
  };
}

/** 归一化后是否存在「非默认」的设置（用来决定要不要注入 style）。 */
export function cvLookIsDefault(look) {
  const L = normalizeCvLook(look);
  return Object.keys(CV_LOOK_DEFAULTS).every((k) => L[k] === CV_LOOK_DEFAULTS[k]);
}

/**
 * 预览用的根节点属性：CSS 变量 + 模式类名。
 * 返回 { style, cls } —— style 是要内联到 .cvp 上的字符串（可能为空）。
 *
 * 只输出**用户真的调过**的项，其余留给 style.css 里的默认值：
 * 这样「没动过设置」的渲染结果与本改造之前逐像素一致。
 */
export function cvLookRootAttrs(look) {
  const L = normalizeCvLook(look);
  const v = [];
  if (L.accent) v.push('--cvp-accent:' + L.accent);
  const stack = cvLookFontStack(L.font);
  if (stack) v.push('--cvp-font:' + stack);
  if (L.lineHeight) v.push('--cvp-lh:' + L.lineHeight);
  if (L.baseSize) v.push('--cvp-fs:' + L.baseSize + 'px');
  if (L.titleSize) v.push('--cvp-h3:' + L.titleSize + 'px');
  if (L.itemTitleSize) v.push('--cvp-t:' + L.itemTitleSize + 'px');
  if (L.moduleGap) v.push('--cvp-sec-gap:' + L.moduleGap + 'px');
  if (L.paraGap) v.push('--cvp-p-gap:' + L.paraGap + 'px');
  const cls = [];
  // 行高必须配一个类名：正文 p 的默认行高是 1.7、列表 li 是 1.65，本来就不同，
  // 统一成一个变量会让"没调过"的渲染立刻变样。所以只在真设了行高时才挂这个类，
  // style.css 里所有行高覆盖都写在 `.cvp-lh` 下面。
  if (L.lineHeight) cls.push('cvp-lh');
  if (L.iconMode) cls.push('cvp-icon');
  if (L.subCenter) cls.push('cvp-subcenter');
  if (L.longTitle) cls.push('cvp-longtitle');
  // 页眉布局：'' 是默认（头像在右），不挂类 —— 一挂就动了老简历的样子。
  if (L.headerLayout) cls.push('cvp-hl-' + L.headerLayout);
  return { style: v.join(';'), cls: cls.join(' ') };
}

/**
 * Word 导出追加的 CSS。
 *
 * 导出的是 HTML 伪 .doc（见 cv-word.mjs 头部说明），所以这里就是给 Word 看的
 * CSS。用 pt 而不是 px：Word 对 pt 的处理比 px 稳（px 在 Word 里按 96dpi 折算，
 * 不同版本偶尔差一档）。1px ≈ 0.75pt。
 *
 * 页边距走 @page —— 那是 Word 真正认的页边距，用 padding 只会让文字挤在纸中间
 * 而页边距纹丝不动。
 */
export function cvLookWordCss(look) {
  const L = normalizeCvLook(look);
  const r = [];
  const pt = (px) => (Math.round(px * 0.75 * 10) / 10) + 'pt';
  if (L.accent) {
    r.push('h2,.role{color:' + L.accent + '}'
      + 'h2{border-color:' + L.accent + '}');
  }
  const stack = cvLookFontStack(L.font);
  if (stack) r.push('body{font-family:' + stack + '}');
  if (L.lineHeight) r.push('body{line-height:' + L.lineHeight + '}');
  if (L.baseSize) r.push('body{font-size:' + pt(L.baseSize) + '}');
  if (L.titleSize) r.push('h2{font-size:' + pt(L.titleSize) + '}');
  if (L.itemTitleSize) r.push('h3,.item-head{font-size:' + pt(L.itemTitleSize) + '}');
  if (L.moduleGap) r.push('h2{margin-top:' + pt(L.moduleGap) + '}');
  if (L.paraGap) r.push('p{margin-bottom:' + pt(L.paraGap) + '}');
  if (L.margin) {
    const mm = Math.round(L.margin * 0.2646 * 10) / 10;   // px → mm
    r.push('@page{margin:' + mm + 'mm}');
  }
  // 页眉布局（证件照位置）。Word 里做不到「文字环绕图片」，只能靠图片自身
  // 的段落对齐来近似 —— 但至少「头像在左 / 居中 / 在右」三态看得出来，
  // 与预览的口径保持一致（.photo 的默认 text-align:right 写在 WORD_STYLE 里）。
  if (L.headerLayout === 'left') r.push('.photo{text-align:left}');
  if (L.headerLayout === 'center') r.push('.photo{text-align:center}');
  return r.join('');
}
