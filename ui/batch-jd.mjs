// ui/batch-jd.mjs — 批量初筛的纯函数（切块 / 归一化 / 排序 / 导出）
//
// 为什么单独一个模块：批量初筛是**前端编排** —— 循环调用已有的
// `/api/eval`（phase=triage），服务端一行都不用改。好处是复用已经调通、
// 已有自检覆盖的那条通路；代价是「切块」「排序」这些容易出错的逻辑
// 全落在浏览器里，无法直接断言。
//
// 所以把可测的部分抽到这里：纯函数、不碰 DOM、不碰网络，
// 由 ui/check-batch-jd.mjs 直接跑（零浏览器、零 token、秒级）。
//
// 一个刻意的设计：**切块只认显式分隔线**（--- / === / ***）。
// 靠空行切块看着聪明，实际会踩两个坑 —— 岗位 JD 里空行是常态（段落之间），
// 而且粘进来的内容常常带着「公司名 + 岗位 + 职责」的多段结构，
// 按空行切会把同一个岗位切成七八条。宁可让用户多打三个减号，也不要猜错。

/** 一次最多处理多少个岗位。上限存在的意义是别让用户误粘一整页搜索结果。 */
export const BATCH_MAX = 20;

/** 单条 JD 上限，与 /api/eval 服务端同口径（那里也会再拒一次）。 */
export const JD_MAX = 30000;

/** 标签最长显示多少个字符（超出截断，仅用于界面显示）。 */
export const LABEL_MAX = 40;

/** 分隔线：三个以上连续的 - / = / *，允许前后空白。 */
const SEP_RE = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/;

/** 把 Markdown 标题记号剥掉：`### 某某公司` → `某某公司` */
function stripHeading(line) {
  return String(line).replace(/^\s*#{1,6}\s*/, '').trim();
}

function clip(text, n = LABEL_MAX) {
  const t = String(text ?? '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 把粘贴的多岗位文本切成一条条 JD。
 *
 * @param {string} text 粘贴内容
 * @param {{max?: number}} [opts]
 * @returns {{items: Array<{index:number,label:string,jd:string,chars:number,tooLong:boolean}>,
 *            total:number, truncated:boolean}}
 *   total 是切出来的真实块数（可能大于 items.length）；
 *   truncated 为 true 表示超出 max 被丢掉了若干条。
 */
export function splitBatchJds(text, { max = BATCH_MAX } = {}) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');

  const blocks = [];
  let cur = [];
  for (const line of lines) {
    if (SEP_RE.test(line)) {
      blocks.push(cur);
      cur = [];
      continue;
    }
    cur.push(line);
  }
  blocks.push(cur);

  const blocks2 = blocks
    .map((b) => b.map((l) => l.replace(/\s+$/, '')))
    .filter((b) => b.some((l) => l.trim() !== ''));  // 丢掉空块（连续两条分隔线会产生）

  const items = [];
  blocks2.forEach((block) => {
    // 用 findIndex 而不是 indexOf(nonEmpty[0])：后者在首行有前导空格时
    // 会因为 trim 过的值匹配不上原行而返回 -1，JD 正文就会被整段吞掉。
    const firstIdx = block.findIndex((l) => l.trim() !== '');
    const label = clip(stripHeading(block[firstIdx].trim()));
    // JD 正文 = **整块**（含首行）。首行看着像「标签」，但它同时是公司名 + 岗位名 ——
    // 初筛要拿它判届次/岗位方向，完整评估还要用它命名报告文件。
    // 剥掉首行等于扔掉评估最需要的两个字段（踩过：剥了之后报告公司名变成 unknown）。
    // label 只是给表格显示用的短名，两者不冲突。
    const jd = block.slice(firstIdx).join('\n').trim();
    if (!jd) return;                                  // 理论上到不了，保险
    if (items.length >= max) return;                  // 超出上限的先不收
    items.push({
      index: items.length + 1,
      label: label || ('第 ' + (items.length + 1) + ' 个岗位'),
      jd,
      chars: jd.length,
      tooLong: jd.length > JD_MAX,
    });
  });

  return { items, total: blocks2.length, truncated: blocks2.length > items.length };
}

/** 分数归一：数字直接用，字符串取第一个数字（`4.5/5` → 4.5）；不合法返回 null。 */
function parseScore(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const m = String(raw ?? '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * 一次初筛的响应 → 表格行。
 * 刻意不抛错：批量里某一条失败不该让整批停下，失败就落成一行带 error 的行。
 */
export function rowFromTriage(item, r) {
  const t = (r && r.triage) || null;
  const ok = !!(r && r.ok);
  return {
    index: item.index,
    label: item.label,
    jd: item.jd,
    score: ok ? parseScore(t && t.score) : null,
    verdict: ok && t ? String(t.verdict || '') : '',
    tier: ok && t ? String(t.tier || '') : '',
    why: ok && t ? String(t.why || '') : '',
    ok,
    skipped: !!(item.tooLong),
    error: item.tooLong
      ? 'JD 过长（' + item.chars + ' 字符，上限 3 万）—— 删掉福利、公司介绍等段落再试'
      : (ok ? '' : String((r && r.friendly) || ('失败：退出码 ' + ((r && r.code) ?? '?')))),
    ms: (r && r.ms) || 0,
  };
}

/** 结论的中文显示（PASS/FAIL → 通过/未通过）。 */
export function verdictZh(verdict) {
  const v = String(verdict || '').toUpperCase();
  if (v === 'PASS') return '通过';
  if (v === 'FAIL') return '未通过';
  return '';
}

/**
 * 排序：'order' 保持粘贴顺序，'score' 按分数降序（没分/失败的行沉底）。
 * 稳定：同分按原始序号，跑两次结果一致 —— 否则每次重绘表格都在跳。
 */
export function sortBatchRows(rows, by = 'order') {
  const list = [...(rows || [])];
  if (by !== 'score') return list.sort((a, b) => a.index - b.index);
  return list.sort((a, b) => {
    const sa = typeof a.score === 'number' ? a.score : -1;
    const sb = typeof b.score === 'number' ? b.score : -1;
    if (sb !== sa) return sb - sa;
    return a.index - b.index;
  });
}

/** 表格 → Markdown（复制按钮用；粘到群里/文档里就能看）。 */
export function batchRowsToMarkdown(rows, { threshold = null } = {}) {
  const list = sortBatchRows(rows, 'score');
  const out = [
    '| # | 岗位 | 分数 | 结论 | 档位 | 理由 |',
    '|---|---|---|---|---|---|',
  ];
  for (const r of list) {
    const score = typeof r.score === 'number' ? r.score.toFixed(1) : '—';
    const note = !r.ok
      ? (r.skipped ? '（已跳过）' : '（失败）')
      : '';
    out.push('| ' + r.index + ' | ' + mdCell(r.label) + ' | ' + score
      + (threshold != null && typeof r.score === 'number'
        ? (r.score >= threshold ? ' ✓' : ' ✗') : '')
      + ' | ' + (verdictZh(r.verdict) || '—') + note
      + ' | ' + mdCell(r.tier || '—')
      + ' | ' + mdCell(r.ok ? (r.why || '') : (r.error || '')) + ' |');
  }
  return out.join('\n') + '\n';
}

/** 单元格里的竖线会截断 Markdown 表格，先换成全角。 */
function mdCell(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '｜').trim();
}
