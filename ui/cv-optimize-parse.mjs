// ui/cv-optimize-parse.mjs — 解析 AI 的「简历优化」输出
//
// 和 ui/eval-parse.mjs 一样单独成模块，原因也相同：这是链路里最脆弱的一环。
// 模型输出的措辞完全不受控，而它坏掉的方式是**静默降级**——
// 问题清单渲染成空、改写稿少了一段，页面看起来「跑成功了」，
// 用户照着半截稿子写回 cv.md，损失的是简历。
//
// 所以解析只认「结构」不认「标签名」：
//   · 清单项：任意列表符号（- * + 1. 1、1)）都算，级别从 [高] / **高** / （高） 里捞
//   · 改写稿：先找「改写稿」这类小标题后面的围栏代码块；
//     找不到就退而取**整段输出里最长的那块围栏代码**（模型经常漏写小标题）
//   · 围栏忘了闭合也要能取到东西（取到文本末尾），否则用户拿到空稿子
//
// 判不出来时**不猜**：draft 明确返回空串 + 一句 parseError，
// 让页面显示「没解析出改写稿，看原始输出」，而不是把问题清单当成简历写回文件。

/** 小标题识别用：把 `### **问题清单**` 这种装饰全剥掉再比 */
const stripMd = (s) => String(s)
  .replace(/^\s*#{1,6}\s*/, '')
  .replace(/^[\s*_`~]+/, '')
  .replace(/[\s*_`~：:]+$/, '')
  .trim();

// 小标题用**前缀**匹配而不是全等：模型常写成「问题清单（按严重度排序）」
// 或「改写稿：完整版」。但也必须配一个长度上限，否则正文里
// 「问题是：项目经历没有量化结果」这种句子会被当成小标题切段。
const ISSUE_HEAD = /^(?:问题清单|问题列表|修改建议|优化建议|issues?|suggestions?)/i;
const DRAFT_HEAD = /^(?:改写稿|改写后的简历|优化后的简历|优化稿|完整简历|简历正文|draft|rewritten\s*cv)/i;
const HEAD_MAX = 24;

/** 判断某一行是不是小标题，是的话返回段类型 */
function headKind(line) {
  const bare = stripMd(line);
  if (!bare || bare.length > HEAD_MAX) return null;
  // 必须长得像个标题：有 # 前缀、整行加粗、或本身就是短行
  const looksLikeHead = /^\s*#{1,6}\s/.test(line)
    || /^\s*\*\*[^*]+\*\*\s*$/.test(line)
    || (!/[，。；！？]/.test(bare) && !LIST_ITEM.test(line));
  if (!looksLikeHead) return null;
  if (ISSUE_HEAD.test(bare)) return 'issues';
  if (DRAFT_HEAD.test(bare)) return 'draft';
  return null;
}

/** 列表项：`- xxx` / `* xxx` / `1. xxx` / `1、xxx` / `1) xxx` */
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,2}\s*[.、)）])\s+(.*)$/;

/** 捞严重度：`[高]` `【中】` `**高**` `（低）` `(HIGH)`，取不到就不标 */
function pickLevel(s) {
  const m = s.match(/[[【(（]\s*(高|中|低|紧急|严重|high|medium|low)\s*[\]】)）]/i)
    || s.match(/\*\*\s*(高|中|低)\s*\*\*/);
  if (!m) return '';
  const v = m[1].toLowerCase();
  return v === 'high' ? '高' : v === 'medium' ? '中' : v === 'low' ? '低'
    : v === '紧急' || v === '严重' ? '高' : m[1];
}

/** 标题 / 说明的分隔符：破折号、冒号都见过 */
const SPLIT_TITLE = /\s*(?:——|--|—|–|：|:)\s*/;

function parseItem(raw) {
  // 先摘掉级别标记，免得它混进标题里
  const level = pickLevel(raw);
  const body = raw
    .replace(/[[【(（]\s*(?:高|中|低|紧急|严重|high|medium|low)\s*[\]】)）]/gi, '')
    .replace(/\*\*\s*(?:高|中|低)\s*\*\*/g, '')
    .trim();
  const parts = body.split(SPLIT_TITLE, 2);
  const full = stripMd(parts[0] || body);
  // 标题截断要留痕：不写省略号的话，用户会以为标题本来就断在这里
  const title = full.length > 120 ? full.slice(0, 120) + '…' : full;
  const detail = (parts[1] || '').trim();
  return { level, title, detail, raw: raw.trim() };
}

/**
 * 切出所有围栏代码块。忘记闭合时把剩下的全算作块内容——
 * 「围栏没闭合」比「整段丢掉」好得多，用户至少能看到稿子。
 * @returns {Array<{lang: string, body: string, closed: boolean}>}
 */
function fencedBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    if (m && !cur) { cur = { lang: m[2] || '', body: [], closed: false, ticks: m[1][0] }; continue; }
    if (m && cur && m[1][0] === cur.ticks) { cur.closed = true; blocks.push(cur); cur = null; continue; }
    if (cur) cur.body.push(line);
  }
  if (cur) blocks.push(cur);   // 没闭合：照样收下
  return blocks.map((b) => ({
    lang: b.lang,
    closed: b.closed,
    body: b.body.join('\n').replace(/^\n+|\n+$/g, ''),
  }));
}

/**
 * 把 AI 的优化输出解析成结构化字段。
 * @param {string} out AI 的原始输出
 * @returns {{summary: string, issues: Array, draft: string, parseError: string}}
 */
export function parseCvOptimize(out) {
  const empty = { summary: '', issues: [], draft: '', parseError: '' };
  const text = String(out || '');
  if (!text.trim()) return { ...empty, parseError: 'AI 没有返回任何内容' };

  const lines = text.split(/\r?\n/);

  // ── 1. 按小标题把文本切成几段（问题清单段 / 改写稿段 / 前言）──────────
  let head = null;                       // 当前段落的类型
  const headText = [];                   // 小标题之前的文本（总评常在这里）
  const issueLines = [];
  const afterDraft = [];
  for (const line of lines) {
    const kind = headKind(line);
    if (kind === 'issues') { head = 'issues'; continue; }
    if (kind === 'draft') { head = 'draft'; continue; }
    if (head === 'issues') issueLines.push(line);
    else if (head === 'draft') afterDraft.push(line);
    else headText.push(line);
  }

  // ── 2. 总评：优先 `SUMMARY:` / `总评：` 这类标签行，否则取小标题前第一段 ──
  let summary = '';
  for (const line of headText) {
    const m = stripMd(line).match(/^(?:SUMMARY|总评|一句话总评|结论)[：:]\s*(.+)$/i);
    if (m) { summary = m[1].trim(); break; }
  }
  if (!summary) {
    summary = headText.map((l) => l.trim())
      .filter((l) => l && !/^-{3,}$/.test(l) && !LIST_ITEM.test(l))[0] || '';
    summary = summary.slice(0, 300);
  }

  // ── 3. 问题清单：问题段里的所有列表项；一段都没有就退而取全文列表项 ────
  //
  // 列表项会被模型折行——实测见过
  //   `1. [高] 「员工`
  //   `腾讯」经历无法自洽 —— 一段需要核实…`
  // 这种写法。第二行没有列表符号，但它属于上一项：不合并的话标题被截成
  // 半句、说明整段丢掉，用户看到的是一条看不懂的问题。
  // 空行、标题、代码围栏视为「打断」，不往上一项上粘。
  const collect = (src) => {
    const items = [];   // string = 一项的累积文本；null = 遇到打断
    for (const line of src) {
      const m = line.match(LIST_ITEM);
      if (m) { items.push(m[1]); continue; }
      const t = line.trim();
      if (!t || /^#{1,6}\s/.test(line) || /^\s*(`{3,}|~{3,})/.test(line)) { items.push(null); continue; }
      const last = items.length ? items[items.length - 1] : null;
      if (typeof last === 'string') items[items.length - 1] = last + ' ' + t;
      else items.push(null);
    }
    return items.filter((x) => typeof x === 'string').map(parseItem).filter((x) => x.title.length > 1);
  };
  let issues = collect(issueLines);
  if (!issues.length && head !== 'issues') {
    // 模型经常把清单直接写在总评下面，连小标题都省了。
    // 只取「改写稿之前」的列表项，避免把改写稿里的 bullet 也当成问题。
    const draftIdx = headText.findIndex((l) => /^\s*`{3,}/.test(l));
    const scope = draftIdx >= 0 ? headText.slice(0, draftIdx) : headText;
    issues = collect(scope).filter((x) => x.level || x.detail);
  }
  issues = issues.slice(0, 20);          // 上限：清单太长反而没法看

  // ── 4. 改写稿：改写稿段里的代码块优先，其次全文最长的那块 ──────────────
  const draftSection = afterDraft.length ? afterDraft.join('\n') : '';
  let draft = '';
  let note = '';

  const inSection = fencedBlocks(draftSection);
  if (inSection.length) {
    // 段内可能有多块（例如前后各贴了一段「改前/改后」），取最长的那块
    draft = inSection.slice().sort((a, b) => b.body.length - a.body.length)[0].body;
  } else if (draftSection.trim()) {
    // 没有围栏：把改写稿小标题之后的正文整体当作稿子（模型偶尔直接贴正文）
    draft = draftSection.replace(/^\s*`{3,}.*$/gm, '').trim();
  }

  if (!draft) {
    const all = fencedBlocks(text);
    if (all.length) draft = all.slice().sort((a, b) => b.body.length - a.body.length)[0].body;
  }

  // ── 5. 兜底判定：太短的「稿子」不是稿子 ────────────────────────────────
  // 阈值刻意低（100 字符只够拦住空块和一两行废话），因为一份很简的应届简历
  // 也可能只有几百字符——真正的校验交给「写回前弹确认」，而不是在这里瞎猜。
  if (draft && draft.trim().length < 100) {
    note = '解析出的改写稿只有 ' + draft.trim().length + ' 字符，太短，已丢弃';
    draft = '';
  }
  if (!draft) {
    note = note || (issues.length
      ? '只解析出问题清单，没找到改写稿（AI 可能没按格式输出）'
      : '没能从 AI 输出里解析出问题清单和改写稿，请查看原始输出');
  }

  return { summary, issues, draft: draft.trim(), parseError: draft ? '' : note };
}
