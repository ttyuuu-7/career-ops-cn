#!/usr/bin/env node
// ui/check-ai-engine.mjs — 「AI 引擎切换」的回归自检
//
// 为什么必须有它：多了一条引擎通路之后，「选错引擎」是**静默失败**的典型 ——
// 不会报错，只会表现成「莫名其妙失败」，或者更糟：用户以为在用本地免费模型，
// 实际每次评估都在跑 CodeBuddy。这种坏法看不出、也想不到，只能靠断言钉住。
//
// 三段：
//   1. 纯函数（ui/ai-engine.mjs）—— 决策口径本身。不经过服务器，坏了一眼能看出是哪条规则。
//   2. HTTP —— 接口契约与**持久化**。切换完要真的写进 data/ai-engine.json，
//      否则刷新页面又跳回去，用户会以为按钮是假的。
//   3. 页面 —— 按钮真的在、点了真的会变。前两段都过了但按钮没绑上事件，
//      是最常见的一种「后端全对、用户用不了」。
//
// ⚠️ 会临时改动你的引擎设置，跑完**自动还原**（见 finally）。
// 前置：控制台已在 127.0.0.1:7317。
// 用法：node ui/check-ai-engine.mjs

import { chromium } from 'playwright';
import {
  ENGINE_AUTO, ENGINE_CLI, ENGINE_OLLAMA, ENGINE_CHOICES,
  normalizeEngine, isKnownEngine, canWriteFiles, pickEngine,
  engineUnavailableText, writeBlockedText,
  normalizeOllamaBase, normalizeOllamaModel,
  DEFAULT_OLLAMA_BASE, DEFAULT_OLLAMA_MODEL,
  ollamaTagsUrl, ollamaChatUrl,
} from './ai-engine.mjs';
// 本地完整评估的纯函数部分：解析 / prompt 拼装 / 落盘产物
import {
  parseLocalEvalOutput, buildLocalEvalPrompt, buildLocalReportArtifacts,
  normalizedTrackerScore, slugifyCompany,
} from './local-eval.mjs';

const PORT = process.env.CAREER_OPS_PORT || '7317';
const BASE = 'http://127.0.0.1:' + PORT + '/';

let pass = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { pass += 1; return true; }
  fails.push(msg);
  return false;
}
function eq(got, want, msg) {
  return ok(got === want, msg + '（期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got) + '）');
}

// ══════════════════════════════════════════════════════════
// 1. 纯函数：决策口径
// ══════════════════════════════════════════════════════════
console.log('\n── 1. 决策口径（纯函数）──');

eq(normalizeEngine('ollama'), ENGINE_OLLAMA, 'ollama 应被识别');
eq(normalizeEngine('CLI'), ENGINE_CLI, '大写 CLI 应被识别');
eq(normalizeEngine(''), ENGINE_AUTO, '空值应退回 auto');
eq(normalizeEngine(null), ENGINE_AUTO, 'null 应退回 auto');
eq(normalizeEngine('ollma'), ENGINE_AUTO, '拼错的引擎名应退回 auto（而不是当成 ollama）');
ok(!isKnownEngine('ollma'), 'isKnownEngine 应拒绝拼写错误的值');
ok(isKnownEngine('auto') && isKnownEngine('cli') && isKnownEngine('ollama'), '三个已知值都应通过');
eq(ENGINE_CHOICES.length, 3, '引擎选项应为 3 档');

// 写文件能力表。这是「完整评估能不能用本地模型」的唯一依据。
// ollama 为 true 的原因：完整评估走**服务端编排**（ui/local-eval.mjs）——
// 模型只出文本，读规则、写盘都是代码干。翻转这张表时看 verify-cn-setup 的
// 对应断言，两边要一起动。
ok(canWriteFiles(ENGINE_CLI) === true, 'CodeBuddy 应能写文件');
ok(canWriteFiles(ENGINE_OLLAMA) === true, '本地模型算能写（服务端代为落盘）');
ok(canWriteFiles(ENGINE_AUTO) === false, 'auto 本身没有写能力（取决于解析到谁）');
ok(canWriteFiles('不存在') === false, '未知引擎不能写文件');

// pickEngine：显式选择优先，auto 优先 CLI
let p = pickEngine({ choice: ENGINE_CLI, cliAvailable: true, ollamaAvailable: true });
eq(p.engine, ENGINE_CLI, '显式选 CLI 时应走 CLI');
p = pickEngine({ choice: ENGINE_OLLAMA, cliAvailable: true, ollamaAvailable: true });
eq(p.engine, ENGINE_OLLAMA, '显式选本地模型时，即使 CLI 可用也应走本地模型');
eq(p.ok, true, '本地模型可用时 ok 应为 true');

p = pickEngine({ choice: ENGINE_OLLAMA, cliAvailable: true, ollamaAvailable: false });
ok(p.engine === null && !p.ok, '选了本地模型但服务没起：不能偷偷退回 CLI');
eq(p.reason, 'no-ollama', '应给出 no-ollama 的原因码');

p = pickEngine({ choice: ENGINE_CLI, cliAvailable: false, ollamaAvailable: true });
ok(p.engine === null && !p.ok, '选了 CLI 但它不存在：不能偷偷改用本地模型');
eq(p.reason, 'no-cli', '应给出 no-cli 的原因码');

p = pickEngine({ choice: ENGINE_AUTO, cliAvailable: true, ollamaAvailable: true });
eq(p.engine, ENGINE_CLI, 'auto 且两者都可用时应优先 CLI（它多出写文件的能力）');
p = pickEngine({ choice: ENGINE_AUTO, cliAvailable: false, ollamaAvailable: true });
eq(p.engine, ENGINE_OLLAMA, 'auto 且只有本地模型时应退回本地模型');
p = pickEngine({ choice: ENGINE_AUTO, cliAvailable: false, ollamaAvailable: false });
ok(p.engine === null && !p.ok, '两条路都不通时应 ok=false');
eq(p.reason, 'none', '两条都不通应给出 none');

ok(engineUnavailableText('no-ollama').includes('Ollama'), 'no-ollama 的说明要点到 Ollama');
ok(engineUnavailableText('no-cli').includes('CodeBuddy'), 'no-cli 的说明要点到 CodeBuddy');
ok(writeBlockedText().includes('不能'), '写受限的说明要说清「不能写文件」这件事');

// ── 1b. 本地完整评估：输出解析（ui/local-eval.mjs）──────────────────────
// 7B 模型不守输出契约是实测事实（output/ollama-evidence/样本报告/），
// 三种形态必须都认得出，认不出要明说 —— 静默解析失败 = 用户白等十分钟。
console.log('\n── 1b. 本地完整评估解析（纯函数）──');

// 形态 1：上游契约块（理想情况）
const r1 = parseLocalEvalOutput(
  '## A) Role Summary\n正文……\n\n---SCORE_SUMMARY---\nCOMPANY: 星海科技\n'
  + 'ROLE: 后端开发工程师\nSCORE: 4.2\nARCHETYPE: Backend / Java\n'
  + 'LEGITIMACY: High Confidence\n---END_SUMMARY---\n',
);
eq(r1.source, 'score-summary', '形态1：契约块应被识别');
eq(r1.score, '4.2', '形态1：分数应解析为 4.2');
eq(r1.company, '星海科技', '形态1：公司名应解析');
ok(r1.body.includes('Role Summary') && !r1.body.includes('SCORE_SUMMARY'),
  '形态1：正文应剥掉机器块');

// 形态 2：## Machine Summary + yaml 围栏（7B 的实际写法，键英文、外面加围栏）
const r2 = parseLocalEvalOutput(
  '# Evaluation: 星海科技 — 后端开发工程师（Java 方向）\n\n**Date:** 2026-10-01\n'
  + '**Score:** 4.2/5\n\n---\n\n## Machine Summary\n```yaml\n---\n'
  + 'COMPANY: Star Sea Technology\nROLE: 后端开发工程师（Java 方向）\nSCORE: 4.2\n'
  + 'ARCHETYPE: Backend / Java\nLEGITIMACY: High Confidence\n---\n```\n\n'
  + '## A) Role Summary\n正文……',
);
eq(r2.source, 'machine-summary', '形态2：Machine Summary 围栏应被识别');
eq(r2.score, '4.2', '形态2：分数应解析为 4.2');
eq(r2.company, 'Star Sea Technology', '形态2：公司名应取机器块里的值');
ok(r2.body.startsWith('## A)') || r2.body.includes('Role Summary'),
  '形态2：模型自带的重复头部应被剥掉，正文从板块开始');

// 形态 2b：Machine Summary 出现多段时，只认含 SCORE 的那段
const r2b = parseLocalEvalOutput(
  '## Machine Summary\n```yaml\nadvertised_comp: 15-22K × 14 薪\n```\n\n'
  + '## A) 正文\n\n## Machine Summary\n```yaml\nCOMPANY: 甲公司\nSCORE: 3.1\n```\n',
);
eq(r2b.source, 'machine-summary', '形态2b：多段时应跳过不含分数的段');
eq(r2b.score, '3.1', '形态2b：分数应取含 SCORE 段的值');

// 形态 2c：加粗形式 `**Machine Summary:**`（第二次真跑的实际写法）
const r2c = parseLocalEvalOutput(
  '## H) Draft Application Answers\n正文……\n\n---\n\n**Machine Summary:**\n\n'
  + '```yaml\n---\nCOMPANY: 星海科技\nROLE: 后端开发工程师\nSCORE: 4.3\n'
  + 'ARCHETYPE: 后端开发\nLEGITIMACY: High Confidence\n---\n```\n',
);
eq(r2c.source, 'machine-summary', '形态2c：加粗形式的机器块应被识别');
eq(r2c.score, '4.3', '形态2c：分数应解析为 4.3');
ok(!r2c.body.includes('Machine Summary'), '形态2c：正文应剥掉整个机器段');

// 散文里提到 Machine Summary 的行不能被误当成标题（run5 样本的坑）
const r2d = parseLocalEvalOutput(
  '**Machine Summary (required):** every report carries a YAML fence with\n'
  + 'advertised_comp etc.\n\n## A) 正文\n\n```yaml\nCOMPANY: 乙公司\nSCORE: 3.6\n```\n',
);
ok(r2d.source === '' || r2d.source === 'header',
  '形态2d：散文行不应被当成 Machine Summary 标题（实际 source=' + r2d.source + '）');

// 形态 3：正文头部兜底（连机器块都没写的情况）
const r3 = parseLocalEvalOutput(
  '# Evaluation: 华为 — 测试开发工程师\n\n**Date:** 2026-09-20\n'
  + '**Archetype:** 测试（校招）\n**Score:** 3.4/5\n**Legitimacy:** High Confidence\n'
  + '\n---\n\n## A) Role Summary\n正文……',
);
eq(r3.source, 'header', '形态3：正文头部应被兜底识别');
eq(r3.score, '3.4', '形态3：分数应解析为 3.4');
eq(r3.company, '华为', '形态3：公司名应取标题行');

// 全都认不出：明说失败，绝不猜
const r0 = parseLocalEvalOutput('一段没有任何结构与分数的话。');
eq(r0.source, '', '无结构输出应报 source 为空');
eq(r0.score, '', '无结构输出不应给出分数');
ok(r0.body.length > 0, '无结构输出时正文应原样保留（供人工查看）');

// 分数边界：10 分制、越界、垃圾值都拒绝
eq(parseLocalEvalOutput('---SCORE_SUMMARY---\nSCORE: 8/10\n---END_SUMMARY---').score, '',
  '10 分制的分数应拒绝而不是折算');
eq(parseLocalEvalOutput('---SCORE_SUMMARY---\nSCORE: 9.9\n---END_SUMMARY---').score, '',
  '越界分数应拒绝');

// 台账分数单元：N/A 哨兵与分母校验
eq(normalizedTrackerScore('4.2'), '4.2/5', '台账分数：裸数字应补上 /5');
eq(normalizedTrackerScore('4.2/10'), 'N/A', '台账分数：分母不是 5 应给 N/A');
eq(normalizedTrackerScore(''), 'N/A', '台账分数：空值应给 N/A');
eq(slugifyCompany('星海科技'), '星海科技', 'slug：中文名应保留（REPORT_NAME_RE 放行汉字）');
eq(slugifyCompany('Star Sea Technology'), 'star-sea-technology', 'slug：英文名应转小写连字符');

// 7B 实测会把整份报告写两遍：第一遍 `### A)` 直接开写，第二遍以自己的
// `# Evaluation:` 标题开头重来 —— 必须在中间那个标题处截断，否则报告翻倍
const rDup = parseLocalEvalOutput(
  '### A) 第一遍评估\n内容甲\n\n# Evaluation: 星海科技 — 后端\n\n## A) 第二遍评估\n内容乙\n\n'
  + '---SCORE_SUMMARY---\nSCORE: 4.0\n---END_SUMMARY---\n',
);
eq(rDup.source, 'score-summary', '重复报告：分数仍应正常解析');
ok(rDup.body.includes('内容甲') && !rDup.body.includes('内容乙'),
  '重复报告应在正文中部的 # Evaluation: 标题处截断');

// 尾部清理：接话、孤立 #、多余分隔线不能进报告
const rTail = parseLocalEvalOutput(
  '## A) 正文\n真实内容结尾。\n\n---\n\n#\n\n请继续生成 `## Cover Letter Draft` 段落。\n\n'
  + '---SCORE_SUMMARY---\nSCORE: 4.0\n---END_SUMMARY---\n',
);
ok(rTail.body.includes('真实内容结尾'), '尾部清理：正文应保留');
ok(!rTail.body.includes('请继续') && !rTail.body.includes('---'),
  '尾部清理：接话与孤立分隔线应被摘掉（实际末尾：' + rTail.body.slice(-40) + '）');

// 尾话变体：「请确认以上内容…」（第四次真跑的实际写法）
const rTail2 = parseLocalEvalOutput(
  '## A) 正文\n真实内容结尾。\n\n请确认以上内容是否符合要求。如果有任何需要调整的地方，请告知。\n\n'
  + '---SCORE_SUMMARY---\nSCORE: 4.0\n---END_SUMMARY---\n',
);
ok(rTail2.body.includes('真实内容结尾') && !rTail2.body.includes('请确认'),
  '尾部清理：「请确认」式尾话也应被摘掉（实际末尾：' + rTail2.body.slice(-40) + '）');

// prompt 拼装：规则内容要在 system prompt 里，门槛数字要出现
const pl = buildLocalEvalPrompt({
  shared: 'SHARED-RULES-MARKER', oferta: 'OFERTA-MARKER', cv: 'CV-MARKER',
  profileYml: 'language:\n  output: zh-CN', profile: 'PROFILE-MARKER',
  jd: 'JD-BODY-MARKER', postingUrl: 'https://example.com/job/1',
});
ok(pl.systemPrompt.includes('SHARED-RULES-MARKER'), 'prompt：_shared.md 内容应进 system');
ok(pl.systemPrompt.includes('OFERTA-MARKER'), 'prompt：oferta.md 内容应进 system');
ok(pl.systemPrompt.includes('CV-MARKER'), 'prompt：简历应进 system');
ok(pl.systemPrompt.includes('PROFILE-MARKER'), 'prompt：中文覆盖规则应进 system');
ok(pl.userPrompt.includes('JD-BODY-MARKER'), 'prompt：JD 应进 user 消息');
ok(pl.userPrompt.includes('https://example.com/job/1'), 'prompt：岗位链接应进 user 消息');
ok(pl.systemPrompt.includes('3.0'), 'prompt：门槛分 3.0 应写明');
ok(Number.isFinite(pl.budgetReport?.totalTokens), 'prompt：应返回 token 预算报告');

// ── 1c. 中文报告格式契约 ────────────────────────────────────────────────
// 报告是给自己看的中文文档，但**六个机器字段标签 + `## Risk Summary` +
// `## Job Description (archived verbatim)` + 字母序号**必须留英文 ——
// 控制台 listReports()、analyze-patterns.mjs、check-jd-archive.mjs 都按字面
// 解析，翻译了是**静默丢弃**（不报错，只是那个字段永远空着）。
// 所以这四条要一起钉住：中文小标题在、英文机器字段也在。
// 少任何一边都不是「本地化」，是坏掉。
console.log('\n── 1c. 中文报告格式契约 ──');

ok(pl.systemPrompt.includes('## A) 岗位概览'), 'prompt：小标题应写明中文全套（A) 岗位概览）');
ok(pl.systemPrompt.includes('## G) 职位真实性评估'), 'prompt：小标题应写到 G)');
// H) 是全报告**唯一**一个「字母后面也必须留英文」的段落 ——
// application-answers.mjs --read-draft 用 /^##\s+H\)\s*Draft Application Answers\s*$/m
// 逐字匹配整行，本地化成中文后那个读取功能会静默返回 null（不报错）。
ok(pl.systemPrompt.includes('## H) Draft Application Answers'),
  'prompt：H) 必须要求照抄英文（application-answers.mjs 逐字匹配它）');
ok(pl.systemPrompt.includes('## Risk Summary')
  && pl.systemPrompt.includes('## Job Description (archived verbatim)'),
  'prompt：Risk Summary 与 JD 归档标题应要求保留英文原样');
ok(pl.systemPrompt.includes('## ATS 关键词提取'), 'prompt：附属段落应给中文名（Keywords extracted）');
ok(pl.systemPrompt.includes('同一句套话整份报告最多出现一次'), 'prompt：去套话规则应写明');
// 求职信草稿：7B 模型实测会吐一份**没填的模板骨架**（{xxx} 花括号 + (placeholder)
// 标注 + 「To be completed」占位），整节空壳对读的人零信息量，程序也不会去填。
// 契约必须是「要么写满、要么整节不写」，并且把三种空壳形态点名。
ok(/求职信草稿[\s\S]{0,120}要么写满、要么整段不写|要么写满、要么整段不写/.test(pl.systemPrompt),
  'prompt：求职信草稿应要求「要么写满、要么整段不写」');
for (const shell of ['{xxx}', '(placeholder)', 'To be completed']) {
  ok(pl.systemPrompt.includes(shell), 'prompt：应点名禁止的空壳形态 ' + shell);
}

// 落盘报告头：中文标题 + 英文机器字段标签。标题前缀由控制台剥掉，
// 字段标签一个都不能少 —— 少哪一个，报告列表里那一列就永远是空的。
const art = buildLocalReportArtifacts({
  num: 7, company: '星海科技', role: '后端开发工程师（Java 方向）',
  score: '4.2', archetype: '后端开发', legitimacy: '谨慎推进',
  body: '## A) 岗位概览\n正文……', today: '2026-10-01',
  postingUrl: 'https://example.com/job/7', model: 'qwen2.5:7b',
});
ok(art.reportContent.startsWith('# 评估报告：星海科技 — 后端开发工程师（Java 方向）'),
  '落盘：报告标题应是中文 `# 评估报告：…`');
for (const label of ['**Date:**', '**URL:**', '**Archetype:**', '**Score:**', '**Legitimacy:**', '**PDF:**']) {
  ok(art.reportContent.includes(label), '落盘：机器字段标签应保留英文 ' + label);
}
ok(art.reportContent.includes('**Legitimacy:** 谨慎推进'), '落盘：字段的值可以是中文');
eq(art.filename, '007-星海科技-2026-10-01.md', '落盘：文件名规则不变（编号-公司-日期）');

// 中文标题也要能反解回公司 / 岗位（reports/ 里的历史报告是英文标题，两种都得认）
const rZh = parseLocalEvalOutput(
  '# 评估报告：星海科技 — 后端开发工程师\n\n**Date:** 2026-10-01\n'
  + '**Archetype:** 后端开发\n**Score:** 4.2/5\n**Legitimacy:** 谨慎推进\n'
  + '\n---\n\n## A) 岗位概览\n正文……',
);
eq(rZh.source, 'header', '中文标题：应能走正文头部兜底');
eq(rZh.score, '4.2', '中文标题：分数应解析');
eq(rZh.company, '星海科技', '中文标题：公司名应解析');
eq(rZh.role, '后端开发工程师', '中文标题：岗位名应解析');
ok(!rZh.body.includes('评估报告'),
  '中文标题：模型自带的标题行应被剥掉，正文从板块开始（实际开头：' + rZh.body.slice(0, 30) + '）');

// Ollama 地址归一化：用户会填 127.0.0.1:11434、也会填带 /api/chat 的整条 URL
eq(normalizeOllamaBase('127.0.0.1:11434'), 'http://127.0.0.1:11434', '缺协议应补 http://');
eq(normalizeOllamaBase('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434', '尾斜杠应去掉');
eq(normalizeOllamaBase('http://127.0.0.1:11434/api/chat'), 'http://127.0.0.1:11434',
  '粘进整条接口 URL 时应只取 origin');
eq(normalizeOllamaBase(''), DEFAULT_OLLAMA_BASE, '空值应退回默认地址');
eq(normalizeOllamaBase('不是地址'), DEFAULT_OLLAMA_BASE, '认不出的一律退回默认地址');
// 坑：new URL('http://不是地址') 不抛错，它按 IDN 编码成一个「合法」地址
// （http://xn--ihqq6tnb086g）。所以必须自己校验主机名，否则随便一段中文
// 都会被当成地址，一路传到连接失败，报错还指不回用户填的那个值。
ok(!normalizeOllamaBase('中文主机名').includes('xn--'), '中文主机名不该被 IDN 编码成合法地址');
eq(normalizeOllamaBase('http://[::1]:11434'), 'http://[::1]:11434', 'IPv6 地址应被接受');
eq(normalizeOllamaBase('localhost:11434'), 'http://localhost:11434', 'localhost 应被接受');
eq(normalizeOllamaModel(''), DEFAULT_OLLAMA_MODEL, '空模型名应退回默认模型');
eq(normalizeOllamaModel('  llama3.2:3b  '), 'llama3.2:3b', '模型名应去空白');
eq(ollamaTagsUrl('127.0.0.1:11434'), 'http://127.0.0.1:11434/api/tags', 'tags 地址应拼对');
eq(ollamaChatUrl('127.0.0.1:11434'), 'http://127.0.0.1:11434/api/chat', 'chat 地址应拼对');

// ══════════════════════════════════════════════════════════
// 2. HTTP：接口契约与持久化
// ══════════════════════════════════════════════════════════
console.log('── 2. 接口与持久化 ──');

async function getJson(path) {
  const res = await fetch(BASE.replace(/\/$/, '') + path, { headers: { 'Content-Type': 'application/json' } });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
}
async function postJson(path, payload) {
  const res = await fetch(BASE.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, body };
}

const first = await getJson('/api/ai-status');
if (!ok(first.status === 200 && first.body, 'GET /api/ai-status 应返回 200 + JSON')) {
  console.log('\n✖ 控制台没在 ' + PORT + ' 上跑，后面两段跳过。');
  console.log('  先启动：双击「启动控制台.cmd」，或 node ui/server.mjs');
  process.exit(1);
}

const st0 = first.body;
const originalChoice = st0.choice;
ok(typeof st0.available === 'boolean', 'available 应是布尔值');
ok([ENGINE_AUTO, ENGINE_CLI, ENGINE_OLLAMA].includes(st0.choice), 'choice 应是三个已知值之一');
ok(Array.isArray(st0.engines) && st0.engines.length === 3, 'engines 应回 3 档');
ok(st0.ollama && typeof st0.ollama.alive === 'boolean', 'ollama.alive 应是布尔值');
ok(typeof st0.ollama.base === 'string' && st0.ollama.base.startsWith('http'), 'ollama.base 应是完整地址');
ok(typeof st0.writeCapable === 'boolean', 'writeCapable 应是布尔值');
// 可用性与实际解析结果必须自洽 —— 这是「按钮说可用、点了说没有」的根因
if (st0.available) {
  ok(!!st0.active, 'available 为 true 时必须给出实际会跑的引擎 active');
  eq(st0.writeCapable, canWriteFiles(st0.active), 'writeCapable 必须与 active 的能力一致');
  eq(st0.unavailableText, '', '可用时不该有「不可用」的说明文案');
} else {
  ok(st0.active === null, '不可用时 active 应为 null');
  ok(st0.unavailableText.length > 0, '不可用时必须说明原因');
}

let c1 = await postJson('/api/ai-engine', { engine: ENGINE_OLLAMA });
ok(c1.status === 200 && c1.body && c1.body.ok, '切到本地模型应返回 200 + ok');
if (c1.body && c1.body.status) {
  eq(c1.body.status.choice, ENGINE_OLLAMA, '切换后 choice 应立刻变成 ollama');
  eq(c1.body.status.active, c1.body.status.available ? ENGINE_OLLAMA : null,
    '本地模型在线时应解析成 ollama');
}
let c2 = await getJson('/api/ai-status');
eq(c2.body.choice, ENGINE_OLLAMA, '重新读取时应仍然是 ollama —— 说明真的落盘了，不是内存态');

let c3 = await postJson('/api/ai-engine', { engine: ENGINE_CLI });
eq(c3.body.status.choice, ENGINE_CLI, '切回 CodeBuddy 应生效');
eq(c3.body.status.writeCapable, true, 'CodeBuddy 的 writeCapable 应为 true');

// 拼错的值必须报错，不能被静默纠正 —— 静默纠正会让用户以为切成功了
let c4 = await postJson('/api/ai-engine', { engine: 'ollma' });
eq(c4.status, 400, '未知引擎应返回 400，而不是静默改成 auto');
ok(String(c4.body && c4.body.error || '').includes('ollma'), '报错里应点出用户填的那个值');
let c5 = await getJson('/api/ai-status');
eq(c5.body.choice, ENGINE_CLI, '400 之后设置不该被改动');

// 只改地址、不改引擎，是允许的（这是「换端口」的用法）
let c6 = await postJson('/api/ai-engine', { base: '127.0.0.1:11434' });
ok(c6.status === 200, '只改 base 应被接受');
eq(c6.body.saved.ollama.base, 'http://127.0.0.1:11434', 'base 应被归一化成完整地址');
eq(c6.body.saved.engine, ENGINE_CLI, '只改 base 时不该动 engine');

// 完整评估 + 本地引擎：**不再是 409 拦截** —— 服务端编排（runLocalFullEval）
// 会真的跑一单，几分钟起步。自检里绝不能发这个请求（实测踩过：check 挂死
// 300 秒，服务端还在用假 JD 烧一张垃圾报告）。改用便宜的断言钉住行为：
// 切档持久化 + 在线时 writeCapable=true；接线本身由 verify-cn-setup 的
// 源码断言（runLocalFullEval 存在且被 /api/eval 引用）兜底。
await postJson('/api/ai-engine', { engine: ENGINE_OLLAMA });
const stOl = (await getJson('/api/ai-status')).body;
eq(stOl.choice, ENGINE_OLLAMA, '切到本地模型应持久化');
if (stOl.ollama.alive) {
  eq(stOl.writeCapable, true, '本地模型在线时 writeCapable 应为 true（服务端代写）');
}

// 「某一档不可用」不能把别的档连坐。
// 用「指向一个没人监听的端口」把本地模型确定性地打掉 —— 这样这条断言
// 跟机器上 Ollama 到底开没开无关，跑在哪台机器上都成立。
// 反例（真踩过）：auto 的可用性曾经拿「当前选择」的解析结果来算，
// 于是选了本地模型而它离线时，auto 也被标成不可用 —— 三个按钮全灰，
// 明明 CLI 好好的，用户会以为整个 AI 都坏了。
const originalBase = st0.ollama.base;
await postJson('/api/ai-engine', { engine: ENGINE_OLLAMA, base: '127.0.0.1:59999' });
const stDead = (await getJson('/api/ai-status')).body;
const deadOllama = (stDead.engines || []).find((x) => x.id === ENGINE_OLLAMA);
const deadCli = (stDead.engines || []).find((x) => x.id === ENGINE_CLI);
const deadAuto = (stDead.engines || []).find((x) => x.id === ENGINE_AUTO);
eq(stDead.ollama.alive, false, '指向死端口时本地模型应报离线');
eq(deadOllama && deadOllama.available, false, '离线时本地模型这一档应报不可用');
if (stDead.cliAvailable) {
  eq(deadCli && deadCli.available, true, '本地模型离线不该把 CodeBuddy 连坐成不可用');
  eq(deadAuto && deadAuto.available, true,
    '本地模型离线时 auto 仍应可用 —— auto 问的是「改成自动能不能跑」，不是「当前档能不能跑」');
  eq(deadAuto && deadAuto.writeCapable, true,
    'auto 在 CLI 可用时应继承「能写文件」（auto 的能力取决于它解析到了谁）');
} else {
  ok(deadCli && deadCli.available === false, '没有 CLI 时 CodeBuddy 这一档应报不可用');
}
eq(stDead.choice, ENGINE_OLLAMA, '选择本身不该被可用性判定改动');
// 还原，别把用户的地址留在死端口上
await postJson('/api/ai-engine', { base: originalBase });
eq((await getJson('/api/ai-status')).body.ollama.base, originalBase, '本地模型地址应被还原');

// 「测一下」这个接口在没有服务时应给出可操作的说明
const t1 = await postJson('/api/ai-engine/test', { base: '127.0.0.1:59999' });
eq(t1.status, 200, '测试接口本身应始终返回 200（用 ok:false 表达失败）');
eq(t1.body.ok, false, '指向一个没人监听的端口时应 ok:false');
ok(String(t1.body.error || '').includes('启动Ollama') || String(t1.body.error || '').includes('连不上'),
  '连不上时要说清怎么办');

// ══════════════════════════════════════════════════════════
// 3. 页面：按钮真的在、点了真的会变
// ══════════════════════════════════════════════════════════
console.log('── 3. 页面按钮 ──');

let browser = null;
try {
  // 回到 auto 再进页面，避免上一步留下的 ollama 影响断言
  await postJson('/api/ai-engine', { engine: ENGINE_AUTO });

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);

  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

  // 引擎卡自 #108 起迁到「全部脚本」页（评估页只剩 mockup 三张卡）
  await page.goto(BASE + '#tools');
  await page.waitForSelector('#aiEngineCard', { timeout: 20000 });

  const btnCount = await page.locator('#aiEngineCard button[data-engine]').count();
  eq(btnCount, 3, '引擎卡片应有 3 个切换按钮');

  const labels = await page.locator('#aiEngineCard button[data-engine]').allTextContents();
  ok(labels.some((t) => t.includes('CodeBuddy')), '按钮里应有 CodeBuddy');
  ok(labels.some((t) => t.includes('本地模型')), '按钮里应有本地模型');

  // 当前档必须高亮（primary），否则用户看不出自己在哪一档
  const primary = await page.locator('#aiEngineCard button[data-engine].primary').count();
  eq(primary, 1, '应且只应有 1 个按钮是选中态');

  ok(await page.locator('#aiEngTest').count() === 1, '应有「测一下本地模型」按钮');
  ok(await page.locator('#aiEngRefresh').count() === 1, '应有「重新检测」按钮');

  // 点「本地模型」→ 期望值**按它此刻在不在线分两种**。
  // 写死「必须显示本地模型」会让 Ollama 没开的机器上红一片，看着像功能坏了、
  // 其实只是服务没起 —— 自检不该偷偷依赖一个外部服务开着。
  const olNow = (await getJson('/api/ai-status')).body;
  await page.locator('#aiEngineCard button[data-engine="ollama"]').click();
  // 等切换真的落盘再读。**要等的是「选中态」，不是徽标文案** ——
  // 徽标在点击瞬间还没变，用「不再显示检测中」当条件会立刻通过，
  // 读到的是上一条档位的旧值（实测踩过：读到 CodeBuddy Code）。
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#aiEngineCard button[data-engine="ollama"]');
      return b && b.getAttribute('aria-pressed') === 'true';
    },
    null, { timeout: 20000 },
  ).catch(() => {});

  const badge = await page.locator('#aiEngBadge').textContent();
  if (olNow.ollama.alive) {
    ok(String(badge).includes('本地模型'), '点「本地模型」后徽标应显示本地模型（实际：' + badge + '）');
    const extra = await page.locator('#aiEngExtra').textContent();
    ok(String(extra).includes('完整报告') && String(extra).includes('服务端代'),
      '本地模型档应提示「完整报告由服务端代写」（实际：' + String(extra).slice(0, 80) + '…）');
    ok(String(extra).includes('11434'), '本地模型档应把地址（含端口）露出来');
  } else {
    // 离线时最要紧的两件事：选择不许被偷偷改掉、要明说怎么办
    eq(await page.locator('#aiEngineCard button[data-engine="ollama"][aria-pressed="true"]').count(), 1,
      '本地模型离线时这一档仍应保持选中态 —— 不能偷偷跳回别的档');
    ok(String(badge).includes('没有可用引擎'),
      '离线时徽标应明说没有可用引擎（实际：' + badge + '）');
    const extra = await page.locator('#aiEngExtra').textContent();
    ok(String(extra).includes('启动Ollama') || String(extra).includes('连不上'),
      '离线时应告诉用户怎么办（实际：' + extra + '）');
    // 而且不许连坐：CLI 好着，auto / cli 都不该被报成不可用
    if (olNow.cliAvailable) {
      const autoTxt = await page.locator('#aiEngineCard button[data-engine="auto"]').textContent();
      ok(!String(autoTxt).includes('不可用'),
        '本地模型离线时 auto 不该报不可用 —— CLI 明明是好的（实际：' + autoTxt + '）');
    }
  }

  // 切回 CodeBuddy：提示应消失
  await page.locator('#aiEngineCard button[data-engine="cli"]').click();
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#aiEngBadge');
      return b && b.textContent.includes('CodeBuddy');
    },
    null, { timeout: 20000 },
  ).catch(() => {});
  const badge2 = await page.locator('#aiEngBadge').textContent();
  ok(String(badge2).includes('CodeBuddy'), '点「CodeBuddy」后徽标应显示 CodeBuddy（实际：' + badge2 + '）');

  // 切页回来状态要还在（切页会重建整个视图，这正是最容易丢的地方）。
  // 跳板用「进阶规划」—— 真实存在的单个视图；拿已撤下的路由当跳板会在日后
  // 悄悄退化成「跳到兜底页」而断言照样通过。
  await page.goto(BASE + '#prep');
  await page.waitForTimeout(400);
  await page.goto(BASE + '#tools');
  await page.waitForSelector('#aiEngineCard', { timeout: 20000 });
  const badge3 = await page.locator('#aiEngBadge').textContent();
  ok(String(badge3).includes('CodeBuddy'), '切页回来引擎状态应保留（实际：' + badge3 + '）');

  ok(errs.length === 0, '页面不应有 console 错误：' + errs.slice(0, 3).join(' | '));
} catch (e) {
  ok(false, '页面段异常：' + (e && e.message ? e.message : String(e)));
} finally {
  // 必须关。只关 page 不关 browser 会让事件循环永远不空 ——
  // 输出全对但进程不退，看起来像自检失败。
  if (browser) { try { await browser.close(); } catch { /* 已经关了 */ } }
  browser = null;
  // 还原用户的原始设置（引擎和地址都要还，上面那段改过 base）
  try { await postJson('/api/ai-engine', { engine: originalChoice, base: originalBase }); } catch { /* 服务没在跑就算了 */ }
}

// ══════════════════════════════════════════════════════════
console.log('\n────────────────────────────');
if (fails.length) {
  console.log('✖ AI 引擎自检失败 ' + fails.length + ' 条（通过 ' + pass + ' 条）');
  for (const f of fails) console.log('  · ' + f);
  process.exit(1);
}
console.log('✔ AI 引擎自检全部通过（' + pass + ' 条断言）');
process.exit(0);
