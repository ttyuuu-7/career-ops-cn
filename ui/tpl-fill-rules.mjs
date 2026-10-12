// ui/tpl-fill-rules.mjs — 「模板内容填充」的替换对生成规则（2026-10-04 重写）
//
// 背景：设计类 Word 模板（文艺/活泼等）的文字全部装在图形文本框里，程序无法
// 按「字段占位符」灌内容；但 COM 的 Find & Replace 能在**保字符样式**的前提
// 下把模板示例值换成用户真实值。本模块就是「模板框文本 + 用户表单 → 替换对」
// 的规则单点，被 ui/server.mjs 直接 import（改本文件必须重启 7317）。
//
// 输入：boxes = 解析器读出的文本框列表（每框若干段落文本）
//       cv = normalizeCv 后的表单
// 输出：pairs = [ [find, replace, nth], ... ]
//       · find    模板里的原文（多段用 ^p、软换行 ^l、Tab ^t 连接）
//       · replace 用户真实值；**空串表示清空该框**（模板示例不得残留）
//       · nth     同一 find 在文档中按序出现的第几个（0 起）——设计类模板一个
//                 栏目常有 4 组示例块（经历 ×4、教育 ×2），不定位就会把「第 1
//                 条经历」灌进所有块，用户看到同一段内容重复 4 次（2026-10-04
//                 预览实测）。nth 让 COM 只改第 k 块，多余块由本模块发空串清空。
//
// 硬规矩：
//   ① 值为空 → 发空串清空该块（而不是保留模板示例，示例假数据比空白更糟）
//   ② find 文本必须 ≥2 字符且 ≠ 替换值
//   ③ 同一 find 只保留一条，但按块分配不同内容时用 nth 区分
//   ④ 每条替换对带 kind 标注，探针/调试能看清「哪条规则生成了它」
//   ⑤ 容量守护：模板文本框是固定尺寸，超长会溢出击 neighbouring 框；按「行数
//      优先、单行再按可视长度」裁剪，且**不静默**——被丢的行进 dropped 列表

const RE_CN_NAME = /^[一-龥]{2,4}$/;
const RE_PHONE = /1[3-9]\d{9}|\d{3,4}[- ]\d{7,8}/;
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
// ⚠️ 「可选的月/日」必须用 (?:\d{1,2}\s*[.\-/月]?\s*)? —— 不能写 \d{1,2}?：
//   {1,2} 的懒惰版下限仍是 1、匹配不了空串，「2020-2024」里 '-' 被前面的
//   可选类吃掉后，这里强制吃掉 1 位数字，后续连接符全部对不上 → 整条 false。
const RE_DATE_RANGE = /\d{4}\s*[.\-/年]?\s*(?:\d{1,2}\s*[.\-/月]?\s*)?[-—~–至]{1,2}\s*\d{4}/;
const RE_SCHOOL = /大学|学院|学校|师范|理工|工业|交通|科技大|外国语|财经|医科/;
const RE_CERT = /证书|CET|普通话|奖学金|三好|荣誉|获奖|资格证|奖/;
const RE_INTENT = /^求职意向\s*[:：]/;
const RE_SECTION_TITLE = new RegExp(
  '^(教育经历|实践经验|实践经历|实习经历|工作经历|校园经历|项目经历|自我评价'
  + '|职业技能|专业技能|兴趣爱好|特长爱好|基本信息|个人简介|个人资料|个人信息'
  + '|荣誉证书|获奖情况|获奖经历|资格证书|证书情况|技能特长|联系方式|求职意向'
  + '|主修课程|语言能力|培训经历|教育背景|个人优势|工作技能)$'
);
const RE_LABELLED = /^(院校|学校|专业|籍贯|地址|现居|学历|年龄|出生年月|政治面貌)\s*[:：]/;
// 「标签：值」行里的标签部分（替换时保留）
const LABEL_RE = /^((?:院校|学校|专业|籍贯|地址|现居|学历|年龄|出生年月|政治面貌)\s*[:：])/;
// 栏目标题 → 其后清单框的语义（兴趣爱好清单块）
const RE_HOBBY_TITLE = /^(兴趣爱好|特长爱好|兴趣特长)$/;
const RE_SKILL_TITLE = /^(职业技能|专业技能|技能特长|工作技能)$/;

function s(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Word 查找替换的段落标记：多段框整框替换时用 ^p 连接（Find.Execute 原生支持）。 */
function joinFind(paras) {
  return paras.join('^p');
}

/* ── 文本框容量守护 ────────────────────────────────────────────────────────
   背景：设计类模板的文本框是**固定尺寸**的。模板里一格只写了「2006-2010」
   这样的短日期，我们却往里灌「2025-06 - 2025-09  某科技公司  Java开发实习生」
   （实测 9 字 → 37 字，膨胀 4.11 倍）—— Word 会让文本溢出框边界，和相邻
   文本框撞在一起，用户看到的就是一片糊在一起的字。
   口径：① 多行替换先按**模板块的行数**裁剪（多出来的条目直接丢，并记账）；
        ② 单行按可视长度预算裁剪（半角 1、全角 2），标签行给宽一点预算。 */
function visualLen(str) {
  let n = 0;
  for (const ch of String(str || '')) {
    n += /[⺀-鿿＀-￯　-〿]/.test(ch) ? 2 : 1;
  }
  return n;
}

/**
 * 容量守护。
 * @param {string} find 模板原文（决定容量预算）
 * @param {string} replace 用户值
 * @param {object} [opt] { wide:标签行, minCap:标签类短文本的最小容量, maxLines:模板块行数 }
 * @returns {{ text:string, dropped:string[] }}
 */
function fitReplace(find, replace, opt) {
  const o = opt || {};
  const dropped = [];
  const findParas = String(find).split('^p');
  const maxLines = o.maxLines || findParas.length;
  // 系数口径：多行文本框 ×2.0（模板示例每行往往只写十几个字，1.6 会把
  // 「刚好放得下」的内容误裁掉，2026-10-04 实测 4 条 bullet 被裁成 2 条）；
  // 标签行（学历：/年龄：…）再宽一点；单行保持 ×1.6 的原口径。
  const ratio = o.wide ? 2.2 : (maxLines > 1 ? 2.0 : 1.6);
  const cap = Math.max(o.minCap || 8, Math.round(visualLen(find) * ratio));

  const raw = String(replace === null || replace === undefined ? '' : replace);
  if (!raw) return { text: '', dropped };
  // 多行值：先按模板块行数裁剪
  let lines = raw.split(/\^l|\v/).filter((x, i, arr) => x !== '' || arr.length === 1);
  if (lines.length > maxLines) {
    dropped.push(...lines.slice(maxLines).filter(Boolean));
    lines = lines.slice(0, maxLines);
  }
  // 再按可视长度逐行裁剪
  const out = [];
  let used = 0;
  for (const line of lines) {
    if (visualLen(line) <= cap - used) {
      out.push(line);
      used += visualLen(line);
      continue;
    }
    // 单行本身就超剩余预算 → 按字符硬截（留前若干可视长度 + 省略号）
    const room = Math.max(0, cap - used - 1);
    let acc = '';
    let n = 0;
    for (const ch of line) {
      const w = visualLen(ch);
      if (n + w > room) break;
      acc += ch;
      n += w;
    }
    if (acc && acc !== line) dropped.push(line);
    out.push(acc + (acc ? '…' : ''));
    used = cap;
    break;
  }
  let text = out.filter((x) => x !== '').join('^l');
  if (!text && raw) {
    // 预算实在太小（模板原文极短）——至少留第一行的前若干字，别交白卷
    const first = raw.split(/\^l|\v/)[0] || '';
    let acc = '';
    let n = 0;
    for (const ch of first) {
      const w = visualLen(ch);
      if (n + w > Math.max(4, cap - 1)) break;
      acc += ch;
      n += w;
    }
    text = acc + '…';
    dropped.push(raw);
  }
  return { text, dropped };
}

/** 表单取值：过滤明显被误解析进 description 的日期行（2026-10-04 实测）。 */
function cleanEducation(e) {
  const o = { ...(e || {}) };
  const d = s(o.description);
  const loc = s(o.location);
  if (d && (RE_DATE_RANGE.test(d) || d === s(o.year) || (loc && d.indexOf(loc) === 0))) {
    // 形如「2024 – 2028（2028 届）· 承德」——这是教育时间/地点，不是描述。
    // ⚠️ loc 必须非空再判 indexOf：''.indexOf → 0，会把所有描述误判成 echo
    // 清空（2026-10-04 单测抓到的真 bug）。
    o.description = '';
  }
  return o;
}

function formOf(cv) {
  const c = (cv && cv.candidate) || {};
  const edu = (Array.isArray(cv && cv.education) ? cv.education : []).map(cleanEducation);
  const exp = (Array.isArray(cv && cv.experience) ? cv.experience : []).map((e) => ({
    ...(e || {}),
    bullets: (e && Array.isArray(e.bullets) ? e.bullets : [])
      .map((b) => s(b).replace(/^-\s+/, ''))
      .filter(Boolean),
  }));
  const certs = (Array.isArray(cv && cv.certifications) ? cv.certifications : [])
    .map((x) => s(x && x.title)).filter(Boolean);
  const awards = (Array.isArray(cv && cv.awards) ? cv.awards : [])
    .map((x) => s(x && x.title)).filter(Boolean);
  const skills = (Array.isArray(cv && cv.skills) ? cv.skills : [])
    .map((x) => ({ category: s(x && x.category), items: (x && x.items ? x.items : []).map(s).filter(Boolean) }))
    .filter((x) => x.category);
  const summary = s(cv && cv.summary);
  // 求职意向：summary 里「目标 X」句式 → 胜任力第一条 → 专业（2026-10-01 实测口径）
  const m = /目标\s*([^，。；,;;]+)/.exec(summary);
  // 求职意向取值优先级：表单「求职意向」→ summary 里「目标 X」→ 胜任力第一条。
  // **不再拿专业名兜底**（2026-10-04 实测：用户没填意向时，专业名被塞进意向格
  // 并被容量守护裁成「计算机科学与技术（…」，半句话很难看）。没有明确来源就
  // 留空，并在 unmapped 里记账。
  const intent = s(c.intent) || s(m && m[1])
    || s(cv && cv.competencies && cv.competencies[0]);
  return {
    name: s(c.name), phone: s(c.phone), email: s(c.email), location: s(c.location),
    degree: s(c.degree), age: s(c.age), hobbies: s(c.hobbies),
    summary, intent, edu, exp, certs, awards, skills,
  };
}

function eduLine(e) {
  const t = s(e && e.title);
  const org = s(e && e.org);
  const y = s(e && e.year);
  return [y, org, t].filter(Boolean).join('  ');
}

function expLine(e) {
  const c = s(e && e.company);
  const r = s(e && e.role);
  const d = s(e && e.dates);
  return [d, c, r].filter(Boolean).join('  ');
}

/** 长中文描述框判定（无日期/无联系方式、有句读或顿号大清单、总长 ≥40）。 */
function longDescBox(paras) {
  const texts = (Array.isArray(paras) ? paras : []).map((p) => s(p)).filter(Boolean);
  if (!texts.length) return null;
  const joined = texts.join('\n');
  if (joined.length < 40) return null;
  if (RE_DATE_RANGE.test(joined) || RE_PHONE.test(joined) || RE_EMAIL.test(joined)) return null;
  const punct = /[。！？，,；;]/.test(joined);
  const courseList = texts.length === 1 && joined.split('、').length >= 5;
  if (!punct && !courseList) return null;
  if (texts.length > 1 && joined.split('、').length > 5) return null;
  return { texts, joined };
}

/**
 * 步骤 1：剥掉 mc:Choice / mc:Fallback 的**相邻**重复副本。
 * 一个形状在 document.xml 里存两份（DrawingML + VML 回退），两份紧邻出现；
 * 但文档里真实存在的多个同文本块（art01 有 4 组经历行）彼此**不相邻**，
 * 必须保留 —— 否则第 2/3/4 组永远清不掉，同一段经历会重复 4 次。
 */
function dedupeBoxes(boxes) {
  const out = [];
  for (const b of (Array.isArray(boxes) ? boxes : [])) {
    const paras = (Array.isArray(b) ? b : []).map((p) => s(p)).filter(Boolean);
    if (!paras.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.join('\n') === paras.join('\n')) continue; // 仅去相邻重复
    out.push(paras);
  }
  return out;
}

/* ── 步骤 2：识别块 ────────────────────────────────────────────────────
   返回 { name, intent, labelled, eduLines, eduDescs, expLines, expDescs,
          certs, skillTags, hobby, tags } */
function classify(boxes, f) {
  const info = {
    name: null, intent: null, labelled: [], eduLines: [], eduDescs: [],
    expLines: [], expDescs: [], certs: null, skillTags: [], hobby: null, tags: [],
  };
  let prev = '';        // 'edu' | 'exp' —— 最近一个行级块
  let lastTitle = '';   // 最近一个栏目标题（用于兴趣爱好/技能清单）
  for (const paras of boxes) {
    const joined = paras.join('\n');

    // 栏目标题本身：不替换，但记住它给紧随其后的清单框定性
    if (paras.length === 1 && RE_SECTION_TITLE.test(paras[0])) {
      lastTitle = paras[0];
      if (RE_HOBBY_TITLE.test(paras[0])) lastTitle = 'hobby';
      else if (RE_SKILL_TITLE.test(paras[0])) lastTitle = 'skill';
      else lastTitle = '';
      continue;
    }

    // 姓名 / 意向
    if (!info.name && paras.length === 1 && f.name && RE_CN_NAME.test(paras[0])
      && !RE_SECTION_TITLE.test(paras[0]) && paras[0] !== f.name) {
      info.name = paras[0];
      continue;
    }
    const intentPara = paras.find((t) => RE_INTENT.test(t));
    if (intentPara && !info.intent) { info.intent = intentPara; continue; }

    // 基本信息「标签：值」框
    if (paras.some((t) => RE_LABELLED.test(t) || RE_PHONE.test(t) || RE_EMAIL.test(t))) {
      info.labelled.push(paras);
      continue;
    }

    // 教育行 / 经历行
    if (RE_DATE_RANGE.test(joined) && RE_SCHOOL.test(joined)) {
      info.eduLines.push(paras);
      prev = 'edu';
      continue;
    }
    if (RE_DATE_RANGE.test(joined)) {
      info.expLines.push(paras);
      prev = 'exp';
      continue;
    }

    // 证书/荣誉块：整块（多行奖项）
    if (RE_CERT.test(joined) && paras.length >= 2) {
      if (!info.certs) info.certs = paras;
      continue;
    }

    // 兴趣爱好清单（跟在「兴趣爱好」标题后的顿号清单）
    if (lastTitle === 'hobby' && !info.hobby && joined.split('、').length >= 3) {
      info.hobby = paras;
      lastTitle = '';
      continue;
    }

    // 技能标签（PS / AI / OFFICE 这类 2-8 字短标签，一行一个框）
    if (paras.length === 1 && paras[0].length <= 8 && !RE_PHONE.test(joined)
      && !RE_EMAIL.test(joined) && !RE_CN_NAME.test(paras[0])
      && !RE_SECTION_TITLE.test(paras[0]) && /[A-Za-z一-龥+#.]/.test(paras[0])) {
      info.skillTags.push(paras[0]);
      continue;
    }

    // 长描述框：按相邻行级框的语义分配
    const d = longDescBox(paras);
    if (d) {
      if (prev === 'exp') info.expDescs.push(paras);
      else if (prev === 'edu') info.eduDescs.push(paras);
      else info.tags.push(paras);
      continue;
    }
    info.tags.push(paras);
  }
  return info;
}

/* ── 步骤 3：生成替换对 ──────────────────────────────────────────────── */
export function buildFillPairs(boxes, cv) {
  const f = formOf(cv);
  const uniq = dedupeBoxes(boxes);
  const info = classify(uniq, f);

  // find → 该文本在文档中第几次出现（0 起）。同一个 find 只会对应一条规则，
  // nth 不同则视为不同条目（多块分配）。
  const occ = new Map();
  const nthOf = (find) => {
    const n = occ.get(find) || 0;
    occ.set(find, n + 1);
    return n;
  };

  const pairs = [];
  const dropped = [];
  const unmapped = [];
  const stats = {};

  const emit = (find, replace, kind, opt) => {
    if (!find || find.length < 2) return;
    // 联系方式不裁剪：截断的邮箱/手机号是**错值**（用户的要求：不得出现错值）。
    // 宁可让它在模板窄框里折行，也只记一条提示。
    const noTrim = opt && opt.noTrim;
    const { text, dropped: drop } = fitReplace(find, replace, opt);
    if (noTrim && drop.length) {
      dropped.push(kind + '：内容比模板示例长，会折行（未截断）');
    } else if (drop.length) {
      dropped.push(...drop.map((d) => kind + '：' + d));
    }
    if (text === find) return;
    pairs.push({ find, replace: noTrim ? String(replace) : text, kind, nth: nthOf(find) });
  };

  /**
   * 行框整框替换（2026-10-04）：模板的行框常是「1 行有效 + 2 个空段（带项目
   * 符号）」，逐段替换只会把第一段换掉，空段连同 ■ 留在页面上（用户截图里
   * 「教育行下面一个空方块」就是它）。整框替换把多余空段一起收掉。
   */
  const emitRowBox = (paras, replace, kind) => {
    if (!paras.length) return;
    emit(joinFind(paras), replace, kind, { wide: true });
  };

  /**
   * 整框清空：发两条 —— ①整框文本→''（必定命中，文本清干净）；
   * ②整框文本+^p→''（若命中，连尾部空段一起删掉，空项目符号消失）。
   * 顺序无关：谁先命中都成立，miss 的那条无害。
   */
  const emitClearBox = (paras, kind) => {
    if (!paras.length) return;
    const whole = joinFind(paras);
    emit(whole, '', kind);
    emit(whole + '^p', '', kind + '-drop');
  };

  // ① 姓名 / 求职意向（无来源 → 清空并记账，别拿专业名硬凑）
  if (info.name && f.name) emit(info.name, f.name, 'name');
  if (info.intent) {
    if (f.intent) emit(info.intent, '求职意向：' + f.intent, 'intent');
    else { emit(info.intent, '求职意向：', 'intent'); unmapped.push('求职意向'); }
  }

  // ② 基本信息：逐行按标签取值；无对应字段 → 值清空（不残留模板示例）
  for (const paras of info.labelled) {
    for (const t of paras) {
      const pm = t.match(RE_PHONE);
      const em = t.match(RE_EMAIL);
      const lm = t.match(LABEL_RE);
      if (pm && f.phone && !RE_DATE_RANGE.test(t)) {
        emit(pm[0], f.phone, 'phone', { noTrim: true });
        continue;
      }
      if (em && f.email) {
        emit(em[0], f.email, 'email', { noTrim: true });
        continue;
      }
      if (!lm) {
        if (RE_PHONE.test(t) || RE_EMAIL.test(t)) emit(t, '', 'clear-contact');
        continue;
      }
      const label = lm[1];
      let val = '';
      let kind = 'label';
      if (/^(院校|学校)/.test(label)) { val = s(f.edu[0] && f.edu[0].org); kind = 'edu-org'; }
      else if (/^专业/.test(label)) { val = s(f.edu[0] && f.edu[0].title); kind = 'edu-title'; }
      else if (/^(籍贯|地址|现居)/.test(label)) { val = f.location; kind = 'location'; }
      else if (/^学历/.test(label)) { val = f.degree; kind = 'degree'; }
      else if (/^(年龄|出生年月)/.test(label)) { val = f.age; kind = 'age'; }
      else { unmapped.push(label.replace(/\s*[:：]\s*$/, '')); }
      emit(t, val ? label + val : label.replace(/\s+$/, ''), kind, { wide: true });
    }
  }

  // ③ 教育：第 k 块 ← education[k]；多余块清空
  //   只认三种明确形态：日期+学校同段、纯学校行、纯日期行。
  //   曾经有个"框内其余短行当学校行"的兜底分支，结果把「主修：现代汉语、写作」
  //   也改成了学校名（2026-10-04 单测抓到）——宁可漏改，不可错改。
  stats.eduSlots = info.eduLines.length;
  info.eduLines.forEach((paras, k) => {
    const e = f.edu[k];
    if (!e) { emitClearBox(paras, 'edu'); return; }
    // 整框替换：把「有效行 + 空段」一次换掉，不留空项目符号
    const dateRow = paras.find((t) => RE_DATE_RANGE.test(t)) || '';
    const schoolRow = paras.find((t) => RE_SCHOOL.test(t) && !RE_DATE_RANGE.test(t)) || '';
    const sameLine = visualLen(dateRow) > 18;
    if (sameLine) {
      emitRowBox(paras, eduLine(e), 'edu');                 // 日期与学校同段 → 整行
    } else if (schoolRow) {
      // 学校与日期分行：日期格只换日期、学校行换「学校 专业」（两行各归其位）
      emit(dateRow, s(e.year), 'edu');
      emit(schoolRow, [s(e.org), s(e.title)].filter(Boolean).join(' '), 'edu', { wide: true });
      const rest = paras.filter((t) => t !== dateRow && t !== schoolRow).join('^p');
      if (rest.length >= 2) emit(rest, '', 'edu-tail');
    } else if (dateRow) {
      emitRowBox(paras, s(e.year), 'edu');
    } else {
      emitRowBox(paras, eduLine(e), 'edu');
    }
  });
  info.eduDescs.forEach((paras, k) => {
    const e = f.edu[k];
    if (e && s(e.description)) emitRowBox(paras, s(e.description), 'edu-desc');
    else emitClearBox(paras, 'edu-desc');
  });

  // ④ 经历：第 k 块 ← experience[k]；描述块同理；多余块清空
  //   「日期与公司同段」→ 灌整行；「日期与公司分行」→ 日期行只换日期、公司行
  //   换公司+角色。**不能把整行灌进日期行**：模板的日期格只放得下日期，整行
  //   灌进去会撑破文本框（这正是旧实现被容量守护砍掉尾巴、又剩半截的原因）。
  stats.expSlots = info.expLines.length;
  info.expLines.forEach((paras, k) => {
    const e = f.exp[k];
    if (!e) { emitClearBox(paras, 'exp'); return; }
    const dateRow = paras.find((t) => RE_DATE_RANGE.test(t)) || '';
    const sameLine = visualLen(dateRow) > 18;   // 日期格里还夹着公司/角色
    if (sameLine) {
      emitRowBox(paras, expLine(e), 'exp');                 // 同段 → 整行
      return;
    }
    // 分行：日期格只换日期（灌整行会撑破格子），其余短行换「公司 角色」
    if (dateRow) emit(dateRow, s(e.dates), 'exp');
    let used = dateRow;
    for (const t of paras) {
      if (t === dateRow || !t) continue;
      if (t.length <= 24 && !/^[-*·]/.test(t)) {
        emit(t, [s(e.company), s(e.role)].filter(Boolean).join(' '), 'exp-role', { wide: true });
        used = t;
      }
    }
    const tail = paras.filter((t) => t !== used).join('^p');
    if (tail.length >= 2) emit(tail, '', 'exp-tail');
  });
  info.expDescs.forEach((paras, k) => {
    const e = f.exp[k];
    if (e && e.bullets.length) emitRowBox(paras, e.bullets.join('^l'), 'exp-desc');
    else emitClearBox(paras, 'exp-desc');
  });

  // ⑤ 自我评价 / 其他描述框：无上下文 → summary；无 summary → 整框清空
  for (const paras of info.tags) {
    const d = longDescBox(paras);
    if (!d) continue;
    if (f.summary) emitRowBox(paras, f.summary, 'summary');
    else emitClearBox(paras, 'summary');
  }

  // ⑥ 证书/荣誉：整块替换（最多 6 条），无值 → 整块清空
  if (info.certs) {
    const all = f.certs.concat(f.awards).slice(0, 6);
    if (all.length) emitRowBox(info.certs, all.join('^l'), 'cert');
    else emitClearBox(info.certs, 'cert');
  }

  // ⑦ 职业技能标签：PS/AI/OFFICE 这类示例标签 ← 用户的具体技能名。
  //   注意别塞「数据库与缓存」这种类别名 —— 模板标签框只放得下 3-4 个字，
  //   塞长类别名会折行、把版式撑坏（2026-10-04 实测「数据库|与缓存」两行）。
  //   取 items 的第一个技能名（再取首个词），最长 6 字符。
  if (info.skillTags.length) {
    stats.skillTags = info.skillTags.length;
    if (!f.skills.length) {
      // 表单专业技能为空：标签清空（PS/AI/OFFICE 是模板示例，留着是误导），
      // 但要在提示里说清楚，否则用户看到"三条没字样的进度条"会以为渲染坏了。
      stats.skillEmpty = true;
    }
    info.skillTags.forEach((tag, k) => {
      const sk = f.skills[k];
      let label = '';
      if (sk) {
        const first = String(sk.items[0] || sk.category).split(/[,，、;；]/)[0].trim();
        label = first.split(/\s+/)[0] || sk.category;
        if (visualLen(label) > 12) label = label.slice(0, 6);
      }
      emit(tag, label, 'skill-tag', { wide: true, minCap: 14 });
    });
  }

  // ⑧ 兴趣爱好清单 ← 表单「兴趣爱好」；无值 → 整框清空
  if (info.hobby) {
    if (f.hobbies) emitRowBox(info.hobby, f.hobbies.replace(/[、,，]/g, '、'), 'hobby');
    else emitClearBox(info.hobby, 'hobby');
  }

  stats.unmapped = unmapped;
  return {
    pairs: pairs.map((p) => [toWordCodes(p.find), toWordCodes(p.replace), p.nth]),
    kinds: pairs.map((p) => p.kind),
    count: pairs.length,
    dropped,
    stats,
  };
}

/**
 * 单框入口（向后兼容层）：把「一个文本框的段落」丢进 buildFillPairs，返回
 * 旧版的 [{ find, replace, kind }] 形状。2026-10-04 重写前 pairsFromBox 是
 * 主入口，外部探针/单测还在用，不能直接删。
 */
export function pairsFromBox(paras, cv) {
  const built = buildFillPairs([paras], cv);
  return built.pairs.map((p, i) => ({ find: p[0], replace: p[1], kind: built.kinds[i] }));
}

/** 提取 docx（已解压的 document.xml 字符串）里的文本框段落。零依赖。 */export function boxesFromDocumentXml(xml) {
  const boxes = [];
  if (!xml) return boxes;
  // 先整段丢掉 mc:Fallback —— 同一个形状在 docx 里存两份（DrawingML 的
  // mc:Choice + VML 回退的 mc:Fallback），而 Word COM 只会看到 Choice 那份。
  // 不剥的话规则层会以为「有 4 组经历块」而实际只有 2 组：多发 2 对替换、
  // nth 全盘错位（2026-10-04 实测 art01：XML 48 段 → COM 24 个形状）。
  const src = xml.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  const re = /<w:txbxContent>([\s\S]*?)<\/w:txbxContent>/g;
  let m;
  while ((m = re.exec(src))) {
    const paras = [...m[1].matchAll(/<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g)]
      .map((pm) => {
        // w:tab/w:br 是 w:t 之间的独立元素，只抓 w:t 会把它们丢掉 —— 而模板
        // 实际文本里 Tab 随处可见（art01 的「院校：→TAB→美术学院」）。先转
        // 成控制字符再剥标签，等价于「w:t 文本 + tab + 软换行」按序拼接。
        const inner = (pm[1] || '')
          .replace(/<w:tab\s*\/>/g, '\t')
          .replace(/<w:br\s*\/>/g, '\v');
        return inner.replace(/<[^>]+>/g, '');
      })
      .map((t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim())
      .filter(Boolean);
    if (paras.length) boxes.push(paras);
  }
  return boxes;
}

/**
 * 替换对出口统一转换：Word 查找/替换串里的制表符要写成 ^t、软换行写成 ^l
 * （Word 的查找替换特殊代码；真实 \t/\v 传进去匹配不到）。
 */
function toWordCodes(str) {
  return String(str).replace(/\t/g, '^t').replace(/\v/g, '^l');
}

export const __test__ = { fitReplace, visualLen, dedupeBoxes, classify, formOf };
