// ui/local-eval.mjs — 本地模型的「完整评估」编排（纯函数部分）
//
// 为什么要有这个模块：完整评估原来只有一条路 —— CodeBuddy CLI 以 agent 身份
// 自己读规则文件、自己写 reports/ 与台账。本地模型不是 agent，看不到文件也
// 写不了盘，所以曾经被 409 直接挡住。但根目录的 ollama-eval.mjs 早就证明了
// 另一条路：**服务端代劳**——把规则读进 prompt、从回复里解析出报告、由代码
// 落盘。这个模块把那条路的「可测部分」抽成纯函数，HTTP 调用与文件读写留在
// server.mjs。
//
// 解析必须宽容，原因是实测的（output/ollama-evidence/样本报告/）：
// 7B 模型会无视 ---SCORE_SUMMARY--- 契约，把机器块写成
// `## Machine Summary` + ```yaml 围栏（键名仍是英文），有时甚至只在正文
// 头部写 **Score:** 4.2/5。三种形态都认，都不认就明说失败，绝不猜。

import { buildBudgetedPrompt } from '../lib/context-budget.mjs';
import { outputLanguageInstruction, parseOutputLanguage } from '../profile-language.mjs';
import { TSV_ADDITION_HEADER } from '../tracker-parse.mjs';
import { formatReportNumber } from '../reserve-report-num.mjs';

// 与 ollama-eval.mjs 同一口径：请求和 prompt 预算都用这个窗口。
// qwen2.5 的上限就是 32768。调用侧必须把它传进 options.num_ctx ——
// Ollama 不设时默认 2048，会把上万 token 的 prompt **静默截断**。
export const LOCAL_EVAL_NUM_CTX = (() => {
  const n = parseInt(process.env.OLLAMA_NUM_CTX || '32768', 10);
  return Number.isNaN(n) || n <= 0 ? 32768 : n;
})();

/**
 * 拼完整评估的 system prompt。规则文件内容由调用方读好传入（本模块不碰 fs）。
 *
 * @param {{shared: string, oferta: string, cv: string, profileYml: string,
 *          profile: string, jd: string, postingUrl?: string}} o
 * @returns {{systemPrompt: string, userPrompt: string, budgetReport: object}}
 */
export function buildLocalEvalPrompt(o) {
  const shared = String(o?.shared ?? '');
  const oferta = String(o?.oferta ?? '');
  const cv = String(o?.cv ?? '');
  const profileYml = String(o?.profileYml ?? '');
  const profile = String(o?.profile ?? '');
  const jd = String(o?.jd ?? '').trim();

  const { contextBody, budgetReport } = buildBudgetedPrompt({
    sharedContent: shared,
    ofertaContent: oferta,
    cvContent: cv,
    profileYml,
    profileContent: profile,
    jdText: jd,
    maxTokens: LOCAL_EVAL_NUM_CTX,
  });

  const language = outputLanguageInstruction(parseOutputLanguage(profileYml));
  const postingUrl = String(o?.postingUrl ?? '').trim();

  const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

${contextBody}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - Block D (Comp research): use training-data salary estimates; note them as estimates.
   - Block G (Legitimacy): analyze JD text only; skip URL/page freshness checks.
   - Report saving is handled by the calling program, not by you.
2. ${language}
3. 中文招聘覆盖规则（modes/_profile.md）优先级最高：门槛分 3.0
   （pipeline.triage_threshold），薪资不参与评分；届次 / 学历 / 专业 / 城市 /
   经验等硬门槛按该文件逐条判定。
4. Generate Blocks A through G in full.

5. 报告正文写成中文，且**小标题保留字母序号、字母后写中文**：
   ## A) 岗位概览 / ## B) 简历匹配分析 / ## C) 级别判断与求职策略 /
   ## D) 薪酬竞争力与市场需求 / ## E) 针对性定制方案 / ## F) 面试备考计划 /
   ## G) 职位真实性评估。
   ## Risk Summary、## H) Draft Application Answers（**这一行照抄英文**，
   application-answers.mjs 逐字匹配它）、## Job Description (archived verbatim)
   （放报告最后一段）这三个标题**保持英文原样**（程序按字面解析，翻译了会被静默丢弃）。
   附属段落：## Keywords extracted 写成 ## ATS 关键词提取，
   ## Cover Letter Draft 写成 ## 求职信草稿。
   ## 求职信草稿 **要么写满、要么整段不写** —— 绝不能把模板骨架留在报告里：
   不许出现 {xxx} 花括号占位、不许出现 (placeholder) 标注、不许出现
   「To be completed」这类待办占位。写不出内容就直接删掉这一节，别留空壳。
   行文按 modes/_profile.md【覆盖规则 8】：结论先行、先给动作再给分析、
   每句判定挂证据（引自 JD 或简历），**同一句套话整份报告最多出现一次**。
   不要出现「英文小标题 + 中文段落」的混排。

6. At the very end, output this exact machine-readable block:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---

   If you cannot produce that exact marker, you MUST still end with a
   Machine Summary carrying the same five fields (COMPANY / ROLE / SCORE /
   ARCHETYPE / LEGITIMACY) — the calling program reads its score from either.`;

  const userPrompt = (postingUrl ? `POSTING URL: ${postingUrl}\n\n` : '')
    + `JOB DESCRIPTION TO EVALUATE:\n\n${jd}`;

  return { systemPrompt, userPrompt, budgetReport };
}

// ── 解析 ────────────────────────────────────────────────────────────────

// 机器块里认字段：英文键是契约，中文键是模型本地化后的实际写法。
const FIELD_RES = {
  company: /^[ \t]*(?:COMPANY|公司)[ \t]*[:：][ \t]*(.+)$/im,
  role: /^[ \t]*(?:ROLE|岗位|职位)[ \t]*[:：][ \t]*(.+)$/im,
  score: /^[ \t]*(?:SCORE|总分|评分)[ \t]*[:：][ \t]*(.+)$/im,
  archetype: /^[ \t]*(?:ARCHETYPE|类型|画像)[ \t]*[:：][ \t]*(.+)$/im,
  legitimacy: /^[ \t]*(?:LEGITIMACY|可信度|合法性)[ \t]*[:：][ \t]*(.+)$/im,
};

/** 从一行值里剥掉围栏残留（`---`、引号、行尾反引号） */
function cleanFieldValue(v) {
  return String(v ?? '')
    .replace(/^[\s'"`—\-]+/, '')
    .replace(/[\s'"`]+$/, '')
    .trim();
}

/** 分数归一：取第一个数字；不是 0–5 就当没解析到（ refusing 比 guessing 安全） */
function parseScore(raw) {
  const m = String(raw ?? '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return '';
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0 || n > 5) return '';
  return String(n);
}

/** 从一段机器块文本里抠五个字段。返回 {} 表示这段里一个都没认出来。 */
function fieldsFromBlock(block) {
  const out = {};
  for (const [key, re] of Object.entries(FIELD_RES)) {
    const m = block.match(re);
    if (m) out[key] = cleanFieldValue(m[1]);
  }
  return out;
}

/**
 * 抠出模型输出里所有「Machine Summary」段的围栏代码块（连同所在段一起）。
 *
 * 实测 7B 至少有两种写法（output/ollama-evidence/样本报告/）：
 *   · `## Machine Summary` —— 标题形式
 *   · `**Machine Summary:**` —— 加粗形式（第二次真跑出现）
 * 所以标题行放宽为「一行里除了装饰只剩 Machine Summary」，正文散文里
 * 提到这个词的行（如模板原文）不会被误当标题。标题与围栏之间允许夹
 * 说明文字（run5 样本里就有「(YAML fence for downstream scripts…)」）。
 */
function machineSummaryBlocks(text) {
  const blocks = [];
  const re = /^[ \t]*(?:#{1,6}[ \t]*)?\**Machine Summary\**[ \t]*[:：]?\**[ \t]*\r?\n[\s\S]*?```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/gm;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push({ full: m[0], inner: m[1] });
  return blocks;
}

/** 正文头部的 `**Score:** X/5` 等字段（最后一级兜底） */
function fieldsFromBodyHeader(text) {
  const out = {};
  const score = text.match(/\*\*Score:\*\*[ \t]*(\d+(?:\.\d+)?)[ \t]*\/[ \t]*5/i);
  if (score) out.score = score[1];
  const archetype = text.match(/\*\*Archetype:\*\*[ \t]*(.+)/i);
  if (archetype) out.archetype = cleanFieldValue(archetype[1]);
  const legitimacy = text.match(/\*\*Legitimacy:\*\*[ \t]*(.+)/i);
  if (legitimacy) out.legitimacy = cleanFieldValue(legitimacy[1]);
  // 标题行：`# 评估报告：公司 — 岗位`（— / – / - 都见过）。
  // 旧英文标题 `# Evaluation: 公司 — 岗位` 照样认 —— reports/ 里的历史报告都是它。
  const title = text.match(/^#[ \t]*(?:评估报告|Evaluation)[ \t]*[:：][ \t]*(.+?)[ \t]*[—–-][ \t]*(.+)$/m);
  if (title) {
    out.company = cleanFieldValue(title[1]);
    out.role = cleanFieldValue(title[2]);
  }
  return out;
}

/**
 * 解析本地模型的完整评估输出。
 *
 * 识别顺序（先结构后兜底，绝不猜）：
 *   1. ---SCORE_SUMMARY--- ... ---END_SUMMARY---（上游契约）
 *   2. ## Machine Summary + 围栏 YAML（7B 模型的实际写法；可能有多段，
 *      只认含 SCORE 字段的那段 —— 实测见过先给占位段再给真段的情况）
 *   3. 正文头部的 **Score:** / **Archetype:** / **Legitimacy:** / 标题行
 *
 * @param {string} text 模型原始输出
 * @returns {{company: string, role: string, score: string, archetype: string,
 *            legitimacy: string, body: string, source: string}}
 *   body 是剥掉机器块（和模型自带的重复头部）后的评估正文；
 *   source 记录分数从哪来（'score-summary' | 'machine-summary' | 'header' | ''）。
 */
export function parseLocalEvalOutput(text) {
  const raw = String(text ?? '');
  const empty = {
    company: 'unknown', role: 'unknown', score: '',
    archetype: 'unknown', legitimacy: 'unknown',
    body: raw.trim(), source: '',
  };
  if (!raw.trim()) return { ...empty, body: '' };

  let fields = {};
  let source = '';

  // 1) 上游契约块
  const m1 = raw.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/);
  if (m1) {
    const f = fieldsFromBlock(m1[1]);
    if (f.score) {
      fields = f; source = 'score-summary';
    }
  }

  // 2) Machine Summary 围栏（可能多段，取含 SCORE 的第一段）
  if (!source) {
    for (const block of machineSummaryBlocks(raw)) {
      const f = fieldsFromBlock(block.inner);
      if (f.score) {
        fields = f; source = 'machine-summary';
        break;
      }
    }
  }

  // 3) 正文头部兜底
  let headerFields = null;
  if (!source) {
    headerFields = fieldsFromBodyHeader(raw);
    if (headerFields.score) {
      fields = headerFields; source = 'header';
    }
  }

  // ── 正文：剥掉所有机器块壳，再剥模型自带的重复头部 ──────────────────
  // 机器块（SCORE_SUMMARY 契约块、各种写法的 Machine Summary 围栏）都是
  // 给程序读的，不属于报告正文 —— **不管分数从哪种格式解析出来**，全部
  // 剥掉。只剥匹配块的话，会留下「### Machine Summary」空壳标题和空围栏
  // （第五次真跑实测）。
  let body = raw.trim();
  if (m1) body = body.replace(m1[0], '');
  for (const block of machineSummaryBlocks(body)) {
    body = body.replace(block.full, '');
  }
  // 7B 实测会把**整份报告写两遍**：第一遍用 `### A)` 小标题直接开写，
  // 第二遍以自己的报告标题（`# 评估报告：…`，旧输出是 `# Evaluation: …`）
  // 开头重来（### / ## 各一份，报告翻倍）。所以只要标题出现在**正文中间**
  // （index > 0，开头的那个已被剥掉），就在那里截断 —— 报告文件只需要一份。
  if (source) {
    const dup = body.match(/^#[ \t]*(?:评估报告|Evaluation)[ \t]*[:：].*$/m);
    if (dup && dup.index > 0) body = body.slice(0, dup.index);
  }
  // 尾部清理：7B 偶尔在末尾留下接话（「请继续生成 XX 段落」「请确认以上
  // 内容是否符合要求」，两种都实测过）、孤立的 `#` 或 `---` 分隔线。
  // 逐行从尾部收，碰到正常内容就停 —— 只摘尾巴，不碰正文。
  {
    const lines = body.split('\n');
    const chatter = /^(?:请|如果|如需|希望|好的?|以上就是?|祝|谢谢|感谢|continue\b|next steps?\b)/i;
    while (lines.length) {
      const t = lines[lines.length - 1].trim();
      if (!t || t === '---' || /^#{1,6}$/.test(t) || chatter.test(t)) lines.pop();
      else break;
    }
    body = lines.join('\n').trim();
  }
  // 模型常自带一份报告标题（`# 评估报告：…`，旧输出是 `# Evaluation: …`）
  // 连同 Score 行。我们会写自己的规范头部，不剥的话报告里出现两份头部
  // （run3 样本正是这样）。只在「确实解析出了分数」时剥 —— 剥错了字段就丢了。
  if (source) {
    body = body.replace(
      /^#[ \t]*(?:评估报告|Evaluation)[ \t]*[:：][\s\S]*?\n---[ \t]*\n/,
      '',
    );
  }
  body = body.trim();

  // 字段补齐：机器块里没有的（如 archetype 缺失）用正文头部兜
  if (source && source !== 'header') {
    headerFields = headerFields || fieldsFromBodyHeader(raw);
    for (const k of Object.keys(FIELD_RES)) {
      if (!fields[k] && headerFields[k]) fields[k] = headerFields[k];
    }
  }

  return {
    company: fields.company || 'unknown',
    role: fields.role || 'unknown',
    // 分数过一遍归一（0–5 之外、10 分制一律拒绝）—— parseScore 认不出就空串，
    // 让上层明说「没解析出分数」，而不是把 8/10 当成合法分写进台账。
    score: source ? parseScore(fields.score) : '',
    archetype: fields.archetype || 'unknown',
    legitimacy: fields.legitimacy || 'unknown',
    body,
    source,
  };
}

// ── 落盘产物（文件名 / 报告正文 / 台账 addition 行）─────────────────────

/**
 * 公司名 → 文件名 slug。保留小写字母、数字和汉字 ——
 * 控制台的 REPORT_NAME_RE 明确放行 `\u4e00-\u9fa5`，
 * 「星海科技」没必要退化成 unknown。
 */
export function slugifyCompany(v) {
  const s = String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return s || 'unknown';
}

/** TSV 单元格：制表符与换行会串列，一律压成空格 */
export function tsvSafe(v) {
  return String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * 模型报的分数 → 台账 score 单元格。缺了或认不出给 `N/A`（文档化的哨兵），
 * 分母不是 5 或超出 0–5 一律拒绝 —— N/A 可恢复，错分数不可恢复。
 * 逻辑与根目录 ollama-eval.mjs 的 normalizedTrackerScore 保持一致。
 */
export function normalizedTrackerScore(v) {
  const clean = tsvSafe(v);
  const parsed = clean.match(/^(\d+(?:\.\d+)?)/);
  if (!parsed) return 'N/A';
  const score = parseFloat(parsed[1]);
  const denominator = clean.match(/\/\s*(\d+(?:\.\d+)?)/);
  const scale = denominator ? parseFloat(denominator[1]) : 5;
  if (!Number.isFinite(score) || scale !== 5 || score < 0 || score > 5) return 'N/A';
  return `${score}/5`;
}

/**
 * 组装落盘需要的三样东西：报告文件名、报告正文、台账 addition。
 * 纯字符串运算，fs 在 server.mjs。
 *
 * @param {{num: number, company: string, role: string, score: string,
 *          archetype: string, legitimacy: string, body: string,
 *          today: string, postingUrl?: string, model: string}} o
 */
export function buildLocalReportArtifacts(o) {
  const numStr = formatReportNumber(o.num);
  const company = o.company || 'unknown';
  const role = o.role || 'unknown';
  const score = o.score || '?';
  const today = o.today;
  const slug = slugifyCompany(company);
  const filename = `${numStr}-${slug}-${today}.md`;
  const postingUrl = String(o?.postingUrl ?? '').trim();

  // 报告头：**中文标题 + 六个英文机器字段标签**。标签必须留英文 ——
  // 控制台 listReports() 与 analyze-patterns.mjs 按字面取值，翻译了会被静默丢弃；
  // 标题则相反，写成中文（`# 评估报告：…`），控制台解析时会剥掉这个前缀。
  const reportContent = `# 评估报告：${company} — ${role}

**Date:** ${today}
**Archetype:** ${o.archetype || 'unknown'}
**Score:** ${score}/5
**URL:** ${postingUrl || '(pasted)'}
**Legitimacy:** ${o.legitimacy || 'unknown'}
**PDF:** pending
**Tool:** Ollama (${o.model})

---

${o.body}
`;

  // 台账 addition：字段顺序是 TSV 契约的 —— status 在 score 前面；
  // merge-tracker 按表头名字解析，不按位置。
  const additionName = `${numStr}-${slug}.tsv`;
  const trackerFields = [
    String(parseInt(numStr, 10)),
    today,
    tsvSafe(company),
    tsvSafe(role),
    'Evaluated',
    normalizedTrackerScore(score),
    '❌',
    `[${numStr}](reports/${filename})`,
    tsvSafe(`本地模型评估 (${o.model})`),
  ];
  if (postingUrl) trackerFields.push(tsvSafe(postingUrl));
  const additionHeader = postingUrl ? `${TSV_ADDITION_HEADER}\turl` : TSV_ADDITION_HEADER;

  return {
    filename,
    reportContent,
    additionName,
    additionHeader,
    additionRow: trackerFields.join('\t'),
  };
}
