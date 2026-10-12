// ui/eval-parse.mjs — 解析 AI 初筛返回的结构化字段
//
// 单独成模块的原因：这是整条链路里**最脆弱**的一环——模型输出的措辞完全不受控，
// 而它坏掉的方式是「静默降级」（分数出来了、理由没了），不会报错。
// 放在 server.mjs 里没法测，所以抽出来配一个回归测试（ui/check-eval-parse.mjs）。
//
// 为什么按结构而不是按标签名解析：
//   同一句 prompt 实测跑出过 **分级 / 评级 / 等级 / 层级** 四种档位标签，
//   分数是「评分」或「分数」，理由是「原因 / 理由 / 评估理由」。
//   穷举同义词是打地鼠，加一个又会冒新的。
//
// 于是利用 prompt 要求的固定四行结构，用**内容特征**定位：
//   · 分数行必含 `x.x/5`
//   · 结论行必含 通过 / 不通过 / PASS / FAIL
//   · 理由行是最长的那行，档位是最短的那行
// 标签名只作第一层兜底。

// 「档位」词表。项目规则里的档位取值就这几个，命中它比按长度猜更可靠。
const TIER_WORDS = /强匹配|值得投递|补投位|不建议|不匹配/;
const VERDICT_WORDS = /通过|未通过|PASS|FAIL|淘汰/i;

const TIER_LABELS = ['分级', '评级', '档位', '等级', '层级', '档次', 'TIER'];
const WHY_LABELS = ['评估理由', '理由', '原因', '依据', '说明', 'WHY'];
const VERDICT_LABELS = ['结论', '判定', 'VERDICT'];

// 扩展字段的标签（评估页雷达图 + 三组标签用，2026-09-23 加入）。
// 全部可选：老格式（只有 SCORE/VERDICT/TIER/WHY 四行）解析结果不变。
const EXT_LABEL_RE = /^(DIMS|GOOD|GAP|TIP|维度|优势|短板|建议)$/i;

/** 把「82, 78, 85, 70, 65, 62」这类串切成 6 个 0–100 整数；不合法返回 null。 */
function parseDims(raw) {
  if (!raw) return null;
  const nums = String(raw).split(/[,，、;；\s]+/).map((x) => parseFloat(x))
    .filter((n) => Number.isFinite(n));
  if (nums.length !== 6) return null;
  return nums.map((n) => Math.max(0, Math.min(100, Math.round(n))));
}

/** 把「a；b；c」切成条目数组（上限 6 条，防模型发疯刷屏）。 */
function splitItems(raw) {
  if (!raw) return [];
  return String(raw).split(/[;；\n]+/).map((x) => x.trim()).filter(Boolean).slice(0, 6);
}

/**
 * 把 AI 的初筛输出解析成结构化字段。
 * @param {string} out AI 的原始输出（期望四行：分数 / 结论 / 档位 / 理由）
 * @returns {{score: number|null, verdict: string, tier: string, why: string, pairs: Array}}
 */
export function parseTriage(out) {
  const empty = {
    score: null, verdict: '', tier: '', why: '',
    dims: null, good: [], gap: [], tip: [],
    pairs: [],
  };
  const text = String(out || '');
  if (!text.trim()) return empty;

  // 1. 切出所有「标签：值」行（中英文冒号都认）
  //
  // 必须先剥掉 markdown 装饰：模型经常输出 `**评分：** 4.4/5`，
  // 不剥的话标签会变成 `**评分`、值变成 `** 4.4/5`，
  // 于是按标签匹配全部落空（分数还侥幸能靠全局正则捞回来，档位就直接丢了）。
  const strip = (s) => String(s).replace(/^[\s*_`#>~]+/, '').replace(/[\s*_`~]+$/, '');

  const pairs = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^\s：:]{1,10})\s*[：:]\s*(.+?)\s*$/);
    if (!m) continue;
    const label = strip(m[1]);
    const value = strip(m[2]);
    if (label && value) pairs.push({ label, value });
  }

  const byLabel = (labels) => {
    for (const l of labels) {
      const hit = pairs.find((p) => p.label === l);
      if (hit) return hit.value;
    }
    return '';
  };

  // 2. 分数：全局正则兜底，不依赖它在第几行
  const scoreM = text.match(/(\d(?:\.\d)?)\s*\/\s*5/);
  const scorePair = pairs.find((p) => /\d(?:\.\d)?\s*\/\s*5/.test(p.value));

  // 3. 结论：标签优先，否则按内容找；判定必须**否定优先**，
  //    否则「不通过」会先被「通过」匹配上，判反。
  const verdictRaw = byLabel(VERDICT_LABELS)
    || (pairs.find((p) => VERDICT_WORDS.test(p.value)) || {}).value
    || '';
  let verdict = '';
  if (/不通过|未通过|FAIL|淘汰/i.test(verdictRaw)) verdict = 'FAIL';
  else if (/PASS|通过|符合|达标/i.test(verdictRaw)) verdict = 'PASS';

  // 4. 剩下的就是档位和理由（把分数行、结论行、扩展字段行摘掉）
  const rest = pairs.filter((p) => p !== scorePair
    && !VERDICT_WORDS.test(p.value)
    && !EXT_LABEL_RE.test(p.label));

  const byLen = (desc) => (rest.slice().sort((a, b) => desc
    ? b.value.length - a.value.length
    : a.value.length - b.value.length)[0] || {}).value || '';

  const tier = byLabel(TIER_LABELS)
    || ((rest.find((p) => TIER_WORDS.test(p.value))) || {}).value
    || byLen(false);          // 档位一定比理由短

  const why = byLabel(WHY_LABELS)
    || byLen(true);           // 理由是最长的那条

  return {
    score: scoreM ? Number(scoreM[1]) : null,
    verdict,
    // 兜底逻辑可能让 tier 和 why 指到同一条（只剩一行时），别重复展示
    tier: tier === why ? '' : tier,
    why,
    // 扩展字段（可选）：雷达图六维分 + 三组标签条目
    dims: parseDims(byLabel(['DIMS', '维度'])),
    good: splitItems(byLabel(['GOOD', '优势'])),
    gap: splitItems(byLabel(['GAP', '短板'])),
    tip: splitItems(byLabel(['TIP', '建议'])),
    pairs,
  };
}
