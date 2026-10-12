// ui/prep-model.mjs — 「面试备考建议」的纯函数内核（**零依赖**）
//
// ── 这个文件为什么必须零依赖 ──────────────────────────────────────────────
// app.js 是浏览器模块，它 import 的东西浏览器必须能解析，而且**服务端的
// STATIC 白名单是逐条列的**（不是目录映射）。所以：
//   · 只允许 import 同为「零依赖」的兄弟模块（本文件刻意一个 import 都没有）
//   · 模块名要加进 ui/server.mjs 的 STATIC，漏一行 → 404 → app.js 整条模块图
//     加载失败 → **整页空白**（控制台只报 404，像静态资源没配好）
//
// ── 职责边界 ─────────────────────────────────────────────────────────────
//   ✅ prompt 拼装、AI 回复解析、本地兜底生成、导出 Markdown 组装
//   ❌ 读文件、跑 AI、写盘 —— 那些在 ui/server.mjs（Node 侧）
// 这样「怎么算」可以被 ui/check-prep.mjs 直接测，不经过服务器；
// 而「去哪儿拿数据」仍然只有一个入口。坏起来能立刻分清是哪一层。
//
// ── 输出契约（三条硬约束，来自需求原文）──────────────────────────────────
//   1. 三部分齐全：知识点 / 实践项目 / 学习资源
//   2. 知识点要标**优先级**与**掌握程度要求**
//   3. 学习资源要**具体、可被检索**（视频课程 + 书籍）
// 前端与自检都按这三条断言，所以这里的解析器要容忍 7B 模型的各种走样格式。

// ══ 一、常量 ══════════════════════════════════════════════════════════════

/** 优先级。顺序即排序权重，别改顺序。 */
export const PRIORITIES = ['P0', 'P1', 'P2'];

/** 优先级的中文说法与视觉档位（颜色由 CSS 决定，这里只说该套哪个档）。 */
export const PRIORITY_ZH = { P0: '必须掌握', P1: '重点补强', P2: '加分项' };
export const PRIORITY_TONE = { P0: 'bad', P1: 'warn', P2: 'info' };

/**
 * 掌握程度要求。写死成三档而不是让模型自由发挥 ——
 * 7B 模型很爱写「深入了解」「熟练掌握」这种无法验收的话，
 * 定成三档至少能拿来做勾选进度。
 */
export const MASTERY_LEVELS = [
  { id: 'know', label: '了解概念', desc: '能说清是什么、解决什么问题' },
  { id: 'use', label: '能上手用', desc: '能在项目里独立写出来' },
  { id: 'deep', label: '能讲原理', desc: '面试深挖到原理也答得上' },
];

export const MASTERY_ZH = Object.fromEntries(MASTERY_LEVELS.map((m) => [m.id, m.label]));

/** 学习资源的类型。视频课程优先（时间成本低），书籍兜原理。 */
export const RESOURCE_KINDS = ['video', 'book', 'doc', 'practice'];
export const RESOURCE_KIND_ZH = {
  video: '视频课程',
  book: '书籍',
  doc: '官方文档',
  practice: '练习 / 题库',
};

/** 三大部分的固定标题，前端小节标题与导出 Markdown 都用它。 */
export const SECTION_TITLES = {
  gaps: '需要学习与补充的知识点',
  projects: '可用来补全简历的实践项目建议',
  resources: '学习资源清单',
};

// ══ 二、数据缺失诊断（需求第 4 条：数据缺失时给出明确提示）══════════════
//
// 为什么单独抽出来：这一条判断会在「页面加载」「点生成」两处用到，
// 写两遍必然分家 —— 然后出现「页面上说能生成、点了说缺数据」这种自相矛盾。
//
// 返回 { ok, reason, hint, missing }：
//   ok=false 时 reason 是机器可读的代号，hint 是给用户看的中文，
//   missing 列出具体缺哪几样（给页面渲染成清单）。

export const MISSING_REASONS = {
  NO_REPORT: 'no-report',
  NO_CV: 'no-cv',
  NO_CV_CONTENT: 'no-cv-content',
  NO_JD: 'no-jd',
  NO_GAPS: 'no-gaps',
};

/**
 * 判断「这一份报告 + 简历」够不够生成备考建议。
 *
 * @param {{report?: object, cvText?: string}} o
 *   report 形如 { file, title, body, hasJd, gaps, requirements }
 * @returns {{ok: boolean, reason: string, hint: string, missing: string[]}}
 */
export function diagnoseInputs({ report, cvText = '' } = {}) {
  const missing = [];

  if (!report || !report.file) {
    return {
      ok: false,
      reason: MISSING_REASONS.NO_REPORT,
      hint: '还没有可分析的评估报告。备考建议要拿「岗位要求 + 能力评估结论」来做差距对比，'
        + '所以先去「评估岗位」跑一次完整评估（初筛不出报告，必须点「生成完整报告」）。',
      missing: ['评估报告'],
    };
  }

  if (!String(cvText || '').trim()) {
    return {
      ok: false,
      reason: MISSING_REASONS.NO_CV,
      hint: '读不到简历正文（cv.md 是空的，或者还没填）。'
        + '备考建议要把岗位要求和你的经历逐条对比才知道缺什么 —— '
        + '先去「我的简历」把内容填上，再回来生成。',
      missing: ['简历（cv.md）'],
    };
  }

  // 报告里没有 JD 归档、也没有 A) 岗位概览，等于无从知道岗位要什么。
  // 这一条要**排在差距判断前面**：没有岗位要求时，现推也推不出东西，
  // 报「缺岗位要求」比报「缺差距清单」更贴近真实原因。
  const hasReq = !!(report.hasJd
    || (report.requirements && report.requirements.length)
    || /任职要求|岗位职责|Job Description/i.test(String(report.body || '')));
  if (!hasReq) {
    return {
      ok: false,
      reason: MISSING_REASONS.NO_JD,
      hint: '这份报告里找不到岗位要求（JD 归档与「岗位概览」都是空的），没法做差距对比。'
        + '可以重新跑一次完整评估（它会归档 JD 原文），或换一份报告。'
        + '（本地模型偶尔会产出「只留标题、没有正文」的残报告，这类报告都要重跑。）',
      missing: ['岗位要求（JD）'],
    };
  }

  // 差距清单是这份功能的主输入。
  //
  // 注意：解析器在报告没写差距时**会拿 JD 跟简历现推**（形状⑥），
  // 所以 gaps 非空不等于「报告里写了差距」。这里要看的是**来源**：
  // 靠现推出来的，结论会粗一些，得如实告诉用户，而不是假装报告写得很全。
  const gaps = Array.isArray(report.gaps) ? report.gaps : [];
  const derived = gaps.filter((g) => /依据：JD 要求与 cv\.md 对照/.test(g));
  const declared = gaps.length - derived.length;

  if (!gaps.length) {
    return {
      ok: false,
      reason: MISSING_REASONS.NO_GAPS,
      hint: '这份报告里有岗位要求，但既没有差距清单、也没能从要求与简历的对照里推出缺口 —— '
        + '多半是本机简历内容太少（例如只有学历、没有任何技术经历）。'
        + '先把 cv.md 里的技能与项目补上，再来生成。',
      missing: ['简历里的技术经历'],
    };
  }

  if (declared === 0) {
    // 有差距，但全是推出来的 —— 能生成，只是精度不如报告自己写的那份
    return {
      ok: true,
      reason: MISSING_REASONS.NO_GAPS,
      hint: '这份报告没有自己写「差距清单」—— 上面的缺口是拿 JD 要求跟你的简历逐条对照推出来的'
        + '（共 ' + derived.length + ' 条）。结论方向没问题，但比报告自带差距清单时粗一些。'
        + '想要更准，重新跑一次完整评估拿到带 Gaps 的报告。',
      missing: ['报告自带的差距清单'],
    };
  }

  if (derived.length) {
    return {
      ok: true,
      reason: MISSING_REASONS.NO_GAPS,
      hint: '这份报告写了 ' + declared + ' 条差距，另有 ' + derived.length
        + ' 条是拿 JD 要求跟简历对照补推出来的（已一并纳入）。',
      missing: [],
    };
  }

  return { ok: true, reason: '', hint: '', missing: [] };
}

// ══ 三、报告解析 ══════════════════════════════════════════════════════════

/** 把报告 markdown 的某个小节切出来（`### X)` 到下一个同级/更高级标题之间）。 */
function sliceSection(md, letter) {
  const s = String(md || '');
  // 字母序号可能是 `## A)` / `### A)` / `#### A)`，全都要认
  const head = new RegExp('^#{2,4}\\s*' + letter + '\\)\\s*(.*)$', 'm');
  const m = head.exec(s);
  if (!m) return '';
  const start = m.index + m[0].length;
  const rest = s.slice(start);
  const next = rest.search(/^#{2,4}\s*[A-H]\)/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** 从 `- **加粗:** 后面的话` 这类行里取「标签」与「值」。 */
function splitLabeled(line) {
  const m = line.match(/^\s*[-*]\s*\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
  if (!m) return null;
  return { label: m[1].trim(), value: m[2].trim() };
}

/**
 * 把归档的 JD 原文按「要求 / 职责」两类块切开。
 *
 * 为什么非要切：JD 前半段通常整段是**岗位职责**（「负责 X 系统的开发与维护」），
 * 见编号就当要求收进来，会把职责原样搬进「技术要点 / 对岗位的价值」，
 * 正文就成了抄 JD —— 备考建议最没用的形态。
 *
 * 判定规则很朴素：遇到「任职要求 / 岗位要求 / 技能要求 / 我们希望你」这类小标题，
 * 之后的编号条目算要求；遇到「岗位职责 / 工作内容 / 你将负责」之后算职责。
 * 一条小标题都没有（很多 JD 就是一段编号）→ 全部按**要求**收，
 * 因为「要你会 X」比「让你做 Y」对备考更有意义，且此时没有更好的判据。
 */
function splitJdByKind(jd) {
  const REQ_HEAD = /任职要求|岗位要求|任职资格|任职条件|技能要求|我们希望你|职位要求|岗位需求|基本要求|加分项|requirements?/i;
  const DUTY_HEAD = /岗位职责|工作职责|职责描述|工作内容|你将|主要工作|职位描述|job\s*description|responsibilit/i;
  const reqs = [];
  const duties = [];
  let mode = ''; // '' 未定 → 见标题才定；未定时按要求收

  for (const raw of String(jd || '').split('\n')) {
    const line = raw.trim().replace(/^\s*[-*]\s*/, '');
    if (!line) continue;

    // 小标题（可能是 `## 任职要求`，也可能是 `任职要求：`）
    const head = line.replace(/^#{1,6}\s*/, '').replace(/[:：]\s*$/, '').trim();
    if (head.length <= 20) {
      if (REQ_HEAD.test(head)) { mode = 'req'; continue; }
      if (DUTY_HEAD.test(head)) { mode = 'duty'; continue; }
    }

    const m = line.match(/^(?:\d+[.)、]|[-*])\s*(.+)$/);
    let item = m ? m[1] : '';
    // 无列表符号的裸行：**只在已进入「要求」段时收**（2026-10-12 修：
    // 从网页粘的 JD 常不带 bullet，「岗位要求」下面就是一整段裸行，
    // 旧规则全跳过 → 解析出 0 条要求，备考建议直接失去主要依据）。
    // 太短的裸行当小节标题跳过（「核心技术」这种），带列表符号的不受此限。
    // 职责段 / 未定段照旧只认列表符号 —— 那两处的裸行大多是叙述性文字。
    if (!item && mode === 'req') {
      if (line.length < 9) continue;
      item = line;
    }
    item = item.trim().replace(/[。．.]$/, '');
    if (item.length < 4 || item.length > 200) continue;
    (mode === 'duty' ? duties : reqs).push(item);
  }
  return { reqs, duties };
}

/**
 * 报告里那些「不是候选人短板」的句子 —— 必须过滤掉。
 * 它们长得很像差距（都以「未提及 / 未提供」开头），但说的是**招聘信息本身**
 * 没写清楚，跟候选人能力无关。7B 模型会把这两类混在一起写进 Gaps flagged 里，
 * 照单全收的话会得出「你要补的是『未提供具体招聘渠道』」这种荒唐建议。
 */
const JD_METADATA_NOISE = /未提供具体(?:日期|渠道|网站|公司)|未提及具体(?:文化|红灯|招聘渠道|就业形式|AI使用|AI筛选)|未披露|不参与评分|沉默即无信号|视为长期开放|Posting\s*(?:Age|Language|Legitimacy)|Culture Screen|Employment Classification|AI[- ](?:Claims|Screening)|JD\s*(?:未|没有)|公司名称：未知|招聘渠道：未知|未发现明显问题|是否符合.{0,6}资格检查/;

/** 这一句是不是在说「候选人缺某样东西」。 */
export function looksLikeCandidateGap(s) {
  const t = String(s || '').trim();
  if (t.length < 6 || t.length > 200) return false;
  if (JD_METADATA_NOISE.test(t)) return false;
  // 有实质内容：提到技术/能力/经历，或有明确的「缺失」措辞
  return /缺乏|未提及|没有|缺少|不具备|尚未|待补|不熟悉|不了解|缺失|不足|待补充|无(?:相关|任何|具体)?(?:经验|经历|产出|项目)|空白/.test(t);
}

/**
 * 最后一招：直接把「JD 要求」和「简历正文」做关键词对照。
 *
 * 为什么需要它：有些报告（本地模型写的）B) 节是一张「要求 | ✅」表，
 * 通篇没标出任何不匹配，Gaps 小节里写的又是招聘信息元数据。这种情况下
 * 「报告里没有差距」并不等于「候选人没短板」—— 是报告没写。
 * 那就回到最朴素的判断：JD 要求里的关键技能词，简历里一个都没出现的，算差距。
 *
 * 这一步是**启发式**，所以结果会带上「依据：JD 要求中未在简历里出现」的说明，
 * 让用户知道这条是自己推的、不是报告里写的。
 */
export function deriveGapsFromJd(requirements, cvText) {
  const cv = String(cvText || '').toLowerCase();
  if (!cv.trim()) return [];

  // 技能词表：只挑能明确判定的硬技能，避免把「沟通能力」这种软素质也算成缺口
  const SKILLS = [
    'JVM', 'Spring Boot', 'Spring Cloud', 'MyBatis', 'MySQL', 'Redis', 'Kafka', 'RabbitMQ',
    'Docker', 'Kubernetes', 'K8s', 'Linux', 'Git', 'Maven', 'Nginx',
    'Java', 'Python', 'C++', 'Go', 'JavaScript', 'TypeScript', 'SQL',
    'PyTorch', 'TensorFlow', 'Transformer', 'BERT', 'Attention', 'NLP', 'CV',
    'YOLO', 'ResNet', 'ViT', 'SAM', 'CLIP', 'GAN', 'VAE', 'DETR',
    'TensorRT', 'ONNX', 'OpenVINO', 'CUDA', '分布式', '微服务', '高并发', '消息队列',
    '数据结构', '算法', '多线程', '并发', 'Linux 内核', 'Netty', 'Elasticsearch',
    'Hadoop', 'Spark', 'Flink', 'ClickHouse', 'MongoDB', 'Zookeeper',
    '单元测试', 'JUnit', 'CI/CD', 'Jenkins', '单元测试框架', '模型部署', '模型量化',
  ];

  const reqText = (requirements || []).join('\n');
  if (!reqText.trim()) return [];

  const out = [];
  for (const skill of SKILLS) {
    const re = new RegExp(escapeRe(skill), 'i');
    if (!re.test(reqText)) continue;          // JD 没要求，不管
    // 简历里出现同义词也算有
    const aliases = ALIASES[skill] || [];
    const has = re.test(cv) || aliases.some((a) => new RegExp(escapeRe(a), 'i').test(cv));
    if (has) continue;
    out.push('『' + skill + '』：JD 明确要求，但简历里找不到相关经历（依据：JD 要求与 cv.md 对照）');
    if (out.length >= 8) break;
  }
  return out;
}

/** 技能别名：简历里写「微服务」而 JD 写「Spring Cloud」时不该算缺口。 */
const ALIASES = {
  'JVM': ['java虚拟机', '垃圾回收', 'GC'],
  'Spring Boot': ['springboot', 'spring'],
  'Spring Cloud': ['微服务', 'springcloud', 'nacos'],
  'Kubernetes': ['k8s', '容器编排'],
  'Docker': ['容器化', '容器'],
  'PyTorch': ['pytorch', 'torch'],
  'TensorFlow': ['tensorflow', 'tf'],
  'NLP': ['自然语言', '大模型', 'llm'],
  'CV': ['计算机视觉', '图像'],
  'Transformer': ['注意力机制', 'self-attention'],
  '分布式': ['集群', '分布式系统'],
  '高并发': ['并发', '压测', 'qps', '吞吐'],
  '消息队列': ['mq', 'kafka', 'rabbitmq', 'rocketmq'],
  'CI/CD': ['持续集成', '持续交付', 'jenkins', 'github actions'],
  '模型部署': ['推理', '上线', '部署'],
  '模型量化': ['量化', 'int8', 'fp16'],
};

/**
 * 解析一份报告，取出备考建议要用的原料。
 *
 * 设计取向：**宽松解析、缺了不炸**。报告是 7B 模型写的，格式本来就会走样。
 * 实测同一个模板会产出至少五种写法（都对，只是形状不同）：
 *   ① `**Gaps:**` + 短横线清单           —— 010
 *   ② `### 差距清单` + 表格 + 编号条目     —— 009
 *   ③ B) 节直接是一张「要求 | 匹配」表，用 ⚠️/❌ 标出不匹配 —— 011
 *   ④ B) 节是「- **要求** 说明」清单，没有单独的差距小节 —— 012
 *   ⑤ 干脆没有 B) 节                       —— 013（残报告）
 * 只认形状①的话，「解析出 0 条差距」会被误判成「这份岗位没短板」，
 * 于是页面显示一堆空洞建议 —— 比报错更糟。所以下面全部认，且按可靠性排序。
 *
 * @param {string} md 报告正文
 * @param {object} meta { file, title, score, archetype }
 * @param {string} cvText 简历正文（只在「报告没写差距」时用来现推，可省）
 * @returns {{file,title,gaps,requirements,matches,questions,score,archetype,jd}}
 */
/**
 * 报告详情页「匹配卡」的字段（2026-10-12 用户要求：详情页内容按初筛结果卡
 * 那套版式写，并把内容扩充）。
 *
 * 与初筛结果卡同构：六维分 / 综合分 / 结论 / 优势 / 短板 / 建议。
 * 优先读报告里**新增的摘要块**（`### 六维评分` 表 + `### 优势匹配点 / 能力短板 /
 * 简历优化建议` 三个小节，见 modes/_profile.md 覆盖规则 8）；
 * 老报告没有这些块时逐项兜底，宁可降级也不编：
 *   六维 → null（前端按总分折算画雷达并注明「示意」，与初筛同口径）
 *   结论 → 头部字段之后的第一段（报告惯例是「**结论：…**」那段）
 *   优势 → B) 匹配表里判定带 ✅/强匹配/通过 的行
 *   短板 → 差距清单（B) 的「差距清单」）
 *   建议 → E) 定制方案里的条目，没有就取 C)「更值得做的三件事」
 */
export const REPORT_DIM_ORDER = ['专业技能', '项目经验', '学历背景', '软技能', '行业经验', '成果量化'];

/** 取某个三级/四级小节的正文（到下一个同级或更高级标题为止）。 */
function mdSubSection(md, re) {
  const m = re.exec(md);
  if (!m) return '';
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^#{2,4}\s+\S/m);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
}

/** 小节正文 → 条目数组（跳过表格行/标题行，去掉列表符号与加粗标记）。 */
function mdBullets(block, limit) {
  const out = [];
  for (const raw of String(block || '').split('\n')) {
    let t = raw.trim();
    if (!t || /^\|/.test(t) || /^#{1,6}\s/.test(t) || /^-{3,}$/.test(t)) continue;
    // 带列表符号的才是「条目」；裸行要考虑是不是混进来的小节标题
    const isItem = /^\s*(?:[-*+]|\d+[.)、])\s+/.test(raw);
    t = t.replace(/^\s*(?:[-*+]|\d+[.)、])\s*/, '').replace(/\*\*/g, '').trim();
    if (t.length < 4) continue;
    // ⚠️ 只对**裸行**做「短行＝小节标题」过滤：带符号的条目再短也要留
    // （踩过：把「缺少高并发场景证据」这种 9 字条目当标题滤掉，整组变空）。
    if (!isItem && t.length <= 12 && !/[。！？；：,，]/.test(t)) continue;
    out.push(t);
    if (limit && out.length >= limit) break;
  }
  return out;
}

/** 表格单元格切分（去首尾空列）。 */
function mdCells(line) {
  const cells = String(line).split('|').map((c) => c.trim());
  return cells.filter((c, i, a) => !(i === 0 && !c) && !(i === a.length - 1 && !c));
}

/** 六维：优先 `DIMS: a,b,c` 一行，其次 `### 六维评分` 表（维度|分）。 */
function parseReportDims(md) {
  const compact = md.match(/^DIMS[:：]\s*([0-9,\s]{5,60})$/im);
  if (compact) {
    const vals = compact[1].split(/[,，\s]+/).map((x) => Number(x)).filter((n) => Number.isFinite(n));
    if (vals.length === 6) return vals.map((v) => Math.max(0, Math.min(100, Math.round(v))));
  }
  const block = mdSubSection(md, /^#{3,4}\s*(?:六维评分|六维能力|能力维度)\s*$/m);
  if (!block) return null;
  const got = {};
  for (const raw of block.split('\n')) {
    if (!/^\|/.test(raw.trim())) continue;
    const cells = mdCells(raw);
    if (cells.length < 2 || /^-+$/.test(cells[1])) continue;
    const name = cells[0].replace(/\*\*/g, '');
    const num = String(cells[1]).match(/(\d{1,3})/);
    if (!num) continue;
    const hit = REPORT_DIM_ORDER.find((d) => name.includes(d));
    if (hit) got[hit] = Math.max(0, Math.min(100, Number(num[1])));
  }
  return REPORT_DIM_ORDER.every((d) => got[d] != null) ? REPORT_DIM_ORDER.map((d) => got[d]) : null;
}

/** B) 匹配表里判定为「通过 / 未通过」的行。 */
function parseMatchTableRows(md) {
  const out = { good: [], gap: [] };
  const b = sliceSection(md, 'B');
  for (const raw of b.split('\n')) {
    const t = raw.trim();
    if (!/^\|/.test(t)) continue;
    const cells = mdCells(t);
    if (cells.length < 3 || /^-+$/.test(cells[1])) continue;
    if (/要求|requirement|importance/i.test(cells[0])) continue;
    const verdict = cells[cells.length - 1];
    const req = cells[0].replace(/\*\*/g, '').replace(/^["“]|["”]$/g, '').trim();
    const how = cells[cells.length - 2] || '';
    if (!req || req.length < 4 || req.length > 120) continue;
    if (/✅|强匹配|通过|达成|命中/.test(verdict)) {
      out.good.push(req + '（' + how.replace(/\*\*/g, '').slice(0, 60) + '）');
    } else if (/无证据|未通过|❌|弱相关|拿不到|不匹配/.test(verdict)) {
      out.gap.push(req + ' —— ' + String(verdict).replace(/\*\*/g, '').slice(0, 30));
    }
  }
  return out;
}

export function parseReportSummary(md, meta = {}, opts = {}) {
  const s = String(md || '');
  const field = (label) => {
    const m = s.match(new RegExp('^\\*\\*' + label + '[:：]\\*\\*\\s*(.+)$', 'm'));
    return m ? m[1].replace(/\*\*/g, '').trim() : '';
  };
  const out = {
    title: '', date: '', url: '', archetype: '', legitimacy: '',
    score5: null, score100: null, threshold: Number(opts.threshold || 3),
    verdictOk: null, tier: '', dims: null, why: '',
    good: [], gap: [], tip: [], fiveDims: [],
  };
  out.title = ((s.match(/^#\s*评估报告[：:]\s*(.+)$/m) || [])[1] || meta.title || '').trim();
  out.date = field('Date');
  out.url = field('URL');
  out.archetype = field('Archetype') || meta.archetype || '';
  out.legitimacy = field('Legitimacy');

  const scText = field('Score');
  const sc = scText.match(/(\d+(?:\.\d+)?)\s*\/\s*5/) || String(meta.score || '').match(/(\d+(?:\.\d+)?)/);
  if (sc) {
    out.score5 = Number(sc[1]);
    out.score100 = Math.max(0, Math.min(100, Math.round((out.score5 / 5) * 100)));
    out.verdictOk = out.score5 >= out.threshold;
    out.tier = out.score5 >= 4 ? '强匹配' : out.score5 >= out.threshold ? '值得投递' : '不建议投递';
  } else if (/未通过|不给分|资格不符|不计分/.test(scText)) {
    // 硬门槛未过 → 按覆盖规则 3 不给分。这不是「解析失败」，卡片要如实说「资格不符」。
    out.gated = true;
    out.verdictOk = false;
    out.tier = '资格不符';
  }

  // 结论：头部字段之后、**第一个任意级标题之前**的第一段。
  // ⚠️ 必须从二级标题收紧到任意级：报告开头新增的「### 六维评分 / ### 优势匹配点」
  // 是三级标题，仍在 `## A)` 之前 —— 只认 `^## ` 会把整块摘要的 markdown
  // 当成结论正文吞进来（实测「JD 解读」里出现了一张 | 维度 | 分 | 表）。
  const headEnd = s.search(/^#{2,6}\s/m);
  const intro = (headEnd > 0 ? s.slice(0, headEnd) : s)
    .split('\n')
    .filter((l) => !/^#/.test(l.trim()) && !/^\|/.test(l.trim())
      && !/^\*\*(Date|URL|Archetype|Score|Legitimacy|PDF)[:：]/.test(l.trim()))
    .join('\n')
    .replace(/\*\*/g, '')
    .trim();
  out.why = intro.replace(/^(\s*-{3,}\s*)+/, '').replace(/\n{2,}/g, ' ')
    .replace(/\s+/g, ' ').replace(/^\s*-{3,}\s*/, '').trim().slice(0, 460);

  out.dims = parseReportDims(s);

  const rows = parseMatchTableRows(s);
  const goodSec = mdBullets(mdSubSection(s, /^#{3,4}\s*(?:优势匹配点|匹配亮点|优势)\s*$/m));
  const gapSec = mdBullets(mdSubSection(s, /^#{3,4}\s*(?:能力短板|主要短板|短板)\s*$/m));
  const tipSec = mdBullets(mdSubSection(s, /^#{3,4}\s*(?:简历优化建议|优化建议|改进建议)\s*$/m));
  out.good = (goodSec.length ? goodSec : rows.good).slice(0, 4);
  out.gap = (gapSec.length ? gapSec : rows.gap).slice(0, 4);
  if (!out.gap.length) {
    const prep = parseReportForPrep(s, meta);
    out.gap = prep.gaps.slice(0, 4).map((g) => g.replace(/\*\*/g, '').slice(0, 90));
  }
  if (tipSec.length) out.tip = tipSec.slice(0, 4);
  else {
    const e = mdBullets(mdSubSection(s, /^##\s*E\)/m), 4);
    const c = mdBullets(mdSubSection(s, /^#{3,4}\s*更值得做的[^\n]*$/m), 3);
    out.tip = (e.length ? e : c).slice(0, 4).map((t) => t.slice(0, 90));
  }

  // 五维评分（老报告里的维度表）：卡片不画它，但详情页可以照原样展示
  const five = mdSubSection(s, /^#{3,4}\s*五维评分\s*$/m);
  for (const raw of five.split('\n')) {
    if (!/^\|/.test(raw.trim())) continue;
    const cells = mdCells(raw);
    if (cells.length < 2 || /^-+$/.test(cells[1]) || /维度/.test(cells[0])) continue;
    out.fiveDims.push({ name: cells[0].replace(/\*\*/g, ''), value: cells[1].replace(/\*\*/g, '') });
  }
  return out;
}

export function parseReportForPrep(md, meta = {}, cvText = '') {
  const s = String(md || '');

  // ── 岗位要求 ─────────────────────────────────────────────────────
  // 关键区分：**任职要求 ≠ 岗位职责**。
  //
  // 「参与公司核心业务系统的后端设计、开发与迭代」是职责 —— 它说明这份工作
  // 让你干什么，**不告诉你该学什么**。拿它去填「技术要点 / 对岗位的价值」，
  // 正文就会变成抄一遍 JD，对备考毫无用处。所以要的是「熟悉 X」「具备 Y 经验」
  // 这类**能力项**，职责只作为实在取不到要求时的兜底。
  const reqFromOverview = [];
  const dutyFromOverview = [];

  // ① A) 岗位概览里那两行「任职要求：1. xxx；2. xxx」
  const overview = sliceSection(s, 'A');
  for (const line of overview.split('\n')) {
    const hit = splitLabeled(line);
    if (!hit || !hit.value) continue;
    const isReq = /任职要求|岗位要求|任职资格|任职条件|技能要求|要求/.test(hit.label);
    const isDuty = /岗位职责|工作职责|职责|工作内容|你将|主要工作/.test(hit.label);
    if (!isReq && !isDuty) continue;
    const items = hit.value.split(/[；;]\s*/)
      .map((v) => v.replace(/^\s*\d+[.)]\s*/, '').trim())
      .filter(Boolean);
    (isReq ? reqFromOverview : dutyFromOverview).push(...items);
  }

  // ② JD 归档原文（最权威）。同样要按「职责 / 要求」两类块切开，
  //    不能见编号就收 —— 很多 JD 前半段全是职责。
  const jdM = /^#{2,4}\s*Job Description\b.*$/im.exec(s);
  let jd = '';
  if (jdM) {
    jd = s.slice(jdM.index + jdM[0].length);
    const fence = jd.match(/```[a-z]*\n([\s\S]*?)```/);
    if (fence) jd = fence[1];
    jd = jd.replace(/```/g, '').trim();
  }
  const jdSplit = jd ? splitJdByKind(jd) : { reqs: [], duties: [] };

  // ③ 表格型「要求 | 匹配」：第一列当要求。011/009 的 B) 节就是这种。
  const tableReqs = [];
  const tableGaps = [];
  {
    const b = sliceSection(s, 'B');
    for (const raw of b.split('\n')) {
      const line = raw.trim();
      if (!/^\|/.test(line)) continue;
      const cells = line.split('|').map((c) => c.trim()).filter((c, i, arr) => !(i === 0 && !c) && !(i === arr.length - 1 && !c));
      if (cells.length < 2) continue;
      // 表头与分隔行跳过
      if (/^-+$/.test(cells[1]) || /要求|requirement/i.test(cells[0])) continue;
      const req = cells[0].replace(/\*\*/g, '').trim();
      const matchCell = cells[cells.length - 1];
      if (req.length < 4 || req.length > 200) continue;
      tableReqs.push(req);
      // ⚠️/❌/部分/未 表示没完全命中 —— 这就是差距
      if (/[⚠❌✗×]|部分|未满足|不匹配|缺失/.test(matchCell)) {
        // 表格里常带一段说明（列数多时取第 2 列或「证据/差距」列）
        const note = cells.length >= 3 ? cells[cells.length - 1] : '';
        tableGaps.push(req + (note && note !== matchCell ? '（' + note.slice(0, 80) + '）' : ''));
      }
    }
  }
  // ── 合并要求来源（按可靠性排序，去重）──────────────────────────
  // 优先「任职要求」类的表述，其次表格首列；**职责只在前面全落空时才兜底**。
  //
  // 这里必须真的做条件判断：早先的写法是把职责无条件追加到末尾当「兜底」，
  // 结果职责照旧混进了要求列表，「技术要点」里又出现「参与公司核心业务系统的
  // 设计与开发」—— 抄 JD 的毛病原样复发（实测踩过）。
  const primary = dedupe([...jdSplit.reqs, ...reqFromOverview, ...tableReqs]);
  const dutyFallback = dedupe([...jdSplit.duties, ...dutyFromOverview]);
  // 少于 3 条说明这份 JD 确实只写了职责，没写要求，这时才退而用职责。
  const requirements = (primary.length >= 3 ? primary : dedupe([...primary, ...dutyFallback])).slice(0, 40);
  const duties = dutyFallback.slice(0, 20);

  // ── 差距清单（Gaps）—— 按可靠性从高到低试五种写法 ───────────────
  const gaps = [];

  // 形状①：`**Gaps:**` 独立成行 + 短横线清单
  {
    const m = /^\s*\*\*Gaps:?\*\*\s*:?\s*$/im.exec(s);
    if (m) {
      const rest = s.slice(m.index + m[0].length);
      for (const raw of rest.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (/^\*\*|^#{1,6}\s/.test(line)) break; // 撞到下一个加粗字段或标题就停
        const item = line.replace(/^\s*[-*]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim();
        if (item) gaps.push(item);
      }
    }
  }

  // 形状②：`Gaps flagged:`（010 的 H 节末尾也是这种）+ 清单
  if (!gaps.length) {
    const m = /^\s*\*\*Gaps flagged:?\*\*\s*:?\s*$/im.exec(s);
    if (m) {
      const rest = s.slice(m.index + m[0].length);
      for (const raw of rest.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (/^#{1,6}\s|^\*\*[A-Za-z\u4e00-\u9fa5]/.test(line)) break;
        if (/^[-*]\s+/.test(line)) {
          const item = line.replace(/^\s*[-*]\s*/, '').trim();
          // 011 这类报告把招聘信息元数据也写进 Gaps flagged —— 要滤掉
          if (looksLikeCandidateGap(item)) gaps.push(item);
        }
      }
    }
  }

  // 形状③：`### 差距清单` / `## 差距清单` 小节（009）；也认「待补 / 短板 / 提升项」
  if (!gaps.length) {
    const m = /^#{2,4}\s*(?:差距清单|差距|待补项|短板|提升项|不足)\s*$/im.exec(s);
    if (m) {
      const rest = s.slice(m.index + m[0].length);
      const stop = rest.search(/^#{2,4}\s/);
      const body = stop === -1 ? rest : rest.slice(0, stop);
      for (const raw of body.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        // 表格行：取最后一列（「证据 / 差距」）当结论
        if (/^\|/.test(line)) {
          const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
          if (cells.length >= 2 && !/^-+$/.test(cells[0])) {
            const last = cells[cells.length - 1].replace(/\*\*/g, '').trim();
            if (last.length >= 6 && !/证据|差距|说明/.test(last)) gaps.push(cells[0] + '：' + last.slice(0, 120));
          }
          continue;
        }
        const item = line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim();
        if (item && !/^\*\*[^*]+\*\*$/.test(item) && looksLikeCandidateGap(item)) gaps.push(item);
      }
    }
  }

  // 形状④：表格型不匹配行（011 这类「要求 | 匹配」表）
  if (!gaps.length && tableGaps.length) gaps.push(...tableGaps);

  // 形状⑤：全文兜底 —— 找「缺乏 / 未提及 / 没有 / 缺少 / 待补全」打头的结论句。
  // 这是最后一道网：宁可抓到几条不那么精确的句子，也不要交一个空清单。
  if (!gaps.length) {
    const seen = new Set();
    for (const raw of s.split('\n')) {
      const line = raw.trim().replace(/^[-*]\s*/, '').replace(/^\|/, '').replace(/\|$/, '').trim();
      // 剥掉编号与加粗再判首字，避免「- **缺乏 X**」被漏掉
      const clean = line.replace(/^\**\s*/, '').replace(/^\d+[.)]\s*/, '');
      if (!looksLikeCandidateGap(clean)) continue;
      const key = clean.slice(0, 24);
      if (seen.has(key)) continue;
      seen.add(key);
      gaps.push(clean.replace(/[。.]$/, ''));
      if (gaps.length >= 12) break;
    }
  }

  // 形状⑥：报告真的没写差距 —— 那就拿 JD 要求跟简历对照现推。
  // 这是「报告写得不够」的补救，不是解析失败，所以最后才走。
  if (!gaps.length && cvText) {
    gaps.push(...deriveGapsFromJd(requirements, cvText));
  }

  // ── 能力评估结论（Match Summary 里的分项）───────────────────────
  const matches = [];
  {
    const m = /^\s*\*\*Match Summary:?\*\*\s*:?\s*$/im.exec(s);
    if (m) {
      const rest = s.slice(m.index + m[0].length);
      for (const raw of rest.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (/^\*\*[A-Za-z\u4e00-\u9fa5]/.test(line) && !/^\*\*\s/.test(line)) break;
        const hit = splitLabeled(line);
        if (hit) matches.push({ label: hit.label, value: hit.value });
      }
    }
    // 形状 ④/⑤ 的报告没有 Match Summary，但有 B) 节的加粗要求清单 ——
    // 那批正好可以当「分项结论」用。
    if (!matches.length) {
      const b = sliceSection(s, 'B');
      for (const raw of b.split('\n')) {
        const hit = splitLabeled(raw.trim());
        if (hit && hit.value) matches.push({ label: hit.label.slice(0, 60), value: hit.value.slice(0, 200) });
        if (matches.length >= 10) break;
      }
    }
  }

  // ── 报告自带的面试题（F 节的 Questions to Prepare）───────────────
  // 不直接复用（它太泛），但可以当作 AI 的参考输入。
  const questions = [];
  {
    const f = sliceSection(s, 'F');
    for (const raw of f.split('\n')) {
      const item = raw.trim().replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').replace(/\*\*/g, '').trim();
      if (item && /\?|？|请|如何|为什么|介绍|说说/.test(item)) questions.push(item);
    }
  }

  const grab = (label) => {
    const m = s.match(new RegExp('\\*\\*' + label + ':\\*\\*\\s*(.+)', 'i'));
    return m ? m[1].trim() : '';
  };

  return {
    file: meta.file || '',
    title: meta.title || '',
    score: meta.score || grab('Score'),
    archetype: meta.archetype || grab('Archetype'),
    gaps: dedupe(gaps).slice(0, 14),
    requirements,
    duties,
    matches: dedupe(matches.map((x) => x.label + '\u0000' + x.value)).map((x) => {
      const [label, value] = x.split('\u0000');
      return { label, value };
    }),
    questions: dedupe(questions).slice(0, 12),
    hasJd: !!jd,
    jd,
  };
}

/** 去重但保序（报告里「熟悉 Java」常出现两三遍）。 */
export function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list || []) {
    const t = String(raw || '').trim();
    if (!t) continue;
    // 去重键剥掉空白与常见标点，避免「熟悉 Java。」和「熟悉 Java」算两条
    const key = t.replace(/[\s。．.，,；;：:、]/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

// ══ 四、prompt 拼装（服务端用，但也放这里便于自检）══════════════════════
//
// ⚠️ 本文件是 .mjs 普通字符串拼接，**不是** JS 模板字面量 ——
//    ui/local-eval.mjs 那边踩过两次「prompt 里的反引号把模板字面量截断」的坑
//    （报 Invalid or unexpected token）。这里用数组 join，天然免疫。

/** AI 要输出的哨兵块。7B 模型爱改格式，所以解析器另有一路宽松兜底。 */
export const PREP_MARKERS = {
  start: '---PREP_JSON---',
  end: '---END_PREP---',
};

export function buildPrepPrompt({ report, cvText, candidate, profile } = {}) {
  const L = [];
  const title = report && report.title ? report.title : '（未命名岗位）';

  L.push('你是中国大陆校招/社招的面试辅导老师。现在要做一件具体的事：');
  L.push('把「这个岗位要什么」和「这位候选人已经有什么」逐条对比，给出**可执行的补强方案**。');
  L.push('');
  L.push('【岗位】' + title);
  if (report && report.score) L.push('【系统给的匹配分】' + report.score + '（5 分制，3 分是门槛）');
  if (report && report.archetype) L.push('【岗位类型】' + report.archetype);
  L.push('');
  L.push('【候选人简历】');
  L.push('```');
  L.push(String(cvText || '').trim().slice(0, 12000));
  L.push('```');
  L.push('');

  if (report && report.gaps && report.gaps.length) {
    L.push('【评估报告已经指出的差距（这是你的主要依据，必须逐条覆盖）】');
    report.gaps.forEach((g, i) => L.push((i + 1) + '. ' + g));
    L.push('');
  }

  // 岗位要求 = 「要你会什么」，直接决定该补什么，必须给。
  //
  // 而**岗位职责**（「负责 X 系统的开发与维护」）这里有意不给：它只说明这份
  // 工作让你干什么，对「该学什么」没有信息量，喂进去只会诱导模型把 JD 抄一遍
  // —— 实测就是这样，正文变成职责的复述稿。report.duties 留着另有用途
  // （给人看「这份工作做什么」），不参与生成。
  if (report && report.requirements && report.requirements.length) {
    L.push('【岗位要求（原文摘录，作为交叉核对）】');
    report.requirements.slice(0, 30).forEach((r, i) => L.push((i + 1) + '. ' + r));
    L.push('');
  }

  if (report && report.matches && report.matches.length) {
    L.push('【报告里的分项评估结论】');
    report.matches.forEach((m) => L.push('- ' + m.label + '：' + m.value));
    L.push('');
  }

  if (profile && String(profile).trim()) {
    L.push('【求职者档案（目标岗位 / 城市 / 薪资）】');
    L.push('```');
    L.push(String(profile).trim().slice(0, 3000));
    L.push('```');
    L.push('');
  }

  L.push('────────────────────────────────');
  L.push('【输出要求】严格按下面写，不要寒暄、不要加前言后语。');
  L.push('');
  // 2026-10-12 提速：条数直接决定输出长度，而输出长度就是生成时间
  // （实测一份 8 知识点 + 4 项目 + 14 资源的稿子，单次流跑了 598 秒）。
  // 收成 4–6 / 2–3 / 每点 1 条，信息密度更高的同时把生成时间砍掉近一半。
  L.push('一、' + SECTION_TITLES.gaps + '（4–6 条）');
  L.push('每条写成三行：');
  L.push('- 知识点名称（要具体到能去搜，例如「JVM 内存模型与 GC 调优」，不要写「Java 进阶」这种空话）');
  L.push('  优先级：P0 / P1 / P2（P0=不补就过不了面试，P1=大概率被问，P2=加分）');
  L.push('  掌握程度：了解概念 / 能上手用 / 能讲原理（三选一，要跟优先级匹配）');
  L.push('  为什么缺：一句话说清它在 JD 的哪条要求上、简历里对应缺什么');
  L.push('');
  L.push('二、' + SECTION_TITLES.projects + '（2–3 个）');
  L.push('每个项目写成：');
  L.push('- 项目名称（要像一个真做得出来的课程设计/个人项目，不要写「XXX 系统」这种半成品名字）');
  L.push('  目标：这个项目做完能证明什么能力，解决上面哪几条知识点');
  L.push('  技术要点：用到哪些具体技术、关键实现点（列 3–5 条）');
  L.push('  对岗位的价值：写进简历后，能回应这个岗位的哪条要求、面试时能撑起什么追问');
  L.push('  工作量：大概多久能做完（按每周 10 小时估）');
  L.push('');
  L.push('三、' + SECTION_TITLES.resources + '（按上面的知识点逐个给，每个知识点 1 条）');
  L.push('每个知识点给 1 条**真实存在、能搜到**的资源（特别关键的才给第 2 条），必须是这两类：');
  L.push('  · 视频课程：写清平台 + 课程名（例：B站《尚硅谷 JVM 全套教程》/ 慕课网《XXX》）');
  L.push('  · 书籍：写清书名 + 作者 + 出版社（例：《深入理解Java虚拟机》周志明 机械工业出版社）');
  L.push('只写你有把握真实存在的。**宁可少写，绝对不要编造书名或课程名** ——');
  L.push('候选人会照着这条去搜，编的等于浪费人家时间。不确定的宁可不给。');
  L.push('每条后面用一句话说清「先看哪部分」，别只丢个名字。');
  L.push('');
  L.push('【必须遵守】');
  L.push('1. 全部用简体中文；技术名词（Java / Spring Boot / Redis）保留原名。');
  L.push('2. 只针对**这位候选人**。他的简历里已经有的东西不要再叫他去学；');
  L.push('   报告里没提到的短板也不要凭空加。');
  L.push('3. 不要写「建议多练习」「要深入理解」这类没法执行的话，每条都要能落到具体内容上。');
  L.push('4. 最后额外输出一个机器可读块，格式如下（键名保持英文，值写中文）：');
  L.push(PREP_MARKERS.start);
  L.push('{"gapCount": <知识点条数>, "topPriority": "P0", "projectCount": <项目条数>,');
  L.push(' "mustLearn": ["最该先补的 3 个知识点名称"], "readiness": "<一句话：距离能面试还差什么>"}');
  L.push(PREP_MARKERS.end);
  L.push('这个块必须完整、必须是合法 JSON（不要写注释、不要用单引号）。');

  return L.join('\n');
}

// ══ 五、AI 回复解析 ══════════════════════════════════════════════════════

/**
 * 把 AI 的中文长文解析成结构化三部分。
 *
 * 策略：**先认标记，再认标题，最后按「- 开头 + 关键词」兜底**。
 * 7B 模型实测会三种走样都出现，缺任何一路都会有报告解析不出内容却「成功返回」。
 *
 * @returns {{gaps: Array, projects: Array, resources: Array, summary: object, unparsed: string}}
 */
export function parsePrepOutput(text) {
  const raw = String(text || '');
  const summary = parseSummaryBlock(raw);
  const body = raw.replace(new RegExp(escapeRe(PREP_MARKERS.start) + '[\\s\\S]*?' + escapeRe(PREP_MARKERS.end), 'g'), '').trim();

  // ── 切三段 ──────────────────────────────────────────────────────
  const seg = splitThreeSections(body);
  const gaps = parseGaps(seg.gaps);
  const projects = parseProjects(seg.projects);
  const resources = parseResources(seg.resources);

  // summary 是「锦上添花」的一段：模型经常直接忘掉末尾那个 JSON 块。
  // 忘了不当作失败（三段正文才是主体），但页面顶部那块得有人填 ——
  // 用刚解析出来的正文回推一份，比留空好。
  const sm = (summary && (summary.readiness || (summary.mustLearn || []).length))
    ? summary
    : backfillSummary(gaps, projects);

  return { gaps, projects, resources, summary: sm, unparsed: body };
}

/** 模型没给摘要块时，用解析出的正文回推一份（字段与 AI 版一致）。 */
function backfillSummary(gaps, projects) {
  const names = (gaps || []).map((g) => g.name).filter(Boolean);
  return {
    gapCount: (gaps || []).length,
    projectCount: (projects || []).length,
    topPriority: (gaps && gaps[0] && gaps[0].priority) || 'P0',
    mustLearn: names.slice(0, 3),
    readiness: names.length
      ? '这份岗位一共对照出 ' + names.length + ' 项能力缺口，最先要补的是下面这几项。'
      : '',
  };
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 按「一、/二、/三、」或「## 三、」把正文切成三段。切不出来就全塞第一段。 */
function splitThreeSections(body) {
  const lines = body.split('\n');
  // 找每段的起始行号
  const marks = [];
  lines.forEach((line, i) => {
    const t = line.trim().replace(/^#{1,6}\s*/, '');
    if (/^[一二三][、.．)）]/.test(t)) marks.push({ i, n: '一二三'.indexOf(t[0]) });
  });

  if (!marks.length) return { gaps: body, projects: '', resources: '' };

  const at = (n) => {
    const hit = marks.find((m) => m.n === n);
    if (!hit) return null;
    const after = marks.filter((m) => m.i > hit.i);
    const end = after.length ? after[0].i : lines.length;
    return lines.slice(hit.i + 1, end).join('\n').trim();
  };

  return { gaps: at(0) || '', projects: at(1) || '', resources: at(2) || '' };
}

/** 知识点：找「- 名称」块，往下读「优先级 / 掌握程度 / 为什么」。 */
function parseGaps(text) {
  const out = [];
  for (const block of splitBulletBlocks(text)) {
    const name = block.title.replace(/^\s*[-*]\s*/, '').replace(/^\s*\d+[.)]\s*/, '')
      .replace(/[（(]P[012][)）]\s*$/, '').trim();
    if (!name || name.length > 120) continue;

    const body = block.body;
    const pm = body.match(/优先级\s*[:：]?\s*\**\s*(P[012])/i);
    const priority = pm ? pm[1].toUpperCase() : guessPriority(body);
    const mm = body.match(/掌握(?:程度)?\s*[:：]?\s*\**\s*([^\n，,。；;]{2,20})/);
    const mastery = masteryIdOf(mm ? mm[1] : '') || 'use';
    const wm = body.match(/为什么缺\s*[:：]?\s*([^\n]+)/) || body.match(/原因\s*[:：]?\s*([^\n]+)/);
    const why = wm ? wm[1].replace(/^\**\s*/, '').trim() : '';

    out.push({ name, priority, mastery, why, detail: body.trim() });
  }
  return out;
}

/** 优先级认不出来时的兜底：按措辞里的权重词猜。猜不出给 P1（中标）。 */
function guessPriority(body) {
  if (/必须|硬性|不会就|前提|基础要求/.test(body)) return 'P0';
  if (/加分|锦上添花|可选|有余力/.test(body)) return 'P2';
  return 'P1';
}

/** 把「能上手用」这类自由说法归到三档 id。 */
export function masteryIdOf(label) {
  const s = String(label || '');
  if (/原理|源码|底层|机制|深挖|精通|深入/.test(s)) return 'deep';
  if (/了解|知道|概念|熟悉概念/.test(s)) return 'know';
  if (/上手|会写|能用|使用|独立|实践|熟练/.test(s)) return 'use';
  return '';
}

/** 项目：找「- 名称」块，往下读 目标 / 技术要点 / 价值 / 工作量。 */
function parseProjects(text) {
  const out = [];
  for (const block of splitBulletBlocks(text)) {
    const name = block.title.replace(/^\s*[-*]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim();
    if (!name || name.length > 120) continue;
    const body = block.body;

    const pick = (re) => {
      const m = body.match(re);
      if (!m) return '';
      // 取到下一个字段名之前
      return m[1].split(/\n\s*\**\s*(?:目标|技术要点|对岗位的价值|价值|工作量|工期)\s*[:：]/)[0]
        .replace(/\s*[-*]\s*(?=[\u4e00-\u9fa5])/g, '；').trim();
    };

    out.push({
      name,
      goal: pick(/目标\s*[:：]\s*([\s\S]+?)(?:\n\s*\**\s*(?:技术要点|对岗位的价值|价值|工作量)|$)/),
      tech: pick(/技术要点\s*[:：]\s*([\s\S]+?)(?:\n\s*\**\s*(?:对岗位的价值|价值|工作量|目标)|$)/),
      value: pick(/(?:对岗位的价值|价值)\s*[:：]\s*([\s\S]+?)(?:\n\s*\**\s*(?:工作量|工期|目标|技术要点)|$)/),
      effort: (body.match(/工作量\s*[:：]\s*([^\n]+)/) || body.match(/工期\s*[:：]\s*([^\n]+)/) || ['', ''])[1].replace(/^\**\s*/, '').trim(),
      detail: body.trim(),
    });
  }
  return out;
}

/** 资源：先按「知识点 → 下面的视频/书籍行」组织，认不出就按行扫。 */
function parseResources(text) {
  const out = [];
  const lines = text.split('\n');

  let current = null;
  const push = (topic, kind, title, note) => {
    const t = String(title || '').trim();
    if (!t) return;
    out.push({ topic: topic || '', kind, title: t, note: String(note || '').trim() });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // 小标题行（知识点名）：`**JVM 内存模型**` 或 `#### JVM 内存模型` 或 `1. JVM 内存模型`
    const asHead = line.replace(/^#{1,6}\s*/, '').replace(/^\*\*(.+?)\*\*$/, '$1').replace(/^\d+[.)]\s*/, '').trim();
    const isHead = (/^#{1,6}\s/.test(line) || /^\*\*.+\*\*$/.test(line) || /^\d+[.)]\s/.test(line))
      && !/视频|书籍|课程|文档|题库/.test(asHead)
      && asHead.length <= 40;
    if (isHead) { current = asHead; continue; }

    const item = line.replace(/^\s*[-*]\s*/, '').trim();
    if (!item) continue;

    // 「视频课程：B站《xxx》」/「书籍：《xxx》 作者 出版社」
    const m = item.match(/^(视频课程|视频|课程|书籍|书|教材|官方文档|文档|练习|题库)\s*[:：]?\s*(.+)$/);
    if (m) {
      const kind = kindOf(m[1]);
      let val = m[2].trim();
      let note = '';
      // 「备注」跟在破折号 / 括号 / 「先看」之后 —— 三种写法模型都会用。
      // 顺序有讲究：破折号要**先**切，否则「《书》—— 看第2章」里的
      // 「看第2章」会被后面那条规则吃掉书名里的「看」字。
      const dash = val.split(/\s*[—–]+\s*/);
      if (dash.length > 1) { val = dash[0].trim(); note = dash.slice(1).join(' ').trim(); }
      if (!note) {
        const nm = val.match(/^(.*?)[（(]\s*(?:先看|重点看|看|读)[:：]?\s*([^）)]*)[）)]$/);
        if (nm) { val = nm[1].trim(); note = (nm[2] || '').trim(); }
      }
      push(current, kind, val, note);
      continue;
    }

    // 没写类型、但带书名号 / 平台名的，按内容猜
    if (/《.+》|B站|bilibili|慕课|网易云课堂|极客时间|Coursera|官方文档|LeetCode|牛客/.test(item)) {
      push(current, kindOf(item), item, '');
    }
  }

  return out;
}

function kindOf(s) {
  const t = String(s || '');
  if (/书|教材/.test(t)) return 'book';
  if (/视频|课程|B站|bilibili|慕课|课堂|极客时间|Coursera/.test(t)) return 'video';
  if (/文档|官网|官方/.test(t)) return 'doc';
  if (/练习|题库|LeetCode|牛客/.test(t)) return 'practice';
  return 'video';
}

/**
 * 把一个段落按「- 开头」切成若干块：每块 = 一条（标题行 + 后续缩进/续行）。
 * 这是解析 7B 输出的关键 —— 它经常把「项目名」写成一行、细节缩进在下面两三行。
 */
function splitBulletBlocks(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { if (cur) cur.body += '\n'; continue; }
    const isBullet = /^\s*(?:[-*]|\d+[.)])\s+\S/.test(line);
    // 顶格的加粗行也算新块（`**JVM 内存模型**` 后面括号写细节）
    if (isBullet) {
      if (cur) out.push(cur);
      cur = { title: line.trim(), body: '' };
      continue;
    }
    if (cur) cur.body += line.trim() + '\n';
    else if (/^[^\s]/.test(line) && line.trim().length <= 60) {
      cur = { title: line.trim(), body: '' };
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** 取末尾的机器可读块。JSON 坏了不算致命 —— 前端那几个字段只是摘要。 */
export function parseSummaryBlock(text) {
  const s = String(text || '');
  // 先试带标记的
  let m = new RegExp(escapeRe(PREP_MARKERS.start) + '([\\s\\S]*?)' + escapeRe(PREP_MARKERS.end)).exec(s);
  let candidate = m ? m[1] : '';
  if (!candidate) {
    // 兜底：末尾随便一个大括号块
    const all = s.match(/\{[\s\S]{20,600}\}/g);
    if (all && all.length) candidate = all[all.length - 1];
  }
  if (!candidate) return null;
  const jsonText = candidate.replace(/```[a-z]*|```/g, '').trim();
  try {
    const j = JSON.parse(jsonText);
    if (!j || typeof j !== 'object') return null;
    return {
      gapCount: Number(j.gapCount) || 0,
      projectCount: Number(j.projectCount) || 0,
      topPriority: String(j.topPriority || '').trim() || 'P0',
      mustLearn: Array.isArray(j.mustLearn) ? j.mustLearn.map((x) => String(x).trim()).filter(Boolean) : [],
      readiness: String(j.readiness || '').trim(),
    };
  } catch {
    return null;
  }
}

/**
 * 解析结果的健康度：三部分都有内容才算「可用」。
 * 界面据此决定「用 AI 结果」还是「降级到本地兜底」——
 * 不这么判的话，模型回一段「好的，我来分析一下…」就会带着空页面显示成功。
 */
export function prepOutputUsable(parsed) {
  if (!parsed) return false;
  const gaps = (parsed.gaps || []).length;
  const projects = (parsed.projects || []).length;
  const resources = (parsed.resources || []).length;
  // 知识点是主干，必须 ≥3；项目与资源各要 ≥1 —— 否则三部分不齐，等于没完成需求
  return gaps >= 3 && projects >= 1 && resources >= 1;
}

/** 不可用时给用户看的原因（写清是哪一部分没出）。 */
export function prepUnusableReason(parsed) {
  if (!parsed) return 'AI 没有返回可解析的内容。';
  if (prepOutputUsable(parsed)) return '';
  const parts = [];
  if ((parsed.gaps || []).length < 3) parts.push('知识点（拿到 ' + (parsed.gaps || []).length + ' 条，至少要 3 条）');
  if ((parsed.projects || []).length < 1) parts.push('实践项目建议');
  if ((parsed.resources || []).length < 1) parts.push('学习资源');
  return 'AI 返回的内容里' + parts.join('、') + '不完整。';
}

// ══ 六、本地兜底（零 token 规则版）════════════════════════════════════════
//
// 需求确认过：AI 不可用时要能降级出结果，并**明确标注这是规则版**。
// 规则版的思路：拿报告里已经写好的 Gaps（那是评估阶段 AI 判过的）当知识点主干，
// 用一张「知识点 → 资源」的本地词典补上学习资源。词典宁可小，也不要编。
//
// 诚实优先：词典里查不到的知识点，资源一栏写「未收录，建议自行搜索关键词：xxx」，
// 而不是硬套一个不相干的课程名。

/** 关键词 → 资源。键是正则片段（大小写不敏感）。 */
export const LOCAL_RESOURCE_DICT = [
  {
    re: /jvm|垃圾回收|gc\b|内存模型/i,
    topic: 'JVM 与性能调优',
    resources: [
      { kind: 'book', title: '《深入理解Java虚拟机》周志明 机械工业出版社', note: '第 2–3 章看内存区域与 GC，第 5 章看调优案例' },
      { kind: 'video', title: 'B站《尚硅谷 JVM 全套教程》（宋红康）', note: '优先看内存结构与垃圾回收两节' },
    ],
  },
  {
    re: /spring\s*boot|spring\s*cloud|spring/i,
    topic: 'Spring 生态',
    resources: [
      { kind: 'book', title: '《Spring实战（第6版）》Craig Walls 人民邮电出版社', note: '重点看依赖注入与自动配置两章' },
      { kind: 'video', title: 'B站《尚硅谷 SpringBoot3 教程》', note: '跟着把自动配置原理那一节敲一遍' },
      { kind: 'doc', title: 'Spring 官方文档 spring.io/guides', note: '按需查，不要通读' },
    ],
  },
  {
    re: /mysql|sql|索引|数据库/i,
    topic: 'MySQL 与索引',
    resources: [
      { kind: 'book', title: '《高性能MySQL（第4版）》Baron Schwartz 等 电子工业出版社', note: '看第 5 章索引与第 6 章查询优化' },
      { kind: 'video', title: 'B站《尚硅谷 MySQL 高级教程》', note: '索引原理与执行计划那两节是面试必问' },
    ],
  },
  {
    re: /redis|缓存/i,
    topic: 'Redis 与缓存',
    resources: [
      { kind: 'book', title: '《Redis设计与实现》黄健宏 机械工业出版社', note: '看数据结构与持久化两章' },
      { kind: 'video', title: 'B站《黑马程序员 Redis 入门到实战》', note: '缓存穿透/击穿/雪崩三节优先' },
    ],
  },
  {
    re: /微服务|分布式|rpc|dubbo|服务治理/i,
    topic: '微服务与分布式',
    resources: [
      { kind: 'book', title: '《凤凰架构：构建可靠的大型分布式系统》周志明 机械工业出版社', note: '第 3–5 章建立整体观' },
      { kind: 'video', title: 'B站《尚硅谷 SpringCloud 教程》', note: '先把注册中心与网关跑通' },
    ],
  },
  {
    re: /docker|容器|kubernetes|k8s/i,
    topic: '容器化部署',
    resources: [
      { kind: 'book', title: '《Docker技术入门与实战（第3版）》杨保华 机械工业出版社', note: '看镜像与容器两章即可上手' },
      { kind: 'doc', title: 'Docker 官方文档 docs.docker.com/get-started', note: '照着走一遍官方入门' },
    ],
  },
  {
    re: /算法|数据结构|leetcode|刷题|手撕/i,
    topic: '算法与数据结构',
    resources: [
      { kind: 'book', title: '《代码随想录》卡尔（开源电子版）', note: '按专题刷，别按题库顺序刷' },
      { kind: 'practice', title: 'LeetCode 热题 100 / 牛客网校招真题', note: '国内校招笔试以这两处最贴近' },
      { kind: 'video', title: 'B站《代码随想录 算法公开课》', note: '配合书一起看' },
    ],
  },
  {
    re: /消息队列|kafka|rabbitmq|mq\b|mq$/i,
    topic: '消息队列',
    resources: [
      { kind: 'book', title: '《深入理解Kafka：核心设计与实践原理》朱忠华 电子工业出版社', note: '看存储与高可用两章' },
      { kind: 'video', title: 'B站《尚硅谷 Kafka 教程》', note: '重点看重复消费与顺序性' },
    ],
  },
  {
    re: /计算机网络|http|tcp|网络协议/i,
    topic: '计算机网络',
    resources: [
      { kind: 'book', title: '《图解HTTP》上野宣 人民邮电出版社', note: '快读，一天能过完' },
      { kind: 'book', title: '《计算机网络：自顶向下方法》James F. Kurose 机械工业出版社', note: '看传输层与应用层' },
    ],
  },
  {
    re: /操作系统|进程|线程|并发|锁/i,
    topic: '操作系统与并发',
    resources: [
      { kind: 'book', title: '《现代操作系统》Andrew S. Tanenbaum 机械工业出版社', note: '看进程与线程、死锁两章' },
      { kind: 'book', title: '《Java并发编程的艺术》方腾飞 机械工业出版社', note: '看锁与线程池' },
    ],
  },
  {
    re: /linux|shell|命令/i,
    topic: 'Linux 基础',
    resources: [
      { kind: 'book', title: '《鸟哥的Linux私房菜：基础学习篇（第4版）》鸟哥 人民邮电出版社', note: '看文件与权限、进程管理' },
      { kind: 'practice', title: '牛客网 Linux 专项练习', note: '校招笔试常考那几十道' },
    ],
  },
  // ── AI / CV / 控制算法方向（2026-10-12 用户反馈「学习资源清单没有具体内容」：
  //    多模态算法岗的计划全落在「未收录」套话上）。**必须排在宽泛的
  //    「机器学习基础」之前** —— 匹配是数组顺序首个命中，宽泛条目会先把
  //    「PyTorch 深度学习…」这类具体词截走。资源只收有把握真实存在的。 ──
  {
    re: /pytorch|torch\b|张量|自动求导|dataloader/i,
    topic: 'PyTorch 框架',
    resources: [
      { kind: 'book', title: '《动手学深度学习（PyTorch版）》李沐 等 人民邮电出版社', note: '前 5 章过框架基础，第 10 章注意力机制重点看' },
      { kind: 'video', title: 'B站《跟李沐学AI》PyTorch 部分（电子工业出版社官方号）', note: '配合书上代码敲一遍' },
      { kind: 'doc', title: 'PyTorch 官方教程 pytorch.org/tutorials', note: '按需查 API，不要通读' },
    ],
  },
  {
    re: /slam|导航|定位|建图|激光雷达|点云/i,
    topic: 'SLAM 与导航',
    resources: [
      { kind: 'book', title: '《视觉SLAM十四讲：从理论到实践（第2版）》高翔 电子工业出版社', note: '前 8 讲建立数学基础，后 6 讲跟着敲代码' },
      { kind: 'video', title: 'B站 高翔《视觉SLAM十四讲》官方配套讲解', note: '与书同步看，代码部分必敲' },
    ],
  },
  {
    re: /cnn|卷积|resnet|图像分类|目标检测|yolo|rcnn|opencv|计算机视觉|图像分割|segment|sam\b|detr|视觉/i,
    topic: '计算机视觉与目标检测',
    resources: [
      { kind: 'video', title: 'B站《斯坦福 CS231n 卷积神经网络》（有中文字幕版）', note: '第 5–8 讲（CNN 基础到检测分割）优先' },
      { kind: 'book', title: '《深度学习》Goodfellow 等 人民邮电出版社（花书）', note: '第 9 章卷积网络建立整体观' },
      { kind: 'doc', title: 'Ultralytics YOLO 官方文档 docs.ultralytics.com', note: 'YOLO 系列训练/部署按官方 Quickstart 走一遍' },
      { kind: 'doc', title: 'Meta SAM 论文与官方仓库 github.com/facebookresearch/segment-anything', note: '分割岗位先读论文摘要 + 跑通官方 Demo' },
    ],
  },
  {
    re: /vit\b|transformer|注意力|多模态|clip|大模型|llm|bert|nlp|自然语言|视觉语言/i,
    topic: 'Transformer 与多模态',
    resources: [
      { kind: 'video', title: 'B站《跟李沐学AI》Transformer / ViT 论文精读系列', note: '先看「Attention Is All You Need」与 ViT 两期' },
      { kind: 'book', title: '《动手学深度学习（PyTorch版）》李沐 等 人民邮电出版社', note: '第 10–11 章注意力与 Transformer' },
      { kind: 'doc', title: 'Hugging Face 文档 huggingface.co/docs（Transformers / Diffusers）', note: '多模态任务按官方 Pipeline 示例跑通一个' },
    ],
  },
  {
    re: /c\+\+|c语言|嵌入式|stm32|单片机|驱动开发/i,
    topic: 'C/C++ 与嵌入式开发',
    resources: [
      { kind: 'book', title: '《C++ Primer（第5版）》Stanley B. Lippman 等 电子工业出版社', note: '前 7 章是校招面试的主战场' },
      { kind: 'book', title: '《Effective C++（第3版）》Scott Meyers 电子工业出版社', note: '55 条条款挑高频的 20 条精读' },
      { kind: 'video', title: 'B站《黑马程序员 C++ 教程》', note: '配合侯捷风格的内存管理讲解看' },
    ],
  },
  {
    re: /matlab|simulink|运动控制|插补|轨迹规划|数控|伺服|nurbs|速度前瞻|螺距|间隙补偿|运动学|动力学|控制算法|pid/i,
    topic: '运动控制与算法工程落地',
    resources: [
      { kind: 'book', title: '《现代控制系统（Modern Control Systems）》Dorf & Bishop 电子工业出版社', note: '第 1–4 章建模与反馈控制，第 10 章看设计' },
      { kind: 'book', title: '《机器人学：建模、规划与控制》Siciliano 等 机械工业出版社', note: '运动学与轨迹规划两章对着岗位要求看' },
      { kind: 'doc', title: 'MathWorks 官方文档 mathworks.com/help（Simulink 示例库）', note: '把 Simulink 官方「模型与仿真」示例跑通两个' },
    ],
  },
  {
    re: /cuda|gpu|并行计算|高性能计算|算子优化/i,
    topic: 'CUDA 与 GPU 编程',
    resources: [
      { kind: 'book', title: '《GPU高性能编程CUDA实战》聂雪军 等 机械工业出版社', note: '前 6 章线程/内存模型是面试重点' },
      { kind: 'doc', title: 'NVIDIA CUDA C++ 编程指南 docs.nvidia.com/cuda', note: '按「编程模型 → 内存层次」顺序读' },
    ],
  },
  {
    re: /机器学习|深度学习|模型|算法工程|ai\b/i,
    topic: '机器学习基础',
    resources: [
      { kind: 'book', title: '《机器学习》周志华 清华大学出版社', note: '看第 2–3 章与第 8 章集成学习' },
      { kind: 'video', title: 'B站《吴恩达 机器学习》中文字幕版', note: '基础不牢时从这看起' },
    ],
  },
  {
    re: /开源|github|项目经历/i,
    topic: '开源与项目背书',
    resources: [
      { kind: 'practice', title: 'GitHub：找一个 3k star 以内的中文项目提第一个 PR', note: '从改文档、修 typo 开始' },
      { kind: 'book', title: '《Git权威指南》蒋鑫 机械工业出版社', note: '看分支与协作流程两章' },
    ],
  },
];

/**
 * 把报告里的差距句「收」成一个像知识点的短名。
 *
 * 报告的差距句是给人读的长句（「未提及 Docker、Kubernetes 等容器化部署工具的
 * 使用经验。」），直接当知识点名会很难看：小标题变成一整句话，项目建议里也会
 * 原样重复三遍。这里只做**两件有把握的修剪**：
 *   1. 剥掉「缺乏 / 未提及 / 没有…」这类前缀
 *   2. 剥掉「（依据：…）」这类括号附注
 *   3. 「A、B 等<类别>」→ 取到「A、B」——**仅当「等」后面跟的是类别词**
 *      （工具 / 技术 / 经历 / 能力…），而不是「等任一领域」这种有实义的短语。
 *
 * 刻意**不做**尾巴剥除：「开源项目贡献经历或在 GitHub 上有个人技术项目」这种
 * 句子里的「经历」是核心信息的一部分，剥掉就变成半句话了。
 * 收不干净不要紧 —— 宁可长一点，也不要写错。
 */
export function gapToTopic(gap) {
  let t = String(gap || '').trim();
  // 竖线状态附注先摘掉（「X | 无相关经验，建议补充」这类 AI 输出把技能名
  // 和状态说明写在同一条里）——名字只取第一段；只有一段（无管道）不动，
  // 第一段过短（表格残渣）也不动，走后面的逻辑兜底：宁长勿错。
  const segs = t.split('|').map((s) => s.trim()).filter(Boolean);
  if (segs.length > 1 && segs[0].length >= 2) t = segs[0];
  // 括号附注先摘掉（「（依据：JD 要求与 cv.md 对照）」/「（critical，缺失）」）
  t = t.replace(/[（(]\s*依据[:：][^）)]*[）)]/g, '').trim();
  t = t.replace(/[（(]\s*(?:critical|high|medium|low|缺失|待补)[^）)]*[）)]/gi, '').trim();
  // markdown 残留：加粗、项目符号、编号。
  // 顺序要紧：`**1. xxx**` 先去掉加粗会剩 `1. xxx`；但 `*1. xxx`（单星号做
  // 列表符）得先摘掉那个 `*`，否则下面按数字开头匹配的规则整条失效
  // ——实测会把「*1. ML/DL…」原样当成知识点名。
  t = t.replace(/\*\*/g, '').replace(/^\s*[*+\-]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim();
  // 前缀。注意「不了解」必须排在「了解」前面 —— 否则「不了解 X」会被
  // 剥成「解 X」。JS 的 alternation 从左往右试，顺序就是语义。
  t = t.replace(/^(?:缺乏|未提及|没有|缺少|不具备|尚未|待补全?|不熟悉|不了解|了解|熟悉|掌握|无)\s*/, '').trim();
  // 句末标点**必须先剥**：下面的尾巴规则都带 `$`，
  // 留着那个「。」会让「…相关项目或实习经历。」整条规则匹配不上（实测踩过）。
  t = t.replace(/[。.；;，,、]+$/, '').trim();
  // 尾巴：把「…相关项目或实习经历」「…的使用经验」这类**经历性尾巴**摘掉。
  //
  // 这里用穷举的尾巴短语，而不是一条贪婪正则：贪婪会把「机器学习/深度学习
  // 算法研究经验」这种整句都是技能名的内容吃掉一半。只认几个确定的形状，
  // 收不干净也不打紧 —— 长一点总比写错强。
  const TAILS = [
    /相关项目或实习(?:经历|经验)$/,
    /相关项目(?:或实习)?(?:经历|经验)$/,
    /项目或实习(?:经历|经验)$/,
    /(?:相关)?(?:项目|实习|工作)(?:经历|经验)$/,
    /的使用(?:经验|经历)$/,
    /(?:获奖|竞赛)(?:经历|经验)$/,
    /等(?:程序设计)?(?:竞赛|比赛|赛事)$/,
    /贡献(?:经历|经验)$/,
    /(?:的)?(?:经历|经验|功底)$/,
  ];
  for (let round = 0; round < 3; round++) {
    let hit = false;
    for (const re of TAILS) {
      const next = t.replace(re, '').trim();
      if (next.length >= 4 && next !== t) { t = next; hit = true; break; }
    }
    if (!hit) break;
  }
  // 「A、B 等<类别词>」→ 取「A、B」
  const beforeDeng = t.match(/^([^等]{2,44}?)\s*等\s*(?:任一)?\s*(?:领域|方向|相关)?/);
  // 「等」后面跟的必须是**类别词**才算举例；否则「等」是实词，
  // 切了反而出错（「等待面试通知」不能被切成「待面试通知」）。
  // 前面那个「的」（「任一领域**的**算法研究」）要先摘掉，
  // 不然它挡在类别词前面，整条判定失效。
  const afterDeng = (beforeDeng ? t.slice(beforeDeng[0].length) : '').replace(/^[的地得]/, '');
  const CATEGORY_AFTER_DENG = /^(?:任一的?|任选|任意|容器化|推理|主流|常见|前沿|传统的?|深度学习|机器学习|大规模|分布式|云原生|后端|前端)?\s*(?:领域的?|方向的?|相关的?|方面的?)?\s*(?:算法|技术|研究|开发|使用|应用|实践|工作|经验|经历|能力|技能|工具|框架|语言|平台|软件|元件|部署|方案)/;
  if (beforeDeng && beforeDeng[1].length >= 4 && CATEGORY_AFTER_DENG.test(afterDeng)) {
    t = beforeDeng[1].trim();
  }
  // 「『C++』：JD 明确要求…」这类自己推出来的差距，取书名号里的技能名
  const quoted = t.match(/^[『「【]\s*([^』」】]{1,30})\s*[』」】]/);
  if (quoted) t = quoted[1].trim();
  // 「A：说明」——冒号后面是解释，不要
  if (/^[^：:]{2,40}[：:]/.test(t) && !/https?:/.test(t)) {
    t = t.split(/[：:]/)[0].trim();
  }
  t = t.replace(/[。.；;，,、]+$/, '').trim();
  return t.length >= 2 ? t : String(gap || '').replace(/[。.]$/, '').trim();
}

/**
 * 把岗位要求压成一句能塞进正文的短句列表。
 *
 * JD 里的条目自带句末标点（「…开发经验；」「…。 」），直接 join('；')
 * 就会出「；；」这种重标点。这里统一剥掉句末标点再拼，并且**不做
 * 中段截断** —— 按字数硬切会把「分布式系统开发经验，熟悉」这种半句
 * 塞进正文，读起来像坏了。
 */
function joinRequirements(list, max) {
  const items = (list || [])
    .map((x) => String(x || '').replace(/[。．.；;，,、\s]+$/, '').trim())
    .filter((x) => x.length >= 4);
  const picked = items.slice(0, max);
  let out = picked.join('；');
  if (items.length > picked.length) out += ' 等';
  return out;
}

/**
 * 汇总「一句话结论」。
 *
 * 设计要点：**结论句不重复列名字**。名字紧接着就会以「最先要补的 N 项」
 * 再出现一次，两处都说同一件事等于没有重点。所以这里只讲数量与门槛结构，
 * 具体是哪几项交给 mustLearn。
 *
 * mustLearn 取的是**排名前 3 条**而不是「所有 P0」：差距少的时候 P0 可能
 * 只有 1–2 条，写死「三项」就会对不上。
 */
function buildSummary(knowledge, requirements, projectCount) {
  const n = (knowledge || []).length;
  if (!n) {
    return {
      gapCount: 0, projectCount: 0, topPriority: '', mustLearn: [],
      readiness: '没有解析出差距项，建议先跑一次完整评估。',
    };
  }
  const hard = knowledge.filter((k) => k.priority === 'P0').length;
  return {
    gapCount: n,
    projectCount: Number(projectCount) || 0,
    topPriority: knowledge[0].priority || 'P0',
    mustLearn: knowledge.slice(0, 3).map((k) => k.name),
    readiness: '这份岗位一共对照出 ' + n + ' 项能力缺口'
      + (hard ? '，其中 ' + hard + ' 项属于面试前必须能讲清的硬门槛（P0）' : '')
      + ((requirements || []).length ? '；岗位要求里能通过学习和项目补的技能项有 ' + requirements.length + ' 条' : '')
      + '。',
  };
}

/**
 * 学历 / 届别 / 专业 / 户籍 这类条目**不是能学的东西**。
 *
 * 「2027 届本科及以上学历，计算机相关专业」在岗位要求里必然出现，但它在备考
 * 建议里毫无用处 —— 人已经定了，补不了。落到「技术要点」里只会把这段文字
 * 挤成一篇抄来的 JD。所以带这类字样、又没有任何可学动词的条目一律滤掉。
 */
export function isLearnableRequirement(s) {
  const t = String(s || '').trim();
  if (t.length < 4) return false;
  const learnable = /熟悉|掌握|了解|精通|具备|会使用|能用|有.{0,8}(?:经验|经历|功底)|理解|能够/.test(t);
  if (learnable) return true;
  return !/(?:届|毕业|学历|学位|本科|硕士|博士|专科|专业|应届|统招|全日制|年龄|性别|户口|户籍|党员|体检|政审)/.test(t);
}

/**
 * 竞赛获奖 / 开源贡献 / 学历 这类缺口**落不成一个项目**。
 *
 * 「ACM / 蓝桥杯 / 天梯赛」是奖项，「开源项目贡献经历」是履历，写进
 * 「技术要点」会变成「技术要点：ACM/蓝桥杯」这种读起来就不对的东西。
 * 项目建议只挑**能靠写代码补**的缺口；一条都挑不出来时再退回全量。
 *
 * 两档判定是有意分开的：
 *   · 硬档看**报告原句** —— 名字已被收敛，「ACM / 蓝桥杯 / 天梯赛」里
 *     已经看不到「竞赛」二字，只查名字会漏。
 *   · 软档只查**名字本身** —— 「分布式系统、微服务架构相关项目或**实习**经历」
 *     里那个「实习」只是话术，这东西明明能靠写项目补，按原句判会被误杀。
 */
const NON_BUILDABLE_STRICT = /竞赛|比赛|获奖|奖项|奖学金|论文|专利|证书|绩点|成绩/;
const NON_BUILDABLE_SOFT = /开源|贡献|实习|工作经历|学历|学位|届|专业/;

function pickBuildableNames(knowledge, max) {
  const buildable = (knowledge || []).filter((k) => {
    if (NON_BUILDABLE_STRICT.test(k.name + ' ' + (k.why || ''))) return false;
    return !NON_BUILDABLE_SOFT.test(k.name);
  });
  const picked = (buildable.length ? buildable : knowledge || []).slice(0, max);
  return picked.map((k) => k.name);
}

/** 从「最该补的第一条」凝出一个项目名；凝不出像样的就退回通用说法。 */
function projectNameFrom(names) {
  const first = String((names && names[0]) || '').trim();
  if (!first) return '一次能讲清取舍的完整实现';
  if (first.length <= 18) return first + ' 实战项目';
  // 太长的按顿号/斜杠切开，取前两个原子（「分布式系统、微服务架构」）——
  // 这比截前 18 个字可读得多，也不会切在半个词上。
  const atoms = first.split(/[、,，/]/).map((x) => x.trim()).filter(Boolean).slice(0, 2);
  const short = atoms.join(' / ');
  return short.length >= 4 && short.length <= 20 ? short + ' 实战项目' : '一次能讲清取舍的完整实现';
}

/** 本地兜底：把 Gaps 变成结构化建议。纯规则，不联网、不花 token。 */
export function buildLocalFallback({ report, cvText } = {}) {
  const gaps = (report && report.gaps) || [];
  // 只拿「能学的要求」去写正文：学历/届别/专业这类补不了，写进去就是抄 JD
  const skillReqs = ((report && report.requirements) || []).filter(isLearnableRequirement);

  const knowledge = [];
  const seenTopics = new Set();
  for (const g of gaps) {
    const name = gapToTopic(g);
    const key = name.replace(/[\s。．.，,；;：:、]/g, '').toLowerCase();
    if (!key || seenTopics.has(key)) continue;
    seenTopics.add(key);
    // priority / mastery 留空，下面按排名比例统一分档（这里先写死会变成死代码）
    knowledge.push({
      name,
      priority: '',
      mastery: '',
      why: '评估报告判定为差距项：' + String(g).replace(/[。.]$/, ''),
      detail: '',
    });
  }
  // 优先级按排名分档，而不是「前三条一律 P0」—— 差距少的时候（比如只有 3 条），
  // 全标 P0 等于没有优先级。按比例分：前 40% P0、到 75% 是 P1、剩下 P2。
  const n = knowledge.length;
  knowledge.forEach((k, i) => {
    const p = n > 0 ? (i / n < 0.4 ? 'P0' : i / n < 0.75 ? 'P1' : 'P2') : 'P0';
    k.priority = p;
    k.mastery = p === 'P0' ? 'deep' : p === 'P1' ? 'use' : 'know';
  });

  // 词典里能对上的，资源直接给；对不上的如实说明
  const resources = [];
  for (const k of knowledge) {
    const hit = LOCAL_RESOURCE_DICT.find((d) => d.re.test(k.name) || d.re.test(k.why));
    if (hit) {
      // topic 用词典里的规范名（「JVM 与性能调优」），比原句好读
      resources.push({ topic: hit.topic, kind: hit.resources[0].kind, title: hit.resources[0].title, note: hit.resources[0].note });
      if (hit.resources[1]) {
        resources.push({ topic: hit.topic, kind: hit.resources[1].kind, title: hit.resources[1].title, note: hit.resources[1].note });
      }
    } else {
      resources.push({
        topic: k.name, kind: 'doc',
        title: '（本地词典未收录）建议搜索关键词：' + k.name,
        note: '用「' + k.name + ' 面试 高频考点」在 B站 / 牛客搜，优先选播放量高、更新近的',
      });
    }
  }

  // 项目建议：按「最该补的前三条」合成一个项目 —— 不做无中生有的组合，
  // 每条都能追溯到报告里写过的差距。
  const projects = [];
  const buildable = pickBuildableNames(knowledge, 3);
  if (buildable.length) {
    const names = buildable;
    projects.push({
      name: projectNameFrom(names),
      goal: '用一个能跑起来、能讲清楚取舍的项目，把报告点出的 '
        + names.join('、') + ' 从「没做过」变成「做过」。'
        + '关键是留下可验证的东西：代码仓库 + 一份说明为什么这么设计的 README。',
      // 技术要点按「能跑 → 能压 → 能讲」三步给，比罗列岗位要求有用 ——
      // 要求里大部分是候选人已有的东西，抄进来说服不了任何人。
      tech: '围绕上面的缺口各落一个能演示的点：'
        + names.join('；') + '。'
        + '按「能跑 → 能压 → 能讲」三步做：先跑通主链路，再补一个可量化的指标'
        + '（接口耗时 / QPS / 内存占用 / 构建镜像体积），最后把取舍写进 README。'
        + '（本地规则版只给方向，AI 可用时重新生成会给出具体技术选型。）',
      value: '这个项目会直接回应岗位要求里的技能项：'
        + (joinRequirements(skillReqs, 3) || '（报告未解析出可对标的技能项）')
        + '。写进简历后，面试官顺着问下去你有东西可讲。',
      effort: '按每周投入 10 小时估算，约 2–3 周',
      detail: '',
    });
  }

  return {
    gaps: knowledge,
    projects,
    resources,
    summary: buildSummary(knowledge, skillReqs, projects.length),
    unparsed: '',
  };
}

// ══ 七、导出 Markdown ════════════════════════════════════════════════════

/**
 * 把结果组装成一份可带走的 Markdown。
 *
 * @param {{report, parsed, source, generatedAt}} o
 *   source: 'ai' | 'local' —— 必须如实标出来。用户拿着这份文档去复习，
 *   得知道它是不是规则版给的。
 */
export function buildPrepMarkdown({ report, parsed, source = 'ai', generatedAt = '' } = {}) {
  const r = report || {};
  const p = parsed || {};
  const L = [];

  L.push('# 面试备考建议：' + (r.title || r.file || '未命名岗位'));
  L.push('');
  L.push('- 来源报告：`' + (r.file || '—') + '`');
  if (r.score) L.push('- 评估得分：' + r.score + '（5 分制，3 分是门槛）');
  if (r.archetype) L.push('- 岗位类型：' + r.archetype);
  if (generatedAt) L.push('- 生成时间：' + generatedAt);
  L.push('- 生成方式：' + (source === 'local'
    ? '**本地规则版**（AI 不可用或未通过校验，结论来自评估报告里的差距项 + 内置资源词典，未经过模型推理）'
    : 'AI 生成'));
  L.push('');

  const sm = p.summary;
  if (sm && (sm.readiness || (sm.mustLearn || []).length)) {
    L.push('## 一句话结论');
    L.push('');
    if (sm.readiness) L.push(sm.readiness);
    if ((sm.mustLearn || []).length) {
      L.push('');
      // 数量按实际条数写：差距少时只有一两条，写死「三项」会对不上
      L.push('最先要补的 ' + sm.mustLearn.length + ' 项：');
      L.push('');
      sm.mustLearn.forEach((x, i) => L.push((i + 1) + '. ' + x));
    }
    L.push('');
  }

  // ── 一、知识点 ──────────────────────────────────────────────────
  L.push('## 一、' + SECTION_TITLES.gaps);
  L.push('');
  const gaps = p.gaps || [];
  if (!gaps.length) {
    L.push('_（没有解析出知识点。请重试一次，或换一份有差距清单的报告。）_');
    L.push('');
  } else {
    gaps.forEach((g, i) => {
      L.push('### ' + (i + 1) + '. ' + g.name);
      L.push('');
      L.push('- **优先级**：' + g.priority + '（' + (PRIORITY_ZH[g.priority] || '—') + '）');
      L.push('- **掌握程度要求**：' + (MASTERY_ZH[g.mastery] || g.mastery || '—'));
      if (g.why) L.push('- **为什么缺**：' + g.why);
      L.push('');
    });
  }

  // ── 二、项目 ────────────────────────────────────────────────────
  L.push('## 二、' + SECTION_TITLES.projects);
  L.push('');
  const projects = p.projects || [];
  if (!projects.length) {
    L.push('_（没有生成项目建议。）_');
    L.push('');
  } else {
    projects.forEach((pr, i) => {
      L.push('### ' + (i + 1) + '. ' + pr.name);
      L.push('');
      if (pr.goal) L.push('- **项目目标**：' + pr.goal);
      if (pr.tech) L.push('- **技术要点**：' + pr.tech);
      if (pr.value) L.push('- **对岗位的价值**：' + pr.value);
      if (pr.effort) L.push('- **工作量估算**：' + pr.effort);
      L.push('');
    });
  }

  // ── 三、资源 ────────────────────────────────────────────────────
  L.push('## 三、' + SECTION_TITLES.resources);
  L.push('');
  const resources = p.resources || [];
  if (!resources.length) {
    L.push('_（没有给出学习资源。）_');
    L.push('');
  } else {
    // 按知识点分组，读起来比一长串列表清楚
    const byTopic = new Map();
    for (const it of resources) {
      const k = it.topic || '通用';
      if (!byTopic.has(k)) byTopic.set(k, []);
      byTopic.get(k).push(it);
    }
    for (const [topic, list] of byTopic) {
      L.push('### ' + topic);
      L.push('');
      list.forEach((it) => {
        L.push('- **' + (RESOURCE_KIND_ZH[it.kind] || '资源') + '**：' + it.title
          + (it.note ? '　—— ' + it.note : ''));
      });
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push('> 这份建议由 career-ops 控制台生成。判断依据是「' + (r.file || '') + '」'
    + '里的岗位要求与差距清单，以及你的 cv.md。**学习资源请自行核对是否仍可访问**：'
    + '课程与书单会随时间下架或改版。');

  return L.join('\n');
}

// ══ 八、计数与摘要（前端徽标用）══════════════════════════════════════════

/** 三部分的条数，页面上当作概览显示。 */
export function countParts(parsed) {
  return {
    gaps: ((parsed && parsed.gaps) || []).length,
    p0: ((parsed && parsed.gaps) || []).filter((g) => g.priority === 'P0').length,
    projects: ((parsed && parsed.projects) || []).length,
    resources: ((parsed && parsed.resources) || []).length,
  };
}

/** 文本 → 可粘贴的纯文本（复制按钮用，去掉 Markdown 记号会更好读）。 */
export function toPlainText(md) {
  return String(md || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^---$/gm, '────────')
    .trim();
}
