#!/usr/bin/env node
/**
 * cn-interview-kit.mjs — 国内面试准备包（零 token，不调用 AI）
 *
 * 为什么需要它：项目自带的 `interview-prep.md` / `interview-prep` 模式是按
 * 欧美岗位面试写的（behavioral + STAR + "tell me about yourself"），
 * 而国内的面试形态是另一套：
 *
 *   校招：投递 → 在线测评 → 笔试 → 初试 → 复试 → 终面 → 意向书 → Offer
 *   社招：投递 → 简历筛选 → 初试 → 复试 → 终面 → 谈薪 → Offer
 *   ＋ 部分企业（尤其校招）有群面 / 无领导小组讨论
 *
 * 考点也不同：技术面大量问「八股」（Java 集合、JVM、MySQL 索引、HTTP…）
 * 和「深挖你的项目」，HR 面固定在 20 来个问题上。用 STAR 那套准备国内面试，
 * 会准备错方向。
 *
 * 本脚本只读 cv.md / config/profile.yml，产出一份针对你自己简历的
 * Markdown 准备包，写到 output/。不联网、不烧额度。
 *
 * 用法：
 *   node tools/cn-interview-kit.mjs
 *   node tools/cn-interview-kit.mjs --company 华为 --role "AI 算法工程师"
 *   node tools/cn-interview-kit.mjs --role 后端开发工程师    # 只出一个方向，清单不膨胀
 *   node tools/cn-interview-kit.mjs --stdout      # 只打到终端，不落盘
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = '') => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const COMPANY = opt('--company', '').trim();
const ROLE = opt('--role', '').trim();
const TO_STDOUT = flag('--stdout');

// ── 读简历与配置，让准备包是「你的」而不是通用模板 ──────────────────────────

let cvText = '';
try { if (existsSync(join(ROOT, 'cv.md'))) cvText = readFileSync(join(ROOT, 'cv.md'), 'utf-8'); } catch { /* 忽略 */ }

let profile = {};
try {
  const mod = await import('js-yaml');
  const load = typeof mod.load === 'function' ? mod.load : mod.default?.load;
  const p = join(ROOT, 'config', 'profile.yml');
  if (load && existsSync(p)) profile = load(readFileSync(p, 'utf-8')) || {};
} catch { /* 忽略 */ }

const name = String(profile?.candidate?.full_name || (cvText.match(/^#\s+(.+)$/m) || [])[1] || '本人').trim();
const cities = (profile?.location?.acceptable_cities || []).slice(0, 8);

// 从 cv.md 的「Projects」段抽项目名（只取该段的 ### 标题，不要把
// 「Experience」段里的岗位名混进来——那会生成一份问错东西的准备包）
function projectHeadings(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  let inProjects = false;
  const out = [];
  for (const ln of lines) {
    const h2 = ln.match(/^##\s+(.+?)\s*$/);
    if (h2) { inProjects = /project|项目/i.test(h2[1]); continue; }
    if (!inProjects) continue;
    const h3 = ln.match(/^###\s+(.+?)\s*$/);
    if (h3) out.push(h3[1]);
  }
  return out;
}
const projects = projectHeadings(cvText)
  // 标题里常把「名称 — 角色　日期」写在一行，只取名称那一段
  .map((s) => s.split(/　|\s+[—–-]\s+/)[0].replace(/\s*_\[.*?\]_\s*$/, '').trim())
  .filter(Boolean)
  .slice(0, 5);

// 从配置抽技术栈（用于选八股方向）。
// 优先用「目标岗位」，不要用整份简历：简历里天然会出现 JavaScript / Linux 这类词，
// 拿简历当判据会把方向判成三四个，八股清单跟着膨胀一倍。
const roleBlob = [
  ROLE,
  JSON.stringify(profile?.target_roles?.primary || []),
  JSON.stringify(profile?.target_roles?.archetypes || []),
].join(' ');

// ── 方向判定：决定给哪一套八股清单 ──────────────────────────────────────────

const DIRS = [
  { key: '后端', label: '后端开发（Java / Go）', test: /后端|Java|Go|Spring|服务端|MyBatis|微服务/i },
  { key: '前端', label: '前端开发', test: /前端|React|Vue|JavaScript|TypeScript|CSS|Web/i },
  { key: '算法', label: '算法 / 数据', test: /算法|机器学习|深度学习|数据挖掘|建模|AI|NLP|推荐/i },
  { key: '测试', label: '测试 / 运维开发', test: /测试|运维|SRE|CI\/CD|自动化测试|Linux/i },
];
const chosen = [];
// 用户明确指定了岗位 → 只按它判方向。
// 不这样做的话，「--role 后端开发工程师」会连带命中配置里那几条
// archetype（档案里写了测试开发），八股清单一下多出一整个方向。
if (ROLE && DIRS.some((d) => d.test.test(ROLE))) {
  chosen.push(...DIRS.filter((d) => d.test.test(ROLE)));
} else {
  for (const d of DIRS) if (d.test.test(roleBlob)) chosen.push(d);
  if (!chosen.length) {
    // 目标岗位没写清楚就退回看简历——但只选命中的第一个，避免清单膨胀
    const fromCv = DIRS.find((d) => d.test.test(cvText));
    chosen.push(fromCv || DIRS[0]);
  }
}
const dirLabel = ROLE || chosen.map((d) => d.label).join(' / ');

// ── 八股清单（按方向） ──────────────────────────────────────────────────────
// 只列「面试官大概率会问、且能用一两句话讲清」的题，不塞偏题。
// 来源是国内面经里反复出现的高频项。

const BA_GU = {
  后端: [
    ['Java 基础', 'String / StringBuilder / StringBuffer 区别；== 与 equals；HashMap 的 put 与扩容过程（1.7 与 1.8 的区别）'],
    ['并发', 'volatile 与 synchronized 的区别；线程池七大参数与拒绝策略；死锁的四个必要条件'],
    ['JVM', '内存区域划分；对象什么时候进老年代；常见 GC 与调优参数；类加载过程与双亲委派'],
    ['MySQL', '索引为什么用 B+ 树；最左前缀原则；回表与覆盖索引；事务隔离级别与 MVCC；explain 看什么'],
    ['Redis', '为什么快；缓存穿透 / 击穿 / 雪崩分别怎么解决；持久化 RDB 与 AOF；分布式锁怎么实现'],
    ['网络', 'TCP 三次握手 / 四次挥手；TCP 与 UDP 区别；HTTP 与 HTTPS 区别；从输入 URL 到页面展示发生了什么'],
    ['框架', 'Spring IoC 与 AOP 原理；Bean 生命周期；Spring Boot 自动装配；MyBatis 的一级 / 二级缓存'],
    ['算法题', '手写反转链表 / 二分查找 / 两数之和 / 快排；时间空间复杂度要能说清'],
  ],
  前端: [
    ['JS 基础', '原型链；闭包与内存泄漏；this 指向；事件循环（宏任务 / 微任务）；ES6 常用特性'],
    ['浏览器', '从输入 URL 到页面渲染；重排与重绘；事件冒泡与捕获；跨域与解决方案'],
    ['框架', 'Vue 双向绑定原理；React 的 diff 与 key；组件通信方式；状态管理怎么选'],
    ['工程化', 'Webpack 与 Vite 的区别；打包优化做了什么；前端性能指标（LCP / FID / CLS）'],
    ['CSS', '盒模型；BFC；flex 与 grid；水平垂直居中的几种写法'],
    ['算法题', '数组去重 / 扁平化 / 防抖节流 / 深拷贝的手写实现'],
  ],
  算法: [
    ['数学与统计', '过拟合怎么判断与解决；偏差与方差；交叉验证；常见分布'],
    ['机器学习', '逻辑回归的损失函数；决策树与随机森林；XGBoost 做了什么优化；特征工程怎么做'],
    ['深度学习', '反向传播；BatchNorm 作用；Transformer 与注意力机制；优化器对比'],
    ['编程', 'Python 基础；Pandas / NumPy 常用操作；手写 K-means 或 AUC 计算'],
    ['项目', '你项目里的指标怎么定义的、baseline 是什么、提升来自哪一步'],
    ['算法题', 'LeetCode 中等难度的数组 / 字符串 / 动态规划；SQL 的窗口函数与分组'],
  ],
  测试: [
    ['测试基础', '黑盒与白盒；等价类与边界值；测试用例怎么写；缺陷的生命周期'],
    ['自动化', 'Selenium / Playwright 原理；元素定位方式；接口测试工具（Postman / JMeter）'],
    ['Linux', '常用命令；查看日志；排查 CPU / 内存 / 磁盘占用'],
    ['网络', 'HTTP 状态码；抓包看什么；接口超时与并发怎么测'],
    ['脚本', 'Python / Shell 写一个批量校验脚本；CI 流水线怎么搭'],
  ],
};

// ── HR 面高频问题（国内固定题库） ──────────────────────────────────────────

const HR_QUESTIONS = [
  ['自我介绍（必问，控制 1 分钟）', '结构：我是谁 → 学校专业与方向 → 做过什么（1 个项目讲重点） → 为什么想做这个岗位。不要背简历，要讲线索。'],
  ['为什么选择我们公司？', '提前查三件事：主营业务、这个岗位所在的业务线、最近的一条新闻或产品。答「平台大 / 稳定」不算答案。'],
  ['为什么选这个岗位？', '把岗位要求和你的经历接上，说清「我做过 ××，这正好是岗位要的」。'],
  ['你的职业规划？', '分阶段说：1 年内打好工程基础 → 2–3 年独立负责模块 → 长期做技术纵深。不要答「三年当主管」。'],
  ['你的优点和缺点？', '优点配一个具体事例；缺点要说真实且正在改的（如「面对新框架习惯先看文档而不是先动手试」），不要用「太追求完美」这类假缺点。'],
  ['你做过最有成就感的项目？', '讲清目标、你负责的部分、遇到的难点、怎么解决、结果的数据。'],
  ['项目里遇到的最大困难是什么？', '同上，重点在「你怎么定位问题」而不是难本身。'],
  ['你平时怎么学习新技术？', '给出具体路径：官方文档 / 开源代码 / 自己写 demo，最好举一个最近学的例子。'],
  ['还投了哪些公司？进展如何？', '如实但简短，不要报一长串。可以说「主要在投同方向的岗位，目前有几个在流程中」。'],
  ['如果拿到多个 offer 你怎么选？', '给出你的排序依据（城市 / 业务方向 / 培养体系），并说明为什么这家符合。'],
  ['期望薪资是多少？', '校招多为统一定价，答「我更关注岗位和培养，薪资希望按公司对应届生的统一标准来，方便了解一下这个岗位的薪资构成吗？」。社招则要给区间并留出议价余地。'],
  ['能接受加班吗？', '不要答「完全能接受」也不要答「不接受」。答「可以在项目节点上加把劲，也希望是可持续的节奏」，并把话题引到「团队平时的工作节奏是怎样的」。'],
  ['能接受调剂城市 / 岗位吗？', '先问清是哪个城市 / 岗位再表态。' + (cities.length ? `你的可接受城市是：${cities.join('、')}。` : '')],
  ['什么时候能到岗？能提前实习吗？', '提前想好：能否提前实习、每周几天、实习到什么时候。这是 HR 很在意的一条。'],
  ['为什么选择这个专业 / 为什么不做科研？', '（碰到就问）给出务实的理由，别说「不喜欢读书」。'],
  ['你的家庭情况 / 有没有对象？', '属于越界问题，可以礼貌带回：「这些和岗位关联不大，我主要考虑的是职业发展。」'],
  ['（校招常见）有没有参加过社团 / 学生工作？', '有就讲清你负责什么、做成了什么；没有就讲团队协作的项目经历。'],
  ['你觉得自己最适合这个岗位的哪一点？', '一句话结论 + 一个证据。'],
  ['如果我们没录用你，你会怎么办？', '展示韧性：继续投同方向岗位、复盘这次面试的不足。'],
  ['你有什么想问我们的？', '见下方「反问清单」。这条一定会问，不能答「没有」。'],
];

// ── 群面 / 无领导小组讨论（部分企业，校招更常见） ──────────────────────────

const GROUP_INTERVIEW = [
  ['典型形式', '6–10 人一组，给一个案例或讨论题，30–45 分钟出结论，通常还要推 1 人做总结汇报。面试官在旁只观察、不参与。'],
  ['四个角色怎么选', '领导者（控流程、拉回主题）、计时员（管时间节点）、记录员（整理观点）、汇报者（最后陈述）。不要硬抢领导者——抢了却控不住场，比不当领导者扣分更多。'],
  ['发言结构（直接用）', '「我先说一个框架：这件事可以分成 A / B / C 三块。我的判断是……理由是……我建议我们先定 A，再讨论 B。」先给结构，再给观点。'],
  ['没想法时怎么办', '做一个高质量的信息整理者：「我先把大家刚才说的归纳成三点……」这比硬编一个观点安全。'],
  ['加分动作', '主动拉沉默的人发言（「刚才那位同学好像有不同角度」）、在争执时提出折中方案、最后帮汇报者梳理提纲。'],
  ['扣分动作', '打断别人、抢话超过 3 次、全程只重复自己观点、超时不管、最后推不出结论。'],
  ['汇报环节', '控制在 2–3 分钟：结论 → 理由（3 点）→ 遗留分歧。不要复述整场讨论。'],
];

// ── 反问清单 ────────────────────────────────────────────────────────────────

const REVERSE_Q = {
  ok: [
    '这个岗位日常的工作内容大概是什么样的？新人前三个月会从什么事情开始入手？',
    '团队目前有多少人、怎么分工？新人会有导师或带教吗？',
    '这个业务线未来一年的重点方向是什么？',
    '如果我有幸入职，公司希望我在试用期内达到什么水平？',
  ],
  no: [
    '「你们几点下班？」「加班多吗？」——想了解作息，换成：这个团队平时的工作节奏是怎样的？',
    '「能涨薪吗？」「年终奖几个月？」——HR 面之前不要问钱，会被认为动机单一。',
    '「我能不能换岗位 / 换城市？」——先拿到 offer 再谈，面试阶段问会显得没想清楚。',
    '「面试结果什么时候出？我能过吗？」——可以问流程时长，不要问结果。',
  ],
};

// ── 组装 ────────────────────────────────────────────────────────────────────

function table(rows) {
  return rows.map(([a, b]) => `| ${a} | ${b} |`).join('\n');
}

const title = ['国内面试准备包', name, COMPANY, ROLE].filter(Boolean).join(' · ');
const L = [];

L.push(`# ${title}`);
L.push('');
L.push(`> 生成时间：${new Date().toLocaleString('zh-CN')}　方向：${dirLabel}`);
L.push('> 本文件由 `tools/cn-interview-kit.mjs` 生成，零 token；内容按国内招聘流程组织'
  + '（校招 / 社招 / 实习通用），与项目自带的 `interview-prep`（欧美 behavioral 路线）是两套东西。');
L.push('');
L.push('## 一、流程与时间线');
L.push('');
L.push('**校招（按批次走）**');
L.push('');
L.push('| 环节 | 你要准备什么 | 一般耗时 |');
L.push('|---|---|---|');
L.push('| 网申 / 投递 | 简历 PDF（一页、中文、教育前置）+ 成绩单；用同一份简历投所有岗位会降低命中率 | 30 分钟/家 |');
L.push('| 在线测评 | 行测（言语 / 数量 / 判断推理 / 资料分析）+ 性格测试。**性格测试不要选极端选项，前后要一致** | 40–60 分钟 |');
L.push('| 笔试 / 机试 | 技术岗：选择题（八股）+ 2–3 道算法题；部分公司限时编程 | 1–2 小时 |');
L.push('| 初试 | 技术面为主，深挖简历项目 + 八股 | 40–60 分钟 |');
L.push('| 复试 | 交叉面 / 部门负责人，更看设计思路与思考深度 | 40–60 分钟 |');
L.push('| 终面 / HR 面 | 意向、薪资构成、到岗时间、稳定性 | 20–40 分钟 |');
L.push('| 群面（部分公司） | 无领导小组讨论 | 30–45 分钟 |');
L.push('| 意向书 → Offer | 口头意向先到，正式 offer 后到；**收到意向书也要继续投别家** | 1–3 周 |');
L.push('');
L.push('**社招（全年滚动）**');
L.push('');
L.push('| 环节 | 你要准备什么 | 一般耗时 |');
L.push('|---|---|---|');
L.push('| 投递 | 简历按 JD 改项目顺序与关键词；能走内推就别走官网 | — |');
L.push('| 简历筛选 | HR / 用人部门过简历。<b>2–5 个工作日没动静基本就是没进流程</b> | 1–2 周 |');
L.push('| 初试 | 通常是直属上级或资深同事，重点是你的实际经验与岗位的贴合度 | 45–60 分钟 |');
L.push('| 复试 | 部门负责人 / 交叉面，看技术深度与协作方式 | 45–60 分钟 |');
L.push('| 终面 | 总监 / 老板，看稳定性、动机、能不能独立扛事 | 30–45 分钟 |');
L.push('| 谈薪 / HR 沟通 | 薪资构成、定级、到岗时间、背调 —— **社招这一步是有议价空间的** | 1–2 周 |');
L.push('');
L.push('**节奏提醒：** 校招秋招 8–10 月是主战场、春招 3–4 月补录，'
  + '多数大厂简历筛选在 9 月中就基本结束，投递要赶早。'
  + '社招全年滚动，3–4 月与 9–10 月岗位最多；单个岗位从投递到 offer 通常 2–6 周。');
L.push('');

L.push('## 二、笔试与在线测评怎么准备（校招常见，部分社招岗位也有）');
L.push('');
L.push('> 社招岗位大多不设笔试，直接进面试；这一节按需看。');
L.push('');
L.push('- **行测**：只练「资料分析」和「判断推理」性价比最高，这两块靠方法能稳定提分；数量关系不会就跳过，别耗时间。');
L.push('- **性格测试**：企业真正筛的是「极端作答」和「前后矛盾」。同一维度上前后答案要一致，别为了显得完美而全选最正面选项。');
L.push('- **技术笔试**：先做完会做的题再回头攻难题；机试要先跑通样例再优化。');
L.push('- **刷题量**：算法题 LeetCode 100–150 道（简单 + 中等）够用，重点在数组、字符串、哈希、双指针、二叉树、动态规划入门。');
L.push('');

L.push('## 三、技术面八股清单（按方向）');
L.push('');
chosen.forEach((d) => {
  L.push(`### ${d.label}`);
  L.push('');
  L.push('| 板块 | 高频考点 |');
  L.push('|---|---|');
  L.push(table(BA_GU[d.key]));
  L.push('');
});
L.push('**怎么用这张表：** 每个考点准备「一句话结论 + 一个自己项目里的例子」。'
  + '面试官最烦的是背概念——「我用 Redis 做缓存，因为……但在压测时发现……」。');
L.push('');
L.push('**社招的差异：** 八股照样会问，但重心更偏向「你在真实项目里怎么落地的」——'
  + '同样的题，社招面试官会追一层「那你线上遇到过什么问题」，校招往往止于知道原理。');
L.push('');

L.push('## 四、项目深挖（技术面 70% 的时间在这里）');
L.push('');
if (projects.length) {
  L.push('你简历上会被追问的项目：');
  L.push('');
  projects.forEach((p, i) => L.push(`${i + 1}. **${p}**`));
  L.push('');
} else {
  L.push('> 没读到项目名（cv.md 里没有 `### ` 开头的项目标题）。下面的问题仍然适用。');
  L.push('');
}
L.push('**每个项目都要能回答这 10 个问题**（面试官基本按这个顺序问）：');
L.push('');
L.push('1. 用两分钟讲一下这个项目（**结论先行**：做了什么、你的角色、结果）');
L.push('2. 整体架构是什么？画一下数据流');
L.push('3. 你具体负责哪一部分？别人负责什么？');
L.push('4. 为什么选这个技术栈？还有别的方案吗？为什么不选？');
L.push('5. 数据量 / 并发量是多少？性能瓶颈在哪？');
L.push('6. 最难的三个问题是什么？你怎么定位和解决的？');
L.push('7. 有哪些地方做得不好？如果重做你会怎么改？');
L.push('8. 你怎么测试的？遇到过线上问题吗？');
L.push('9. 这个项目里你写的代码大概多少行 / 几个模块？');
L.push('10. 从中学到了什么？');
L.push('');
L.push('**红线：** 只讲你真正做过的部分。说「这块是队友做的，我了解思路」不丢分，'
  + '把队友做的说成自己的，被追问两层就露了。');
L.push('');

L.push('## 五、HR 面 20 问');
L.push('');
L.push('| 问题 | 怎么答 |');
L.push('|---|---|');
L.push(table(HR_QUESTIONS));
L.push('');

L.push('## 六、群面 / 无领导小组讨论（部分企业，校招更常见）');
L.push('');
L.push('| 要点 | 说明 |');
L.push('|---|---|');
L.push(table(GROUP_INTERVIEW));
L.push('');

L.push('## 七、反问清单');
L.push('');
L.push('**可以问（面试官会觉得你在认真考虑这份工作）：**');
L.push('');
REVERSE_Q.ok.forEach((q) => L.push(`- ${q}`));
L.push('');
L.push('**不要问（换成箭头后的说法）：**');
L.push('');
REVERSE_Q.no.forEach((q) => L.push(`- ${q}`));
L.push('');

L.push('## 八、薪资怎么谈');
L.push('');
L.push('- **校招**：绝大多数是**统一定级**，按「城市 + 学历 + 岗位序列」定，本科普遍低于硕士一档，谈薪空间极小 —— 把精力放在问清构成上。');
L.push('- **社招**：定级与薪资通常**有议价空间**。职级、月薪、签字费、到岗时间都能谈，但要有依据（同期同岗位的行情、你手头的其他 offer）。先让对方给数字，再表态。');
L.push('- 无论哪种，要问清的是**构成**，不是数字：月薪 × 几薪、年终奖几个月、绩效系数、餐补 / 房补 / 交通补贴、公积金比例、有没有股票或期权。');
L.push('- 问法：「想了解一下这个岗位的薪资构成，比如月薪、年终和补贴，方便我做个整体了解。」');
L.push('- **不要做**：用网上查到的数据向 HR 施压、假装已有更高 offer（背景调查很容易核实）、把期望薪资写进简历。');
L.push('');

L.push('## 九、面试当天检查清单');
L.push('');
L.push('- [ ] 线上面试：提前 15 分钟测设备 —— 摄像头、麦克风、网络；关掉会弹窗的软件；背景干净、光线在正前方');
L.push('- [ ] 线下：提前 20 分钟到，带 2 份纸质简历 + 成绩单 + 证书原件');
L.push('- [ ] 电脑里常备：简历 PDF、项目代码仓库地址、部署的 demo 地址');
L.push('- [ ] 一段 1 分钟自我介绍，练到不用看稿（**不要背简历原文**）');
L.push('- [ ] 准备 3 个反问问题（见上），写在纸上');
L.push('- [ ] 面试后当天记下面了哪些题、答得不好的地方 —— 下一家会问同样的题');
L.push('');

L.push('---');
L.push('');
L.push('> 这份准备包是**模板化的清单**，不含公司内情。'
  + '想针对某家公司深挖（业务、融资、近期新闻、面试风格），用 AI 对话跑 `/career-ops deep` 或直接问它。');
L.push('');

const md = L.join('\n');

if (TO_STDOUT) {
  process.stdout.write(md);
} else {
  const dir = join(ROOT, 'output');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const safe = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40);
  // 有公司就用公司，没有就退回岗位名，别生成「通用-后端开发工程师」这种半截名字
  const subject = safe(COMPANY) || safe(ROLE) || '通用';
  const file = `面试准备-${subject}${COMPANY && ROLE ? '-' + safe(ROLE) : ''}-${stamp}.md`;
  const out = join(dir, file);
  writeFileSync(out, md, 'utf-8');

  const qCount = HR_QUESTIONS.length
    + chosen.reduce((a, d) => a + BA_GU[d.key].length, 0)
    + 10 + GROUP_INTERVIEW.length;
  process.stdout.write([
    '',
    '国内面试准备包已生成',
    '='.repeat(56),
    `  对象　　：${name}${COMPANY ? ' → ' + COMPANY : ''}${ROLE ? ' · ' + ROLE : ''}`,
    `  方向　　：${dirLabel}`,
    `  简历项目：${projects.length ? projects.join(' / ') : '（未读到项目）'}`,
    `  清单条目：约 ${qCount} 条（八股 ${chosen.reduce((a, d) => a + BA_GU[d.key].length, 0)} 个板块 · HR ${HR_QUESTIONS.length} 问 · 项目深挖 10 问 · 群面 ${GROUP_INTERVIEW.length} 条）`,
    `  覆盖流程：校招 / 社招两条时间线`,
    `  输出文件：output/${file}`,
    '',
    '提示：带 --company / --role 生成针对性的文件名；带 --stdout 只打印不落盘。',
    '',
  ].join('\n'));
}
