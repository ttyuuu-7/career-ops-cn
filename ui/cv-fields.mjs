// ui/cv-fields.mjs — 简历「基本信息」字段行的顺序与显隐（2026-10-09）
//
// 接入来源：魔方简历（magicv.art）编辑区右侧的「基础字段」区块 ——
// 一行一个字段：拖拽手柄 + 字段图标 + 字段名 + 输入框 + 眼睛。
// 那边是「用户可自建字段」的自由模型，本项目的基本信息是**固定 schema**
//（candidate.name / email / phone / location / intent / degree / age / hobbies），
// 所以这里只搬**交互范式**（可拖拽排序、可单独隐藏），不搬那套自定义字段引擎。
//
// 三处共读一份（与 ui/cv-nav.mjs、ui/cv-look.mjs 同一个理由）：
//   ① 编辑页「基础字段」的字段行  ② HTML 预览 renderCvVisual  ③ Word 导出
// 任何一处自己再排一遍顺序，就会出现「表单里排在前面的字段，简历上跑到后面去了」
// 这种没人会去查的静默不一致。
//
// ⚠️ 语义边界（与 cv-nav.mjs 完全一致）：隐藏**只影响预览与导出**。
//    值始终完整留在 cv.md 里 —— 为了投某一家不写「年龄」点一下眼睛，
//    不该把年龄这条信息从简历素材里抹掉。
//
// ⚠️ 默认值恰好等于改造前的呈现（order = 表单原本的排列顺序、hidden = 空），
//    所以「没动过」的简历渲染结果与本改造之前一致（回归安全网）。

/**
 * 基本信息字段表。数组顺序 = 默认顺序。
 *
 * `key` 直接对应 cv.md / 表单里的 `candidate.<key>` 路径 —— 不另造一层映射，
 * 免得将来加字段时漏改某一处。`icon` 用 emoji：参考站那排彩色图标就是 emoji，
 * 项目铁律又是不引 CDN / 不打包字体，emoji 是唯一能做到彩色又不加依赖的选项。
 */
export const CV_BASIC_FIELDS = [
  { key: 'name', label: '姓名', icon: '👤', ph: '张三' },
  { key: 'intent', label: '求职意向', icon: '🎯', ph: '如 Java 后端开发 / 数据分析' },
  { key: 'phone', label: '手机', icon: '📞', ph: '1774985444' },
  { key: 'email', label: '邮箱', icon: '✉️', ph: 'zhangsan@163.com' },
  { key: 'location', label: '所在城市', icon: '📍', ph: '北京' },
  { key: 'gender', label: '性别', icon: '🚻', ph: '男 / 女' },
  { key: 'birthday', label: '生日', icon: '🎂', ph: '如 1998-05，或 2000-05-20' },
  { key: 'native', label: '籍贯', icon: '🏠', ph: '如 广东深圳' },
  { key: 'political', label: '政治面貌', icon: '⚖️', ph: '如 共青团员' },
  { key: 'major', label: '专业', icon: '📚', ph: '如 计算机科学与技术' },
  { key: 'degree', label: '学历', icon: '🎓', ph: '本科 / 硕士 / 博士' },
  { key: 'age', label: '年龄', icon: '🕐', ph: '如 24' },
  { key: 'height', label: '身高', icon: '📏', ph: '如 175cm' },
  { key: 'hobbies', label: '兴趣爱好', icon: '⭐', ph: '用、分隔，如 篮球、围棋、摄影' },
];

/** 全部基础字段 key（默认顺序）。 */
export const CV_BASIC_KEYS = CV_BASIC_FIELDS.map((f) => f.key);

/**
 * 头像（证件照）的伪 key。
 *
 * 它在界面上单独占「资料」区块、不在「基础字段」列表里（参考站也是这么分的），
 * 但「要不要在简历上显示头像」这件事和字段显隐是同一类开关，共用一份 hidden ——
 * 拆成两个存储只会让「点眼睛 → 只写了一半」这种问题有地方发生。
 * 它**不进 order**：资料区块固定在基础字段之上。
 */
export const CV_FIELD_PHOTO = 'photo';

const KNOWN_KEYS = new Set(CV_BASIC_KEYS.concat([CV_FIELD_PHOTO]));

/** 默认：按字段表的顺序、全部显示。 */
export function defaultCvFields() {
  return { order: CV_BASIC_KEYS.slice(), hidden: [] };
}

/** 单个字段的定义（未知 key 返回 null —— 调用方自己决定怎么兜底）。 */
export function cvBasicField(key) {
  return CV_BASIC_FIELDS.find((f) => f.key === key) || null;
}

/** 字段中文名。未知 key 原样返回（不抛错：预览画不出来比整页崩好）。 */
export function cvFieldLabel(key) {
  if (key === CV_FIELD_PHOTO) return '头像';
  const hit = cvBasicField(key);
  return hit ? hit.label : String(key);
}

/**
 * 容错归一：只认已知 key（脏数据丢弃），缺失的按默认顺序补到末尾。
 *
 * 补而不是拒绝 —— 将来新增字段（比如「政治面貌」）时，用户磁盘上那份
 * cv-fields.json 里没有它，补到末尾就自动可见；反过来判为非法会让用户
 * 好不容易拖出来的顺序莫名其妙全部重置。
 */
export function normalizeCvFields(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const order = [];
  for (const k of (Array.isArray(src.order) ? src.order : [])) {
    // 头像不进 order：界面里它固定在上面的「资料」区块
    if (k === CV_FIELD_PHOTO) continue;
    if (KNOWN_KEYS.has(k) && !seen.has(k)) { seen.add(k); order.push(k); }
  }
  for (const k of CV_BASIC_KEYS) if (!seen.has(k)) order.push(k);
  const hidden = [];
  for (const k of (Array.isArray(src.hidden) ? src.hidden : [])) {
    if (KNOWN_KEYS.has(k) && !hidden.includes(k)) hidden.push(k);
  }
  return { order, hidden };
}

/** 单个字段是否被隐藏。 */
export function isCvFieldHidden(fields, key) {
  return normalizeCvFields(fields).hidden.includes(key);
}

/** 拖拽排序：把 from 位置的 key 挪到 to 位置，返回新的 order（不改原数组）。 */
export function moveCvField(order, from, to) {
  const list = Array.isArray(order) ? order.slice() : CV_BASIC_KEYS.slice();
  if (from < 0 || from >= list.length) return list;
  const dst = Math.max(0, Math.min(list.length - 1, to));
  const [k] = list.splice(from, 1);
  list.splice(dst, 0, k);
  return list;
}

/** 切换某个字段的显隐，返回新的 hidden 数组。 */
export function toggleCvField(hidden, key) {
  const list = Array.isArray(hidden) ? hidden.slice() : [];
  const i = list.indexOf(key);
  if (i >= 0) list.splice(i, 1); else list.push(key);
  return list;
}

/**
 * 预览 / 导出的「页眉信息行」该输出哪些值。
 *
 * 规则集中在这一处，是因为预览和 Word 两边的组成完全一样 ——
 * 分开写必然出现「预览里有手机号、导出的 Word 里没有」。
 *
 * - 跳过 `name`：它由页眉的大标题单独渲染，不该在信息行里重复一遍。
 * - 跳过 `intent`：求职意向有它自己的位置（标题下方一行）。混进
 *   「北京 · 本科 · 178…」这种信息行里，会把一个短句塞进一串词中间。
 * - 跳过隐藏项与空值。
 */
export function cvHeaderValues(candidate, fields) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const f = normalizeCvFields(fields);
  const hid = new Set(f.hidden);
  const out = [];
  for (const k of f.order) {
    if (k === 'name' || k === 'intent' || hid.has(k)) continue;
    const v = c[k] == null ? '' : String(c[k]).trim();
    if (v) out.push(v);
  }
  return out;
}

/** 求职意向：显式填了的 candidate.intent 优先，其次回落简历对象的目标岗位。 */
export function cvHeaderRole(candidate, fallback, fields) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const f = normalizeCvFields(fields);
  const own = f.hidden.includes('intent') ? '' : String(c.intent == null ? '' : c.intent).trim();
  return own || String(fallback == null ? '' : fallback).trim();
}

/** 头像是不是被用户用眼睛关掉了。 */
export function isCvPhotoHidden(fields) {
  return normalizeCvFields(fields).hidden.includes(CV_FIELD_PHOTO);
}

/**
 * 头像是否要在简历上显示（填了图 + 没被眼睛关掉）。
 *
 * ⚠️ 只给**预览**用。导出那边别用它做判据：那里的 photoSrc 是调用方抓好的
 *    dataURL（「表单项里的图源」），拿这个函数去门控等于用「表单里有没有 photo
 *    路径」去否决一个已经准备好的图源 —— 一条真的会丢图的路径（2026-10-09 探针抓到）。
 *    那边要的是 isCvPhotoHidden。
 */
export function cvHeaderPhoto(candidate, fields) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  if (isCvPhotoHidden(fields)) return '';
  return String(c.photo == null ? '' : c.photo);
}
