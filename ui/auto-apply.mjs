// ui/auto-apply.mjs — BOSS 直聘自动投递的**纯逻辑**层（零依赖）
//
// 移植自 get_jobs（Java/Spring）的 BOSS 投递流程，按本项目「零依赖 ESM +
// 纯函数可被 Node 与浏览器同时 import」的约定重写。这里只有**规则与常量**，
// 碰浏览器的部分在根目录 auto-apply-run.mjs。
//
// ⚠️ 风险最小化是这一层的第一原则（2026-09-26 用户明确要求）：
//   1. 默认 dry-run：只生成「打算投谁」的计划，一个字都不发给平台；
//   2. 真实发送必须二次确认 + 每日上限 + 随机间隔（固定节奏本身是风控特征）；
//   3. 台账去重：同一个岗位投过一次，永远不再投第二次；
//   4. 遇安全验证（滑块）立即停，绝不硬闯 —— 硬闯=封号。
//
// ⚠️ 被 app.js import（浏览器侧），**必须保持零依赖**：不能 import node:*
// 或任何需要 fs / js-yaml 的文件，否则浏览器模块图失败、页面全白。

/** 平台标识（cookie 文件名也用它）。 */
export const PLATFORM = 'boss';

/** 平台侧硬上限：BOSS 每日打招呼上限 150（get_jobs README）。 */
export const PLATFORM_DAILY_CAP = 150;

/** 本项目**建议**上限：远低于平台上限，宁可少投也不要触发风控。 */
export const SAFE_DEFAULTS = {
  dailyCap: 20,          // 单次最多投多少个
  minIntervalSec: 8,     // 岗位间停顿下界
  maxIntervalSec: 25,    // 上界（随机取，避免固定节奏）
  sayHi: '您好，我对这个岗位很感兴趣，我的经历和岗位要求比较匹配，方便沟通一下吗？',
};

/**
 * BOSS 登录态 cookie 名。口径来自 get_jobs 的 PlaywrightManager.java:111
 * （BOSS_LOGIN_COOKIES）—— 不在名单里的 cookie（__c / __g / __a / Hm_* …）
 * 都是匿名设备标识，**有文件 ≠ 已登录**。
 */
export const LOGIN_COOKIES = ['bst', 'wt2', 'zp_at', 'geek_zp_token'];

/**
 * 这份 cookie 里到底有没有登录态。
 * 为什么要有它：`save-cookies.mjs` 只要按了回车就会写文件，
 * 没登录也照样写。只判「文件在不在」会得出一个假绿的结论 ——
 * 页面说「已就绪」，跑起来却什么都读不到。
 */
export function hasLoginCookie(cookies) {
  const names = new Set((cookies || []).map((c) => String((c && c.name) || '').trim()));
  return LOGIN_COOKIES.some((n) => names.has(n));
}

/** 计划项状态。 */
export const ITEM_STATE = {
  pending: 'pending',     // 待投递
  skipped: 'skipped',     // 被过滤，不会投
  sent: 'sent',           // 已发送
  failed: 'failed',       // 发送失败
};

export const STATE_ZH = {
  pending: '待投递',
  skipped: '已跳过',
  sent: '已投递',
  failed: '投递失败',
};

/** 过滤原因（给人看的）。key 与 filterJob 返回的 reason 对应。 */
export const FILTER_REASON_ZH = {
  blackJob: '职位名命中黑名单',
  deadHr: 'HR 长期不活跃（活跃度含「年」）',
  blackCompany: '公司在黑名单',
  blackRecruiter: '招聘者命中黑名单',
  alreadyApplied: '这个岗位已经投过（本地台账命中）',
  noSayHi: '没有打招呼语，跳过（配置里填一个再跑）',
};

/**
 * 岗位去重键。优先用平台 encryptId（岗位唯一 ID），
 * 取不到就退到详情页 URL —— 首次创建台账时两者齐全，URL 兜底足够。
 */
export function dedupeKey(job) {
  const id = String((job && job.encryptId) || '').trim();
  if (id) return 'id:' + id;
  const url = String((job && job.url) || '').trim();
  return url ? 'url:' + url.replace(/[?#].*$/, '') : '';
}

/**
 * 城市名 → BOSS 城市码对照表（BOSS 沿用中国天气网编码体系）。
 * 直接填「北京 / 上海」就行，不用再查 101010100 这类码；纯数字输入原样透传（向后兼容）。
 * 没收录的城市会回落到「全国」（100010000），调用方负责提示。
 */
export const BOSS_CITIES = {
  北京: '101010100', 上海: '101020100', 广州: '101280100', 深圳: '101280600',
  天津: '101030100', 重庆: '101040100',
  杭州: '101210100', 南京: '101190100', 苏州: '101190400', 无锡: '101190200',
  常州: '101191101', 南通: '101190600', 徐州: '101190800', 宁波: '101210400',
  温州: '101210701', 绍兴: '101210500', 嘉兴: '101210300', 金华: '101210900', 台州: '101210600',
  成都: '101270101', 武汉: '101200101', 西安: '101110100', 郑州: '101180101',
  长沙: '101250101', 合肥: '101220101', 青岛: '101120201', 济南: '101120101',
  烟台: '101120501', 潍坊: '101120601', 沈阳: '101070101', 大连: '101070201',
  哈尔滨: '101050101', 长春: '101060101', 石家庄: '101090101',
  保定: '101090201', 张家口: '101090301', 承德: '101090402', 唐山: '101090501',
  廊坊: '101090601', 沧州: '101090701', 衡水: '101090801', 邢台: '101090901',
  邯郸: '101091001', 秦皇岛: '101091101',
  福州: '101230101', 厦门: '101230201', 泉州: '101230501', 南昌: '101240101',
  昆明: '101290101', 贵阳: '101260101', 南宁: '101300101', 海口: '101310101',
  三亚: '101310201', 兰州: '101160101', 西宁: '101150101', 银川: '101170101',
  乌鲁木齐: '101130101', 呼和浩特: '101080101', 拉萨: '101140101', 太原: '101100101',
  东莞: '101281600', 佛山: '101280800', 珠海: '101280701', 中山: '101281701',
  惠州: '101280301', 洛阳: '101180901',
};
export const CITY_ALL = '100010000';   // 全国

/**
 * 「北京」「上海市」「101010100」→ 城市码。
 * 纯数字原样透传；带「市」等后缀的先剥掉；认不出返回 null（由调用方决定回落与提示）。
 */
export function resolveCity(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{6,12}$/.test(s)) return s;                       // 已是城市码
  const name = s.replace(/(市|地区|自治州|特别行政区)$/, '');
  if (BOSS_CITIES[name]) return BOSS_CITIES[name];
  // 容错：输入里带前缀（如「河北承德」）——找收录表里能完整匹配尾部的
  const hit = Object.keys(BOSS_CITIES).find((k) => name.endsWith(k));
  return hit ? BOSS_CITIES[hit] : null;
}

/** 搜索页 URL（与 get_jobs 的 buildSearchUrl 同口径：只拼「非不限」的筛选项）。 */
export function buildSearchUrl(cfg, cityCode) {
  const c = cfg || {};
  // 城市支持「名称或码」两种写法：这里统一换算，调用方传什么都行
  const resolved = resolveCity(cityCode) || CITY_ALL;
  const params = ['city=' + encodeURIComponent(resolved)];
  const add = (key, val) => {
    // "0" 表示不限，拼进去反而缩小结果集（get_jobs JobUtils 同款处理）
    if (val !== undefined && val !== null && String(val) !== '' && String(val) !== '0') {
      params.push(key + '=' + encodeURIComponent(String(val)));
    }
  };
  add('jobType', c.jobType);
  add('salary', c.salary);
  add('experience', c.experience);
  add('degree', c.degree);
  add('scale', c.scale);
  add('industry', c.industry);
  add('stage', c.stage);
  const base = 'https://www.zhipin.com/web/geek/jobs?' + params.join('&');
  const q = String(c.keyword || '').trim();
  return q ? base + '&query=' + encodeURIComponent(q) : base;
}

/**
 * 四道过滤 + 台账去重（照搬 get_jobs Boss.java:413-433 的判定口径）。
 * @returns {{pass: boolean, reason: string}}
 */
export function filterJob(job, cfg, blacklists, appliedKeys) {
  const j = job || {};
  const bl = blacklists || { companies: [], jobs: [], recruiters: [] };
  const c = cfg || {};

  const hit = (list, text) => (list || []).some((x) => String(x || '').trim()
    && String(text || '').includes(String(x).trim()));

  if (hit(bl.jobs, j.jobName)) return { pass: false, reason: 'blackJob' };
  // 活跃度含「年」= 半年/一年没上线（get_jobs Boss.java:419）——这种 HR 投了也白投
  if (c.filterDeadHr && String(j.hrActive || '').includes('年')) {
    return { pass: false, reason: 'deadHr' };
  }
  if (hit(bl.companies, j.company)) return { pass: false, reason: 'blackCompany' };
  // 招聘者黑名单要**名字和头衔都比对**：写 `hrTitle || hrName` 的话，
  // 黑名单里存的是人名、而这个人恰好有头衔时就会漏网（黑名单形同虚设）。
  if (hit(bl.recruiters, j.hrName) || hit(bl.recruiters, j.hrTitle)) {
    return { pass: false, reason: 'blackRecruiter' };
  }

  const key = dedupeKey(j);
  if (key && appliedKeys && appliedKeys.has(key)) return { pass: false, reason: 'alreadyApplied' };

  if (!String(c.sayHi || '').trim()) return { pass: false, reason: 'noSayHi' };
  return { pass: true, reason: '' };
}

/** 是否触发了平台安全验证（滑块/风控）——命中必须停，get_jobs 也是这么做的。 */
export function isSecurityCheckUrl(url) {
  const u = String(url || '');
  return u.includes('/web/user/safe/verify-slider')
    || u.includes('/web/passport/zp/verify')
    || u.includes('/web/passport/zp/security')
    || u.includes('security-check');
}

/** 岗位间随机停顿秒数：固定节奏是风控特征，必须随机化。 */
export function nextIntervalSec(cfg) {
  const c = cfg || {};
  const lo = Number(c.minIntervalSec) > 0 ? Number(c.minIntervalSec) : SAFE_DEFAULTS.minIntervalSec;
  const hi = Number(c.maxIntervalSec) > 0 ? Number(c.maxIntervalSec) : SAFE_DEFAULTS.maxIntervalSec;
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  return Math.round(min + Math.random() * (max - min));
}

/** 计划汇总（界面顶部那一行）。 */
export function summarizePlan(items) {
  const s = { total: (items || []).length, pending: 0, skipped: 0, sent: 0, failed: 0 };
  (items || []).forEach((it) => { if (s[it && it.state] !== undefined) s[it.state] += 1; });
  return s;
}

/** 计划项 → 台账行（JSONL，一行一条，追加写）。 */
export function logEntry(item, state, extra) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    key: dedupeKey(item),
    state: state || ITEM_STATE.sent,
    jobName: (item && item.jobName) || '',
    company: (item && item.company) || '',
    salary: (item && item.salary) || '',
    url: (item && item.url) || '',
    note: (extra && extra.note) || '',
  });
}
