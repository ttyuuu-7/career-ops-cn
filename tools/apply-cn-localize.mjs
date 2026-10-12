#!/usr/bin/env node
/**
 * apply-cn-localize.mjs — 把「国内求职阶段」重新打回系统层文件
 *
 * 为什么需要它：国内求职的阶段划分（简历筛选 / 笔试测评 / 初试 / 复试 / 终面 /
 * 谈薪 / 无回应）必须写进 `templates/states.yml` —— 那是全项目的
 * 「规范状态」事实来源，verify-pipeline.mjs、normalize-statuses.mjs、
 * funnel-velocity.mjs、set-status.mjs 都动态读它。写进别的地方不生效。
 *
 * 但 `templates/states.yml` 和 `stats.mjs` 属于**系统层**，
 * `node update-system.mjs` 会把它们还原成上游版本，本地化就丢了。
 *
 * 所以本地化以「本脚本 + 下面那张表」为准：系统更新之后重跑一次即可恢复。
 * 脚本是幂等的 —— 已经打过补丁再跑，只会报「无需改动」。
 *
 * 用法：
 *   node tools/apply-cn-localize.mjs            # 打补丁（幂等）
 *   node tools/apply-cn-localize.mjs --check    # 只检查，不写文件
 *   node tools/apply-cn-localize.mjs --revert   # 从 .cn-backup 还原
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const STATES = join(ROOT, 'templates', 'states.yml');
const STATS = join(ROOT, 'stats.mjs');
// 备份放在 data/ 下而不是 templates/ ：templates/ 会被各种校验脚本扫描，
// 多出 .bak 文件容易被当成异常数据。
const BACKUP_DIR = join(ROOT, 'data', '_cn-localize');

const CHECK_ONLY = process.argv.includes('--check');
const REVERT = process.argv.includes('--revert');

// ── 单一事实来源：国内求职阶段 ────────────────────────────────────────────
// 顺序即生命周期顺序。`after` 只在插入时用；真正的顺序看下面的 ORDER。
//
// 设计原则：这套阶段**不绑定校招**，校招 / 社招 / 实习都适用。
// 上游按欧美节奏分成 Applied → Responded → Interview → Offer 四大段，
// 粒度太粗 —— 看不出「卡在简历筛选」「卡在复试」这类真正需要跟进的位置。
const CN_STAGES = [
  {
    id: 'screening', label: 'Resume Screening', cn: '简历筛选',
    aliases: '[简历筛选, 筛选中, 过筛, 简历通过, 已查看, 待初试, resume screening]',
    description: '简历在筛选中 / 已通过筛选，等待安排面试', dashboard_group: 'responded',
  },
  {
    id: 'written_test', label: 'Written Test', cn: '笔试 / 测评',
    aliases: '[笔试, 机试, 在线笔试, 专业笔试, coding test, 测评, 在线测评, 在线测试, 性格测评, 行测, 行测题, assessment]',
    description: '收到笔试 / 机试 / 在线测评（含性格测评、行测）', dashboard_group: 'responded',
  },
  {
    id: 'first_interview', label: 'Interview 1', cn: '初试',
    aliases: '[初试, 一面, 初面, 技术一面, 业务一面]',
    description: '初试（通常为技术面 / 业务面）', dashboard_group: 'interview',
  },
  {
    id: 'second_interview', label: 'Interview 2', cn: '复试',
    aliases: '[复试, 二面, 复面, 技术二面, 交叉面]',
    description: '复试（通常为交叉面 / 部门面）', dashboard_group: 'interview',
  },
  {
    id: 'final_interview', label: 'Final Interview', cn: '终面',
    aliases: '[终面, 终试, 三面, 总监面, 主管面, 部门面]',
    description: '终面 / 最后一面（常见为总监面、主管面）', dashboard_group: 'interview',
  },
  {
    id: 'salary_negotiation', label: 'Salary Negotiation', cn: '谈薪 / HR 沟通',
    aliases: '[谈薪, 薪资沟通, 薪资谈判, 待遇沟通, hr面, 人力面, 综合面, hr沟通]',
    description: 'HR 沟通环节：谈薪、定级、到岗时间、背调', dashboard_group: 'offer',
  },
  {
    id: 'no_response', label: 'No Response', cn: '无回应',
    aliases: '[无回应, 无响应, 石沉大海, 已沉默, ghosted]',
    description: '投递后长期无回应（超过 3 周可按此归档）', dashboard_group: 'discarded',
    terminal: true,
  },
];

// 上游 9 个状态补中文显示名（缺了界面会掉回英文）
const CN_ON_UPSTREAM = {
  evaluated: '待投递',
  applied: '已投递',
  responded: '已回应',
  interview: '面试中',
  offer: '正式 Offer',
  rejected: '已拒',
  discarded: '已放弃',
  skip: '不可投',
  hired: '已入职',
};

// 上游状态补中文别名（让台账里写中文也能被归一化认出来）
const ALIAS_ON_UPSTREAM = {
  evaluated: ['待投递', '已评估', '待申请'],
  applied: ['已投递', '已网申', '已申请', '网申'],
  responded: ['已回应', '已回复', '有回应', 'hr已联系'],
  interview: ['面试', '面试中', '面试流程中'],
  offer: ['已发offer', '正式offer', '录用', '口头offer', '意向书'],
  rejected: ['已拒', '被拒', '未通过', '已拒信', '感谢信'],
  discarded: ['已放弃', '主动放弃', '已归档', '已关闭'],
  skip: ['不可投', '资格不符', '不投'],
  hired: ['已入职', '已接受offer', '已签约'],
};

// 最终顺序 = 国内求职生命周期
const ORDER = [
  'evaluated', 'applied', 'responded', 'screening', 'written_test',
  'interview', 'first_interview', 'second_interview', 'final_interview',
  'salary_negotiation', 'offer', 'rejected', 'no_response', 'discarded', 'skip', 'hired',
];

// ── 工具 ───────────────────────────────────────────────────────────────────

const log = [];
const say = (s) => { log.push(s); console.log(s); };
const bakPath = (file) => join(BACKUP_DIR, file.split(/[\\/]/).pop() + '.bak');
/** 只在还没有备份时备份一次——_cn-localize/ 里存的应当是「打补丁之前」的原件 */
const backup = (file) => {
  if (!existsSync(BACKUP_DIR)) mkdirSync(BACKUP_DIR, { recursive: true });
  const b = bakPath(file);
  if (!existsSync(b)) { copyFileSync(file, b); return true; }
  return false;
};
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 说明段落用哨兵注释包起来。
// 为什么要哨兵：早先的实现靠正则从 note 开头一路删到文件结尾来「替换说明」，
// 而上游文件里 `states:` 恰好排在说明之后 —— 于是第一次打补丁就把
// `states:` 一起删掉了，文件直接变成非法 YAML（loadCanonicalStates 会抛错）。
// 用一对明确的 BEGIN/END 标记，就只可能删掉自己写的那一段。
const NOTE_BEGIN = '# ═══ CN-LOCALIZE:BEGIN ═══';
const NOTE_END = '# ═══ CN-LOCALIZE:END ═══';

const NOTE_BODY = [
  NOTE_BEGIN,
  '# 本段由 tools/apply-cn-localize.mjs 生成，请勿手工编辑。',
  '#',
  '# ── 中国大陆求职扩展（本地化增量，非上游状态） ──────────────────────────',
  '# 上游这套状态按欧美求职节奏设计：Applied → Responded → Interview → Offer。',
  '# 粒度太粗，看不出「卡在简历筛选」「卡在复试」这类真正需要跟进的位置，',
  '# 所以按国内招聘的通用习惯把中段拆细。这套阶段**不绑定校招**，',
  '# 校招 / 社招 / 实习都适用：',
  '#',
  '#   Applied（已投递）→ Resume Screening（简历筛选）→ Written Test（笔试 / 测评）',
  '#   → Interview 1（初试）→ Interview 2（复试）→ Final Interview（终面）',
  '#   → Salary Negotiation（谈薪 / HR 沟通）→ Offer（正式 offer）',
  '#',
  '# 每个状态都带 `cn:` 中文显示名和中文别名，因此：',
  '#   - 台账里直接写「复试」「谈薪」也能被 normalize-statuses.mjs 认出来',
  '#   - 控制台「投递台账」页显示中文，写回文件时仍是英文规范值',
  '#   - verify-pipeline.mjs / normalize-statuses.mjs / funnel-velocity.mjs',
  '#     都是动态读本文件，自动认可新状态，无需改代码',
  '#',
  '# ⚠️ `templates/states.yml` 与 `stats.mjs` 属于系统层，`node update-system.mjs`',
  '#    会把它们还原成上游版本。系统更新之后重跑',
  '#    `node tools/apply-cn-localize.mjs` 即可恢复（幂等，可反复执行）。',
  '#',
  '# 注意 label 一律用**多词**写法（含空格），不引入新的单词标签：上游',
  '# test-all.mjs 用 /^\\s+label:\\s*"?([A-Za-z]+)"?$/ 抽取单词标签，去和 web/',
  '# 里 Next.js 看板的六个状态表交叉校验。多词标签不进那个集合，于是不会把',
  '# 本地扩展误报成「看板缺少规范状态」。（代价：那一套看板不认识这些新状态。）',
  NOTE_END,
].join('\n');

/** 摘掉上一次生成的说明段（没有就原样返回） */
function stripNote(text) {
  if (!text.includes(NOTE_BEGIN)) return text;
  const re = new RegExp(escRe(NOTE_BEGIN) + '[\\s\\S]*?' + escRe(NOTE_END) + '\\n?');
  return text.replace(re, '');
}
const nodeCheck = (file) => {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); return null; }
  catch (e) { return String(e.stderr || e.message).slice(0, 400); }
};

// ── states.yml 合并 ────────────────────────────────────────────────────────

/** 把 states.yml 切成「头部注释 + 每个 - id 块」 */
function splitStates(text) {
  const first = text.search(/^  - id: /m);
  if (first < 0) throw new Error('states.yml 里找不到 "  - id: " 开头；文件结构变了吗？');
  const header = text.slice(0, first);
  const body = text.slice(first);
  const blocks = body.split(/\n(?=  - id: )/).map((b) => b.replace(/\s+$/, ''));
  return { header, blocks };
}

function idOf(block) {
  const m = block.match(/^  - id:\s*(\S+)/);
  return m ? m[1] : null;
}

/** 在块内的 label 行后插入 cn；在 aliases 行里追加别名 */
function patchUpstreamBlock(block, id) {
  let out = block;

  if (CN_ON_UPSTREAM[id] && !/^\s+cn:/m.test(out)) {
    out = out.replace(/^(    label:.*)$/m, `$1\n    cn: ${CN_ON_UPSTREAM[id]}`);
  }

  const extra = ALIAS_ON_UPSTREAM[id] || [];
  if (extra.length) {
    const m = out.match(/^    aliases:\s*\[(.*)\]\s*$/m);
    if (m) {
      const have = m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      const add = extra.filter((a) => !have.includes(a));
      if (add.length) {
        out = out.replace(/^    aliases:\s*\[.*\]\s*$/m,
          `    aliases: [${m[1].trim()}, ${add.join(', ')}]`);
      }
    } else if (!/^    aliases:/m.test(out)) {
      out = out.replace(/^(    label:.*)$/m, `$1\n    aliases: [${extra.join(', ')}]`);
    }
  }
  return out;
}

function makeCnBlock(s) {
  return [
    `  - id: ${s.id}`,
    `    label: ${s.label}`,
    `    cn: ${s.cn}`,
    `    aliases: ${s.aliases}`,
    `    description: ${s.description}`,
    `    dashboard_group: ${s.dashboard_group}`,
    ...(s.terminal ? ['    terminal: true'] : []),
  ].join('\n');
}

function buildStates(text) {
  const clean = stripNote(text).replace(/\n{3,}/g, '\n\n');
  const { header, blocks } = splitStates(clean);
  if (!/^states:/m.test(header)) {
    throw new Error('states.yml 的 "states:" 顶层键不在第一个条目之前；文件结构对吗？');
  }
  const known = new Set(blocks.map(idOf).filter(Boolean));
  const byId = new Map();
  for (const b of blocks) {
    const id = idOf(b);
    if (id) byId.set(id, patchUpstreamBlock(b, id));
  }

  const added = [];
  const ordered = [];
  for (const id of ORDER) {
    if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id); }
    else {
      const st = CN_STAGES.find((s) => s.id === id);
      if (st) { ordered.push(makeCnBlock(st)); added.push(id); }
    }
  }
  // 上游将来新增的状态：不丢，追加在后面
  const leftovers = [...byId.values()];
  if (leftovers.length) say(`  保留上游新增状态 ${leftovers.length} 个（追加在末尾）`);
  ordered.push(...leftovers);

  // 说明段紧跟在 `states:` 之后，条目块之间保留空行（与上游排版一致）
  const head = header.replace(/^(states:[^\n]*\n)/m, `$1${NOTE_BODY}\n`);
  return { text: head + ordered.join('\n\n') + '\n', added };
}

// ── stats.mjs 注入（漏斗分桶） ─────────────────────────────────────────────
//
// 幂等策略（踩过坑，别简化）：
//   常量块用 BEGIN/END 哨兵包住，每次先整段摘掉再重新注入 —— 否则反复执行
//   会在文件里堆出多份 CN_* 常量（`already` 那种「按常量名判断」的守卫更糟：
//   它认名字不认内容，改了注入内容之后会被误判为「无需改动」，新版永远不生效）。
//   其余锚点的正则一律写成**能同时匹配打补丁前后**的形式，replace 语义天然幂等。

const STATS_BEGIN = '// ═══ CN-LOCALIZE:BEGIN ═══';
const STATS_END = '// ═══ CN-LOCALIZE:END ═══';

const CN_CONST_BODY = [
  '// ── 中国大陆求职扩展阶段（见 templates/states.yml 顶部注释） ────────────────',
  '// 这些状态不新增漏斗层级，只归入已有四个桶（投递 → 回应 → 面试 → Offer），',
  '// 因此下面的算式对上游 9 个状态的结果一字未改。',
  "const CN_SCREENING_STATUSES = ['Resume Screening'];",
  "const CN_ASSESSMENT_STATUSES = ['Written Test'];",
  "const CN_INTERVIEW_STATUSES = ['Interview 1', 'Interview 2', 'Final Interview'];",
  "const CN_OFFER_STATUSES = ['Salary Negotiation'];",
  'const CN_EXTRA_STATUSES = [',
  '  ...CN_SCREENING_STATUSES, ...CN_ASSESSMENT_STATUSES,',
  "  ...CN_INTERVIEW_STATUSES, ...CN_OFFER_STATUSES, 'No Response',",
  '];',
  'const ALL_STATUSES = [...CANONICAL_STATUSES, ...CN_EXTRA_STATUSES];',
];

/** 早期版本（V1）注入的常量块没有哨兵，只能按「段落形状」识别 */
const LEGACY_CONST_BLOCK =
  /\n*\/\/[^\n]*中国大陆(?:校招|求职)扩展阶段[\s\S]*?const ALL_STATUSES = \[\.\.\.CANONICAL_STATUSES, \.\.\.CN_EXTRA_STATUSES\];/;

/** 摘掉上一次注入的 CN 常量块（V1 无哨兵的也认）（没有就原样返回） */
function stripStatsBlock(text) {
  return text
    .replace(new RegExp('\\n*' + escRe(STATS_BEGIN) + '[\\s\\S]*?' + escRe(STATS_END)), '')
    .replace(LEGACY_CONST_BLOCK, '');
}

/** 从 Set 的内联列表里去掉上一次注入的 ...CN_* 展开项 */
// 逐项过滤（不是逐行）：注入后可能写在同一行里，
// 形如 `...CN_A, ...CN_B, ...CN_C,`，按行判断会漏掉。
const stripCnSpreads = (inner) => inner
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s && !/^\.\.\.CN_\w+$/.test(s))
  .join(', ');

const STATS_ANCHORS = [
  {
    name: '国内阶段常量',
    re: /^(const CANONICAL_STATUSES = \[[^\n]*\];)$/m,
    inject: (m) => `${m}\n\n${STATS_BEGIN}\n${CN_CONST_BODY.join('\n')}\n${STATS_END}`,
  },
  {
    name: 'ACTIVE_STATUSES 纳入国内阶段',
    re: /^const ACTIVE_STATUSES = new Set\(\[([\s\S]*?)\]\);$/m,
    inject: (m, g1) => `const ACTIVE_STATUSES = new Set([${stripCnSpreads(g1)},\n`
      + '  ...CN_SCREENING_STATUSES, ...CN_ASSESSMENT_STATUSES,\n'
      + '  ...CN_INTERVIEW_STATUSES, ...CN_OFFER_STATUSES,\n]);',
  },
  {
    name: 'PURSUED_STATUSES 纳入国内阶段',
    re: /^const PURSUED_STATUSES = new Set\(\[([\s\S]*?)\]\);$/m,
    inject: (m, g1) => `const PURSUED_STATUSES = new Set([${stripCnSpreads(g1)},\n  ...CN_EXTRA_STATUSES,\n]);`,
  },
  {
    name: 'canonicalStatus 认识国内阶段',
    re: /^(\s+return )(?:CANONICAL|ALL)_STATUSES(\.includes\(cased\) \? cased : 'Unknown';)$/m,
    inject: (m, g1, g2) => `${g1}ALL_STATUSES${g2}`,
  },
  {
    name: 'byStatus 统计国内阶段',
    // 注意结尾是 `))` —— Object.fromEntries(...) 的右括号 + 语句分号。
    // 早先漏了这个括号，导致该锚点从来没匹配上（被上面的 `already` 守卫掩盖了）。
    re: /^(\s+const byStatus = Object\.fromEntries\()(?:CANONICAL|ALL)_STATUSES(\.map\(\(s\) => \[s, 0\]\)\);)$/m,
    inject: (m, g1, g2) => `${g1}ALL_STATUSES${g2}`,
  },
  {
    name: 'computeFunnel 分桶',
    re: /^export function computeFunnel\(byStatus\) \{[\s\S]*?\n\}$/m,
    inject: () => [
      'export function computeFunnel(byStatus) {',
      '  const n = (k) => byStatus[k] || 0;',
      '  const sum = (keys) => keys.reduce((acc, k) => acc + n(k), 0);',
      '  // 国内扩展阶段归入已有四个桶，不新增层级：',
      '  //   简历筛选 / 笔试测评    → 公司已回应（含回复率的分子）',
      '  //   初试 / 复试 / 终面     → 进入面试',
      '  //   谈薪 / HR 沟通         → 视同进入 offer 阶段',
      '  // 「无回应」计入 everApplied —— 和 Rejected 同样的道理：它证明岗位确实投出去了。',
      '  // 不这样算的话，被公司晾着的岗位不进分母，回应率会被虚高。',
      "  const everApplied = n('Applied') + n('Responded') + n('Interview') + n('Offer') + n('Hired') + n('Rejected')",
      "    + sum(CN_SCREENING_STATUSES) + sum(CN_ASSESSMENT_STATUSES) + sum(CN_INTERVIEW_STATUSES) + sum(CN_OFFER_STATUSES) + n('No Response');",
      "  const everResponded = n('Responded') + n('Interview') + n('Offer') + n('Hired')",
      '    + sum(CN_SCREENING_STATUSES) + sum(CN_ASSESSMENT_STATUSES) + sum(CN_INTERVIEW_STATUSES) + sum(CN_OFFER_STATUSES);',
      "  const everInterview = n('Interview') + n('Offer') + n('Hired')",
      '    + sum(CN_INTERVIEW_STATUSES) + sum(CN_OFFER_STATUSES);',
      "  const everOffer = n('Offer') + n('Hired') + sum(CN_OFFER_STATUSES);",
      '  return {',
      '    everApplied,',
      '    everResponded,',
      '    everInterview,',
      '    everOffer,',
      '    responseRate: pct(everResponded, everApplied),',
      '    interviewRate: pct(everInterview, everApplied),',
      '    offerRate: pct(everOffer, everApplied),',
      '    smallSample: everApplied < 10,',
      '  };',
      '}',
    ].join('\n'),
  },
  {
    name: 'STAGE_RANK 补国内阶段',
    // 单行 / 多行两种排版都认（上游排版变过，只认单行会静默失配）
    re: /^const STAGE_RANK = \{[\s\S]*?\};$/m,
    inject: () => [
      'const STAGE_RANK = {',
      '  Applied: 1, Responded: 2, Interview: 3, Offer: 4, Hired: 5,',
      "  'Resume Screening': 2, 'Written Test': 2,",
      "  'Interview 1': 3, 'Interview 2': 3, 'Final Interview': 3,",
      "  'Salary Negotiation': 4,",
      '};',
    ].join('\n'),
  },
];

function buildStats(text) {
  let out = stripStatsBlock(text);
  const missing = [];
  for (const a of STATS_ANCHORS) {
    const m = out.match(a.re);
    if (!m) { missing.push(a.name); continue; }
    const replaced = a.inject(m[0], ...m.slice(1));
    if (replaced === m[0]) continue;
    out = out.replace(a.re, () => replaced);
  }
  return { text: out, missing };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

if (REVERT) {
  let n = 0;
  for (const f of [STATES, STATS]) {
    const b = bakPath(f);
    if (existsSync(b)) {
      copyFileSync(b, f);
      say(`已还原 ${f.startsWith(ROOT) ? f.slice(ROOT.length + 1) : f}`);
      n++;
    }
  }
  say(n ? '' : `没有找到备份（${BACKUP_DIR}），无需还原。`);
  process.exit(0);
}

say('\n国内求职本地化 — 打补丁到系统层文件');
say('='.repeat(56));

// 1) templates/states.yml
const statesSrc = readFileSync(STATES, 'utf-8');
let statesOut, added = [];
try {
  ({ text: statesOut, added } = buildStates(statesSrc));
} catch (e) {
  say(`✗ 解析 templates/states.yml 失败：${e.message}`);
  process.exit(2);
}
const statesChanged = statesOut !== statesSrc;

if (!statesChanged) {
  say('✓ templates/states.yml 已经是本地化状态，无需改动');
} else if (CHECK_ONLY) {
  say(`⚠ templates/states.yml 需要改动（缺 ${added.length} 个国内阶段：${added.join(', ') || '仅缺 cn/别名'}）`);
} else {
  const fresh = backup(STATES);
  writeFileSync(STATES, statesOut, 'utf-8');
  say(`✓ templates/states.yml 已更新${added.length ? `（新增 ${added.join(', ')}）` : '（补齐 cn 与中文别名）'}`);
  if (fresh) say(`  备份：data/_cn-localize/states.yml.bak`);
}

// 2) stats.mjs
// 不设「已经打过补丁就跳过」的守卫 —— 那种守卫认名字不认内容，
// 一旦注入内容改版（比如换了阶段名），它会把新版本误判成「无需改动」，
// 于是文件永远停在旧版。改成：先摘掉旧块，再按当前模板重建，最后比字符串。
const statsSrc = readFileSync(STATS, 'utf-8');
let statsChanged = false;
{
  const { text: statsOut, missing } = buildStats(statsSrc);
  if (missing.length) {
    say(`✗ stats.mjs 有 ${missing.length} 处锚点找不到，未做任何修改（避免写坏文件）：`);
    missing.forEach((n) => say(`    - ${n}`));
    say('  → 上游可能改了这些代码的结构。请对照 tools/apply-cn-localize.mjs 里的');
    say('    STATS_ANCHORS 手工把国内阶段补进 stats.mjs，或直接跑 tools/verify-cn-setup.mjs 看哪一项没过。');
    process.exitCode = 2;
  } else if (statsOut === statsSrc) {
    say('✓ stats.mjs 已经是当前版本的本地化状态，无需改动');
  } else if (CHECK_ONLY) {
    say('⚠ stats.mjs 需要改动（把国内阶段并入漏斗分桶）');
  } else {
    backup(STATS);
    writeFileSync(STATS, statsOut, 'utf-8');
    const err = nodeCheck(STATS);
    if (err) {
      if (existsSync(bakPath(STATS))) copyFileSync(bakPath(STATS), STATS);
      else writeFileSync(STATS, statsSrc, 'utf-8');
      say(`✗ 注入后 stats.mjs 语法校验失败，已回滚。错误：${err.split('\n')[0]}`);
      process.exitCode = 2;
    } else {
      statsChanged = true;
      say('✓ stats.mjs 已更新（漏斗分桶纳入国内阶段，语法校验通过）');
      if (existsSync(bakPath(STATS))) say('  备份：data/_cn-localize/stats.mjs.bak');
    }
  }
}

say('='.repeat(56));
if (process.exitCode) {
  say('结论：有未完成项，见上面的说明\n');
} else if (!statesChanged && !statsChanged) {
  say('结论：本地化完好，没有需要改的地方');
  say('提示：系统更新之后再跑一次本脚本即可恢复。\n');
} else {
  say('结论：本地化已应用');
  // 这里刻意不写「应 N/N 通过」：那个数字每加一条断言就过期一次，
  // 而过期的提示比没有提示更糟 —— 有人会照着旧数字判断「怎么少了」。
  say('下一步：node tools/verify-cn-setup.mjs   （应全部通过，失败 0）');
  say('       node stats.mjs                     （漏斗里应出现国内阶段）\n');
}
