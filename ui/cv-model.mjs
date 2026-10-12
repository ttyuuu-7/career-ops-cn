// ui/cv-model.mjs
//
// 结构化简历模型：在「表单可编辑的 JSON」和「career-ops 能读的 cv.md」之间双向转换。
//
// 为什么要这一层：
//   career-ops 的评估、PDF 生成、事实校验全部以 cv.md 为唯一数据源。
//   但直接编辑 Markdown 对用户不友好，而 build-cv-html.mjs 需要的是一份
//   固定 schema 的 JSON payload（见 lib/cv-payload-schema.mjs）。
//   所以这里定义一份「结构化简历」作为中转：表单读写它，cv.md 由它生成，
//   PDF payload 也由它生成。三方字段名统一，不会出现「改了表单但 PDF 没变」。
//
// 字段命名严格对齐 lib/cv-payload-schema.mjs 里 html 格式的 known 键，
// 避免出现该文件开头描述的那类静默丢字段问题。

export const EMPTY_CV = () => ({
  candidate: {
    name: '', email: '', phone: '', wechat: '',
    location: '', linkedin: '', github: '', portfolio: '',
    degree: '', age: '', hobbies: '', intent: '',
    // 稳重模板资料栏要的六项（2026-10-09）。见 normalizeCv 里那段说明。
    gender: '', birthday: '', native: '', political: '', height: '', major: '',
    // 头像（2026-10-09）：存的是应用内路径 /api/cv/asset/xxx.png，
    // **不写进 cv.md** —— 见 normalizeCv 里 photo 那一段的说明。
    photo: '',
  },
  summary: '',
  competencies: [],
  experience: [],
  projects: [],
  education: [],
  certifications: [],
  awards: [],
  skills: [],
});

// ── 章节标题的**唯一权威定义**（中文） ──────────────────────────────────────
//
// 用户看的每一处（cv.md 的 `## 标题`、编辑页视觉预览、导出 PDF）都用这一份。
// 之所以要「唯一」，是因为这里曾经有三份各写各的：
//   cv-model.mjs 的 cvToMarkdown()、ui/app.js 的 renderCvPreview()（已于
//   2026-09-26 随「写进 cv.md 的原文预览」折叠区一并删除）、
//   ui/cv-zh-layout.mjs 的 ZH_SECTION_TITLES。
// 前两处写英文、第三处写中文，于是「导出的 PDF 是中文、页面预览和 cv.md 还是英文」
// —— 同一份简历在两处显示不一样，用户根本判断不出哪个算数。
//
// 键名 = key（与 lib/cv-payload-schema.mjs 的 html 规格一致），值 = 中文标题。
// 顺序不在这里定义，章节顺序见 cvToMarkdown() 里的注释。
export const CV_SECTION_TITLES_ZH = {
  summary: '个人简介',
  competencies: '核心能力',
  education: '教育背景',
  experience: '实习与工作经历',
  projects: '项目经历',
  skills: '专业技能',
  certifications: '证书',
  awards: '荣誉奖项',
};

export const emptyExperience = () => ({ company: '', role: '', location: '', dates: '', bullets: [] });
export const emptyProject = () => ({ name: '', badge: '', description: '', tech: '', url: '', bullets: [] });
export const emptyEducation = () => ({ title: '', org: '', location: '', year: '', description: '' });
export const emptyCertification = () => ({ title: '', org: '', year: '' });
export const emptyAward = () => ({ title: '', org: '', year: '' });
export const emptySkill = () => ({ category: '', items: [] });

const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v === null || v === undefined ? '' : String(v));
const list = (v) => arr(v).map(str).filter(Boolean);

// ── 归一化：把任意来源的对象收敛成合法结构 ─────────────────────────────────
export function normalizeCv(input) {
  const base = EMPTY_CV();
  const src = input && typeof input === 'object' ? input : {};
  const c = src.candidate && typeof src.candidate === 'object' ? src.candidate : {};

  base.candidate = {
    name: str(c.name), email: str(c.email), phone: str(c.phone), wechat: str(c.wechat),
    location: str(c.location), linkedin: str(c.linkedin), github: str(c.github),
    portfolio: str(c.portfolio),
    // 学历 / 年龄 / 兴趣爱好（2026-10-04 新增）：设计类模板的「基本信息」框里
    // 有这三格，表单没有对应输入项 → 模板示例值（本科 / 28 周岁 / 8 项爱好）
    // 永远替换不掉。补上字段后它们才会随表单实时变化。
    degree: str(c.degree), age: str(c.age), hobbies: str(c.hobbies),
    intent: str(c.intent),
    // 「稳重」系列模板（2026-10-09 接入 10 套稳重版式）的资料栏要的字段：
    // 性别 / 生日 / 籍贯 / 政治面貌 / 身高 / 专业 —— 它们在原有六项里没有对应键，
    // 不补的话那些位置在预览里永远是空的（等于模板白给了一半）。
    // ⚠️ 同样**必须在这个白名单里**，否则表单填了、保存后回来就没了。
    gender: str(c.gender), birthday: str(c.birthday), native: str(c.native),
    political: str(c.political), height: str(c.height), major: str(c.major),
    // 头像（2026-10-09）。**必须在这个白名单里**：normalizeCv 是全量重建，
    // 不在这里列出来的键会被静默丢掉 —— 表单里填了、保存后回来就没了。
    // 只接受应用内路径或 http(s) 链接：data:/javascript: 这类一律清空，
    // 免得表单被污染后把一段脚本当图片地址渲染出去。
    photo: (() => {
      const p = str(c.photo).trim();
      if (!p) return '';
      if (/^\/api\/cv\/asset\/[a-z0-9]{1,40}\.(png|jpg|jpeg|webp|gif)$/i.test(p)) return p;
      if (/^https?:\/\/[^\s"'<>]{1,500}$/i.test(p)) return p;
      return '';
    })(),
  };
  base.summary = str(src.summary);
  base.competencies = list(src.competencies);

  base.experience = arr(src.experience).map((e) => ({
    company: str(e && e.company), role: str(e && e.role),
    location: str(e && e.location), dates: str(e && e.dates),
    bullets: list(e && e.bullets),
  }));

  base.projects = arr(src.projects).map((p) => ({
    name: str(p && p.name), badge: str(p && p.badge), description: str(p && p.description),
    tech: str(p && p.tech), url: str(p && p.url), bullets: list(p && p.bullets),
  }));

  base.education = arr(src.education).map((e) => ({
    title: str(e && e.title), org: str(e && e.org), location: str(e && e.location),
    year: str(e && e.year), description: str(e && e.description),
  }));

  base.certifications = arr(src.certifications).map((e) => ({
    title: str(e && e.title), org: str(e && e.org), year: str(e && e.year),
  }));

  base.awards = arr(src.awards).map((e) => ({
    title: str(e && e.title), org: str(e && e.org), year: str(e && e.year),
  }));

  base.skills = arr(src.skills).map((s) => ({
    category: str(s && s.category), items: list(s && s.items),
  }));

  return base;
}

// ── 生成 cv.md ────────────────────────────────────────────────────────────

/** 一条记录是不是「各字段全空」——即用户点了「+ 添加」还没开始填的占位。 */
function blankItem(o, keys) {
  return keys.every((k) => !String((o || {})[k] == null ? '' : o[k]).trim());
}

/**
 * 各章节里「不是全空」的条目。
 *
 * 为什么需要它（2026-10-09）：用户点一下「+ 添加荣誉奖项」，表单里就多出一个
 * 各字段全空的条目。实时保存（同日上线的「填写自动落盘」）会立刻把这个中间状态
 * 写进 cv.md —— 于是文件末尾多出 `## 荣誉奖项` + 一个空的 `- `。
 *
 * 后果不只是难看：那份残缺章节回读时解析出 0 条，auditCvMarkdown 判它 broken，
 * 「AI 优化结果写回」接口直接 422 —— 用户什么都没做错却被挡住。
 *
 * ⚠️ **预览与 cv.md 生成必须读同一份**（exports 就是为此）：预览多渲染一个空章节、
 *    或少渲染一个有内容的，就会出现「预览里有的、导出的 Word 里没有」这种
 *    没人会去查的静默不一致 —— 项目里吃过一次同类的亏（章节顺序）。
 *
 * ⚠️ 只影响「渲染与落盘」：表单缓存（cv-form.json）里那个空条目**原样保留** ——
 *    它是用户正在编辑的工作状态，切页回来还得在那儿。
 */
export function cvLiveItems(cv) {
  const d = normalizeCv(cv);
  return {
    competencies: d.competencies.filter((x) => String(x == null ? '' : x).trim()),
    education: d.education.filter((e) => !blankItem(e, ['title', 'org', 'location', 'year', 'description'])),
    experience: d.experience.filter((e) => !blankItem(e, ['role', 'company', 'location', 'dates'])
      || e.bullets.some((b) => String(b || '').trim())),
    projects: d.projects.filter((p) => !blankItem(p, ['name', 'badge', 'description', 'tech', 'url'])
      || p.bullets.some((b) => String(b || '').trim())),
    skills: d.skills.filter((s) => !blankItem(s, ['category'])
      || s.items.some((x) => String(x || '').trim())),
    certifications: d.certifications.filter((e) => !blankItem(e, ['title', 'org', 'year'])),
    awards: d.awards.filter((e) => !blankItem(e, ['title', 'org', 'year'])),
  };
}

export function cvToMarkdown(cv) {
  const d = normalizeCv(cv);
  const out = [];
  const push = (...lines) => out.push(...lines);
  // 章节标题一律走 CV_SECTION_TITLES_ZH —— 不要再往这里写字符串字面量，
  // 否则又会多出一份「和别处不一致的标题表」。
  const T = CV_SECTION_TITLES_ZH;

  push(`# ${d.candidate.name || '（未填写姓名）'}`, '');

  // 只写「不是全空」的条目 —— 见 cvLiveItems 的说明。
  const live = cvLiveItems(d);

  // ⚠️ 头像（candidate.photo）**故意不写进 cv.md**。
  // cv.md 是给人看、给 AI 读的纯文本：塞一条 /api/cv/asset/xxx.png 进去，
  // 离开这台机器就是一句无意义的死链，而塞 base64 会把整份文件毁掉。
  // 它是「版式资产」，和主色、字体同类 —— 存在 cv-form.json 里随表单走，
  // 预览与导出各自去取图。代价：「用 cv.md 覆盖表单」不会带回头像，
  // 这是有意的取舍，不是漏写。

  const contact = [
    d.candidate.email, d.candidate.phone, d.candidate.wechat,
    d.candidate.location, d.candidate.linkedin, d.candidate.github, d.candidate.portfolio,
  ].filter(Boolean);
  if (contact.length) push(contact.join(' · '), '');
  // 学历 / 年龄 / 兴趣爱好：设计类模板「基本信息」框需要的三格（2026-10-04）。
  // 单起一行、写成「标签：值」—— 回读时走 CONTACT_LABELS 的同一套解析。
  const extra = [
    d.candidate.intent ? `求职意向：${d.candidate.intent}` : '',
    d.candidate.degree ? `学历：${d.candidate.degree}` : '',
    d.candidate.age ? `年龄：${d.candidate.age}` : '',
    // 稳重模板资料栏的六项。空着就不出现 —— 老简历的 cv.md 一行都不会多。
    d.candidate.gender ? `性别：${d.candidate.gender}` : '',
    d.candidate.birthday ? `生日：${d.candidate.birthday}` : '',
    d.candidate.native ? `籍贯：${d.candidate.native}` : '',
    d.candidate.political ? `政治面貌：${d.candidate.political}` : '',
    d.candidate.major ? `专业：${d.candidate.major}` : '',
    d.candidate.height ? `身高：${d.candidate.height}` : '',
    d.candidate.hobbies ? `兴趣爱好：${d.candidate.hobbies}` : '',
  ].filter(Boolean);
  if (extra.length) push(extra.join(' · '), '');

  if (d.summary) push(`## ${T.summary}`, '', d.summary, '');

  if (live.competencies.length) {
    push(`## ${T.competencies}`, '');
    live.competencies.forEach((x) => push(`- ${x}`));
    push('');
  }

  // ── 章节顺序：国内应届简历惯例 ──────────────────────────────────────
  // 简介 → 核心能力 → 教育背景 → 实习经历 → 项目经历 → 专业技能 → 证书 → 荣誉。
  //
  // 上游的顺序是 Experience → Projects → Education → Certifications → Awards
  // → Skills（海外社招模板：先看工作履历，学历垫底，技能收尾）。国内 HR 先看
  // 学历和学校，应届生没有履历可排，实习与项目才是正文 —— 学校排到项目后面
  // 只会增加筛选成本。cn-cv-check.mjs 也会单独报这一条。
  //
  // ⚠️ 模板 templates/cv-template.zh-minimal.html 仍是上游顺序，导出 PDF 时由
  // ui/cv-zh-layout.mjs 重排。两边都要管：cv.md 是给 AI 读的数据源，PDF 是给人
  // 看的成品，顺序错位会让「AI 评估的那份」和「HR 看到的那份」不是同一份简历。
  // 改这里时记得同步 ui/cv-zh-layout.mjs 的 ZH_SECTION_ORDER（那是 PDF 的槽位置换表）。
  //
  // ⚠️ 标题已全部中文化（CV_SECTION_TITLES_ZH）。上面 SECTION_ALIASES 里那几个中文
  // 叫法（个人简介 / 核心能力 / 教育背景 / 实习与工作经历 / 项目经历 / 专业技能 /
  // 证书 / 荣誉奖项）因此变成了**回读时必需的**项 —— 少了任何一个，cvToMarkdown
  // 写出去的文件再解析回来就会「有内容却解析出 0 条」，auditCvMarkdown 会报
  // broken。改标题表时先确认别名表里有同名项。

  if (live.education.length) {
    push(`## ${T.education}`, '');
    live.education.forEach((e) => {
      push(`### ${e.title || '（未填写）'}`);
      const meta = [e.org, e.location, e.year].filter(Boolean).join(' · ');
      if (meta) push('', meta);
      if (e.description) push('', e.description);
      push('');
    });
  }

  if (live.experience.length) {
    push(`## ${T.experience}`, '');
    live.experience.forEach((e) => {
      const head = [e.role, e.company].filter(Boolean).join(' — ');
      push(`### ${head || '（未填写）'}`);
      const meta = [e.dates, e.location].filter(Boolean).join(' · ');
      if (meta) push('', `**${meta}**`);
      if (e.bullets.length) {
        push('');
        e.bullets.forEach((b) => push(`- ${b}`));
      }
      push('');
    });
  }

  if (live.projects.length) {
    push(`## ${T.projects}`, '');
    live.projects.forEach((p) => {
      push(`### ${p.name || '（未填写）'}${p.badge ? `  _[${p.badge}]_` : ''}`);
      if (p.description) push('', p.description);
      if (p.tech) push('', `**技术栈：** ${p.tech}`);
      if (p.url) push('', p.url);
      if (p.bullets.length) {
        push('');
        p.bullets.forEach((b) => push(`- ${b}`));
      }
      push('');
    });
  }

  if (live.skills.length) {
    push(`## ${T.skills}`, '');
    live.skills.forEach((s) => {
      const items = s.items.join(', ');
      push(`- ${s.category ? `**${s.category}：** ` : ''}${items}`);
    });
    push('');
  }

  if (live.certifications.length) {
    push(`## ${T.certifications}`, '');
    live.certifications.forEach((e) => {
      const meta = [e.org, e.year].filter(Boolean).join(' · ');
      push(`- ${e.title}${meta ? ` — ${meta}` : ''}`);
    });
    push('');
  }

  if (live.awards.length) {
    push(`## ${T.awards}`, '');
    live.awards.forEach((e) => {
      const meta = [e.org, e.year].filter(Boolean).join(' · ');
      push(`- ${e.title}${meta ? ` — ${meta}` : ''}`);
    });
    push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// ── 从 cv.md 解析（容错） ─────────────────────────────────────────────────
//
// 章节名先「归一化」再查表：去掉空格与全部标点，于是 `## 专业技能`、
// `## 专业技能 `、`## Technical Skills` 都会落到同一个 key。
//
// ⚠️ 别名表必须**穷举常见叫法**，这条教训是 2026-09-18 用真实数据换来的：
// 表里只写了「工作经历」没写「实习经历」、只写了「荣誉」「奖项」没写
// 「荣誉奖项」。AI 改写简历时正好换了这几个词，于是两整节被判为
// 「未识别」直接丢弃 —— 表单里实习经历、荣誉奖项变成空白，用户看到的就是
// 「优化之后把我填的信息全删了」。下面还有一层「剥掉 情况/经历/清单 这类
// 无区分度后缀再查一次」的兜底，就是为了不再靠人肉记忆补别名。
const SECTION_ALIASES = new Map(Object.entries({
  // 简介 / 概览
  summary: 'summary', professionalsummary: 'summary', profile: 'summary', about: 'summary',
  个人简介: 'summary', 简介: 'summary', 个人概述: 'summary', 个人总结: 'summary',
  自我评价: 'summary', 个人优势: 'summary', 自我介绍: 'summary',
  // 核心能力
  corecompetencies: 'competencies', competencies: 'competencies', competency: 'competencies',
  核心能力: 'competencies', 核心技能: 'competencies', 个人能力: 'competencies', 能力清单: 'competencies',
  // 技能
  skills: 'skills', technicalskills: 'skills', 技能: 'skills', 专业技能: 'skills',
  技能特长: 'skills', 技能清单: 'skills',
  // 经历
  experience: 'experience', workexperience: 'experience', employment: 'experience',
  工作经历: 'experience', 实习经历: 'experience', 实习: 'experience', 经历: 'experience',
  工作经验: 'experience', 实习与工作经历: 'experience', 工作与实习经历: 'experience',
  // 项目
  projects: 'projects', projectexperience: 'projects', 项目: 'projects',
  项目经历: 'projects', 项目经验: 'projects',
  // 教育
  education: 'education', 教育: 'education', 教育背景: 'education',
  教育经历: 'education', 学历: 'education', 学历背景: 'education',
  // 证书
  certifications: 'certifications', certification: 'certifications', certificates: 'certifications',
  证书: 'certifications', 资格证书: 'certifications', 证书与资质: 'certifications',
  资质证书: 'certifications', 证书资质: 'certifications', 获得证书: 'certifications', 证书情况: 'certifications',
  // 荣誉
  awards: 'awards', honors: 'awards', honours: 'awards', achievements: 'awards',
  荣誉: 'awards', 奖项: 'awards', 荣誉奖项: 'awards', 奖项与荣誉: 'awards',
  荣誉与奖项: 'awards', 获奖: 'awards', 获奖情况: 'awards', 获奖经历: 'awards',
  奖励: 'awards', 荣誉奖励: 'awards',
  // 经历（补充：Word 简历模板里常见的叫法，2026-09-30 模板栏目对照用）
  校园经历: 'experience', 社会实践: 'experience', 实践经历: 'experience',
  工作实习经历: 'experience', 实习与实践: 'experience',
}));

/** 归一化章节标题：抹掉空格与所有标点，只留字母数字与汉字。 */
function normSectionKey(title) {
  return stripMd(String(title)).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** 兜底：剥掉「情况 / 经历 / 清单」这类无区分度后缀再查一次别名表。 */
const SECTION_SUFFIXES = ['情况', '经历', '清单', '一览', '概述', '介绍', '信息', '部分', '列表'];

/**
 * 标题 → 章节 key（summary/education/…），认不出返回 null。
 * 2026-09-30 起导出：简历页「按模板栏目填写」对照卡用同一份别名表把
 * Word 模板的栏目名映射到编辑区章节 —— 「库里有的叫法」两边必须一致。
 */
export function sectionKeyOf(title) {
  const k = normSectionKey(title);
  if (SECTION_ALIASES.has(k)) return SECTION_ALIASES.get(k);
  for (const suf of SECTION_SUFFIXES) {
    if (k.length > suf.length && k.endsWith(suf)) {
      const base = k.slice(0, -suf.length);
      if (SECTION_ALIASES.has(base)) return SECTION_ALIASES.get(base);
    }
  }
  return null;
}

function stripMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .trim();
}

/**
 * 容错解析 cv.md。目标是「经 cvToMarkdown 产出的文件能无损往返」，
 * 同时对用户手写的常见变体保持宽容——解析不出的内容不会丢，会留在
 * 未识别块里以原样回写。
 */
export function markdownToCv(markdown) {
  const cv = EMPTY_CV();
  if (!markdown || typeof markdown !== 'string') return cv;

  const lines = markdown.split(/\r?\n/);

  // 1. 标题行 → 姓名
  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 >= 0) cv.candidate.name = stripMd(lines[h1].replace(/^#\s+/, ''));

  // 2. 标题下方到第一个 ## 之间 → 联系方式
  //
  // 要同时吃下两种写法：`电话 · 邮箱 · 城市` 这种裸值，和
  // `GitHub：xxx` / `邮箱：xxx` 这种带标签的键值。
  //
  // 踩过的坑（2026-09-18）：旧版把「不认识的项」一律兜底成城市，于是
  // candidate.location 变成了 `GitHub：【待补充：GitHub/Gitee 链接（如有）】`。
  // 现在的原则是**不认识就不认**：宁可留空，也不往任何字段里塞看不懂的东西。
  const CONTACT_LABELS = [
    [/^(github|gitee|码云|仓库|git)/i, 'github'],
    [/^(linkedin|领英)/i, 'linkedin'],
    [/^(个人网站|博客|主页|网站|作品集|portfolio|website|blog)/i, 'portfolio'],
    [/^(微信|wechat|weixin)/i, 'wechat'],
    [/^(邮箱|电子邮箱|email|e-mail|mail)/i, 'email'],
    [/^(电话|手机|联系电话|tel|phone|mobile)/i, 'phone'],
    [/^(城市|所在城市|所在地|现居|现居地|地址|location|city)/i, 'location'],
    [/^(学历|学位|最高学历)/i, 'degree'],
    [/^(年龄|出生年月|出生日期|岁数)/i, 'age'],
    // 「稳重」模板资料栏的六项（2026-10-09）。
    // ⚠️ 「专业」用负向断言排除「专业技能」—— 那是一级章节标题，走的是
    //    SECTION_ALIASES；真让它落到 candidate.major，页面上「专业技能」那一栏
    //    的内容会突然变成简历抬头里的一行字。
    [/^(性别)/i, 'gender'],
    [/^(生日)/i, 'birthday'],
    [/^(籍贯|籍\s*贯)/i, 'native'],
    [/^(政治面貌|政治\s*面貌)/i, 'political'],
    [/^(身高)/i, 'height'],
    [/^(专业(?!技能)|所学专业|毕业专业)/i, 'major'],
    [/^(兴趣爱好|兴趣|爱好|特长)/i, 'hobbies'],
    [/^(求职意向|意向岗位|目标岗位|应聘岗位|应聘职位|期望职位|target)/i, 'intent'],
  ];
  // 这些标签后面跟的是「简历内容」而不是联系方式字段，整行跳过
  const SKIP_LINE = /^\*{0,2}(届次|毕业时间)\*{0,2}[:：]/;
  const isPlaceholder = (v) => /待补充|待填写|待定|TBD|xx+/i.test(String(v || ''));

  if (h1 >= 0) {
    let consumed = 0;
    for (let i = h1 + 1; i < lines.length && consumed < 4; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      if (raw.startsWith('#')) break; // 进入正文，联系方式区结束
      consumed++;
      // `联系方式：` 只是个小标题，剥掉它继续解析同一行
      const l = raw.replace(/^\*{0,2}(联系方式|contact)\*{0,2}[:：]\s*/i, '');
      if (SKIP_LINE.test(l)) continue;
      const parts = l.split(/\s*[·|]\s*|\s{2,}/).map((s) => s.trim()).filter(Boolean);
      parts.forEach((p) => {
        // 键值写法
        const kv = p.match(/^\*{0,2}([^:：]{1,14}?)\*{0,2}[:：]\s*(.*)$/);
        if (kv) {
          const label = stripMd(kv[1]).trim();
          const value = stripMd(kv[2]).trim();
          for (const [re, field] of CONTACT_LABELS) {
            if (!re.test(label)) continue;
            // 占位符不落库：宁可字段为空，也不要让「【待补充：…】」变成城市名
            if (value && !isPlaceholder(value)) cv.candidate[field] ||= value;
            return;
          }
          return; // 不认识的标签一律忽略，绝不兜底成 location
        }
        if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) cv.candidate.email ||= p;
        else if (/^\+?[\d\s\-()]{7,}$/.test(p)) cv.candidate.phone ||= p;
        else if (/linkedin\.com/i.test(p)) cv.candidate.linkedin ||= p;
        else if (/github\.com|gitee\.com/i.test(p)) cv.candidate.github ||= p;
        else if (/^https?:\/\//i.test(p)) cv.candidate.portfolio ||= p;
        else if (/微信|wechat/i.test(p)) cv.candidate.wechat ||= stripMd(p).replace(/^微信[:：]?\s*/i, '');
        else if (isPlaceholder(p)) { /* 占位符，跳过 */ }
        // 纯 ASCII 短串（gy76543 这类账号名）当 GitHub 账号存。
        // 旧版会把它当成「城市」，location 里躺着个账号名。
        else if (/^[A-Za-z][A-Za-z0-9._-]{2,}$/.test(p)) cv.candidate.github ||= p;
        // 2–8 个汉字且不含数字 → 才认作城市
        else if (/^[\u4e00-\u9fa5]{2,8}$/.test(p)) cv.candidate.location ||= p;
        // 其余一律不认，避免污染字段
      });
    }
  }

  // 3. 按 ## 切 section
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      current = { key: sectionKeyOf(m[1]), title: stripMd(m[1]), body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }

  const text = (body) => body.join('\n').trim();
  const bullets = (body) => body.map((l) => l.match(/^\s*[-*]\s+(.*)$/)).filter(Boolean).map((m) => stripMd(m[1]));
  const h3blocks = (body) => {
    const blocks = [];
    let cur = null;
    for (const line of body) {
      const m = line.match(/^###\s+(.+?)\s*$/);
      if (m) { cur = { title: stripMd(m[1]), rest: [] }; blocks.push(cur); continue; }
      if (cur) cur.rest.push(line);
    }
    return blocks;
  };

  // 一行是不是「只有起止时间」。判定方式：含 4 位年份，且把数字抹掉后
  // 剩下的实义字符不超过 4 个（`2024.09 – 2028.06（2028 届）` → 只剩「届」）。
  const isPeriodLine = (t) => /(19|20)\d{2}/.test(t)
    && t.replace(/\d/g, '').replace(/[^\p{L}\p{N}]/gu, '').length <= 4;

  // `主修课程：xxx` / `GPA：xxx` 这类「标签很短」的行是上一段的补充说明，
  // 不能当成新条目的开始。
  const isLabelledDetail = (t) => {
    const m = t.match(/^\*{0,2}([\p{L}\p{N}]{1,5})\*{0,2}[:：]\s*\S/u);
    return !!m && !/大学|学院|学校|公司|科技|集团/.test(m[1]);
  };

  // 没有 ### 小标题时的降级分块：以「顶格、非列表、非小标题」的行作为条目
  // 起点，起止时间行与标签行的归属跟着上一段。
  //
  // 为什么需要它：AI 改写简历时常写成
  //     **河北民族师范学院** · 本科 · 人工智能专业 · 承德
  //     2024.09 – 2028.06（2028 届）
  // 完全没有 ### —— 只认 h3blocks 的话整节解析成 0 条，表单里「教育背景」
  // 整块消失。这是 2026-09-18 那次「优化后信息全没了」的另一半原因。
  const looseBlocks = (body) => {
    const blocks = [];
    for (const raw of body) {
      const t = stripMd(raw).trim();
      if (!t) continue;
      // 只认 `### `（与 cvToMarkdown 的输出一致）。更深的标题（`#### 某某大学`）
      // 故意不支持，留给 auditCvMarkdown 报「解析不出条目」，让调用方拒绝写盘——
      // 反正解析不出来的那节在表单里是空的，写下去就是静默删除。
      if (/^#{1,6}\s/.test(raw.trim())) continue;
      const bullet = raw.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        // 整节没有小标题、只有列表项（AI 写项目经历时会这样）：
        // 让第一项当条目标题、后面的挂在它下面。结构不算漂亮，
        // 但**一个字都不会丢**——宁可排版怪，也不要静默少内容。
        if (blocks.length) blocks[blocks.length - 1].rest.push(raw);
        else if (stripMd(bullet[1]).trim()) blocks.push({ title: stripMd(bullet[1]), rest: [] });
        continue;
      }
      if (blocks.length && (isPeriodLine(t) || isLabelledDetail(t))) {
        blocks[blocks.length - 1].rest.push(raw);
        continue;
      }
      blocks.push({ title: t, rest: [] });
    }
    return blocks;
  };

  /** 优先按 ### 分块，没有小标题就降级。各节共用，行为一致。 */
  const sectionBlocks = (body) => {
    const b = h3blocks(body);
    return b.length ? b : looseBlocks(body);
  };

  // 期间**整段**（2026-10-04）：先整段抠出再切分。踩过的坑：按空格切分会把
  // 「2023.09 - 2027.06」切成 3 段，年份只剩 2023.09、连接符被当成城市。
  const RE_PERIOD_FULL = /(?:19|20)\d{2}(?:\s*[.\-/年]\s*\d{1,2}(?:\s*[.\-/月]\s*\d{1,2})?)?\s*[—–\-~至]\s*(?:19|20)\d{2}(?:\s*[.\-/年]\s*\d{1,2}(?:\s*[.\-/月]\s*\d{1,2})?)?|至今|present/gi;
  const RE_PERIOD_ONE = /^(?:19|20)\d{2}(?:\s*[.\-/年]\s*\d{1,2})?$/;
  const RE_COMPANY_HINT = /公司|集团|科技|网络|信息|有限|责任|股份|银行|保险|证券|研究院|研究所|实验室|工作室|事业部/;
  const RE_AWARD_HINT = /奖|赛|奖学金|称号|优秀|三好|杯|challenge|award/i;
  const RE_COURSE_HINT = /GPA|绩点|主修|课程|成绩|排名|专业前/i;
  const normLine = (x) => stripMd(x).replace(/\s+/g, ' ').trim();
  /** 抠出期间整段，并从文本里移除（返回 [剩余文本, 期间]）。 */
  const takePeriod = (t) => {
    const m = t.match(RE_PERIOD_FULL);
    if (!m) return [t, ''];
    return [t.replace(RE_PERIOD_FULL, ' '), m[0].trim()];
  };

  const isSchool = (s) => /大学|学院|学校|中学|高中|职业技术|研究院|研究所|school|universit|college|institute/i.test(s);
  const isDegree = (s) => /本科|专科|硕士|博士|研究生|学士|学历|学位|专业|major|bachelor|master|phd|diploma/i.test(s);
  const isPeriod = (s) => /^(19|20)\d{2}/.test(s) || /至今|present|current/i.test(s);

  const splitHead = (title) => {
    const parts = title.split(/\s+[—–-]\s+/).map((s) => s.trim());
    return parts.length >= 2 ? parts : [title, ''];
  };

  for (const s of sections) {
    switch (s.key) {
      case 'summary':
        cv.summary = stripMd(text(s.body)).replace(/\n{2,}/g, '\n\n');
        break;

      case 'competencies':
      case 'skills': {
        if (s.key === 'competencies') { cv.competencies = bullets(s.body); break; }
        cv.skills = bullets(s.body).map((b) => {
          const m = b.match(/^([^:：]+)[:：]\s*(.+)$/);
          return m
            ? { category: stripMd(m[1]), items: m[2].split(/[,，、]/).map((x) => x.trim()).filter(Boolean) }
            : { category: '', items: b.split(/[,，、]/).map((x) => x.trim()).filter(Boolean) };
        });
        break;
      }

      case 'experience': {
        // 2026-10-04 重写（第二轮）。坏数据实测：把「2025.09」当公司、把城市
        // 当角色、把同一段经历拆成 5 个 ### 块、把项目描述当新经历。
        // 口径：**按内容归类**；期间整段抠出；重复角色块并入上一条；
        // 长句不是经历，归 bullets；城市与单个年份不入任何字段。
        const rows = [];
        // 职位词表：用来判断「A — B」里谁是职位、谁是公司。
        // 真实公司名（腾讯/网易/字节）**不含"公司"字样**，所以不能只靠
        // 公司关键词判公司（2026-10-04 回归：check-cv-optimize 的
        // 「数据分析实习生 — 腾讯　杭州」会丢掉公司名）。
        const RE_ROLE = /实习|工程师|经理|专员|助理|开发|设计师|运营|分析师|测试|运维|产品|策划|编辑|教师|护士|律师|顾问|BD|HR|财务/;
        for (const b of sectionBlocks(s.body)) {
          const titleRaw = normLine(b.title);
          // 结构化分支要用**保留全角空格**的标题：normLine 会把「腾讯　杭州」
          // 的全角空格压成半角，城市就拆不出来了（check-cv-optimize 断言）。
          const rawTitle = stripMd(b.title).replace(/[ \t]{2,}/g, ' ').trim();
          const rest = b.rest.map(normLine).filter((l) => l && l !== titleRaw);
          const joined = (titleRaw + ' ' + rest.join(' ')).trim();
          if (!joined) continue;
          const [residue0, per] = takePeriod(joined);
          // 结构化优先：`职位 — 公司　城市`（也接受 `公司 — 职位`）
          const [ha, hc] = splitHead(rawTitle);
          if (ha && hc && (RE_ROLE.test(ha) || RE_ROLE.test(hc))) {
            const [comp, city] = hc.split(/\s{2,}|[\u3000]/);
            const aIsRole = RE_ROLE.test(ha);
            const company = (aIsRole ? comp : ha).trim();
            const role = (aIsRole ? ha : comp).trim();
            const [res2, per2] = takePeriod(residue0);
            rows.push({
              company, role,
              dates: per2 || per,
              location: (city || '').trim(),
              bullets: bullets(b.rest),
            });
            continue;
          }
          // 长块（整句描述）不按空格切碎——切了就会把「…12 篇，被团队沿用…」
          // 里的碎片当公司/角色。判定：没有公司特征、没有期间、且首行够长。
          const segSource = (!per && !RE_COMPANY_HINT.test(residue0) && titleRaw.length > 24)
            ? titleRaw
            : residue0;
          const segs = segSource
            .split(/\s*[·|]\s*|\s*[—–]\s*|\s{2,}|\s+/)
            .map((x) => x.trim()).filter(Boolean);
          let company = '', role = '', loc = '';
          const loose = [];
          for (const seg of segs) {
            if (!loc && seg === cv.candidate.location && seg.length <= 8) { loc = seg; continue; }
            if (!company && RE_COMPANY_HINT.test(seg) && seg.length <= 24) { company = seg; continue; }
            if (RE_PERIOD_ONE.test(seg)) continue;          // 单个年份：日期碎片
            if (!role && seg.length <= 20) { role = seg; continue; }
            loose.push(seg);
          }
          const longText = loose.join(' ').trim();
          const bl = bullets(b.rest);
          const isReal = !!(company || per || (role && !longText));
          if (!isReal) {
            // 不是经历：长句并入上一条的要点；城市碎片直接丢
            if (rows.length && longText) rows[rows.length - 1].bullets.push(longText);
            continue;
          }
          // 与上一条角色重复（同一段经历被拆成多个 ### 块）→ 并入上一条
          const last = rows[rows.length - 1];
          if (last && !company && !per && role) {
            // 只有角色没公司没期间 → 它是上一条的职位，补进上一条而不是新开一条
            if (!last.role) last.role = role;
            else last.bullets = last.bullets.concat(longText ? [longText] : []).concat(bl);
            continue;
          }
          if (last && !company && role && last.role === role) {
            last.bullets = last.bullets.concat(longText ? [longText] : []).concat(bl);
            if (!last.dates && per) last.dates = per;
            continue;
          }
          rows.push({
            company, role, dates: per, location: loc,
            bullets: bl.length ? bl : (longText ? [longText] : []),
          });
        }
        if (rows.length) cv.experience = rows;
        break;
      }

      case 'projects':
        cv.projects = sectionBlocks(s.body).map((b) => {
          const bm = b.title.match(/^(.*?)\s*_?\[(.+?)\]_?\s*$/);
          const rest = b.rest;
          const techLine = rest.find((l) => /^\s*\*\*技术栈[:：]\*\*/.test(l));
          const urlLine = rest.find((l) => /^\s*https?:\/\//.test(l));
          const descLines = rest
            .filter((l) => /^\s*[^-\s#*]/.test(l) && !/^\s*https?:\/\//.test(l) && l !== techLine)
            .map((l) => stripMd(l)).filter(Boolean);
          return {
            name: bm ? bm[1].trim() : b.title,
            badge: bm ? bm[2].trim() : '',
            description: descLines.join(' ').trim(),
            tech: techLine ? stripMd(techLine.replace(/^\s*\*\*技术栈[:：]\*\*\s*/, '')) : '',
            url: urlLine ? urlLine.trim() : '',
            bullets: bullets(rest),
          };
        });
        break;

      case 'education': {
        // 判定顺序是关键（2026-10-04 两轮修正）：
        //   ① 标题行像**奖项**（含"奖/赛/杯"且不是光学校名）→ 归荣誉；
        //   ② 标题行或正文里有**学校词 / 期间** → 当教育条目正常拆
        //      （裸排版「河北民族师范学院 · 本科 · 承德」必须走这里，
        //        否则会被下面的课程分流整块丢掉 —— check-cv-optimize A2 回归）；
        //   ③ 否则含 GPA/主修/课程 → 并入第一条教育的描述；
        //   ④ 其余（城市碎片、英文栏目标题）→ 丢弃。
        const items = [];
        const extraDesc = [];
        const awardsFromEdu = [];
        for (const b of sectionBlocks(s.body)) {
          const titleRaw = normLine(b.title);
          const rest = b.rest.map(normLine).filter((l) => l && l !== titleRaw);
          const joined = (titleRaw + ' ' + rest.join(' ')).trim();
          if (!joined) continue;
          // ⓪ 英文栏目标题（"Awards & Honors"）先排掉：它含 award 关键词，
          //    否则会被下面的奖项判定收进荣誉栏（用户荣誉列表里出现英文栏目标题）
          if (/^[A-Za-z][A-Za-z &.]*$/.test(titleRaw)) continue;
          // ① 奖项
          if (RE_AWARD_HINT.test(titleRaw)
              && (RE_AWARD_HINT.test(titleRaw.replace(/大学|学院|学校/g, '')) || !isSchool(titleRaw))) {
            awardsFromEdu.push({
              title: titleRaw, org: '',
              year: ((titleRaw + ' ' + rest.join(' ')).match(/(?:19|20)\d{2}/) || [])[0] || '',
            });
            continue;
          }
          // ② 学校 / 期间线索
          const [residueAll, per] = takePeriod(joined);
          const hasSchool = isSchool(residueAll);
          const hasPeriod = !!per || rest.some((l) => isPeriod(l));
          if (!hasSchool && !hasPeriod) {
            if (titleRaw === cv.candidate.location) continue;       // 城市碎片
            if (RE_COURSE_HINT.test(joined)) { extraDesc.push(joined); continue; }
            continue;
          }
          if (titleRaw === cv.candidate.location && !per) continue;
          // 拆段：期间已抠出，剩下的按「像什么」分
          const segs = residueAll.split(/\s*[·|]\s*|\s+/).map((x) => x.trim()).filter(Boolean);
          // 学位/专业段先单独收拢：「本科」和「人工智能专业」都是专业描述，
          // 顺序判定会先把「人工智能专业」抢去当城市，承德就丢了（check-cv-optimize A2）。
          const degs = segs.filter((x) => isDegree(x) && x.length <= 20);
          let t = '', org = '', loc = '';
          for (const seg of segs) {
            if (!org && isSchool(seg) && seg.length <= 20) { org = seg; continue; }
            if (degs.indexOf(seg) >= 0) continue;
            if (!loc && seg.length <= 12 && !/\d/.test(seg)) { loc = seg; continue; }
            if (!t) { t = seg; continue; }
          }
          if (!t && degs.length) t = degs.join(' ');
          if (degs.length && t && degs.indexOf(t) < 0) t = degs.join(' ') + ' ' + t;
          if (!org && !t) continue;
          const used = [org, t, loc, per].filter(Boolean);
          const desc = rest.filter((l) => !used.includes(l) && l.length > 1).join(' ').trim();
          items.push({ title: t, org, location: loc, year: per, description: desc });
        }
        if (extraDesc.length && items.length) {
          const merged = extraDesc.join(' ').trim();
          items[0].description = items[0].description
            ? items[0].description + ' ' + merged : merged;
        }
        if (items.length) cv.education = items;
        if (awardsFromEdu.length) cv.awards = cv.awards.concat(awardsFromEdu);
        break;
      }

      case 'certifications':
      case 'awards': {
        const rows = bullets(s.body)
          .map((b) => {
            // 分隔符可能是「 — 」，也可能是「）— 」（前面不是空格）。
            // 只认第一种的话，`省三好学生（省级）— 河北省教育厅 · 2025`
            // 整串都会被当成标题，颁发单位与年份就丢了。
            let parts = b.split(/\s+[—–-]\s+/);
            if (parts.length < 2) parts = b.split(/\s*[—–]\s*/);
            const [title, meta] = parts;
            const [org, year] = (meta || '').split(/\s*[·|]\s*/);
            return { title: (title || '').trim(), org: (org || '').trim(), year: (year || '').trim() };
          })
          // 空条目（只有一个「-」的占位行）不要留下来：留着重写回 cv.md
          // 就是一个空的 `- `，还会让「荣誉/证书」看起来有条目其实没内容。
          .filter((r) => r.title);
        if (s.key === 'certifications') cv.certifications = rows; else cv.awards = rows;
        break;
      }

      default:
        // 未识别的 section（例如用户自己加的）不解析——文本已由 cvToMarkdown
        // 之外的手工编辑保留在文件里，不会被覆盖，因为保存时以其为准。
        break;
    }
  }

  return normalizeCv(cv);
}

/**
 * 结构体检：把 cv.md 里出现的章节标题逐个对回解析结果。
 *
 * 存在的意义是把「静默丢内容」变成显式错误。cvToMarkdown 是**全量重建**：
 * 表单里某节是空的，写回去的 cv.md 里那一节就消失了。而「表单为空」的
 * 常见原因不是用户清空了它，而是解析器读不懂某种写法。
 *
 * 于是约定：凡出现「章节里有内容，却一条都没解析出来」，一律当异常报出来
 * ——要么是这个标题没收录进别名表（unknown），要么是这种排版没被识别
 * （broken）。调用方据此拒绝写盘，而不是让用户第二天发现简历少了一半。
 */
export function auditCvMarkdown(markdown) {
  const md = String(markdown || '');
  const raw = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      cur = { title: stripMd(m[1]), key: sectionKeyOf(m[1]), lines: [] };
      raw.push(cur);
      continue;
    }
    if (cur) cur.lines.push(line);
  }

  const parsed = markdownToCv(md);
  const countOf = (key) => {
    switch (key) {
      case 'summary': return parsed.summary.trim() ? 1 : 0;
      case 'competencies': return parsed.competencies.length;
      case 'skills': return parsed.skills.length;
      case 'experience': return parsed.experience.length;
      case 'projects': return parsed.projects.length;
      case 'education': return parsed.education.length;
      case 'certifications': return parsed.certifications.length;
      case 'awards': return parsed.awards.length;
      default: return null;
    }
  };

  const sections = raw.map((s) => {
    // 只有空列表项（`## Certifications` 下面孤零零一个 `- `）不算有内容，
    // 否则这个纯粹的占位残留会被误报成「解析失败」。
    const hasContent = s.lines.some((l) => l.trim() && !/^\s*[-*+]\s*$/.test(l));
    const count = s.key ? countOf(s.key) : null;
    return {
      title: s.title,
      key: s.key,
      count,
      // 有内容却解析出 0 条：解析器不认识这种写法或这个章节名
      broken: hasContent && s.key !== null && count === 0,
      // 章节名完全没收录：保存时同样会被整个丢掉
      unknown: hasContent && s.key === null,
    };
  });

  return {
    sections,
    broken: sections.filter((s) => s.broken).map((s) => s.title),
    unknown: sections.filter((s) => s.unknown).map((s) => s.title),
  };
}

// ── 生成 build-cv-html.mjs 需要的 payload ─────────────────────────────────
// 字段名严格对齐 lib/cv-payload-schema.mjs 的 html 规格。
export function cvToPayload(cv, opts = {}) {
  const d = normalizeCv(cv);
  const c = d.candidate;

  const payload = {
    lang: opts.lang || 'zh-CN',
    page_format: opts.page_format || 'a4',
    candidate: {
      name: c.name, email: c.email, phone: c.phone,
      location: c.location, linkedin: c.linkedin, github: c.github,
    },
  };
  if (opts.title) payload.candidate.title = opts.title;

  if (d.summary) payload.summary = d.summary;
  if (d.competencies.length) payload.competencies = d.competencies;

  payload.experience = d.experience
    .filter((e) => e.company || e.role)
    .map((e) => {
      const o = { company: e.company, role: e.role };
      if (e.location) o.location = e.location;
      if (e.dates) o.dates = e.dates;
      if (e.bullets.length) o.bullets = e.bullets;
      return o;
    });

  payload.projects = d.projects
    .filter((p) => p.name)
    .map((p) => {
      const o = { name: p.name };
      if (p.badge) o.badge = p.badge;
      if (p.description) o.description = p.description;
      if (p.tech) o.tech = p.tech;
      if (p.url) o.url = p.url;
      if (p.bullets.length) o.bullets = p.bullets;
      return o;
    });

  payload.education = d.education
    .filter((e) => e.title)
    .map((e) => {
      const o = { title: e.title };
      if (e.org) o.org = e.org;
      if (e.location) o.location = e.location;
      if (e.year) o.year = e.year;
      if (e.description) o.description = e.description;
      return o;
    });

  const certs = d.certifications.filter((e) => e.title).map((e) => {
    const o = { title: e.title };
    if (e.org) o.org = e.org;
    if (e.year) o.year = e.year;
    return o;
  });
  if (certs.length) payload.certifications = certs;

  const awards = d.awards.filter((e) => e.title).map((e) => {
    const o = { title: e.title };
    if (e.org) o.org = e.org;
    if (e.year) o.year = e.year;
    return o;
  });
  if (awards.length) payload.awards = awards;

  const skills = d.skills.filter((s) => s.items.length).map((s) => {
    const o = { items: s.items };
    if (s.category) o.category = s.category;
    return o;
  });
  if (skills.length) payload.skills = skills;

  return payload;
}

/** 简历完整度自检——返回 % 和缺失项，用于界面提示。 */
export function cvCompleteness(cv) {
  const d = normalizeCv(cv);
  const missing = [];
  const check = (ok, label) => { if (!ok) missing.push(label); };

  check(!!d.candidate.name, '姓名');
  check(!!d.candidate.email, '邮箱');
  check(!!d.summary, '个人简介');
  check(d.experience.length > 0, '实习与工作经历');
  check(d.experience.some((e) => e.bullets.length > 0), '经历中的成果要点');
  check(d.projects.length > 0, '项目经历');
  check(d.education.length > 0, '教育背景');
  check(d.skills.length > 0, '专业技能');

  const total = 8;
  return { percent: Math.round(((total - missing.length) / total) * 100), missing };
}
