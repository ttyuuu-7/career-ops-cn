// 改造验证：检查配置在整个系统读取链路上是否被正确解析
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import { parseOutputLanguage, outputLanguageInstruction } from '../profile-language.mjs';

const results = [];
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail });
};

// ── 1. profile.yml 语法与关键字段 ──
const raw = fs.readFileSync('config/profile.yml', 'utf8');
let p;
try {
  p = yaml.load(raw);
  ok('profile.yml 语法合法', true, '');
} catch (e) {
  ok('profile.yml 语法合法', false, e.message);
  process.exit(1);
}

ok('language.output = zh-CN', p.language?.output === 'zh-CN', `实际: ${p.language?.output}`);
ok('cv.template = zh-minimal', p.cv?.template === 'zh-minimal', `实际: ${p.cv?.template}`);
ok('currency = CNY', p.compensation?.currency === 'CNY', `实际: ${p.compensation?.currency}`);
ok('无签证依赖（authorized_in 为中国）', JSON.stringify(p.location?.authorized_in) === JSON.stringify(['中国']), `实际: ${JSON.stringify(p.location?.authorized_in)}`);
ok('needs_sponsorship = false', p.location?.needs_sponsorship === false, `实际: ${p.location?.needs_sponsorship}`);
ok('degree_level = 本科', p.location?.degree_level === '本科', `实际: ${p.location?.degree_level}`);
ok('graduation_year 已设', !!p.location?.graduation_year, `实际: ${p.location?.graduation_year}`);
ok('acceptable_cities 非空', (p.location?.acceptable_cities || []).length >= 5, `${(p.location?.acceptable_cities || []).length} 个`);
ok('acceptable_majors 非空', (p.location?.acceptable_majors || []).length >= 3, `${(p.location?.acceptable_majors || []).length} 个`);
ok('triage_threshold = 3.0', p.pipeline?.triage_threshold === 3.0, `实际: ${p.pipeline?.triage_threshold}`);
ok('auto_pdf_score_threshold = 4.0', p.auto_pdf_score_threshold === 4.0, `实际: ${p.auto_pdf_score_threshold}`);
ok('archetypes 含后端方向', (p.target_roles?.archetypes || []).some(a => /后端|Java|软件/.test(a.name)), '');
ok('outreach.greeting_max_chars = 150', p.outreach?.greeting_max_chars === 150, `实际: ${p.outreach?.greeting_max_chars}`);

// ── 2. 语言指令注入 ──
const lang = parseOutputLanguage(raw);
const instr = outputLanguageInstruction(lang);
ok('parseOutputLanguage 识别 zh-CN', lang === 'zh-CN', `实际: ${lang}`);
ok('语言指令含 zh-CN', instr.includes('zh-CN'), '');
ok('语言指令含 A–G 覆盖说明', /A–G/.test(instr), '');

// ── 3. _profile.md 覆盖规则完整性 ──
const profileMd = fs.readFileSync('modes/_profile.md', 'utf8');
const needRules = [
  ['覆盖规则 1（评分体系）', /【覆盖规则 1】/],
  ['覆盖规则 2（文化信号）', /【覆盖规则 2】/],
  ['覆盖规则 3（资格检查）', /【覆盖规则 3】/],
  ['覆盖规则 4（岗位来源）', /【覆盖规则 4】/],
  ['覆盖规则 5（投递流程）', /【覆盖规则 5】/],
  ['覆盖规则 6（简历规范）', /【覆盖规则 6】/],
  ['覆盖规则 7（机器块输出纪律）', /【覆盖规则 7】/],
  ['Comp 降权声明', /仅参考，不参与打分|降级/],
  ['放弃自动扫岗', /放弃自动扫岗/],
  ['状态字段重定义', /Resume Screening|Final Interview|Salary Negotiation/],
  ['应届生资格检查机制', /资格不符/],
];
needRules.forEach(([n, re]) => ok(`_profile.md 含 ${n}`, re.test(profileMd), ''));

// 覆盖规则 7 必须把机器块的英文键名逐个写明 —— 少写一个，模型就可能把那一个
// 键名换成中文（实测 7B 模型会整块「本地化」），脚本随即解析不到分数。
// 断言键名而不是断言句子，句子改了不该红，键名漏了必须红。
['SCORE_SUMMARY', 'END_SUMMARY', 'COMPANY', 'ROLE', 'SCORE', 'ARCHETYPE', 'LEGITIMACY']
  .forEach((k) => ok(`覆盖规则 7 写明机器块键名 ${k}`, profileMd.includes(k), ''));

// _profile.md 必须已脱离模板
const templateMd = fs.readFileSync('modes/_profile.template.md', 'utf8');
ok('_profile.md 已定制（≠模板）', profileMd !== templateMd, '');
ok('_profile.md 无遗留占位符', !/\{Your |\{Archetype|\{Accomplishment/.test(profileMd), '');

// ── 4. _brief.md 完整性 ──
const brief = fs.readFileSync('modes/_brief.md', 'utf8');
const templateBrief = fs.readFileSync('modes/_brief.template.md', 'utf8');
ok('_brief.md 已定制（≠模板）', brief !== templateBrief, '');
ok('_brief.md 无未填占位符', !/\{Your Name\}|\{Archetype name\}|\{e\.g\./.test(brief), '');
// 只在「Hard DQ Criteria」表格段落内数编号行，避免匹配到判定纪律的编号
const dqSection = brief.slice(brief.indexOf('Hard DQ Criteria'), brief.indexOf('Quick Scoring Guide'));
const dqRows = (dqSection.match(/^\| \d+ \|/gm) || []).length;
ok('_brief.md 含五条硬门槛', dqRows === 5, `实际 ${dqRows} 条`);
ok('_brief.md 含「沉默即无信号」原则', /沉默即无信号/.test(brief), '');
ok('_brief.md 说明薪资不参与评分', /不参与评分/.test(brief), '');
ok('_brief.md 门槛为 3.0', /3\.0/.test(brief), '');

// ── 5. 中文简历模板可解析 ──
ok('zh-minimal 模板文件存在', fs.existsSync('templates/cv-template.zh-minimal.html'), '');

// ── 6. 国内求职投递阶段（templates/states.yml） ─────────────────────────────
// 国内求职要在台账里分开记录「简历筛选 / 笔试测评 / 初试 / 复试 / 终面 / 谈薪」，
// 否则看不出候选人卡在哪一环。这一段保证这些状态真的进了状态表，
// 并且带上了中文显示名与中文别名（缺任一半，界面或归一化就会掉链子）。
//
// 注意：这套阶段**不绑定校招**，校招 / 社招 / 实习通用。
const statesRaw = fs.readFileSync('templates/states.yml', 'utf8');
const statesDoc = yaml.load(statesRaw);
const allStates = statesDoc?.states || [];
const stateIds = new Set(allStates.map((s) => s.id));

const CN_STAGES = [
  ['screening', '简历筛选'],
  ['written_test', '笔试 / 测评'],
  ['first_interview', '初试'],
  ['second_interview', '复试'],
  ['final_interview', '终面'],
  ['salary_negotiation', '谈薪 / HR 沟通'],
  ['no_response', '无回应'],
];
CN_STAGES.forEach(([id, cn]) => {
  const st = allStates.find((s) => s.id === id);
  ok(`states.yml 含国内阶段 ${id}（${cn}）`, !!st, st ? '' : '缺失');
  if (st) {
    ok(`  └ ${id} 的 cn 中文显示名 = ${cn}`, st.cn === cn, `实际: ${st.cn}`);
    ok(`  └ ${id} 有中文别名（台账里写中文也能识别）`,
      (st.aliases || []).some((a) => /[\u4e00-\u9fff]/.test(String(a))), '');
  }
});

// 已废弃的校招专属状态不该再出现（改成通用阶段时替换掉了）
const RETIRED = ['online_assessment', 'hr_interview', 'offer_call'];
const stillThere = RETIRED.filter((id) => stateIds.has(id));
ok('已废弃的校招专属状态已移除', stillThere.length === 0,
  stillThere.length ? `仍存在: ${stillThere.join(', ')}` : '');

// 上游 9 个规范状态一个都不能丢——test-all.mjs 盯着这条，这里也钉一次
const UPSTREAM = ['evaluated', 'applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'skip', 'hired'];
const lostUpstream = UPSTREAM.filter((id) => !stateIds.has(id));
ok('上游 9 个规范状态全部保留', lostUpstream.length === 0,
  lostUpstream.length ? `丢了: ${lostUpstream.join(', ')}` : '');

// 每个状态都要有 cn，否则界面会掉回英文
const noCn = allStates.filter((s) => !s.cn);
ok('每个状态都有 cn 中文显示名', noCn.length === 0,
  noCn.length ? `缺 cn: ${noCn.map((s) => s.id).join(', ')}` : '');

// 漏斗分桶：stats.mjs 必须认识这些新状态
const statsSrc = fs.readFileSync('stats.mjs', 'utf8');
ok('stats.mjs 把国内阶段并入漏斗分桶',
  /CN_SCREENING_STATUSES/.test(statsSrc) && /CN_INTERVIEW_STATUSES/.test(statsSrc)
  && /CN_OFFER_STATUSES/.test(statsSrc)
  && /const ALL_STATUSES = \[\.\.\.CANONICAL_STATUSES/.test(statsSrc), '');

// 中文别名的双向可解析性：normalize-statuses 必须认得中文写法
const { normalizeStatus } = await import('../normalize-statuses.mjs');
for (const [raw, want] of [['简历筛选', 'Resume Screening'], ['初试', 'Interview 1'],
  ['复试', 'Interview 2'], ['终面', 'Final Interview'], ['谈薪', 'Salary Negotiation'],
  ['笔试', 'Written Test'], ['在线测评', 'Written Test'], ['一面', 'Interview 1'],
  ['HR面', 'Salary Negotiation'], ['无回应', 'No Response'], ['已投递', 'Applied'],
  ['不可投', 'SKIP']]) {
  const got = normalizeStatus(raw).status;
  ok(`归一化「${raw}」→ ${want}`, got === want, `实际: ${got}`);
}

// 控制台状态接口要把 cn 透出来（界面靠它显示中文）
const serverSrc = fs.readFileSync('ui/server.mjs', 'utf8');
ok('/api/states 返回 cn 字段', /cn: s\.cn/.test(serverSrc), '');

// ── 7. 国内专用工具 ────────────────────────────────────────────────────────
const CN_TOOLS = [
  ['tools/cn-cv-check.mjs', '中文简历规范自检'],
  ['tools/cn-interview-kit.mjs', '国内面试准备包'],
];
CN_TOOLS.forEach(([f, label]) => {
  ok(`${label} 脚本存在（${f}）`, fs.existsSync(f), '');
  ok('  └ 已登记进控制台可运行脚本', serverSrc.includes(f), `server.mjs 的 SCRIPTS 里没有 ${f}`);
});
ok('国内投递阶段显示回归测试存在', fs.existsSync('ui/check-cn-states.mjs'), '');
ok('本地化重放脚本存在（系统更新后恢复用）', fs.existsSync('tools/apply-cn-localize.mjs'), '');

// ── 8. 中文简历版式 ────────────────────────────────────────────────────────
// 标题中文化、章节重排、项目要点分行都在 ui/cv-zh-layout.mjs 里做，不写进
// templates/ —— 模板属于系统层，会被 update-system.mjs 还原成上游的英文版，
// 中文排版规则活不过一次更新。
ok('中文版式模块存在（ui/cv-zh-layout.mjs）', fs.existsSync('ui/cv-zh-layout.mjs'), '');
ok('中文版式回归测试存在（ui/check-cv-layout.mjs）', fs.existsSync('ui/check-cv-layout.mjs'), '');

// 数据源顺序：教育背景要排在实习与项目之前。国内 HR 先看学历和学校，而
// cv.md 的顺序就是 AI 评估时读到的顺序 —— 与 PDF 的顺序错位会让
// 「AI 判断的那份」和「HR 看到的那份」不是同一份简历。
const cvOrder = [...fs.readFileSync('cv.md', 'utf8').matchAll(/^## (.+)$/gm)]
  .map((m) => m[1].trim());
const idxOf = (re) => cvOrder.findIndex((t) => re.test(t));
const iEdu = idxOf(/Education|教育|学历/);
const iExp = idxOf(/Experience|工作经历|实习经历/);
const iProj = idxOf(/Projects|项目/);
ok('cv.md 有教育背景章节', iEdu >= 0, `实际章节: ${cvOrder.join(' → ')}`);
ok('cv.md 教育背景排在实习与项目之前', iEdu >= 0 && iEdu < iExp && iEdu < iProj,
  `实际顺序: ${cvOrder.join(' → ')}`);

// ── 9. 简历章节标题全中文 ──────────────────────────────────────────────────
//
// 标题「中文化」最怕的不是没改，而是**只改了一半**：PDF 是中文、cv.md 还是
// 英文，或者页面预览是英文 —— 同一份简历在两处显示不一样，用户判断不出
// 哪个算数。所以这里不只查「有没有中文」，还查「有没有残留英文」。
const cvRaw = fs.readFileSync('cv.md', 'utf8');
const cvTitles = [...cvRaw.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const EN_TITLE = /^(Summary|Professional Summary|Core Competencies|Competencies|Education|Experience|Work Experience|Projects|Skills|Technical Skills|Certifications|Awards|Honors|Interests)$/i;
const leftoverEn = cvTitles.filter((t) => EN_TITLE.test(t));
ok('cv.md 章节标题没有英文残留', leftoverEn.length === 0,
  `仍是英文: ${leftoverEn.join(' / ')}`);
ok('cv.md 章节标题以中文为主', cvTitles.length > 0
  && cvTitles.every((t) => /[\u4e00-\u9fa5]/.test(t)),
  `实际: ${cvTitles.join(' → ')}`);

// 标题的唯一权威定义在 ui/cv-model.mjs，其它地方必须引用它而不是各抄一份
const cvModelSrc = fs.readFileSync('ui/cv-model.mjs', 'utf8');
ok('标题表 CV_SECTION_TITLES_ZH 已定义（ui/cv-model.mjs）',
  /export const CV_SECTION_TITLES_ZH = \{/.test(cvModelSrc), '');
ok('cvToMarkdown 走标题表而不是字面量',
  /const T = CV_SECTION_TITLES_ZH/.test(cvModelSrc) && !/push\('## (Summary|Projects|Education)'/.test(cvModelSrc),
  'cvToMarkdown 里还有写死的英文章节标题');

// PDF 后处理必须复用同一份标题表（曾经是各抄一份，结果两边不一致）
const zhLayoutSrc = fs.readFileSync('ui/cv-zh-layout.mjs', 'utf8');
ok('PDF 版式模块复用同一份标题表',
  /import \{ CV_SECTION_TITLES_ZH \} from '\.\/cv-model\.mjs'/.test(zhLayoutSrc), '');

// 编辑页预览（2026-09-26 起 markdown 原文预览已删，现在是 renderCvVisual 色系版式
// ＋ docx fill 合成预览；断言跟着改指 renderCvVisual —— 函数不存在时切片为空，
// length>100 会把它揪出来，不会静默放行）。
const appSrc = fs.readFileSync('ui/app.js', 'utf8');
const preview = appSrc.slice(appSrc.indexOf('function renderCvVisual'),
  appSrc.indexOf('function renderCvVisual') + 4000);
ok('编辑页预览不含英文章节标题',
  preview.length > 100 && !/'\s*## (Summary|Core Competencies|Experience|Projects|Education|Skills|Certifications|Awards)'/.test(preview),
  'renderCvVisual 里还有英文字面量');

// 中文简历自检必须按「语义」找章节：精确匹配英文名会在标题改中文后静默失效
// （取不到段就当没有，依赖它的检查全部报通过 —— 越改越宽松的失败）
const cnCheckSrc = fs.readFileSync('tools/cn-cv-check.mjs', 'utf8');
ok('中文简历自检按语义匹配章节（SEC_MATCH）', /const SEC_MATCH = \{/.test(cnCheckSrc), '');
// 比较前先剥掉整行注释：说明里会**引用**旧的写法（`body('Education')`），
// 不剥的话这条断言会被自己的注释绊倒 —— 断言应该只看代码。
const cnCheckCode = cnCheckSrc.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
ok('中文简历自检不再按英文名精确取段',
  !/body\('(Education|Experience|Summary|Core Competencies|Projects|Skills|Certifications|Awards)'\)/.test(cnCheckCode),
  "还有 body('Education') 这类精确匹配");

// 控制台是离线本地工具：任何外链脚本 / CDN 一断就整页空白，这里禁止出现。
// （原先还断言「洞察页画的是图表」，数据洞察页已按需求整页下线，只保留
// 这条更普适的约束 —— 它约束的是「整站不引外链」，与具体页面无关。）
ok('控制台不依赖外部脚本 / CDN（无 script 外链）',
  !/<script[^>]+src="https?:/i.test(fs.readFileSync('ui/index.html', 'utf8')), '');

// ── 11. CodeBuddy 技能适配（国内主力 AI CLI）────────────────────────────────
// CodeBuddy Code 只从「用户级 ~/.codebuddy/skills/」和「项目级 .codebuddy/skills/」
// 发现技能；上游把技能放在 .agents/skills/，那不在它的扫描路径里。
// 所以这里放一份拷贝。注意 .agents/ 属系统层（会被 update-system.mjs 更新），
// 上游一改就会与本拷贝不一致 —— 这条断言就是防漂移的哨兵。
const AGENTS_SKILL = '.agents/skills/career-ops/SKILL.md';
const CBC_SKILL = '.codebuddy/skills/career-ops/SKILL.md';
ok('CodeBuddy 技能适配文件存在', fs.existsSync(CBC_SKILL),
  `缺 ${CBC_SKILL}；用 cp "${AGENTS_SKILL}" "${CBC_SKILL}" 生成`);
if (fs.existsSync(AGENTS_SKILL) && fs.existsSync(CBC_SKILL)) {
  const a = fs.readFileSync(AGENTS_SKILL, 'utf8');
  const b = fs.readFileSync(CBC_SKILL, 'utf8');
  ok('CodeBuddy 技能与上游 .agents 版本一致（防漂移）', a === b,
    '上游技能已更新，重新执行 cp 覆盖 .codebuddy 那份');
}
ok('config/local-paths.txt 已声明 .codebuddy/',
  fs.existsSync('config/local-paths.txt')
  && fs.readFileSync('config/local-paths.txt', 'utf8').split('\n').some(l => l.trim() === '.codebuddy/'),
  '.codebuddy/ 未被声明为 fork 自有路径，update-system 可能把它当孤儿');

// ── 12. AI 引擎：本机 Ollama ⇄ CodeBuddy ───────────────────────────────────
// 这一节只验「接线还在」—— 决策口径本身由 ui/check-ai-engine.mjs 在纯函数层测
// （它不需要服务器，坏了一眼能看出是哪条规则）。
// 这里守的是最容易在重构里被悄悄拆掉的三处：模块在不在、路由注册没、
// 前端是不是又退回成写死的「只有 CodeBuddy」。
ok('引擎决策模块存在（ui/ai-engine.mjs）', fs.existsSync('ui/ai-engine.mjs'), '');
ok('引擎回归测试存在（ui/check-ai-engine.mjs）', fs.existsSync('ui/check-ai-engine.mjs'), '');
ok('引擎切换接口已注册（/api/ai-engine）', /route === '\/api\/ai-engine'/.test(serverSrc), '');
ok('本地模型连通性接口已注册（/api/ai-engine/test）',
  /route === '\/api\/ai-engine\/test'/.test(serverSrc), '');
// 本地模型的写能力 = true 的前提是**服务端编排真的存在**（ui/local-eval.mjs：
// 读规则进 prompt → 解析回复 → 代码落盘）。两边缺一个，用户都会拿到
// 一段落不了盘的输出 —— 所以表和模块要一起断言。
ok('本地模型标记为可写（服务端编排）且编排模块存在',
  /\[ENGINE_OLLAMA\]\s*:\s*true/.test(fs.readFileSync('ui/ai-engine.mjs', 'utf8'))
  && fs.existsSync('ui/local-eval.mjs')
  && /runLocalFullEval/.test(serverSrc),
  'ai-engine.mjs 的 ENGINE_WRITE_CAPABLE[ollama] 应为 true，'
  + '且 server.mjs 里要有 runLocalFullEval 编排');
// 两处入口都必须走统一的引擎决策，不能各写一遍「先找 CLI」。
// 断言拆成两个独立特征，而不是用 `[\s\S]{0,400}` 连起来 ——
// 中间那段注释一改长，跨距断言就会以「看起来像功能坏了」的方式变红。
ok('评估路由走统一引擎决策',
  /const \{ picked \} = await resolveEngine\(\)/.test(serverSrc)
  && /if \(phase === 'full' && !canWriteFiles\(picked\.engine\)\)/.test(serverSrc),
  '/api/eval 应调 resolveEngine() 并拦截「不能写文件」的引擎');
ok('简历优化路由走统一引擎决策（本地模型可用）',
  (serverSrc.match(/await resolveEngine\(\)/g) || []).length >= 2,
  '/api/cv/optimize 也应用 resolveEngine()，否则本地模型做不了简历优化');
ok('评估页有引擎切换卡片', /function aiEngineCardHtml/.test(appSrc) && /id="aiEngineCard"/.test(appSrc),
  'ui/app.js 缺 aiEngineCardHtml() / #aiEngineCard');
ok('引擎状态挂在 S 上而不是 DOM 上', /aiEngine: null/.test(appSrc)
  && /S\.aiEngine\s*=/.test(appSrc), '引擎状态必须跨渲染保留，见 S 里其他会话状态的注释');
ok('引擎状态出口带「不在本页就 return」守卫',
  /function paintAiEngine\(\)[\s\S]{0,200}?if \(!box\) return;/.test(appSrc), '');
// 旧提示条被卡片取代了。它要是回来，说明卡片被绕开了 —— 用户会看到两句互相矛盾的话。
ok('旧的「没找到 AI 命令行」提示条已被卡片取代',
  !/没找到 AI 命令行，暂时不能评估/.test(appSrc),
  'ui/app.js 里还留着旧的 aiBar 提示条');
// auto 档的可用性必须**单独解析一次**，不能拿「当前选择」的解析结果顶替。
// 顶替的后果实测过：选了本地模型而它离线时 auto 也被标成不可用，三个按钮全灰 ——
// 明明 CLI 好好的，用户会以为整个 AI 都坏了。行为由 check-ai-engine 的
// 「死端口」那段守（与机器上 Ollama 开没开无关）。
ok('auto 档的可用性单独解析（autoPick），不复用当前档的 picked',
  /const autoPick = pickEngine\(/.test(serverSrc)
  && /c\.id === ENGINE_AUTO\s*\?\s*autoPick\.ok/.test(serverSrc),
  'ui/server.mjs 的 aiStatus() 里，auto 的 available 必须来自 autoPick.ok');

// ── 汇总 ──
const failed = results.filter(r => !r.pass);
console.log('\n改造验证 — 配置与规则文件检查');
console.log('='.repeat(52));
results.forEach(r => {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.detail && !r.pass ? '  → ' + r.detail : ''}`);
});
console.log('='.repeat(52));
console.log(`通过 ${results.length - failed.length}/${results.length}，失败 ${failed.length}`);
console.log(failed.length ? '\n结论：存在未通过项' : '\n结论：全部通过');
process.exit(failed.length ? 1 : 0);
