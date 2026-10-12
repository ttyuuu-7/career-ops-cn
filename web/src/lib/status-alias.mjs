// Status alias → canonical stage, mirroring `templates/states.yml`.
//
// Pure JS (no TS types) so it can be imported both by format.ts and by a
// `node --test` unit test, matching funnel-tiles.mjs / clean-chips.mjs /
// stream-parse.mjs.
//
// This map is a LITERAL rather than a read of states.yml because format.ts is
// node-free on purpose — it is imported by client components, so it cannot
// touch fs at runtime. The map has to ship in the bundle as data.
//
// Kept honest by tests/lib/status-alias.test.mjs, which loads states.yml and
// asserts every alias in it resolves here. A copy with nothing checking it is
// what #2249 fixed by hand for `Hired` and what drifted again as #2917.
//
// Entries marked `web-only` have no counterpart in states.yml; they predate it
// and are kept so this cannot regress an existing tracker. The sync is
// one-directional: states.yml is a floor, not a cap.

/** @type {Record<string, string>} */
export const STATUS_ALIAS = {
  // Evaluated — states.yml `evaluated`
  evaluada: "EVALUATED",
  condicional: "EVALUATED",
  hold: "EVALUATED",
  evaluar: "EVALUATED",
  verificar: "EVALUATED",
  "değerlendirildi": "EVALUATED",
  degerlendirildi: "EVALUATED",
  evaluado: "EVALUATED", // web-only: not in states.yml
  // Applied — states.yml `applied`
  aplicado: "APPLIED",
  enviada: "APPLIED",
  aplicada: "APPLIED",
  sent: "APPLIED",
  "başvuruldu": "APPLIED",
  basvuruldu: "APPLIED",
  // Responded — states.yml `responded`
  respondido: "RESPONDED",
  "yanıt verildi": "RESPONDED",
  "yanıt_verildi": "RESPONDED",
  "yanit verildi": "RESPONDED",
  yanit_verildi: "RESPONDED",
  respondida: "RESPONDED", // web-only: not in states.yml
  contestada: "RESPONDED", // web-only: not in states.yml
  // Interview — states.yml `interview`
  entrevista: "INTERVIEW",
  "mülakat": "INTERVIEW",
  mulakat: "INTERVIEW",
  // Offer — states.yml `offer`
  oferta: "OFFER",
  teklif: "OFFER",
  // Rejected — states.yml `rejected`
  rechazado: "REJECTED",
  rechazada: "REJECTED",
  reddedildi: "REJECTED",
  // Discarded — states.yml `discarded`
  descartado: "DISCARDED",
  descartada: "DISCARDED",
  cerrada: "DISCARDED",
  cancelada: "DISCARDED",
  "iptal edildi": "DISCARDED",
  iptal_edildi: "DISCARDED",
  "ıptal edildi": "DISCARDED",
  "ıptal_edildi": "DISCARDED",
  duplicado: "DISCARDED", // web-only: not in states.yml
  repost: "DISCARDED", // web-only: not in states.yml
  // SKIP — states.yml `skip`
  no_aplicar: "SKIP",
  "no aplicar": "SKIP",
  skip: "SKIP",
  monitor: "SKIP",
  "geo blocker": "SKIP",
  geo_blocker: "SKIP",
  "uygun değil": "SKIP",
  "uygun_değil": "SKIP",
  "uygun degil": "SKIP",
  uygun_degil: "SKIP",
  // Hired — states.yml `hired`
  contratado: "HIRED",
  contratada: "HIRED",
  hired: "HIRED",
  accepted: "HIRED",
  accept: "HIRED",
  "kabul edildi": "HIRED",
  kabul_edildi: "HIRED",
  "işe alındı": "HIRED",
  "ise alindi": "HIRED",
  "işe alindi": "HIRED",

  // ── CN-LOCALIZE:BEGIN ────────────────────────────────────────────────
  // 中国大陆求职状态（与 templates/states.yml 的 CN-LOCALIZE 段一一对应）。
  //
  // 上游这套状态按欧美节奏设计，粒度太粗，看不出「卡在简历筛选」「卡在复试」，
  // 于是本地化时在 states.yml 里加了一批中文别名，并把中段拆细成
  // Resume Screening / Written Test / Interview 1 / Interview 2 /
  // Final Interview / Salary Negotiation。**但这份映射表当时没跟着补**，
  // 结果中文状态在面板里解析不到规范阶段（#2917 的同类问题）：
  // canonStatus 对未知输入是「原样转大写返回」，于是「已投递」→「已投递」，
  // 而所有消费方都拿 `.includes(规范名)` 去匹配 —— 一个都对不上，
  // 该行只在 ALL 里出现、不进任何阶段页签、页签角标与阶段条都读成 0。
  //
  // 由 tests/lib/status-alias.test.mjs 守住：states.yml 里任何一个别名
  // 不在这里解析出自己的 label，CI 就红。加别名请两处一起加。
  // ── CN 求职节奏：评估 → 投递 → 回应 → 筛选 → 笔试 → 面试 → offer ──
  // Evaluated — states.yml `evaluated`
  "待投递": "EVALUATED",
  "已评估": "EVALUATED",
  "待申请": "EVALUATED",
  // Applied — states.yml `applied`
  "已投递": "APPLIED",
  "已网申": "APPLIED",
  "已申请": "APPLIED",
  "网申": "APPLIED",
  // Responded — states.yml `responded`
  "已回应": "RESPONDED",
  "已回复": "RESPONDED",
  "有回应": "RESPONDED",
  "hr已联系": "RESPONDED",
  // Resume Screening — states.yml `screening`（上游无此阶段，本地化拆分）
  "简历筛选": "RESUME SCREENING",
  "筛选中": "RESUME SCREENING",
  "过筛": "RESUME SCREENING",
  "简历通过": "RESUME SCREENING",
  "已查看": "RESUME SCREENING",
  "待初试": "RESUME SCREENING",
  // Written Test — states.yml `written_test`
  "笔试": "WRITTEN TEST",
  "机试": "WRITTEN TEST",
  "在线笔试": "WRITTEN TEST",
  "专业笔试": "WRITTEN TEST",
  "coding test": "WRITTEN TEST",
  "测评": "WRITTEN TEST",
  "在线测评": "WRITTEN TEST",
  "在线测试": "WRITTEN TEST",
  "性格测评": "WRITTEN TEST",
  "行测": "WRITTEN TEST",
  "行测题": "WRITTEN TEST",
  assessment: "WRITTEN TEST",
  // Interview — states.yml `interview`
  "面试": "INTERVIEW",
  "面试中": "INTERVIEW",
  "面试流程中": "INTERVIEW",
  // Interview 1 — states.yml `first_interview`
  "初试": "INTERVIEW 1",
  "一面": "INTERVIEW 1",
  "初面": "INTERVIEW 1",
  "技术一面": "INTERVIEW 1",
  "业务一面": "INTERVIEW 1",
  // Interview 2 — states.yml `second_interview`
  "复试": "INTERVIEW 2",
  "二面": "INTERVIEW 2",
  "复面": "INTERVIEW 2",
  "技术二面": "INTERVIEW 2",
  "交叉面": "INTERVIEW 2",
  // Final Interview — states.yml `final_interview`
  "终面": "FINAL INTERVIEW",
  "终试": "FINAL INTERVIEW",
  "三面": "FINAL INTERVIEW",
  "总监面": "FINAL INTERVIEW",
  "主管面": "FINAL INTERVIEW",
  "部门面": "FINAL INTERVIEW",
  // Salary Negotiation — states.yml `salary_negotiation`
  "谈薪": "SALARY NEGOTIATION",
  "薪资沟通": "SALARY NEGOTIATION",
  "薪资谈判": "SALARY NEGOTIATION",
  "待遇沟通": "SALARY NEGOTIATION",
  "hr面": "SALARY NEGOTIATION",
  "人力面": "SALARY NEGOTIATION",
  "综合面": "SALARY NEGOTIATION",
  "hr沟通": "SALARY NEGOTIATION",
  // Offer — states.yml `offer`
  // （「已发offer」「正式offer」「口头offer」不用列：原样转大写后本身含 OFFER）
  "录用": "OFFER",
  "意向书": "OFFER",
  // Rejected — states.yml `rejected`
  "已拒": "REJECTED",
  "被拒": "REJECTED",
  "未通过": "REJECTED",
  "已拒信": "REJECTED",
  "感谢信": "REJECTED",
  // No Response — states.yml `no_response`
  "无回应": "NO RESPONSE",
  "无响应": "NO RESPONSE",
  "石沉大海": "NO RESPONSE",
  "已沉默": "NO RESPONSE",
  ghosted: "NO RESPONSE",
  // Discarded — states.yml `discarded`
  "已放弃": "DISCARDED",
  "主动放弃": "DISCARDED",
  "已归档": "DISCARDED",
  "已关闭": "DISCARDED",
  // SKIP — states.yml `skip`
  "不可投": "SKIP",
  "资格不符": "SKIP",
  "不投": "SKIP",
  // Hired — states.yml `hired`
  "已入职": "HIRED",
  "已接受offer": "HIRED",
  "已签约": "HIRED",
  // ── CN-LOCALIZE:END ──────────────────────────────────────────────────
};

/**
 * Fold raw status text to a lookup key.
 *
 * Mirrors foldStatusInput() in tracker-utils.mjs (#2705). The `\u0307` strip is
 * what makes a capitalised Turkish status resolve: JS lowercases `İ` to `i` +
 * U+0307 COMBINING DOT ABOVE, so "İşe alındı" keys as "i̇şe alındı" and misses
 * the "işe alındı" entry. Real tracker rows are capitalised, so without this
 * the alias table is only reachable by input that is already lowercase.
 *
 * NFKC and NOT NFD, deliberately: NFD decomposes precomposed letters too, so
 * the same strip would reach the dots of ż / ė / ġ and collapse Żubr onto
 * Zubr, Ėmė onto Eme, Ġenerali onto Generali.
 *
 * Markdown bold is stripped because AGENTS.md forbids it in the status field —
 * which is exactly why it turns up there.
 *
 * @param {string} s - Raw status text from the tracker.
 * @returns {string} Lookup key.
 */
function foldStatus(s) {
  return String(s ?? "")
    .replace(/\*\*/g, "")
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u0307/gu, "");
}

/**
 * Normalize a raw tracker status to a canonical stage token.
 *
 * Unknown input is passed through uppercased rather than rejected, so a status
 * this map has never seen still renders as itself. Consumers substring-test the
 * result, which is why an alias missing from the map above resolves to no stage
 * at all — see tests/lib/status-alias.test.mjs.
 *
 * @param {string} s - Raw status text from the tracker.
 * @returns {string} Canonical stage token, or the uppercased input.
 */
export function canonStatus(s) {
  const k = foldStatus(s);
  if (k === "" || k === "—" || k === "-") return "DISCARDED";
  return STATUS_ALIAS[k] ?? String(s ?? "").toUpperCase();
}
