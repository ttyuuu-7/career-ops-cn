// ui/followup-cn.mjs — 国内求职的「跟进节奏」口径（Node 侧，纯函数）
//
// ⚠️ 这个模块**不能**被 app.js import：它 import 根目录的 followup-cadence.mjs，
//    而那一份依赖 js-yaml / node:fs / tracker-utils.mjs，浏览器解析不了 ——
//    结果是整个 app.js 模块图加载失败、页面全白（控制台只报几个 404，
//    看起来像静态资源没配好，实际是依赖方向错了）。
//    浏览器要用的展示常量与写盘格式在 ui/followup-format.mjs（零依赖）。
//
// ── 为什么需要这一层，而不是直接调 followup-cadence.mjs 的 analyzeFromContent ──
//
// 根目录 followup-cadence.mjs 是系统层（`node update-system.mjs` 会还原），
// 它的 ACTIONABLE_STATUSES 只有上游三个状态：
//
//     ['applied', 'responded', 'interview']
//
// 而本项目按国内招聘习惯把中段拆细了（见 templates/states.yml 的 CN 段）：
//
//     已投递 → 简历筛选 → 笔试/测评 → 初试 → 复试 → 终面 → 谈薪 → Offer
//
// 于是「简历筛选 / 笔试 / 初试 / 复试 / 终面 / 谈薪」全部落在
// ACTIONABLE_STATUSES 之外 —— 直接复用 analyzeFromContent 的话，跟进页面对
// 国内求职者**基本永远是空的**（能进队列的只剩「已投递」和「已回应」）。
// 这不是「将来会出问题」，而是已经存在的静默失效：空列表和不适用长得一模一样，
// 只有打开跟进页才会发现「一条都没有」。
//
// 所以状态覆盖面写在 ui/（不被 update-system.mjs 还原），
// 而**节奏数学一个都不重写** —— computeUrgency / computeNextFollowupDate /
// 钉日期与挂起指令的解析全部 import 自根目录那份。两处口径各写一套的话，
// 「改了 A 忘了 B」会静默地给出两个不同的日期，这正是本仓库最反复踩的那类坑。
//
// ── 一个必须说清的取舍：天数用「评估日期」当代理 ──
//
// 台账只有一列 date（评估日期），没有「状态变更日期」。所以
// daysSinceApplication 对这些中段状态而言是**推断**出来的，不是量出来的：
// 9/17 评估、9/20 才收到笔试的岗位，按评估日期算是「已过 3 天」，而真实投递
// 才刚开始。core 的 resolveAppliedDate 已经把这个来源标在 appDateSource
// （'notes' = 笔记里写了真实投递日 / 'evaluation-date-fallback' = 推断），
// 前端必须显示出来 —— 一个看起来精确、实际推断的天数，比一个标着「推断」的
// 天数危险得多。

import {
  // 状态归一：把台账里的「笔试」「复试」「谈薪」或英文规范值统一成 states.yml 的 id。
  // 用它而不是自己写一张别名表 —— 别名表一旦分家，就会出现「台账里认得出、
  // 跟进页认不出」这种只在某一个页面上暴露的错。
  normalizeStatus,
  // 跟进记录 / 钉日期（pin）/ 挂起（cleared）三类指令的解析，与 CLI 完全同源
  parseFollowups,
  parseNextOverrides,
  parseClearedDirectives,
  // 节奏数学
  computeUrgency,
  computeNextFollowupDate,
  resolveNextOverride,
  isRetired,
  // 日期
  resolveAppliedDate,
  daysBetween,
  parseDate,
  // 联系人提取（从 Notes 列里认领可联系的人）
  extractContacts,
  contactLabel,
  DEFAULT_CADENCE,
  resolveCadenceConfig,
} from '../followup-cadence.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { localToday } from '../lib/local-today.mjs';

// 展示常量与写盘格式从零依赖那份 re-export，这样调用方只认一个入口，
// 而「页面上的中文」和「写进文件的值」仍然是同一份定义（不复制）。
export {
  URGENCY_RANK, URGENCY_ZH, URGENCY_TONE, FAMILY_LABEL,
  CHANNELS, CHANNEL_ZH, normalizeChannel,
  cell, FOLLOWUPS_TABLE_HEADER, FOLLOWUPS_FILE_SKELETON,
  nextFollowupNum, hasTableHeader, followupRowLine,
  appendFollowupRow, followupPinLine, appendFollowupLine,
} from './followup-format.mjs';

import { URGENCY_RANK } from './followup-format.mjs';

// ── 状态 → 跟进节奏族 ────────────────────────────────────────────────────
//
// 节奏族只有三种（core 的 computeUrgency 就认这三种），国内拆细的状态映射到
// 最接近的那一族。理由逐条写下来，因为「为什么笔试算 responded 不算 interview」
// 这种问题三个月后一定会有人再问一次。
//
//   applied    —— 投出去了，还没人理。首次跟进 7 天，之后每 7 天一次，最多 2 次（然后转冷）。
//   responded  —— 对方有人理了（含筛选通过、笔试邀约、HR 沟通）。
//   interview  —— 进了面试流程。
//
// 落在外面的状态是**故意**的：
//   evaluated（待投递）   还没投，追什么？
//   offer / hired         已经成了，跟进节奏没有意义
//   rejected / no_response / discarded / skip   已结束
export const CN_STATUS_FAMILY = {
  applied: 'applied',

  responded: 'responded',
  screening: 'responded',          // 简历筛选：对方已在看，值得催
  written_test: 'responded',       // 笔试/测评：给了题就是有回应，催的是笔试后的结果
  salary_negotiation: 'responded', // 谈薪/HR 沟通：节奏同「已回应」（每 3 天一次最合适）

  interview: 'interview',
  first_interview: 'interview',    // 初试
  second_interview: 'interview',   // 复试
  final_interview: 'interview',    // 终面
};

/** 某个规范化状态进不进跟进队列；返回节奏族或 null。 */
export function familyOf(stateId) {
  return CN_STATUS_FAMILY[String(stateId || '').toLowerCase()] || null;
}

// ── 解析台账 ─────────────────────────────────────────────────────────────
// 与 core 的 parseTrackerContent 同构（那个函数没导出）。列序靠 resolveColumns
// 自动识别，所以台账加了列、换了列序也不会读错位。
function parseTrackerContent(content) {
  const lines = String(content ?? '').split('\n');
  const colmap = resolveColumns(lines);
  const entries = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) entries.push(row);
  }
  return entries;
}

// ── 主分析 ───────────────────────────────────────────────────────────────
/**
 * 分析台账 + 跟进记录，给出「现在该跟进谁」。
 *
 * 入参是**内容**不是路径：自检可以直接喂字符串，不动用户的真实文件。
 * 读盘由调用方（ui/server.mjs）负责。
 *
 * @param {string} trackerContent   data/applications.md 的内容
 * @param {string} followupsContent data/follow-ups.md 的内容（可缺省）
 * @param {{today?: string}} [options] today 注入（YYYY-MM-DD），自检用来钉住时钟
 * @returns {{metadata: object, entries: object[], cadenceConfig: object, cadenceDefaults: object}}
 */
export function analyzeFollowups(trackerContent, followupsContent = '', options = {}) {
  const apps = parseTrackerContent(trackerContent);
  // 时钟注入：自检钉住「今天」，否则跑一次断言一次，隔天就红。
  const injected = options.today ? parseDate(options.today) : null;
  const now = injected || new Date(localToday());
  const analysisDate = injected ? options.today : localToday();
  // 节奏配置（profile.yml 的 followup_cadence 覆盖 + 默认值）只解析一次：
  // resolveCadenceConfig() 每次都读一遍 profile.yml，放进循环就是每个请求读 N 遍盘。
  const cadence = resolveCadenceConfig();

  const followups = parseFollowups(followupsContent);
  const overrides = parseNextOverrides(String(followupsContent ?? ''));
  const cleared = parseClearedDirectives(String(followupsContent ?? ''));

  const followupsByApp = new Map();
  for (const fu of followups) {
    if (!followupsByApp.has(fu.appNum)) followupsByApp.set(fu.appNum, []);
    followupsByApp.get(fu.appNum).push(fu);
  }

  const entries = [];

  for (const app of apps) {
    const stateId = normalizeStatus(app.status);
    const family = familyOf(stateId);
    if (!family) continue;

    // 投递日期优先取 Notes 里的「Applied YYYY-MM-DD」，取不到才用 date 列，
    // 并且一路上带着 appDateSource 说明这个日期是量出来的还是推断的。
    const { appliedDate, appDateSource } = resolveAppliedDate(app);
    const appDate = parseDate(appliedDate);
    if (!appDate) continue;

    const daysSinceApp = daysBetween(appDate, now);
    const appFollowups = followupsByApp.get(app.num) || [];
    const followupCount = appFollowups.length;

    let lastFollowupDate = null;
    let daysSinceLastFollowup = null;
    const sortedFollowups = [...appFollowups].sort((a, b) => (a.date > b.date ? -1 : 1));
    if (sortedFollowups.length > 0) {
      lastFollowupDate = sortedFollowups[0].date;
      const lastDate = parseDate(lastFollowupDate);
      if (lastDate) daysSinceLastFollowup = daysBetween(lastDate, now);
    }

    let urgency = computeUrgency(family, daysSinceApp, daysSinceLastFollowup, followupCount);
    let nextFollowupDate = computeNextFollowupDate(family, appliedDate, lastFollowupDate, followupCount);

    // 钉住的日期优先于算出来的（明确的用户意图，甚至能把「已转冷」救回来）
    const nextOverride = resolveNextOverride(overrides.get(app.num), lastFollowupDate);
    if (nextOverride) {
      nextFollowupDate = nextOverride;
      urgency = daysBetween(parseDate(nextOverride), now) >= 0 ? 'overdue' : 'waiting';
    }

    // 挂起（"这里根本没有能联系的人"）压过钉日期
    const retired = isRetired(cleared.get(app.num), lastFollowupDate);
    if (retired) {
      urgency = 'retired';
      nextFollowupDate = null;
    }

    const nextDate = nextFollowupDate ? parseDate(nextFollowupDate) : null;
    const daysUntilNext = nextDate ? daysBetween(now, nextDate) : null;
    const contacts = extractContacts(app.notes);

    entries.push({
      num: app.num,
      date: app.date,
      appliedDate,
      appDateSource,          // 'notes' | 'evaluation-date-fallback'
      company: app.company,
      role: app.role,
      status: app.status,     // 台账里的原文，原样回给前端（不替用户改文件）
      stateId,                // 归一后的规范 id
      family,
      score: app.score,
      notes: app.notes,
      contacts,
      contactLabel: contacts.length ? contactLabel(contacts[0]) : null,
      daysSinceApplication: daysSinceApp,
      daysSinceLastFollowup,
      followupCount,
      followups: sortedFollowups,
      urgency,
      nextFollowupDate,
      nextOverride,
      daysUntilNext,
      retirementNote: retired ? 'cleared' : null,
    });
  }

  const retiredCount = entries.filter((e) => e.urgency === 'retired').length;
  const active = entries.filter((e) => e.urgency !== 'retired');
  active.sort((a, b) => {
    const d = (URGENCY_RANK[a.urgency] ?? 9) - (URGENCY_RANK[b.urgency] ?? 9);
    return d !== 0 ? d : a.daysSinceApplication > b.daysSinceApplication ? -1 : 1;
  });

  return {
    metadata: {
      analysisDate,
      trackerTotal: apps.length,
      actionable: active.length,
      urgent: active.filter((e) => e.urgency === 'urgent').length,
      overdue: active.filter((e) => e.urgency === 'overdue').length,
      waiting: active.filter((e) => e.urgency === 'waiting').length,
      cold: active.filter((e) => e.urgency === 'cold').length,
      retired: retiredCount,
      // 「现在就该动手」的条数 —— 卡片顶部那个数字用它，避免前端各算各的
      dueNow: active.filter((e) => e.urgency === 'urgent' || e.urgency === 'overdue').length,
      // 有多少条的天数是推断出来的（评估日期代理）。>0 时前端要挂提示。
      inferredDates: active.filter((e) => e.appDateSource === 'evaluation-date-fallback').length,
      // 跟进上限，前端用它解释「为什么这条转冷了」
      maxFollowups: cadence.applied_max_followups,
    },
    entries: active,
    cadenceConfig: cadence,
    cadenceDefaults: DEFAULT_CADENCE,
  };
}
