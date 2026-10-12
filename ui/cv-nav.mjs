// ui/cv-nav.mjs — 简历分区导航（章节顺序与显隐）
//
// 接入来源：github.com/ThanosKa/magic-resume 的编辑器分区导航
// （components/editor/section-tabs.tsx：可拖拽排序 + 眼睛图标显隐）。
// 这边是**重新实现**，不是搬运代码 —— 那份是 Next.js + Radix + framer-motion
// 的组件，本项目是零依赖浏览器模块，两者没有可复用的形态；移植的是**交互范式**。
//
// 为什么单独一份：同一套顺序要被三处读到 ——
//   ① 编辑区左侧的导航列表（ui/app.js 的 VIEWS.cv）
//   ② HTML 实时预览（ui/app.js 的 renderCvVisual）
//   ③ Word 导出（ui/cv-word.mjs 的 cvFormToWordHtml）
// 三处各写一份顺序，迟早出现「预览里有、导出的 Word 里没有」这种静默不一致。
//
// 形态：
//   - 「基本信息」固定在导航最上方，不可排序、不可隐藏 —— 它就是简历页眉
//     （姓名 / 联系方式），拿掉之后预览只剩一具没有抬头的躯干。
//   - 其余 8 个章节可拖拽排序、可单个隐藏。
//
// ⚠️ 语义边界（重要）：隐藏**只影响预览与导出**，内容始终完整保留在 cv.md 里。
// 「隐藏 = 从简历里删掉」是另一个动作（在章节卡里删条目 / 删整节），两者不能混。
// 这样用户为了「投这家先不写项目经历」点一下眼睛，不会因为看了眼预览就把素材弄丢。

/** 「基本信息」的固定 key。它不进 order，也不进 hidden。 */
export const CV_NAV_BASIC = 'basic';

/**
 * 可排序 / 可隐藏的章节。数组顺序 = 默认顺序，
 * 与 ui/cv-model.mjs 的 cvToMarkdown() 章节顺序保持一致
 * （简介 → 核心能力 → 教育 → 实习与工作 → 项目 → 技能 → 证书 → 奖项）。
 */
export const CV_NAV_SECTIONS = [
  { key: 'summary', label: '个人简介' },
  { key: 'competencies', label: '核心能力' },
  { key: 'education', label: '教育背景' },
  { key: 'experience', label: '实习与工作经历' },
  { key: 'projects', label: '项目经历' },
  { key: 'skills', label: '专业技能' },
  { key: 'certifications', label: '证书' },
  { key: 'awards', label: '荣誉奖项' },
];

/** 全部可排序 key（按默认顺序）。 */
export const CV_NAV_KEYS = CV_NAV_SECTIONS.map((s) => s.key);

/** 默认导航：全显示、按默认顺序。 */
export function defaultCvNav() {
  return { order: CV_NAV_KEYS.slice(), hidden: [] };
}

/**
 * 容错归一：只认已知 key（脏数据一律丢弃 —— 例如去掉某个章节后老配置里的残留），
 * 缺失的按默认顺序补到末尾。
 *
 * 为什么补而不是拒绝：将来新增章节（比如「论文发表」）时，用户磁盘上那份
 * cv-nav.json 里没有它 —— 补到末尾就自动可见，不需要写迁移脚本；反过来把
 * 整份配置判为非法会让用户的自定义顺序莫名其妙全部重置。
 */
export function normalizeCvNav(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const order = [];
  for (const k of (Array.isArray(src.order) ? src.order : [])) {
    if (CV_NAV_KEYS.includes(k) && !seen.has(k)) { seen.add(k); order.push(k); }
  }
  for (const k of CV_NAV_KEYS) if (!seen.has(k)) order.push(k);
  const hidden = [];
  for (const k of (Array.isArray(src.hidden) ? src.hidden : [])) {
    if (CV_NAV_KEYS.includes(k) && !hidden.includes(k)) hidden.push(k);
  }
  return { order, hidden };
}

/** 章节中文名。未知 key 原样返回（不抛错 —— 预览画不出来比整页崩好）。 */
export function cvNavLabel(key) {
  if (key === CV_NAV_BASIC) return '基本信息';
  const hit = CV_NAV_SECTIONS.find((s) => s.key === key);
  return hit ? hit.label : String(key);
}

/** 按 order + hidden 算出「要渲染哪些章节」，顺序即返回顺序。 */
export function visibleCvSections(nav) {
  const n = normalizeCvNav(nav);
  const hid = new Set(n.hidden);
  return n.order.filter((k) => !hid.has(k));
}

/** 单个章节是否被隐藏。 */
export function isCvSectionHidden(nav, key) {
  return normalizeCvNav(nav).hidden.includes(key);
}

/** 拖拽排序：把 from 位置的 key 挪到 to 位置，返回新的 order（不改原数组）。 */
export function moveCvSection(order, from, to) {
  const list = Array.isArray(order) ? order.slice() : CV_NAV_KEYS.slice();
  if (from < 0 || from >= list.length) return list;
  const dst = Math.max(0, Math.min(list.length - 1, to));
  const [k] = list.splice(from, 1);
  list.splice(dst, 0, k);
  return list;
}

/** 切换某个章节的显隐，返回新的 hidden 数组。 */
export function toggleCvSection(hidden, key) {
  const list = Array.isArray(hidden) ? hidden.slice() : [];
  const i = list.indexOf(key);
  if (i >= 0) list.splice(i, 1); else list.push(key);
  return list;
}
