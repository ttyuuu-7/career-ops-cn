// ui/followup-format.mjs — 跟进记录的展示常量 + 写盘格式（纯常量，**零 import**）
//
// ── 为什么必须单独一个文件，而不是都放在 followup-cn.mjs ──
//
// app.js 是浏览器模块，它 import 的东西浏览器必须能解析。而 followup-cn.mjs
// 要做节奏计算，它 import 根目录的 followup-cadence.mjs —— 那一份又 import
// js-yaml / node:fs / tracker-utils.mjs。浏览器里没有这些，于是：
//
//     浏览器请求 /followup-cadence.mjs → 404 → 整个 app.js 模块图加载失败
//     → 页面全白（而且控制台只报 404，看起来像静态资源没配好）
//
// 踩过一次了（`/batch-jd.mjs` 忘了加白名单，页面空白）。这里的规矩因此定死：
//
//     能被 app.js import 的模块，必须零依赖（只有相对路径 import 也不允许，
//     因为 `../x.mjs` 会被浏览器解析成站点根路径，而根路径不在静态白名单里）。
//
// 所以：**展示常量与写盘格式放这里**（纯字符串/正则，零依赖），
// 分析逻辑留在 followup-cn.mjs（Node 侧专用，不进静态白名单）。
// 两份东西不重复定义 —— followup-cn.mjs 从这里 import 再 re-export，
// 保证「页面上写的中文」和「写进文件的值」永远是同一份定义。

// ── 紧急度 ───────────────────────────────────────────────────────────────
/** 排序权重：越靠前越该先动手（与 core 的排序口径一致）。 */
export const URGENCY_RANK = { urgent: 0, overdue: 1, waiting: 2, cold: 3 };

/** 紧急度的中文说法。'retired' 不会出现在清单里（被过滤掉了），留着只为防御。 */
export const URGENCY_ZH = {
  urgent: '马上跟进',
  overdue: '已超期',
  waiting: '等回应',
  cold: '已转冷',
  retired: '已挂起',
};

/** 紧急度 → 视觉档位。前端据此套 .badge.ok/.warn/.bad/.info，颜色不在这里写死。 */
export const URGENCY_TONE = {
  urgent: 'bad',
  overdue: 'warn',
  waiting: 'info',
  cold: 'muted',
  retired: 'muted',
};

/** 「这一条为什么会出现在队列里」—— 列表里那行小字。 */
export const FAMILY_LABEL = {
  applied: '已投递未回应',
  responded: '已有回应',
  interview: '面试流程中',
};

// ── 跟进通道 ─────────────────────────────────────────────────────────────
//
// 与 web/ 那套（web/src/lib/followups.ts 的 CHANNELS）逐字一致：写进
// data/follow-ups.md 的是英文规范值，页面上显示中文。改这里的拼写之前先确认
// web 那边 —— 不一致的话，同一个人的跟进记录在控制台和 Next 看板上会显示成
// 两种通道，而两边读的是同一个文件。
export const CHANNELS = ['Email', 'LinkedIn', 'Phone', 'Other'];

export const CHANNEL_ZH = {
  Email: '邮件',
  LinkedIn: '领英',
  Phone: '电话',
  Other: '其他',
};

/** 把用户输入/历史数据里的通道规整成规范值；认不出就回落 'Other'。 */
export function normalizeChannel(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'Other';
  const hit = CHANNELS.find((c) => c.toLowerCase() === s);
  if (hit) return hit;
  // 中文也认 —— 手写台账的人写「微信」的概率不比写 WeChat 低
  const zhHit = Object.entries(CHANNEL_ZH).find(([, zh]) => zh === String(raw).trim());
  return zhHit ? zhHit[0] : 'Other';
}

// ── 写盘格式 ─────────────────────────────────────────────────────────────
//
// 「往里加一条」拆成纯函数是为了让它可测：真正危险的不是拼接本身，而是
// 「文件末尾没有换行时新行会粘在上一行」「没有表头时这行对解析器不可见」
// 这类只在**某些文件状态下**才出现的错。纯函数化之后自检能把边界一个个喂进去。

/** Markdown 表格单元格：单行、不含竖线。上限只给身份类字段设（备注不限）。 */
export function cell(v, max) {
  const s = String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\|/g, '/')
    .trim();
  return max ? s.slice(0, max) : s;
}

export const FOLLOWUPS_TABLE_HEADER =
  '| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|';

/** 跟进记录的空文件骨架（与 followup-seed.mjs 的 FOLLOWUPS_HEADER 同形）。 */
export const FOLLOWUPS_FILE_SKELETON = '# Follow-ups\n\n' + FOLLOWUPS_TABLE_HEADER + '\n';

/**
 * 给一条跟进记录分配 num。
 * 只数**表格行**：旧版遗留的 bullet 行没有 num，pin 指令行也不是记录，
 * 数进去会撞号。表头首列两种写法都存在（'num' 和 '#'），两种都认，
 * 否则会在已经有表头的文件里再插一个表头。
 */
export function nextFollowupNum(content) {
  let maxNum = 0;
  for (const line of String(content ?? '').split('\n')) {
    if (!line.startsWith('|')) continue;
    const first = (line.split('|')[1] ?? '').trim();
    if (!/^\d+$/.test(first)) continue;
    const n = parseInt(first, 10);
    if (Number.isInteger(n) && n > maxNum) maxNum = n;
  }
  return maxNum + 1;
}

/** 文件里是否已经有表头（认 'num' 和 '#' 两种首列名）。 */
export function hasTableHeader(content) {
  for (const line of String(content ?? '').split('\n')) {
    if (!line.startsWith('|')) continue;
    if (/^(num|#)$/i.test((line.split('|')[1] ?? '').trim())) return true;
  }
  return false;
}

/** 一条跟进记录 → data/follow-ups.md 的一行（core 的 parseFollowups 认这个格式）。 */
export function followupRowLine({ num, appNum, date, company, role, channel, contact, notes }) {
  return `| ${num} | ${appNum} | ${date} | ${cell(company, 80)} | ${cell(role, 80)} | `
    + `${normalizeChannel(channel)} | ${cell(contact, 120)} | ${cell(notes)} |`;
}

/**
 * 把一行追加进已有内容，返回新内容（不落盘）。三个边界都在这里兜住：
 *   ① 文件末尾没换行 → 新行会粘在上一行；
 *   ② 没有表头 → 补一个（`parseFollowups` 靠 `|` 开头的行解析，缺表头虽然还能读，
 *      但文件本身就不成表格了，人再打开就懵）；
 *   ③ 已有内容原样保留，绝不改写既有行 —— 这是追加式日志。
 */
export function appendFollowupRow(content, rowLine) {
  const existing = String(content ?? '');
  let out = '';
  if (existing && !existing.endsWith('\n')) out += '\n';
  if (!hasTableHeader(existing)) out += FOLLOWUPS_TABLE_HEADER + '\n';
  out += rowLine + '\n';
  return existing + out;
}

/** 钉住某条申请的下次跟进日 —— core 的 parseNextOverrides 认这个格式。 */
export function followupPinLine(appNum, nextDate, setDate) {
  return `- next #${appNum} ${nextDate} (set ${setDate})`;
}

/** 非表格行（pin 指令）追加：同样要处理末尾没有换行的情况。 */
export function appendFollowupLine(content, line) {
  const existing = String(content ?? '');
  return existing + (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n';
}
