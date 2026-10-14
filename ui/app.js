// ui/app.js — 历琢 本地控制台前端
//
// 安全说明：报告、JD 正文、公司名都来自外部（招聘网站），属于不可信内容。
// 所有渲染路径一律「先转义、再套格式」。Markdown 渲染器只在转义后的纯文本上
// 做替换，不会执行任何来自数据的 HTML 或脚本。

// ══ 基础工具 ══════════════════════════════════════════════
// 批量初筛的切块/归一化/排序是纯函数，单独放在 batch-jd.mjs：
// 批量是**前端编排**（循环调用 /api/eval），这些逻辑全在浏览器里，
// 抽出来才能被 ui/check-batch-jd.mjs 直接断言（纯函数、无需浏览器）。
import {
  splitBatchJds, rowFromTriage, sortBatchRows, batchRowsToMarkdown,
  verdictZh, BATCH_MAX,
} from './batch-jd.mjs';
// 跟进提醒的展示常量（状态族 → 中文、紧急度中文、通道中文）。
// **必须从 followup-format.mjs 取，不能从 followup-cn.mjs 取** —— 后者要做
// 节奏计算，import 了根目录的 followup-cadence.mjs，而那一份依赖 js-yaml /
// node:fs；浏览器解析不了，整个 app.js 模块图会加载失败、页面全白。
// followup-format.mjs 是零依赖的，专门给浏览器用。
// 同时：写盘用的是英文规范值、显示用中文，两份映射共用同一份定义，
// 免得「页面上选的『领英』存进去变成别的通道」。
import {
  URGENCY_ZH, URGENCY_TONE, FAMILY_LABEL, CHANNELS, CHANNEL_ZH,
} from './followup-format.mjs';
// 文档导入：把 .docx / .xlsx / .csv / .txt 变成批量初筛能吃的多岗位文本。
// 同样必须是零依赖模块（解压走浏览器内置的 DecompressionStream），
// 且**在本机解析、不上传** —— 文件内容不离开用户的电脑。详见 ui/doc-import.mjs。
import {
  IMPORT_ACCEPT, parseDocument, mergeImports, kindLabel,
} from './doc-import.mjs';
// 简历的 Word 导入/导出：.docx 解析进表单、保存后下载 .doc。
// 同为零依赖模块（复用 doc-import 的 zip 解压与 cv-model 的 markdown 解析）。
import {
  WORD_ACCEPT, WORD_MAX_BYTES, docxToCvForm, markdownToCv,
} from './cv-word.mjs';
// 简历模板库：内置三套版式、id→渲染参数的解析、样例简历。零依赖模块，
// 与服务端共用同一份定义 —— 「库里有的」必须就是「预览渲染得出的」。
import {
  BUILTIN_CV_TEMPLATES, resolveCvTplStyle, CV_TPL_BASES, CV_TPL_SAMPLE_FORM,
  DUAL_TPL_BASE,
} from './cv-templates.mjs';
// 「哪些条目该出现在简历上」的口径单点（2026-10-09）。预览与 Word 导出都读它 ——
// 用户点「+ 添加荣誉奖项」留下的全空条目不该渲染成一个空章节。
import { cvLiveItems } from './cv-model.mjs';
// 简历分区导航（2026-10-09，交互范式参照 github.com/ThanosKa/magic-resume 的
// section-tabs：可拖拽排序 + 眼睛显隐）。同一份章节表既驱动编辑区左侧的导航，
// 也驱动预览（renderCvVisual）与 Word 导出（cvFormToWordHtml）的顺序 ——
// 三处读同一份，才不会出现「预览里有、导出的 Word 里没有」。
import {
  CV_NAV_SECTIONS, CV_NAV_BASIC, defaultCvNav, normalizeCvNav,
  cvNavLabel, isCvSectionHidden, moveCvSection, toggleCvSection,
} from './cv-nav.mjs';
// 简历外观设置（2026-10-09，参照 magicv.art 魔方简历的设置卡）：
// 主题色 / 字体 / 字号 / 行高 / 间距 / 模式。与模板分开 —— 模板管版式结构，
// 外观管样式数值，换模板不该把调好的字号冲掉。三处共读一份（左栏 / 预览 / 导出）。
import {
  CV_LOOK_DEFAULTS, CV_LOOK_ACCENTS, CV_LOOK_FONTS,
  normalizeCvLook, cvLookRootAttrs, cvLookFontLabel,
} from './cv-look.mjs';
// 基本信息字段行的顺序与显隐（2026-10-09，参照 magicv.art 编辑区的「基础字段」：
// 一行一个字段 = 拖拽手柄 + 图标 + 字段名 + 输入框 + 眼睛）。
// 与 cv-nav.mjs 同一套语义：隐藏只影响预览与导出，值始终留在 cv.md。
// 三处共读一份 —— 编辑区的字段行、预览页眉、Word 导出。
import {
  CV_FIELD_PHOTO, defaultCvFields, normalizeCvFields,
  cvBasicField, isCvFieldHidden, moveCvField, toggleCvField,
  cvHeaderValues, cvHeaderRole, cvHeaderPhoto,
} from './cv-fields.mjs';
// 双栏黄·图文模板（base 4）：结构与三档单栏完全不同，独立模块 + 独立渲染器。
// 2026-10-09 接入，来源见该文件头部注释。
import {
  DUAL_TPL, DUAL_TPL_FIELDS, DUAL_TPL_CSS, renderDualCv, dualTplGroups,
} from './cv-tpl-dual.mjs';
// 「稳重」系列 10 套模板（2026-10-09）。它们是**原始 HTML 资产** + 运行时解析
// （见 ui/cv-tpl-wz.mjs 的文件头）。渲染器是同步的，所以模板源要先取回来再填 ——
// 这里负责「取 + 缓存」。
import {
  WZ_PREFIX, wzTpl, renderWzCv, wzHasContent, wzTemplateFields,
} from './cv-tpl-wz.mjs';

/** 双栏模板的「有没有内容」判定：全空时显示占位，而不是渲染一张白纸。
 *  判定口径与 renderDualCv 实际用到的字段一致 —— 少判一个会出现「有内容却
 *  显示占位」，多判一个会出现「空简历却画出一堆空模块」。 */
function dualCvHasContent(f) {
  if (!f) return false;
  const c = f.candidate || {};
  if (c.name || c.phone || c.email || c.location) return true;
  if (f.targetRole || f.summary || f.summaryExtra) return true;
  if ((f.interests || []).length || (f.competencies || []).length) return true;
  for (const k of ['experience', 'education', 'skills', 'certifications', 'awards']) {
    if ((f[k] || []).length) return true;
  }
  return false;
}
// 模板文件解析器（.pdf/.doc/.docx/.图片 → 统一模板结构）：本机解析不上传，
// 确认导入时提交的是结构化数据。零依赖（unzip 走浏览器 DecompressionStream）。
// 图片分支：downscaleTplImage 在浏览器侧压图，OCR 由本机服务 /api/tpl/ocr 做。
import {
  TPL_FILE_ACCEPT, TPL_FILE_MAX_BYTES, TPL_IMAGE_EXTS, TPL_KIND_ZH, TPL_ROW_KINDS,
  readTplFile, tplFilePreflight, parseTplFile, tplRowsToStructure, tplStructureFingerprint,
  classifyTplItem, downscaleTplImage,
} from './tpl-file-parse.mjs';
// docx 保真渲染：模板带原文件时，库卡缩略直接渲染原 docx
//（Shadow DOM 隔离 + 按模板缓存；window.docx 由 index.html 顺序加载的 vendor 提供）。
import { renderDocxTemplate, isDocxRendererReady } from './tpl-docx-view.mjs';
// 面试备考建议：展示常量、解析结果的字段名、导出 Markdown 的组装规则。
// 同样是零依赖模块 —— 页面只负责「把算好的东西画出来」，怎么算是 Node 侧
// （/api/prep/generate）调这里的纯函数做的，两边共用同一份定义。
// 这样「优先级是 P0/P1/P2」「掌握程度只有三档」这类约定不会两边各写一遍。
import {
  SECTION_TITLES, PRIORITY_ZH, PRIORITY_TONE, MASTERY_ZH, MASTERY_LEVELS,
  RESOURCE_KIND_ZH, MISSING_REASONS, countParts,
} from './prep-model.mjs';
// 自动投递：安全口径与展示常量（默认上限、平台上限、状态中文、过滤原因中文）。
// 零依赖模块，页面与服务端共用 —— 界面上写的「单次最多 20 个」「今天还剩 130」
// 必须和服务端真正执行的那个数是同一个，不能各写一份。
// 真正开浏览器的部分在 auto-apply-run.mjs（Node 侧），页面只发请求。
import {
  PLATFORM, PLATFORM_DAILY_CAP, SAFE_DEFAULTS, ITEM_STATE, STATE_ZH,
  FILTER_REASON_ZH, summarizePlan,
} from './auto-apply.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeHref(url) {
  const u = String(url || '').trim();
  return /^(https?:|mailto:)/i.test(u) ? esc(u) : '#';
}

const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

// ══ 图标（内联 SVG，统一 24 视框、描边风格）═══════════════════
// 图标一律 aria-hidden：相邻必有可见文字标签，避免读屏重复播报。
const ICON = {
  overview: '<path d="M3 12h4l2.5-6 5 12L17 12h4"/>',
  pipeline: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  tracker: '<path d="M4 5h16v14H4z"/><path d="M4 10h16M9.5 10v9"/>',
  // 备考建议：书 + 一支笔（「学什么 / 做什么」的意象），不用学位帽 ——
  // 那顶帽子在 24px 下会和「全部脚本」的工具图标糊在一起。
  prep: '<path d="M4 5.5A2 2 0 0 1 6 4h5v15H6a2 2 0 0 0-2 1.5z"/><path d="M20 5.5A2 2 0 0 0 18 4h-7v15h5a2 2 0 0 1 2 1.5z"/><path d="M17 8l-3 3"/><circle cx="17.5" cy="7.5" r="1.4"/>',
  reports: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 13h6M9 17h4"/>',
  cv: '<path d="M12 12.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5z"/><path d="M5 20.5a7 7 0 0 1 14 0"/>',
  profile: '<path d="M4 7h9M19 7h1M4 17h5M15 17h5"/><circle cx="16" cy="7" r="2"/><circle cx="12" cy="17" r="2"/>',
  tools: '<path d="M14.5 6.5a3.5 3.5 0 0 1 4.8 4.8L10 20.6 4 21l.4-6z"/><path d="M12.5 8.5l3 3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.5 2.3c-.7.35-1.1.85-1.1 1.6v.2"/><path d="M12 17h.01"/>',
  box: '<path d="M3 7.2 12 3l9 4.2-9 4.2z"/><path d="M3 7.2v9.6L12 21l9-4.2V7.2"/><path d="M12 11.4V21"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8.2 12.4l2.6 2.6L16 9.6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.8h.01"/>',
  warn: '<path d="M12 4.2 21 20H3z"/><path d="M12 10v4.2"/><path d="M12 16.8h.01"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4.5V11h-6.5"/>',
  search: '<circle cx="11" cy="11" r="6.6"/><path d="M20 20l-4.2-4.2"/>',
  // 自动投递：纸飞机（「发出去」）。和 prep 的书、tools 的扳手区分得开。
  apply: '<path d="M21 3 3 10.5l7 2.8L13 21z"/><path d="M10 13.3 21 3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h13"/><path d="M13 6.5l5.5 5.5-5.5 5.5"/>',
  // 系统设置下拉里的「退出登录」：电源符号（竖线 + 开口圆弧），和问号 help 区分得开
  power: '<path d="M12 3v8"/><path d="M6.2 6.8a8 8 0 1 0 11.6 0"/>',
  // 账号安全中心：盾牌 + 对勾
  shield: '<path d="M12 3l7 2.8v5.4c0 4.6-3 7.9-7 9.8-4-1.9-7-5.2-7-9.8V5.8z"/><path d="M9.2 12.2l2.1 2.1 3.6-3.9"/>',
};

function icon(name, extra = '') {
  const body = ICON[name] || '';
  return '<svg class="' + extra + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

// ══ 请求层 ═══════════════════════════════════════════════════
// timeout: 毫秒；传 0 表示不超时（用于 PDF 生成、脚本执行这类长任务）
async function api(path, opts = {}) {
  const { timeout = 90000, ...rest } = opts;
  const ctrl = timeout > 0 ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
  let res;
  try {
    res = await fetch(path, {
      headers: {
        'Content-Type': 'application/json',
        // 会话令牌：管理端接口与反馈提交都靠它认人（服务端从 x-lizhuo-token 取）。
        // 未登录时 S.session 为空，这个头就不带 —— 老接口一律匿名可用。
        ...(S.session && S.session.token ? { 'x-lizhuo-token': S.session.token } : {}),
      },
      ...rest,
      signal: ctrl ? ctrl.signal : undefined,
      body: rest.body ? JSON.stringify(rest.body) : undefined,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('请求超时（' + Math.round(timeout / 1000) + ' 秒没有响应）。任务可能仍在后台执行，稍后刷新看看。');
    }
    throw new Error('连不上本地服务。请确认启动控制台的窗口还开着，然后刷新页面。');
  } finally {
    if (timer) clearTimeout(timer);
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应（例如 404 页面） */ }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.hint)) || ('请求失败（HTTP ' + res.status + '）'));
    err.status = res.status;
    // 把结构化附加信息（如「这次会删掉哪些章节」的 dropped 清单）一并带出来，
    // 只靠一句 error 文案的话，调用方没法把清单摆给用户看。
    err.data = data;
    throw err;
  }
  return data;
}

// ══ 轻提示 ═══════════════════════════════════════════════════
const TOAST_ICON = { ok: 'check', bad: 'alert', warn: 'warn', info: 'info' };

function toast(msg, kind = 'info', opts = {}) {
  const host = $('#toast');
  if (!host) return null;
  const k = kind || 'info';
  const el = document.createElement('div');
  el.className = 'toast ' + k;
  el.innerHTML = '<span class="toast-ico">' + icon(TOAST_ICON[k] || 'info') + '</span>'
    + '<span class="toast-msg">' + esc(msg).replace(/\n/g, '<br>') + '</span>'
    + '<button class="toast-close" type="button" aria-label="关闭提示">\u00D7</button>';

  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 180);
  };
  $('.toast-close', el).addEventListener('click', remove);
  host.appendChild(el);

  // 同时最多 4 条，超出先移除最旧的
  while (host.children.length > 4) host.removeChild(host.firstChild);

  const ttl = opts.duration === 0 ? 0
    : (opts.duration || (k === 'bad' ? 8000 : k === 'warn' ? 5500 : 3200));
  if (ttl) setTimeout(remove, ttl);
  return el;
}

// ══ 骨架屏 ═══════════════════════════════════════════════════
const skLines = (n = 3) => {
  const w = ['w-90', 'w-70', 'w-50', 'w-30'];
  let s = '';
  for (let i = 0; i < n; i++) s += '<div class="skeleton sk-line ' + w[i % w.length] + '"></div>';
  return s;
};

const skCards = (n = 3) => Array.from({ length: n }, () => '<div class="skeleton sk-card" style="margin-bottom:12px"></div>').join('');

const skTable = (rows = 6, cols = 5) => '<div class="card" style="padding:0;overflow:hidden">'
  + '<div class="skeleton sk-row" style="background:var(--bg-2)"></div>'
  + Array.from({ length: rows }, () => '<div style="display:flex;gap:12px;padding:9px 12px;border-bottom:1px solid var(--line)">'
    + Array.from({ length: cols }, (_, i) => '<div class="skeleton sk-line" style="margin:0;height:12px;flex:'
      + (i === 0 ? '0 0 40px' : '1 1 auto') + '"></div>').join('') + '</div>').join('')
  + '</div>';

// 按视图给不同骨架，让等待形态和真实内容接近（减少跳动感）
function viewSkeleton(id) {
  switch (id) {
    case 'home': return '<div class="skeleton sk-title" style="width:46%;margin:44px auto 16px"></div>'
      + '<div class="skeleton sk-line" style="width:62%;margin:0 auto 10px"></div>'
      + '<div class="skeleton sk-line" style="width:54%;margin:0 auto 32px"></div>'
      + '<div class="skeleton sk-card" style="height:220px;max-width:760px;margin:0 auto"></div>';
    case 'evaluate': return '<div class="skeleton sk-title"></div>'
      + '<div class="skeleton sk-card" style="height:220px"></div>';
    case 'prep':     return '<div class="skeleton sk-title"></div>'
      + '<div class="skeleton sk-card" style="height:120px"></div>' + skLines(8);
    case 'reports':  return skCards(3);
    case 'autoapply': return '<div class="skeleton sk-title"></div>'
      + '<div class="skeleton sk-card" style="height:150px"></div>' + skLines(6);
    case 'cv':       return '<div class="skeleton sk-title"></div>' + skCards(3);
    case 'cvopt':    return '<div class="skeleton sk-title"></div>'
      + '<div class="grid2"><div class="skeleton sk-card" style="height:420px"></div>'
      + '<div class="skeleton sk-card" style="height:420px"></div></div>';
    case 'templates': return '<div class="skeleton sk-title"></div>' + skCards(3);
    case 'profile':  return '<div class="skeleton sk-title"></div>' + skCards(3);
    case 'tools':    return '<div class="tools-grid">'
      + Array.from({ length: 6 }, () => '<div class="skeleton sk-card"></div>').join('') + '</div>';
    default:         return '<div class="skeleton sk-title"></div>' + skLines(8);
  }
}

// ══ 状态块 ═══════════════════════════════════════════════════
// 空状态：图标 + 标题 + 说明 + 可选主操作
function emptyState({ ico = 'box', title = '', desc = '', actions = [] } = {}) {
  return '<div class="empty">'
    + '<span class="empty-ico" aria-hidden="true">' + icon(ico) + '</span>'
    + (title ? '<b>' + esc(title) + '</b>' : '')
    + (desc ? '<p>' + esc(desc) + '</p>' : '')
    + (actions.length
      ? '<div class="empty-actions">' + actions.map((a, i) =>
          '<button class="btn' + (a.primary ? ' primary' : '') + '" type="button" data-act="' + i + '">'
          + esc(a.label) + '</button>').join('') + '</div>'
      : '')
    + '</div>';
}

// 绑定 emptyState 生成的操作按钮
function wireActions(root, actions = []) {
  $$('[data-act]', root).forEach((b) => {
    const a = actions[Number(b.dataset.act)];
    if (a && typeof a.onClick === 'function') b.addEventListener('click', a.onClick);
  });
}

// 错误状态：复用空状态外观，附带重试入口
function errorState(err, retry) {
  const msg = (err && err.message) || String(err || '未知错误');
  return '<div class="card">'
    + emptyState({
        ico: 'alert',
        title: '读取失败',
        desc: msg,
        actions: retry ? [{ label: '重试', primary: true, onClick: retry }] : [],
      })
    + '</div>';
}

// ══ 按钮忙碌态 ═══════════════════════════════════════════════
// 保留原宽度（记住原始 innerHTML），避免点击后布局跳动
function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    if (!('idleHtml' in btn.dataset)) btn.dataset.idleHtml = btn.innerHTML;
    btn.classList.add('is-busy');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="spinner' + (btn.classList.contains('primary') ? ' on-accent' : '')
      + '" aria-hidden="true"></span><span class="btn-label">' + esc(label || '处理中…') + '</span>';
  } else {
    btn.classList.remove('is-busy');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if ('idleHtml' in btn.dataset) {
      btn.innerHTML = btn.dataset.idleHtml;
      delete btn.dataset.idleHtml;
    }
  }
}

// ══ 表单校验反馈 ═════════════════════════════════════════════
// 就地显示错误（而不是只弹一个转瞬即逝的提示），并关联 aria-describedby
function setFieldError(input, msg) {
  if (!input) return;
  const field = input.closest('label.field') || input.parentElement;
  let box = field ? field.querySelector('.field-error') : null;

  if (!msg) {
    input.classList.remove('is-invalid');
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    if (box) box.remove();
    return;
  }

  input.classList.add('is-invalid');
  input.setAttribute('aria-invalid', 'true');
  if (!input.dataset.errId) input.dataset.errId = 'ferr-' + Math.random().toString(36).slice(2, 8);

  if (!box && field) {
    box = document.createElement('div');
    box.className = 'field-error';
    box.id = input.dataset.errId;
    box.innerHTML = icon('alert') + '<span></span>';
    field.appendChild(box);
  }
  if (box) {
    const span = box.querySelector('span');
    if (span) span.textContent = msg;
  }
  input.setAttribute('aria-describedby', input.dataset.errId);
}

// ══ 响应式抽屉与外壳交互 ═════════════════════════════════════
const drawerMQ = window.matchMedia('(max-width: 1023px)');
const isDrawerMode = () => drawerMQ.matches;

function setDrawer(open) {
  document.body.classList.toggle('drawer-open', !!open);
  const btn = $('#navToggle');
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
  }
  if (!isDrawerMode()) return;
  if (open) {
    const first = $('#nav .nav-item');
    if (first) first.focus();
  } else if (btn) {
    btn.focus();
  }
}

const drawerOpen = () => document.body.classList.contains('drawer-open');

function initShell() {
  const btn = $('#navToggle');
  if (btn) btn.addEventListener('click', () => setDrawer(!drawerOpen()));

  // 品牌块点击回首页（index.html 里 .sidebar-brand 是 <button id="brandHome">）
  const brand = $('#brandHome');
  if (brand) brand.addEventListener('click', () => go('home'));

  const mask = $('#drawerMask');
  if (mask) mask.addEventListener('click', () => setDrawer(false));

  // 视口变宽后抽屉失去意义，自动收起
  const onChange = () => { if (!isDrawerMode() && drawerOpen()) setDrawer(false); };
  if (drawerMQ.addEventListener) drawerMQ.addEventListener('change', onChange);
  else if (drawerMQ.addListener) drawerMQ.addListener(onChange);

  // 导航下拉是浮层，必须能关掉：点栏目之外收起、Esc 收起。
  // 这两个监听**只在启动时挂一次**（不是每次 renderNav 都挂），否则会累积。
  // Esc 只在"确实有栏开着"时才吞掉这次按键 —— 否则会抢掉弹层那套 Esc 逻辑。
  document.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('#nav .nav-col')) return;
    closeNavCols();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (closeNavCols()) e.stopPropagation();
  }, true);
}

// ══ 弹层：Esc 关闭 + 焦点圈定 + 焦点归还 ═════════════════════
function wireModal(mask, onClose) {
  const prevFocus = document.activeElement;
  const focusables = () => $$(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    mask
  ).filter((el) => el.offsetParent !== null);

  const close = () => {
    if (!mask.isConnected) return;
    mask.remove();
    if (prevFocus && prevFocus.isConnected) prevFocus.focus();
    if (typeof onClose === 'function') onClose();
  };

  mask.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // 打开时把焦点送进弹层（优先第一个表单控件）
  const list = focusables();
  if (list.length) list[0].focus();

  return close;
}

// ══ 确认对话框 ═══════════════════════════════════════════════
// 替代原生 confirm：样式统一、支持 Esc、焦点默认落在「取消」上
function confirmDialog({
  title = '确认操作', desc = '',
  confirmLabel = '确定', cancelLabel = '取消', danger = false,
} = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    mask.setAttribute('aria-label', title);
    mask.innerHTML = '<div class="modal" style="max-width:460px">'
      + '<div class="modal-head"><h3>' + esc(title) + '</h3></div>'
      + (desc ? '<p class="hint">' + esc(desc) + '</p>' : '')
      + '<div class="foot"><button class="btn" type="button" id="cfNo">' + esc(cancelLabel) + '</button>'
      + '<button class="btn ' + (danger ? 'danger' : 'primary') + '" type="button" id="cfYes">'
      + esc(confirmLabel) + '</button></div></div>';
    document.body.appendChild(mask);

    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const close = wireModal(mask, () => finish(false));
    $('#cfNo', mask).addEventListener('click', () => { finish(false); close(); });
    $('#cfYes', mask).addEventListener('click', () => { finish(true); close(); });
    mask.addEventListener('click', (e) => { if (e.target === mask) { finish(false); close(); } });
  });
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === undefined || cur[k] === null) cur[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

const linesToArr = (s) => String(s ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
const arrToLines = (a) => (Array.isArray(a) ? a.join('\n') : '');

// ══ Markdown 渲染 ═════════════════════════════════════════
function mdInline(t) {
  let s = esc(t);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, txt, href) => '<a href="' + safeHref(href) + '" target="_blank" rel="noreferrer noopener">' + txt + '</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return s;
}

function mdToHtml(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|[\s:\-|]+\|\s*$/.test(l) && l.indexOf('-') >= 0;

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1][0];
      const buf = [];
      i++;
      const closeRe = new RegExp('^\\s*' + marker + '{3,}');
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }

    if (!line.trim()) { i++; continue; }

    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push('<hr>'); i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const n = h[1].length; out.push('<h' + n + '>' + mdInline(h[2]) + '</h' + n + '>'); i++; continue; }

    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push('<table><thead><tr>' + head.map((c) => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.push('<blockquote>' + mdInline(buf.join(' ')) + '</blockquote>');
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        items.push('<li>' + mdInline(m[1]) + '</li>');
        i++;
      }
      out.push('<ul>' + items.join('') + '</ul>');
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
        if (!m) break;
        items.push('<li>' + mdInline(m[1]) + '</li>');
        i++;
      }
      out.push('<ol>' + items.join('') + '</ol>');
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s|\s*>|\s*`{3,}|\s*~{3,})/.test(lines[i])
      && !isRow(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push('<p>' + mdInline(para.join(' ')) + '</p>');
  }

  return out.join('\n');
}

// ══ 全局状态 ══════════════════════════════════════════════
const S = {
  status: null,
  stats: null,
  // 登录态（{ token, role, username, name } | null）。初值从 localStorage 恢复，
  // 有效性由启动后的 /api/auth/me 校验（服务端重启会清内存会话表）。
  session: (() => {
    try { return JSON.parse(localStorage.getItem('lizhuo.session') || 'null'); } catch { return null; }
  })(),
  // 备考会话：和 evalSession 同理必须跨渲染保留 ——
  // 生成一次要等 AI 跑完，切页回来要是空的，用户会以为白等了一场。
  prep: null,
  // 跟进提醒：投递记录 + 跟进记录的合成结果（服务端算好的，前端不再复算）。
  // 和 evalSession 同理跨渲染保留 —— 切页回来要是空的，卡片会闪一下「读取中」。
  followups: null,
  reports: null,
  cv: null,
  // 简历表单的工作副本。**必须跨渲染保留**，否则页面一重画就丢改动。
  // cvDraft = 当前正在编辑的表单，cvDirty = 有没有未保存的改动。
  // cvSaving = 自动保存正在飞；cvSaveBlocked = 服务端的「整节消失」守卫拦下了
  // 这次保存，等用户确认（见 cvAutoSaveNow）。
  cvDraft: null,
  cvDirty: false,
  cvSaving: false,
  cvSaveBlocked: false,
  // 评估会话：与 cvDraft 同理，必须跨渲染保留。
  // 见「评估会话」一节——切页会把整个视图重建，状态不放这里就会丢。
  evalSession: null,
  // 简历版本列表的服务端缓存。磁盘上的 data/cv-versions/ 才是事实来源，
  // 这份只是拿来渲染的；每次增删改都重新拉，不做本地增量维护。
  cvVersions: null,
  // AI 引擎状态（当前选择 + 两条路各自的可用性 + 本地模型的地址与模型名）。
  // 和 evalSession 同理必须跨渲染保留：切页回来要是空的，按钮会闪回「检测中」，
  // 用户会以为自己刚才那次切换没生效。
  aiEngine: null,
  // 「评估页 AI优化弹窗 → 简历页」的交接包：AI 改写稿 + 问题清单 + JD。
  // 弹窗里点「应用到简历」后放这里，跳到简历页开面板用掉再清空 ——
  // 页面之间不通过 DOM 传数据。
  pendingCvOptDraft: null,
  // 版本卡的「AI 优化」在「简历工具」页点下时，优化面板在「我的简历」页 ——
  // 放一个待处理标记，简历页渲染完成后展开面板并滚过去。
  pendingCvOptOpen: false,
  // 「AI 润色本段」的状态（简历编辑器）。会话级：等待期间切页回来结果还在。
  cvPolish: null,
  // 最近一次点进去的表单字段（focusin 记录）——「本段」指的就是它。
  cvPolishLast: null,
  // 预览模板：现在是模板库里的一个 id（内置 '1'/'2'/'3' 或自定义 'tpl_xxx'），
  // 会话级记忆；权威值在服务端 cv-templates.json 的 selected，进简历页时同步。
  cvTpl: '1',
  // 模板库的自定义模板缓存（/api/cv/templates 拉回后填充）。renderCvVisual
  // 解析自定义 id 时要用；null = 还没拉过，解析自动回落内置，不会崩。
  cvTplItems: null,
  // 分区导航（2026-10-09，参照 magic-resume）：章节顺序 + 显隐。
  // null = 还没从 /api/cv/nav 拉过；权威值在服务端 data/cv-nav.json。
  cvNav: null,
  // 外观设置（同上：服务端 data/cv-look.json 是权威值，这里只是缓存）。
  cvLook: null,
  // 基本信息字段行的顺序 + 显隐（2026-10-09，参照 magicv.art 的「基础字段」）。
  // 权威值同样在服务端 data/cv-fields.json，这里只是缓存。
  cvFields: null,
  // 「稳重」模板的原始 HTML（按模板 id 缓存）。renderWzCv 是**同步**的，
  // 而模板源要 fetch —— 所以先取回来缓存，再进那个同步渲染器。
  cvWzSrc: {},
  // 撤销 / 重做栈（2026-10-09）。存的是 S.cvDraft 的 JSON 快照 ——
  // 只覆盖「表单内容」（含头像路径），不覆盖外观设置：调字号不该把写了一半的
  // 经历一起撤销回去，两者是两件事。
  cvUndo: [],
  cvRedo: [],
  // 预览面板是否收起（参照 magicv.art 的「收起预览面板」）
  cvSideHidden: false,
  // 当前正在编辑哪个分区。**纯 UI 状态、不落盘** —— 重开页面回到「基本信息」
  // 是最自然的起点，把「上次停在证书页」也记下来只会让人莫名其妙。
  cvNavActive: CV_NAV_BASIC,
  profile: null,
  portals: null,
  scripts: null,
  states: [],
  log: null,
};

// ══ 登录态（用户端 / 管理端）══════════════════════════════
// 前端唯一的会话持久层是 localStorage；门禁统一收口在 route()：
// 除落地页（纯门面）与登录页本身，其余视图一律先登录，管理后台还要求
// 管理员角色。token 的真伪由服务端 /api/auth/me 说了算。
const SESSION_KEY = 'lizhuo.session';
const PUBLIC_VIEWS = ['home', 'login'];

// 自动化旁路：check-*.mjs / gen-shots.mjs 用 Playwright 直连各功能页且不带
// 会话，登录门禁会把它们全部重定向到登录页（成片假红）。Playwright 启动的
// 浏览器 navigator.webdriver 恒为 true，用它识别自动化环境；?autotest=1 是
// 手动兜底。门禁本身由探针脚本验证 —— 那边用 ignoreDefaultArgs 去掉
// --enable-automation，让 navigator.webdriver 变回 false，走真实用户路径。
const AUTOTEST = (typeof navigator !== 'undefined' && navigator.webdriver === true)
  || (typeof location !== 'undefined' && location.search.indexOf('autotest=1') >= 0);

function saveSession(s) {
  S.session = s || null;
  try {
    if (S.session) localStorage.setItem(SESSION_KEY, JSON.stringify(S.session));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* localStorage 不可用时只保留内存态 */ }
}

function sessionShapeOk(s) {
  return !!(s && s.token && (s.role === 'admin' || s.role === 'user'));
}
S.session = sessionShapeOk(S.session) ? S.session : null;

// 顶栏右侧的会话条：未登录给「登录」入口（登录页自己不再放一个）。
// 已登录的**身份胶囊外观不变**（用户 2026-09-27 明确要求），但点击它弹出
// 「系统设置」下拉 —— 收编原一级导航「系统」栏的全部去处：求职配置 /
// 全部脚本 / 账号安全中心 / 使用帮助；「退出」保持独立按钮。
// 独立于 #topActions —— 各视图会重写 topActions，谁也不冲掉谁。
const CHIP_MENU_ITEMS = [
  { id: 'profile', label: '求职配置', icon: 'profile' },
  { id: 'tools', label: '全部脚本', icon: 'tools' },
  { id: 'security', label: '账号安全中心', icon: 'profile' },
  // 「使用帮助」按约定永远是菜单的最后一项
  { id: 'help', label: '使用帮助', icon: 'help' },
];
function paintSessionChip() {
  const el = $('#sessionChip');
  if (!el) return;
  const s = S.session;
  if (!s) {
    const cur = location.hash.slice(1) || 'home';
    // 醒目登录入口（用户要求放顶栏最右、一眼可见）：不用 .btn sm（太小），
    // 用专门的 .chip-login —— 渐变底白字胶囊，见 style.css §05 顶栏段。
    el.innerHTML = cur === 'login' ? ''
      : '<button class="chip-login" type="button" data-chip="login">登录</button>';
  } else {
    el.innerHTML = '<button class="chip-user" type="button" data-chip="menu"'
      + ' aria-haspopup="true" aria-expanded="false"'
      + ' title="' + (s.role === 'admin' ? '管理员' : '用户端') + ' · 点开系统设置">'
      + '<span class="chip-dot" aria-hidden="true"></span>' + esc(s.name || s.username || '已登录')
      + (s.role === 'admin' ? ' · 管理员' : '')
      + '</button>'
      + '<button class="btn sm ghost" type="button" data-chip="logout">退出</button>'
      + '<div class="chip-menu" role="menu" aria-label="系统设置">'
      + '<div class="chip-menu-title">系统设置</div>'
      + CHIP_MENU_ITEMS.map((n) => '<button class="chip-item" type="button" role="menuitem"'
        + ' data-go="' + n.id + '" title="' + esc(n.label) + '">'
        + '<span class="ico" aria-hidden="true">' + icon(n.icon) + '</span>'
        + '<span class="label">' + esc(n.label) + '</span></button>').join('')
      + '</div>';
  }
  const closeMenu = () => {
    el.classList.remove('is-open');
    const t = el.querySelector('[data-chip="menu"]');
    if (t) t.setAttribute('aria-expanded', 'false');
  };
  $$('[data-chip], .chip-item', el).forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (b.dataset.go) {                    // 菜单里的功能项 → 跳页并收起
      closeMenu();
      go(b.dataset.go);
      if (isDrawerMode() && drawerOpen()) setDrawer(false);
      return;
    }
    if (b.dataset.chip === 'login') { go('login'); return; }
    if (b.dataset.chip === 'logout') { closeMenu(); doLogout(); return; }
    // 身份胶囊本身：开/收「系统设置」菜单
    const open = !el.classList.contains('is-open');
    closeNavCols();
    el.classList.toggle('is-open', open);
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
  }));
  // 点胶囊以外的地方收起菜单（document 级只挂一次，见下面的守卫）
  if (!window.__chipOutsideBound) {
    window.__chipOutsideBound = true;
    document.addEventListener('click', (ev) => {
      const el2 = $('#sessionChip');
      if (el2 && el2.classList.contains('is-open') && !el2.contains(ev.target)) {
        el2.classList.remove('is-open');
        const t = el2.querySelector('[data-chip="menu"]');
        if (t) t.setAttribute('aria-expanded', 'false');
      }
    });
  }
}

async function doLogout() {
  const token = S.session && S.session.token;
  saveSession(null);
  paintSessionChip();
  try { await api('/api/auth/logout', { method: 'POST', body: { token } }); } catch { /* 本地会话已清；服务端那份等 TTL 自己过期 */ }
  toast('已退出登录');
  go('home');
}

// 导航结构：按「任务阶段」分组，而不是平铺 10 个入口。
// 顺序对应真实使用顺序：先看总览 → **先把自己的简历做出来** → 再评估岗位
// → 最后看分析结果与系统工具。
//
// 「我的简历」必须排在「评估岗位」前面：评估是拿着你的简历去比对一个岗位，
// 简历没填完整时分数一定偏低（AI 不认识你，只能按模板/空缺打分）。
// 把顺序摆正，比在评估页写一段警告更能拦住「先乱投一气」。
//
// 导航结构（2026-09-26 第五版）：**一级只有 4 个栏目**
//   做简历 / 评岗位 / 分析 / 系统
// （「总览」页已按需求整页移除 —— 落地看 #home，进来直接干活。）
// 栏目里的功能项收进下拉面板 —— 一级目标数恒定，不会随着功能变多把顶部横栏
// 撑爆；「系统」里的琐碎入口（配置 / 脚本 / 帮助）也不再各占一个座位。
// 栏目顺序 = 求职的实际顺序（先写简历，再去评岗位），不按字母排。
//
// 展开是**纯 CSS**（:hover / :focus-within / .is-open）；JS 只渲染结构、
// 点开时同步 aria-expanded，不引入新的交互状态机，也不碰抽屉那套逻辑。
// 单项栏目（分析）不出下拉，点标题直接走。
//
// 改栏数/项数要同步 ui/check-ui.mjs 的断言（cols === 4 / navCount === 8，
// 「help 必须是最后一项」），以及 ui/gen-shots.mjs 那份「顺序即编号」的清单。
// 导航结构（2026-09-28 第八版）：**一级 5 个座位，同一行排开**
//   产品能力 / 简历编辑 / 岗位评估 / 自动投递 / 进阶规划
// 「自动投递」是单项栏（head 直接跳转，不出下拉，同「产品能力」）；
// 「系统」栏已整体撤出导航，收进右上角身份胶囊的「系统设置」菜单（点头像弹出）。
// 改栏数/项数要同步 ui/check-ui.mjs 的断言（cols === 5 / navCount === 7）、
// ui/check-cn-states.mjs 的 navCount，以及 ui/gen-shots.mjs 那份「顺序即编号」的清单。
// 2026-10-10 整体换肤（对齐「简历工坊」原型 index.html）：导航从左侧分组栏
// 改成顶栏水平文字导航，5 项一一对应原型。**只换入口，不删功能** ——
// 简历编辑（cv）、简历工具、模板库、全局优化（cvopt）、岗位评估（evaluate）、
// 报告详情（reports）、自动投递（autoapply）、进阶规划（prep）等视图全部保留，
// 从新页面的按钮与直链进入（比如工作台的「AI 定向优化」→ cvopt）。
const NAV_GROUPS = [
  { title: '工作台', icon: 'overview', items: [{ id: 'home', label: '工作台', icon: 'overview' }] },
  { title: '我的简历', icon: 'cv', items: [{ id: 'resumes', label: '我的简历', icon: 'cv' }] },
  { title: '目标岗位', icon: 'reports', items: [{ id: 'jobs', label: '目标岗位', icon: 'reports' }] },
  { title: '提升计划', icon: 'prep', items: [{ id: 'growth', label: '提升计划', icon: 'prep' }] },
  // 自动投递（2026-10-10 用户要求）：升回一级导航，放在「投递记录」前面 ——
  // 先去发起投递，再看结果，顺序跟流程一致。
  { title: '自动投递', icon: 'apply', items: [{ id: 'autoapply', label: '自动投递', icon: 'apply' }] },
  { title: '投递记录', icon: 'apply', items: [{ id: 'applications', label: '投递记录', icon: 'apply' }] },
];

// 扁平视图，供其他逻辑引用
const NAV = NAV_GROUPS.flatMap((g) => g.items);

// 页面标题。[标题, 副标题] —— **副标题全部留空**（2026-10-12 用户要求：
// 「所有页面这些提示的句子都删掉」）。保留双元组结构是为了不动 route() 与
// VIEWS.cv 里 `TITLES.cv[1]` 之类的既有引用；要恢复某页说明就把字符串填回去。
const TITLES = {
  home: ['工作台', ''],
  login: ['登录', ''],
  admin: ['管理后台', ''],
  resumes: ['我的简历', ''],
  jobs: ['目标岗位', ''],
  growth: ['提升计划', ''],
  applications: ['投递记录', ''],
  cv: ['我的简历', ''],
  evaluate: ['岗位评估', ''],
  prep: ['能力复盘与进阶规划', ''],
  reports: ['评估报告', ''],
  cvopt: ['AI 定向优化', ''],
  templates: ['简历模板库', ''],
  cvkit: ['简历工具', ''],
  profile: ['求职配置', ''],
  tools: ['全部脚本', ''],
  autoapply: ['自动投递', ''],
  security: ['账号安全中心', ''],
  help: ['使用帮助', ''],
};

// 2026-10-10 换肤：导航改成原型的水平文字链接（.nav a / .on）。
// 高亮规则带一层「家族映射」：编辑器（cv）/模板库（templates）/简历工具（cvkit）/
// 全局优化（cvopt）都算「我的简历」家族，停留其上时那项保持点亮 ——
// 否则从列表页点进编辑器，导航会全部熄灭，像走错了地方。
const NAV_FAMILY = {
  cv: 'resumes', templates: 'resumes', cvkit: 'resumes', cvopt: 'resumes',
  evaluate: 'jobs', reports: 'jobs',
  prep: 'growth',
  // autoapply 现在自己是导航入口（2026-10-10），不再借用「投递记录」的高亮
};

function renderNav() {
  const current = location.hash.slice(1) || 'home';
  const base = NAV_FAMILY[current] || current;

  $('#nav').innerHTML = NAV_GROUPS.map((g) => {
    const n = g.items[0];
    const on = n.id === base;
    return '<a href="#' + n.id + '" data-go="' + n.id + '"' + (on ? ' class="on" aria-current="page"' : '')
      + '>' + esc(n.label) + '</a>';
  }).join('');
}

/** 收起所有下拉栏目与胶囊菜单。返回是否有浮层被收起（供 Esc 判断要不要吞掉这次按键）。 */
function closeNavCols() {
  let closed = false;
  $$('#nav .nav-col.is-open').forEach((c) => {
    c.classList.remove('is-open');
    const h = c.querySelector('.nav-col-head');
    if (h) {
      h.setAttribute('aria-expanded', 'false');
      // 焦点还留在标题上时 :focus-within 会继续把它撑着 —— 必须一并交还焦点
      if (h === document.activeElement) h.blur();
    }
    closed = true;
  });
  // 身份胶囊的「系统设置」菜单同属一族浮层，Esc / 切页时一起收
  const chip = $('#sessionChip');
  if (chip && chip.classList.contains('is-open')) {
    chip.classList.remove('is-open');
    const t = chip.querySelector('[data-chip="menu"]');
    if (t) t.setAttribute('aria-expanded', 'false');
    closed = true;
  }
  return closed;
}

function go(id) {
  // 已在当前视图时直接重载，否则 hashchange 不会触发
  if ((location.hash.slice(1) || 'home') === id) { route(); return; }
  location.hash = id;
}

// opts.keepScroll：简历编辑器增删条目后的内部重画用。
// 那只是把同一页重新画一遍，不该滚回顶部（见 VIEWS.cv 里的 rerender）。
async function route(opts) {
  const keepScroll = !!(opts && opts.keepScroll);
  const id = location.hash.slice(1) || 'home';
  // 视图已移除但 hash 还停在上面（旧书签、浏览器前进后退）：
  // 回首页，别把用户扔在「不是函数」的白屏上。
  if (!VIEWS[id]) { location.replace(location.pathname + '#home'); return; }
  // 登录门禁：功能页一律要登录，管理后台还要管理员身份。
  // 未登录访问功能页 → 回登录页；普通用户想进管理后台 → 回首页并提示。
  if (!PUBLIC_VIEWS.includes(id) && !AUTOTEST) {
    if (!S.session) { location.replace(location.pathname + '#login'); return; }
    if (id === 'admin' && S.session.role !== 'admin') {
      toast('管理后台需要管理员账号登录', 'warn');
      location.replace(location.pathname + '#home');
      return;
    }
  }
  const view = $('#view');
  const [title, sub] = TITLES[id] || TITLES.home;

  $('#pageTitle').textContent = title;
  $('#pageSub').textContent = sub;
  // 首页是门面页，标签页标题不带「控制台」后缀 —— 标题就应该是产品名
  document.title = (id === 'home') ? '历琢 · AI 求职工作台' : title + ' · 历琢 控制台';
  $('#topActions').innerHTML = '';
  paintSessionChip();

  // 先渲染与目标视图形态接近的骨架，并标记忙碌
  view.setAttribute('aria-busy', 'true');
  if (!keepScroll) view.innerHTML = viewSkeleton(id);
  renderNav();
  if (isDrawerMode() && drawerOpen()) setDrawer(false);
  if (!keepScroll) window.scrollTo({ top: 0, left: 0 });

  try {
    await VIEWS[id](view);
    const ann = $('#routeAnnouncer');
    if (ann) ann.textContent = '已进入「' + title + '」';
  } catch (err) {
    view.innerHTML = errorState(err, true);
    wireActions(view, [{ label: '重试', primary: true, onClick: () => route() }]);
  }
  view.setAttribute('aria-busy', 'false');
  renderNav();
}

// ══ 视图：总览 ════════════════════════════════════════════
const VIEWS = {};

/**
 * 从 JD 正文里猜一个岗位名，用于给新版本命名。
 * 猜错了也不要紧 —— 弹层里可以改，这里只是免得用户从空白框开始敲。
 */
function guessRoleFromJd(jd) {
  const t = String(jd || '');
  const m = t.match(/(?:岗位名称|职位名称|岗位|职位)\s*[:：]\s*([^\n\r]{2,40})/);
  if (m) return m[1].trim();
  // 退一步：第一行往往就是「岗位名称：xxx」之外的标题行
  const first = t.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
  if (first && first.length <= 40 && !/^https?:/i.test(first)) return first;
  return '';
}

// ══ 评估会话：跨页面切换保留 ══════════════════════════════════
// 本页有个别的页面没有的麻烦：route() 每次切页都会把整个视图重建
// （view.innerHTML = viewSkeleton(id)），写在 DOM 上的东西一离开就没了。
    // 评估结果恰恰是「跑一次、看很久」的东西——切去别页再回来发现分数、
// 结论、日志全空了，是这里最容易出现的回归；更糟的是请求还在飞的时候
// 切走，回调会去写已经 detach 的旧节点（$('#evState') 拿到 null 直接抛错）。
//
// 做法和简历表单（S.cvDraft）一样：**状态放会话里，DOM 只是它的投影**。
//   · S.evalSession 保存输入、运行态、状态徽标、日志、结果 HTML、按钮形态
//   · paintEval() 是唯一的「会话 → DOM」出口，不在本页时直接返回
//   · 所有会写 DOM 的地方都改成「改会话 → paintEval()」
function newEvalSession() {
  return {
    jd: '',
    // 简历来源（mockup 上传卡）：'' = 用在线简历编辑器内容（cv.md，服务端默认）；
    // 非空 = 上传文件解析出的正文，评估时作为 cvText 传给服务端覆盖。
    cvText: '',
    // 用哪份简历做评估（2026-10-12 用户要求加回来）：'base' = 原简历 cv.md，
    // 其它值 = 「我的简历」里的某个版本 id。随请求一起发给服务端
    // （/api/eval 的 cvVersion，id 过白名单，传什么都不可能变成任意文件读）。
    // 默认永远是 base —— 用户没主动选过，评估就必须与左边简历编辑器里的内容一致。
    cvVersion: 'base',
    cvFile: null,         // { name, chars } —— 只存回显用的摘要，不存正文以外的东西
    cvErr: '',            // 上传/解析失败的提示
    // 代次：新评估开始时递增，作废在飞的旧请求
    runId: 0,
    running: false,
    state: { label: '待评估', cls: 'badge' },
    hint: '填好左侧信息后点「开始AI评估」。',
    log: '', logShown: false,
    result: '',           // 报告卡主体（空 = 显示占位）
    // 「生成完整报告」原是次级 ghost 入口（mockup 三主按钮之外的补充动作），
    // 2026-09-26 并入 mockup 三主按钮的第一位（data-act="full"「生成报告」）。
    // 同日改为**后台**生成：跑的时候不占结果区，初筛分析照常可看，完成只提醒。
    fullBg: null,         // null | 'running' —— 后台生成中（生成报告按钮随之禁用）
    triageHtml: '',       // 初筛匹配报告的 HTML（后台生成期间/完成后都保留显示）
    fullBgNotice: '',     // 后台生成状态条（进行中/已完成/失败），拼在结果区顶部
    reportBtnShown: false,
    triageScore: null,
    // ── AI 简历优化弹窗（mockup：#optimizeModal）──────────────────
    optOpen: false,
    optRunning: false,
    optResult: null,      // { summary, issues, draft } | { error }
    // ── 批量初筛（界面迁到「全部脚本」页，会话仍挂这里）────────────
    // 独立于单条那套状态：批量跑的时候用户可能想同时看看单条结果，
    // 两套混在一个状态里会互相清空（resetResult 会清 triageScore 等）。
    // 同样遵循「状态挂 S、DOM 只是投影」：循环里只改这里，由
    // paintEvalBatch() 负责画；切页时它直接返回，切回来再补齐。
    batch: {
      text: '',            // 粘贴内容（跨切页保留）
      items: [],           // 切出来的岗位
      rows: [],            // 结果行（含 pending/running 占位，跑完逐行替换）
      running: false,
      runId: 0,            // 递增让在跑的旧批次作废（「停止」就是 ++ 一次）
      sortBy: 'score',     // 'score' 降序 | 'order' 粘贴顺序
      done: 0,
      total: 0,
      current: null,       // 正在跑的岗位名
      copyMsg: '',
      // 上次导入的文档摘要（文件名/格式/编码/读出几个岗位/读不了的原因）。
      // 只存摘要不存 File 对象：File 活得比这次操作长没关系，但把一个
      // 几百 KB 的 ArrayBuffer 挂在会话里跨页持有纯属浪费。
      imported: null,
    },
  };
}

// 惰性初始化：会话跟着窗口活着，所以切页回来它还在
function evalSession() {
  if (!S.evalSession) S.evalSession = newEvalSession();
  return S.evalSession;
}

// 按钮形态统一在这里变。busy() 用 dataset.idleHtml 记住原文案，
// 先改 textContent 再调 busy 会打架，所以顺序固定为
// 「清忙态 → 写 class/文案 → 需要时再加忙态」。
function paintBtn(btn, text, cls, on, label) {
  if (!btn) return;
  busy(btn, false);
  if (cls) btn.className = cls;
  if (text != null) btn.textContent = text;
  if (on) busy(btn, true, label);
}

// 输入框 → 会话。只在 input 里调，paintEval 不反向覆盖它。
function pullEvalInputs() {
  const s = S.evalSession;
  if (!s) return;
  const j = $('#evJd');
  if (j) s.jd = j.value;
}

// 会话 → DOM。不在评估页（已经切走）时静默返回 —— 这不是「什么也没做」，
// 而是把「更新会话」和「更新界面」解耦的关键：异步回调在别的页面上跑完时
// 只能更新会话，界面等切回来时再由它补上。
// ══ AI 引擎：本地开源模型 ⇄ CodeBuddy ══════════════════════════
// 多一条引擎通路的真实价值不只是省钱：本地模型离线、零成本、简历原文不出本机，
// 初筛、简历优化、完整评估三件事它都能干。
//
// 但它是**纯文本模型** —— 自己读不了项目文件，也写不了盘。完整评估能跑，
// 靠的是**服务端代劳**（读规则进 prompt、解析回复、由代码落盘），代价是
// 慢、而且 7B 的判断质量明显弱于 CodeBuddy。卡片必须把这个差别讲明白，
// 否则用户拿到一份「分数不对劲」的报告会以为页面算错了。
//
// 状态挂在 S.aiEngine 上，DOM 只是投影 —— 理由同 evalSession：
// route() 每次切页都把整个视图重建，写在 DOM 上的东西一离开就没了。

// 卡片内容（不含外层 .card 容器，方便整体重绘）
function aiEngineCardHtml() {
  const e = S.aiEngine;

  if (!e) {
    return '<div class="card-head"><span class="card-title">AI 引擎</span>'
      + '<span class="badge info" id="aiEngBadge">检测中</span></div>'
      + '<p class="hint">正在检测可用的 AI 引擎…</p>';
  }

  const ol = e.ollama || {};
  const btns = (e.engines || []).map((x) => {
    const on = x.id === e.choice;
    // 「不可用」的按钮**不禁用** —— 点一下会给出怎么把它弄好的提示，
    // 禁用掉的按钮什么也不说，用户只会以为界面坏了。
    return '<button class="btn sm' + (on ? ' primary' : (x.available ? '' : ' ghost')) + '"'
      + ' type="button" data-engine="' + esc(x.id) + '" title="' + esc(x.desc) + '"'
      + ' aria-pressed="' + (on ? 'true' : 'false') + '">'
      + esc(x.label) + (x.available ? '' : ' · 不可用') + '</button>';
  }).join('');

  const badge = e.available
    ? '<span class="badge ok" id="aiEngBadge">' + esc(e.activeLabel || '就绪') + '</span>'
    : '<span class="badge bad" id="aiEngBadge">没有可用引擎</span>';

  // 本地模型的实时状态单独一行。**地址（含端口）要露出来** ——
  // 启动器换了端口、或用户自己改了 OLLAMA_HOST 时，这是他第一个要看的东西。
  const olState = ol.alive
    ? '在线 · ' + esc(ol.base || '')
      + ' · 模型 ' + esc(ol.model || '')
      + (ol.models && ol.models.length ? '（已装 ' + ol.models.length + ' 个）' : '')
    : '离线 · ' + esc(ol.base || '') + (ol.error ? '（' + esc(ol.error) + '）' : '');

  const extra = [];
  if (!e.available) {
    extra.push('<div class="notice bad" style="margin-top:10px"><b>当前选择没有可用的引擎</b>'
      + '<p>' + esc(e.unavailableText || '') + '</p></div>');
  } else if (e.active === 'ollama') {
    // 本地模型在跑。三件事都能做，但要说清两点代价：
    // ① 完整报告是服务端代写落盘的（模型只出文本），比 CodeBuddy 慢；
    // ② 7B 的判断质量明显弱一档 —— 初筛分数只当预筛用，别拿它当最终结论。
    extra.push('<div class="notice info" style="margin-top:10px">'
      + '<b>本地模型：三件事都能跑，但慢一档、也糙一档</b>'
      + '<p>初筛、简历优化、完整报告都可用；完整报告由服务端代为落盘'
      + '（模型只出文字，写盘的是程序），一单要等几分钟到十几分钟。'
      + '它的分数只当<b>预筛</b>用——拿不准的岗位再用 CodeBuddy 复核一遍。</p></div>');
  }
  extra.push('<p class="hint" style="margin:8px 0 0">本地模型：' + olState + '</p>');
  // 2026-10-12 用户要求：完整报告改用 CodeBuddy 生成。初筛仍走本地模型
  //（快、零成本、简历不出本机）—— 只有「生成报告」（完整 A–H）跟引擎卡走。
  extra.unshift('<div class="notice info" style="margin-bottom:10px">'
    + '<b>初筛走本地模型，完整报告走 CodeBuddy</b>'
    + '<p>「开始评估」（初筛）仍用本机 qwen2.5:7b——快、零成本、简历原文不出本机；'
    + '「生成报告」（完整 A–H）已改用 CodeBuddy 生成，质量更高。'
    + 'CodeBuddy 不可用（未登录 / 刚失效过）时，完整报告会自动改回本地编排版，'
    + '生成结果里会注明实际用了哪个。</p></div>');

  return '<div class="card-head"><span class="card-title">AI 引擎</span>' + badge + '</div>'
    + '<p class="hint">评估和简历优化都靠它跑。切到「本地模型」不联网、不花钱、'
    + '简历原文不出本机；完整报告由服务端代写落盘。</p>'
    + '<div class="row tight">' + btns
    + '<button class="btn sm ghost" type="button" id="aiEngTest">测一下本地模型</button>'
    + '<button class="btn sm ghost" type="button" id="aiEngRefresh">重新检测</button>'
    + '</div>'
    + '<div id="aiEngExtra">' + extra.join('') + '</div>';
}

// 会话 → DOM 的唯一出口。不在评估页时 #aiEngineCard 取不到，直接返回 ——
// 切页之后硬写就是 $() 拿到 null 再抛错。
function paintAiEngine() {
  const box = $('#aiEngineCard');
  if (!box) return;
  box.innerHTML = aiEngineCardHtml();
  wireAiEngineCard();
}

// 绑定卡片里的事件。paintAiEngine() 每次重绘都要重绑，
// 所以这里写成可重复调用、且对缺失节点免疫。
function wireAiEngineCard() {
  const box = $('#aiEngineCard');
  if (!box) return;
  box.querySelectorAll('button[data-engine]').forEach((b) => {
    b.addEventListener('click', () => { switchAiEngine(b.dataset.engine); });
  });
  const t = $('#aiEngTest');
  if (t) t.addEventListener('click', testLocalModel);
  const rf = $('#aiEngRefresh');
  if (rf) rf.addEventListener('click', () => { loadAiEngine(); });
}

async function loadAiEngine() {
  try {
    S.aiEngine = await api('/api/ai-status');
  } catch {
    // 拉不到就退回「没有引擎」这一形态。**不能抛** —— 引擎状态拿不到
    // 不该让整个评估页打不开，页面里其他部分都还能用。
    S.aiEngine = null;
  }
  paintAiEngine();
  return S.aiEngine;
}

async function switchAiEngine(id) {
  const cur = S.aiEngine;
  if (cur && cur.choice === id) return;

  // 切换要落盘（服务端写 data/ai-engine.json），所以是请求不是纯前端状态。
  // 在这之前先看看这一档是否可用，能省掉一次注定失败的往返，
  // 也能把「不可用」的原因直接说给用户。
  const opt = cur && (cur.engines || []).find((x) => x.id === id);
  if (opt && !opt.available) {
    // 已知不可用：仍然提交（用户可能刚启动了服务，让服务端定论），
    // 但先把话说在前面。
    toast('「' + opt.label + '」当前检测为不可用，仍尝试切换…', 'warn');
  }

  try {
    const r = await api('/api/ai-engine', { method: 'POST', body: { engine: id }, timeout: 30000 });
    S.aiEngine = r.status;
    paintAiEngine();
    if (r.status && r.status.available) {
      toast('已切到「' + (r.status.activeLabel || id) + '」', 'ok');
    } else {
      toast('已切到「' + id + '」，但它当前不可用：'
        + ((r.status && r.status.unavailableText) || ''), 'warn');
    }
  } catch (e) {
    toast('切换引擎失败：' + e.message, 'bad');
    loadAiEngine();
  }
}

async function testLocalModel() {
  const btn = $('#aiEngTest');
  if (btn) busy(btn, true, '测试中…');
  try {
    const r = await api('/api/ai-engine/test', { method: 'POST', body: {}, timeout: 90000 });
    if (r.ok) toast('本地模型正常（' + r.ms + ' ms）：' + (r.sample || '有回话'), 'ok');
    else toast(r.error || '本地模型没有正常回话', 'bad');
  } catch (e) {
    toast('测试本地模型失败：' + e.message, 'bad');
  } finally {
    // 重绘会把按钮换掉，所以这里必须重新取一次节点，不能复用上面那个
    const b2 = $('#aiEngTest');
    if (b2) busy(b2, false);
    await loadAiEngine();
  }
}

// 报告卡的空态（还没有评估结果时）
const EV_EMPTY_RESULT = '<div class="ev-empty">'
  + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  + '<p>还没有评估结果</p>'
  + '<p class="hint">左侧选好简历来源、粘上岗位 JD，点「开始AI评估」。</p>'
  + '</div>';

/**
 * 六维能力雷达（mockup 用 Chart.js，这里零依赖手写 SVG —— 页面不许依赖 CDN）。
 * values/labels 等长（6 项），取值 0–100。标签外圈摆放，数值随标签展示。
 */
function radarSvg(values, labels) {
  const cx = 160; const cy = 132; const R = 88; const N = labels.length;
  const pt = (i, frac) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    return [cx + Math.cos(a) * R * frac, cy + Math.sin(a) * R * frac];
  };
  const poly = (frac) => labels.map((_, i) => pt(i, frac).map((n) => n.toFixed(1)).join(',')).join(' ');
  const axes = labels.map((_, i) => {
    const p = pt(i, 1);
    return '<line x1="' + cx + '" y1="' + cy + '" x2="' + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '"/>';
  }).join('');
  const vals = values.map((v) => Math.max(0, Math.min(100, Number(v) || 0)));
  const data = vals.map((v, i) => pt(i, v / 100));
  const dataPoly = data.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
  const dots = data.map((p) => '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3"/>').join('');
  const texts = labels.map((lb, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    const lx = cx + Math.cos(a) * (R + 14);
    const ly = cy + Math.sin(a) * (R + 14);
    const anchor = Math.abs(Math.cos(a)) < 0.35 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
    const dy = Math.sin(a) < -0.35 ? -2 : (Math.sin(a) > 0.35 ? 8 : 4);
    return '<text x="' + lx.toFixed(1) + '" y="' + (ly + dy).toFixed(1) + '" text-anchor="' + anchor + '">'
      + esc(lb) + '<tspan class="ev-radar-num">' + vals[i] + '</tspan></text>';
  }).join('');
  return '<svg viewBox="0 0 320 268" role="img" aria-label="六维匹配雷达图">'
    + [0.25, 0.5, 0.75, 1].map((f) => '<polygon points="' + poly(f) + '" class="ev-radar-ring"/>').join('')
    + axes
    + '<polygon points="' + dataPoly + '" class="ev-radar-data"/>'
    + dots
    + texts
    + '</svg>';
}

/** 六维标签（顺序与服务端 DIMS 输出一致）。提到顶层：匹配卡初筛/报告两处共用。 */
const DIM_LABELS = ['专业技能', '项目经验', '学历背景', '软技能', '行业经验', '成果量化'];

/**
 * 匹配卡：初筛结果卡与报告详情卡**共用同一套版式**（2026-10-12 用户要求：
 * 报告详情的内容也按初筛卡那样写）。提到顶层就是为了不让两处版式分叉。
 *
 * t: { score(5 分制|null), verdict('PASS'|'FAIL'|null), tier, why, dims(6 个数|null),
 *      good[], gap[], tip[], gated(硬门槛未过、按规则不给分) }
 * th: 门槛分；meta: { ms, engineLabel, infoLine }
 *   · 有 ms 才画「耗时 N 秒 · 这次用 X 完成」那行（初筛用）；
 *   · infoLine 是报告页的补充信息（日期 / Archetype / 真实性），有就并排显示。
 */
function matchCardHtml(t, th, meta) {
  const meta0 = meta || {};
  const lim = Number(th || 3);
  const score5 = t.score == null ? null : Number(t.score);
  const gated = !!t.gated || score5 == null;
  const score100 = score5 == null ? null
    : Math.max(0, Math.min(100, Math.round((score5 / 5) * 100)));
  const tier = String(t.tier || '').trim()
    || (gated ? '资格不符' : score5 >= 4 ? '强匹配' : score5 >= lim ? '值得投递' : '不建议投递');
  const tierCls = /强匹配|值得投递/.test(tier) ? 'ok' : (/补投/.test(tier) ? 'warn' : 'bad');
  const verdictRaw = String(t.verdict || '').toUpperCase();
  const verdictOk = verdictRaw === 'FAIL' ? false
    : (verdictRaw ? true : (score5 != null && score5 >= lim));

  // 服务端 prompt 已要求输出 DIMS 六维分；拿不到就按总分折算（平铺六边形），
  // 并注明「示意」—— 宁可诚实降级，不编造维度差异。
  const dims = Array.isArray(t.dims) && t.dims.length === 6 ? t.dims : null;
  const values = dims || DIM_LABELS.map(() => (score100 == null ? 0 : score100));
  let radar;
  if (dims) {
    radar = '<div class="ev-radar">' + radarSvg(values, DIM_LABELS) + '</div>';
  } else if (score100 == null) {
    // 硬门槛未过 → 按规则不给分，别画一个全 0 的雷达假装有数据
    radar = '<div class="ev-radar"><div class="note ev-radar-gated">'
      + '这份报告没有维度分<br>（硬门槛未过，按评估纪律不给分）</div></div>';
  } else {
    radar = '<div class="ev-radar">' + radarSvg(values, DIM_LABELS)
      + '<p class="hint ev-radar-note">维度分缺失，雷达按总分折算显示，仅供示意</p></div>';
  }

  const group = (cls, title, items) => '<div class="ev-group ev-g-' + cls + '"><h3>' + title + '</h3>'
    + (items && items.length
      ? '<ul>' + items.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
      : '<ul><li class="hint" style="margin:0">（AI 这次没有给出这一组的分析）</li></ul>')
    + '</div>';

  const metaBits = [];
  if (meta0.infoLine) metaBits.push(esc(meta0.infoLine));
  if (meta0.ms) {
    metaBits.push('耗时 ' + (meta0.ms / 1000).toFixed(0) + ' 秒 · 这次用 '
      + esc(meta0.engineLabel || '') + ' 完成');
  }

  return '<div class="ev-match">'
    + '<div class="ev-match-top">'
    + radar
    + '<div class="ev-match-side">'
    + '<div class="ev-k">综合匹配</div>'
    + '<div class="ev-v">' + (score100 == null ? '—' : score100) + '<span>/100</span></div>'
    + '<div class="ev-badges">'
    + '<span class="pill pill-' + tierCls + '">' + esc(tier) + '</span>'
    + '<span class="pill pill-' + (verdictOk ? 'ok' : 'bad') + '">'
    + (verdictOk ? '已过门槛' : '未过门槛') + '</span>'
    + (score5 == null ? '' : '<span class="pill pill-plain">' + score5 + '/5</span>')
    + '</div>'
    + '<div class="ev-why"><b>JD 解读</b><p>'
    + esc(t.why || '（这份报告没有写结论段）') + '</p></div>'
    + (metaBits.length ? '<div class="ev-meta">' + metaBits.join('　·　') + '</div>' : '')
    + '</div></div>'
    + '<div class="ev-groups">'
    + group('ok', '优势匹配点', t.good)
    + group('warn', '能力短板', t.gap)
    + group('acc', '简历优化建议', t.tip)
    + '</div>'
    + '</div>';
}

/** AI 简历优化弹窗（mockup：#optimizeModal）。藏在视图里，用 hidden 切换。 */
function optModalHtml() {
  const scopes = ['项目经历', '工作经历', '技能板块', '个人简介'];
  return '<div class="modal-mask opt-modal" id="optimizeModal" role="dialog" aria-modal="true" aria-label="AI简历优化" hidden>'
    + '<div class="modal" style="max-width:640px;width:100%">'
    + '<div class="modal-head"><h3>基于本次评估结果 · AI简历优化</h3>'
    + '<button class="modal-x" type="button" data-opt-close aria-label="关闭">&times;</button></div>'
    + '<p class="hint">AI将结合本次岗位评估短板、JD关键词，针对性改写简历，补齐匹配短板，提升ATS通过率。'
    + '优化只出稿，写回简历需要你在「我的简历」页确认。</p>'
    + '<div class="opt-sec"><span class="opt-label">优化范围</span>'
    + '<div class="opt-scope">'
    + scopes.map((x, i) => '<label class="opt-check"><input type="checkbox" name="optScope" value="' + x + '"'
      + (i < 2 ? ' checked' : '') + '>' + x + '</label>').join('')
    + '</div></div>'
    + '<div class="opt-sec"><label class="opt-label" for="evOptStyle">简历文风风格</label>'
    + '<select class="input" id="evOptStyle">'
    + '<option value="专业精炼">专业精炼（推荐，适合大厂ATS）</option>'
    + '<option value="成果量化">成果量化突出</option>'
    + '<option value="简洁保守">简洁保守（国企/传统行业）</option>'
    + '<option value="项目领导力">突出项目领导力</option>'
    + '</select></div>'
    + '<div class="opt-sec"><label class="opt-label" for="evOptExtra">补充要求（可选）</label>'
    + '<textarea class="textarea" id="evOptExtra" rows="3" '
    + 'placeholder="额外要求，例如：重点突出数据分析能力，不要夸大经历"></textarea></div>'
    + '<div class="opt-preview" id="evOptPreview"></div>'
    + '<div class="foot">'
    + '<button class="btn" type="button" data-opt-close>取消</button>'
    + '<button class="btn primary" type="button" id="evOptGo">开始AI优化</button>'
    + '</div>'
    + '</div></div>';
}

/** 弹窗会话 → DOM。不在评估页（节点已随视图销毁）时直接返回。 */
function paintOptModal() {
  const m = $('#optimizeModal');
  if (!m) return;
  const s = S.evalSession;
  if (!s) return;
  m.hidden = !s.optOpen;
  const pv = $('#evOptPreview');
  if (pv) {
    const r = s.optResult;
    if (s.optRunning) {
      // 说明句已按用户要求删除（2026-10-12），只留转圈表示在跑（按钮同时显示「优化中…」）
      pv.innerHTML = '<p class="hint"><span class="spinner" aria-hidden="true"></span></p>';
    } else if (!r) {
      pv.innerHTML = '<h4>AI优化预览（生成后展示）</h4>';
    } else if (r.error) {
      pv.innerHTML = '<div class="notice bad"><b>优化没有完成</b><p>' + esc(r.error) + '</p></div>';
    } else {
      pv.innerHTML = '<h4>AI优化预览</h4>'
        + (r.summary ? '<p class="hint">' + esc(r.summary) + '</p>' : '')
        + (r.issues && r.issues.length
          ? '<ul class="opt-issues">' + r.issues.slice(0, 5).map((i) =>
            '<li><b>[' + esc(i.level || '提示') + ']</b> ' + esc(i.title || i.raw || '') + '</li>').join('') + '</ul>'
          : '')
        + '<pre class="opt-draft">' + esc(String(r.draft).slice(0, 1200))
        + (String(r.draft).length > 1200 ? '\n…（完整改写稿到「我的简历」页查看）' : '') + '</pre>'
        + '<div class="row tight"><button class="btn primary sm" type="button" data-act="applyOpt">到「我的简历」页查看完整改写稿并应用</button></div>';
    }
  }
  const go = $('#evOptGo');
  if (go) {
    go.disabled = !!s.optRunning;
    go.textContent = s.optRunning ? '优化中…' : '开始AI优化';
  }
}

/** 上传摘要区 + 来源说明（会话 → DOM）。不在评估页时直接返回。 */
function paintEvalUpload() {
  const s = S.evalSession;
  if (!s) return;
  const info = $('#evCvFileInfo');
  if (info) {
    if (s.cvErr) {
      info.innerHTML = '<div class="notice bad">' + esc(s.cvErr) + '</div>';
    } else if (s.cvFile) {
      info.innerHTML = '<div class="notice ok">已读取 <b>' + esc(s.cvFile.name) + '</b>'
        + '（约 ' + s.cvFile.chars.toLocaleString('zh-CN') + ' 字）'
        + '<button class="btn ghost sm" type="button" data-act="clearCv">清除</button></div>';
    } else {
      info.innerHTML = '';
    }
  }
  const note = $('#evSrcNote');
  if (note) {
    note.textContent = s.cvFile
      ? '本次评估将以上传的简历内容为准（不再读取 cv.md）'
      : '当前来源：在线简历编辑器内容（cv.md）';
  }
  // 简历来源换了，「选哪份简历」的可用性也要跟着变（上传正文优先于版本）
  paintEvalCvVer();
}

/**
 * 「用哪份简历做评估」下拉（2026-10-12 用户要求，放在开始评估右边）。
 *
 * 会话是权威：`s.cvVersion`，'base' = 原简历 cv.md。**默认永远是 base** ——
 * 用户没主动选过，评估就必须与左边简历编辑器里的内容一致，不能悄悄换成别的。
 * 这个函数只把会话同步到 DOM（选项由 VIEWS.evaluate 灌，那里才知道版本列表）。
 *
 * ⚠️ 上传了简历正文（s.cvText）时**禁用下拉**：服务端优先级是
 * cvText > cvVersion > cv.md。不禁用的话，用户选了版本却悄无声息地用了
 * 上传那份 —— 「我以为用了 A 其实用了 B」是最难排查的那类问题。
 */
function paintEvalCvVer() {
  const s = S.evalSession;
  if (!s) return;
  const sel = $('#evCvVer');
  const note = $('#evCvVerNote');
  if (!sel) return;

  const uploaded = !!String(s.cvText || '').trim();
  sel.disabled = uploaded;

  // 会话里存的值可能已经不在了（版本被删、列表还没拉到）—— 一律回落 base，
  // 别让下拉悬在一个不存在的 option 上（那样 sel.value 会是空串）。
  if (uploaded) {
    s.cvVersion = 'base';
  } else if (s.cvVersion && ![...sel.options].some((o) => o.value === s.cvVersion)) {
    s.cvVersion = 'base';
  }
  sel.value = s.cvVersion || 'base';

  if (note) {
    note.textContent = uploaded
      ? '已上传简历正文，本次评估以它为准（选哪份简历暂不生效）'
      : (sel.value === 'base'
        ? '默认用「我的简历」里的原版 cv.md；也可选某一份独立简历来评估'
        : '本次评估将用你选的这份简历');
  }
}

/** 版本下拉的选项 HTML：固定第一项「原简历」+ 各独立版本。
 *  评估页 #evCvVer 与目标岗位页 #wzCvVer 共用 —— 两处各写一遍必然走偏
 *  （早先就只有评估页有，目标岗位页的评估因此永远用原简历）。 */
function cvVerOptions(vers) {
  return '<option value="base">原简历</option>'
    // ⚠️ 过滤掉 id === 'base' 的那一项：服务端的版本列表把原版也一起返回
    //（name 叫「原版简历」），不滤就会出现两个指向同一份简历的选项。
    + (Array.isArray(vers) ? vers : [])
      .filter((v) => v && v.id && v.id !== 'base')
      .map((v) => '<option value="' + esc(v.id) + '">'
        + esc(v.name || v.id) + '</option>').join('');
}

/** 灌版本选项 + 恢复上次选择 + 挂 change。只在 VIEWS.evaluate 挂载时调一次。 */
function fillEvalCvVerSelect(s, vers) {
  const sel = $('#evCvVer');
  if (!sel) return;
  const keep = s.cvVersion || 'base';
  sel.innerHTML = cvVerOptions(vers);
  s.cvVersion = keep;
  paintEvalCvVer();
  sel.addEventListener('change', () => {
    s.cvVersion = sel.value || 'base';
    paintEvalCvVer();
  });
}

/** 目标岗位页的「用哪份简历评估」下拉（2026-10-14 用户要求，放在开始评估左边）。
 *  与评估页**共用同一份会话状态**（evalSession().cvVersion）：两边选哪个都同步，
 *  不会出现「这页选了、那页不认」。 */
function fillWzCvVerSelect(s, vers) {
  const sel = $('#wzCvVer');
  if (!sel) return;
  sel.innerHTML = cvVerOptions(vers);
  sel.addEventListener('change', () => {
    s.cvVersion = sel.value || 'base';
    paintWzCvVer();
  });
  paintWzCvVer();
}

function paintWzCvVer() {
  const s = S.evalSession;
  const sel = $('#wzCvVer');
  if (!s || !sel) return;
  // 会话里存的值可能已经不在了（版本被删、列表还没拉到）→ 回落 base，
  // 别让下拉悬在一个不存在的 option 上（那样 sel.value 是空串）。
  if (s.cvVersion && ![...sel.options].some((o) => o.value === s.cvVersion)) {
    s.cvVersion = 'base';
  }
  sel.value = s.cvVersion || 'base';
  const note = $('#wzCvVerNote');
  if (note) {
    // 本页**不发** cvText（上传是评估页那条路径的事），所以这里以下拉为准；
    // 但会话里可能留着评估页上传过的正文，要说清楚，否则用户会以为用了它。
    note.textContent = String(s.cvText || '').trim()
      ? '评估页上传过简历正文；本页按下面选的那份评估'
      : (sel.value === 'base'
        ? '默认用原版 cv.md，也可选某一份独立简历'
        : '本次评估将用你选的这份简历');
  }
}

function paintEval() {
  const s = S.evalSession;
  const view = $('#view');
  if (!s || !view || !view.querySelector('#evGo')) return;

  const j = $('#evJd');
  if (j && j.value !== s.jd) j.value = s.jd;

  // 上传摘要与来源说明（重绘后节点是新的，统一在这里铺）
  paintEvalUpload();

  const st = $('#evState');
  if (st) { st.textContent = s.state.label; st.className = s.state.cls; }
  const hint = $('#evHint');
  if (hint) hint.innerHTML = s.hint;
  const log = $('#evLog');
  if (log) { log.textContent = s.log; log.style.display = s.logShown ? 'block' : 'none'; }
  const res = $('#evResult');
  if (res) res.innerHTML = s.result || EV_EMPTY_RESULT;

  paintBtn($('#evGo'), null, null, s.running, '评估中…');
  paintOptModal();
}

// ══ 视图：评估岗位 ════════════════════════════════════════
// 这是「在页面里直接做评估」的主入口。服务端会拉起 AI 命令行，
// 让它读 modes/ 下的规则、打分、写 reports/ 与台账。
//
// 两阶段设计（速度实测决定的）：
//   · 初筛：只读 _brief.md + _profile.md，约 20–30 秒 → 给分数和结论
//   · 完整评估：读 5 份规则 + 写报告 + 更新台账，10 分钟以上
// 所以先跑初筛给即时反馈，用户想深入时再点「生成完整报告」。
// ══ 批量初筛：一次粘多个岗位 ══════════════════════════════════════
//
// 编排刻意放在**前端**：逐条调用已经调通的 /api/eval（phase=triage），
// 每回来一条就补一行 —— 而不是让服务端收一整批、跑完再一起返回。三个理由：
//   1. 用户能看着表一格格填满，不是盯着转圈等四分钟；
//   2. 中途可停，已经跑完的行仍然有用；
//   3. 单条超时只废掉一行，不会把整批拖垮（一单最多 360 秒）。
// 代价：切页/关页面会中断这一批（状态在会话里，切回来能看到已跑完的行）。
// 服务端一行都不用改 —— 这也是选它的主要原因：复用已被自检覆盖的那条通路。

/** 批量卡片。textarea 的值从会话恢复，所以切页回来内容还在。 */
function batchCardHtml(s) {
  return '<div class="card" id="evBatchCard">'
    + '<div class="card-head"><span class="card-title">批量初筛</span>'
    + '<span class="badge info">一次最多 ' + BATCH_MAX + ' 个</span></div>'
    + '<p class="hint">导入岗位文档，或直接粘贴，挨个跑初筛，跑完出排序表。'
    + 'Word 里用<b>标题</b>样式标出的岗位、Excel 和 Word 表格里的<b>每一行</b>，都会自动拆成一条。'
    + '批量评估统一用原版简历（cv.md）；想按定制版本评，去「岗位评估」页单条跑。</p>'
    + '<div class="row tight" style="margin-bottom:10px">'
    + '<button class="btn primary" id="evBatchPick" type="button">导入文档</button>'
    + '<input type="file" id="evBatchFile" accept="' + IMPORT_ACCEPT + '" multiple hidden>'
    + '<span class="hint" style="margin:0">支持 .docx / .xlsx / .csv / .txt / .md，可多选；'
    + '也能把文件直接拖到下面的框里。文档在本机打开，不会上传。</span>'
    + '</div>'
    + '<div id="evBatchImport"></div>'
    + '<label class="field"><span>岗位 JD <em>多个岗位之间用单独一行的 --- 隔开</em></span>'
    + '<textarea class="textarea" id="evBatchJd" rows="12" spellcheck="false" '
    + 'placeholder="导入文档后内容会出现在这里，也可以直接粘贴：&#10;字节跳动 · 后端开发工程师&#10;职责：……&#10;任职要求：……&#10;---&#10;腾讯 · 后台开发&#10;……"></textarea></label>'
    + '<div class="row tight" style="margin-bottom:12px">'
    + '<span class="hint" id="evBatchCount" style="margin:0"></span></div>'
    + '<div class="row tight">'
    + '<button class="btn primary" id="evBatchGo">开始批量初筛</button>'
    + '<button class="btn ghost" id="evBatchStop" style="display:none">停止</button>'
    + '<button class="btn ghost" id="evBatchDemo">填入示例</button>'
    + '<button class="btn ghost" id="evBatchClear">清空</button>'
    + '</div>'
    + '<div id="evBatchOut"></div>'
    + '</div>';
}

/** 示例数据：三个不同届次/城市的岗位，跑一遍就能看出初筛的区分度。 */
const BATCH_DEMO = [
  '示例科技 · 后端开发工程师（2027 届校招）',
  '工作地点：西安',
  '岗位职责：',
  '1. 参与公司核心业务系统的后端设计与开发；',
  '2. 负责接口性能优化与稳定性保障。',
  '任职要求：',
  '1. 2027 届本科及以上，计算机相关专业；',
  '2. 熟悉 Java 或 Go，了解 MySQL、Redis；',
  '3. 有后端项目经历者优先。',
  '---',
  '示例网络 · 服务端开发（2026 届，招满即止）',
  '工作地点：北京',
  '任职要求：',
  '1. 2026 届本科及以上，计算机相关专业；',
  '2. 熟悉 Java、Spring 全家桶；',
  '3. 有分布式系统经验。',
  '---',
  '示例智能 · 测试开发工程师（2027 届提前批）',
  '工作地点：承德',
  '任职要求：',
  '1. 2027 届本科，计算机相关专业；',
  '2. 熟悉 Python 或 Java，了解自动化测试框架；',
  '3. 有测试平台开发经验者优先。',
].join('\n');

/** 输入框下方的识别结果提示：切出几个、有没有超上限/过长。 */
function batchCountText(text) {
  const p = splitBatchJds(text);
  if (!p.items.length) return '还没有内容 —— 粘上 JD 后这里会显示识别出几个岗位';
  const parts = ['识别出 ' + p.items.length + ' 个岗位'];
  if (p.truncated) parts.push('超过上限，只跑前 ' + BATCH_MAX + ' 个');
  const tooLong = p.items.filter((i) => i.tooLong).length;
  if (tooLong) parts.push(tooLong + ' 个 JD 过长（会被跳过）');
  return parts.join(' · ');
}

function paintBatchCount() {
  const el = $('#evBatchCount');
  if (!el) return;
  const s = S.evalSession;
  el.textContent = batchCountText(s ? s.batch.text : '');
}

/**
 * 导入摘要。刻意放在按钮和文本框**之间**：用户点完「导入文档」，
 * 视线就在这一带，读到了什么必须出现在动作旁边 —— 而不是跑到卡片底部
 * 结果区去，让人以为「点了没反应」。
 *
 * 三类信息分开写、分开配色，因为用户对它们的处置完全不同：
 *   ok    读到了什么（文件名 / 格式 / 编码 / 几个岗位）→ 确认后开跑
 *   warn  读得不完美（超上限、表格按行展开、没认出行标题）→ 值得看一眼原文
 *   bad   哪些文件没读成 → 要换个格式重来
 */
function paintBatchImport() {
  const host = $('#evBatchImport');
  if (!host) return;
  const s = S.evalSession;
  const imp = s && s.batch.imported;
  if (!imp) { host.innerHTML = ''; return; }

  let html = '';
  if (imp.names.length) {
    const files = imp.names.map((n, i) => '<b>' + esc(n) + '</b>'
      + (imp.labels[i] ? '（' + esc(imp.labels[i]) + '）' : '')).join('、');
    const encs = imp.encodings.filter(Boolean);
    html += '<div class="notice ok" style="margin-bottom:10px">'
      + '已读入 ' + files
      + (encs.length ? ' <span class="hint" style="color:inherit;opacity:.85">（'
        + esc([...new Set(encs)].join(' / ')) + '）</span>' : '')
      + ' · 识别出 <b>' + imp.blocks + '</b> 个岗位'
      // 覆盖是可逆的：原件留在文本区外面一份，用户随时能撤回去
      + (imp.prev ? '<div class="notice-actions">'
        + '<button class="btn ghost sm" type="button" id="evBatchUndo">恢复导入前的内容</button></div>' : '')
      + '</div>';
  }
  if (imp.warnings.length) {
    html += '<div class="notice warn" style="margin-bottom:10px">'
      + imp.warnings.map((w) => '<div>' + esc(w) + '</div>').join('') + '</div>';
  }
  if (imp.failed.length) {
    html += '<div class="notice bad" style="margin-bottom:10px">'
      + '<b>' + imp.failed.length + ' 个文件没读成：</b>'
      + imp.failed.map((f) => '<div>' + esc(f) + '</div>').join('') + '</div>';
  }
  host.innerHTML = html;
}

/**
 * 导入一个或多个文档 → 填进批量文本框。
 *
 * 刻意不自动开跑：导入是**输入**动作，而跑初筛要花时间和 token
 * （一条 20–30 秒、十几条就是好几分钟）。读进来的东西必须先让用户过一眼 ——
 * 一口气跑完才发现 Excel 读错了列，那几分钟就白等了。
 */
async function importBatchDocs(fileList) {
  const s = S.evalSession;
  if (!s) return;
  const b = s.batch;
  if (b.running) { toast('正在跑批量初筛，等这一批跑完再导入', 'warn'); return; }

  const files = Array.from(fileList || []);
  if (!files.length) return;

  const btn = $('#evBatchPick');
  busy(btn, true, '正在读…');
  const results = [];
  const failed = [];
  try {
    for (const f of files) {
      let bytes;
      try {
        bytes = new Uint8Array(await f.arrayBuffer());
      } catch (err) {
        failed.push(f.name + '：读不到文件内容（' + (err.message || '未知原因') + '）');
        continue;
      }
      // 串行解析：一次拖进来的通常是同一种表，并行省不了多少时间，
      // 反而让「正在读第几个」没法显示，出错时也分不清是哪个文件。
      const r = await parseDocument(f.name, bytes);
      if (r.ok) results.push(r);
      else failed.push(f.name + '：' + r.error);
    }
  } finally {
    busy(btn, false);
  }

  const merged = mergeImports(results);
  const bjd = $('#evBatchJd');

  if (!merged.text) {
    // 全都读不成：摘要区照样要更新 —— 只弹一条几秒后就消失的提示，
    // 用户回头想看清楚「到底为什么不行」就没了。
    //
    // 但**不能**顺手把上一次的成功摘要擦掉：这次导入失败并不影响文本框里
    // 已经躺着的那批岗位。擦掉之后页面会变成「1 个文件没读成」+ 下方一堆
    // 岗位内容并存，用户没法判断这些内容是哪来的（踩过：截图里看着像 bug）。
    // 有旧摘要就只挂新的失败项，没有才新建一条空摘要。
    const prevImp = b.imported && b.imported.names.length ? b.imported : null;
    b.imported = prevImp
      ? { ...prevImp, failed }
      : { names: [], labels: [], encodings: [], blocks: 0, warnings: [], failed, prev: '' };
    paintBatchImport();
    toast(failed.length ? '这些文件都没读成，原因写在按钮下面' : '没读到岗位内容', 'bad');
    return;
  }

  // 换输入 = 上一批结果作废。留着旧表格，用户会以为新导入的岗位已经跑过了。
  b.runId += 1;
  b.items = []; b.rows = []; b.done = 0; b.total = 0;
  b.current = null; b.copyMsg = '';

  const hadText = String(b.text || '').trim();
  b.text = merged.text;
  if (bjd) bjd.value = merged.text;

  b.imported = {
    names: results.map((r) => r.name),
    labels: results.map((r) => kindLabel(r.kind)),
    encodings: results.map((r) => r.encoding || ''),
    blocks: merged.blocks,
    warnings: merged.warnings,
    failed,
    // 只有「导入会覆盖掉已有内容」时才给撤销按钮，否则按钮点了也没变化
    prev: hadText && hadText !== merged.text ? hadText : '',
  };

  paintBatchImport();
  paintBatchCount();
  paintEvalBatch();
  toast('已导入 ' + merged.blocks + ' 个岗位，确认无误后点「开始批量初筛」'
    + (failed.length ? '（' + failed.length + ' 个文件没读成）' : ''),
  failed.length ? 'warn' : 'ok');
}

/** 分数徽标：有服务端门槛就按门槛分色，没有就按 4/3 分档（纯视觉）。 */
function batchScoreHtml(r) {
  if (r.state === 'running') return '<span class="hint">跑着呢…</span>';
  if (r.state === 'pending') return '<span class="hint">待跑</span>';
  if (r.state === 'stopped') return '<span class="hint">已停</span>';
  if (typeof r.score !== 'number') return '<span class="badge">—</span>';
  const th = typeof S.evalThreshold === 'number' ? S.evalThreshold : 3;
  const cls = r.score >= Math.max(th + 1, 4) ? 'ok' : r.score >= th ? 'warn' : 'bad';
  return '<span class="badge score ' + cls + '">' + r.score.toFixed(1) + '/5</span>';
}

function batchRowHtml(r) {
  const pending = r.state === 'pending' || r.state === 'running';
  const note = r.skipped ? '（过长，已跳过）'
    : r.state === 'stopped' ? '（已停止）'
      : pending ? '' : r.ok ? '' : '（失败）';
  // 还没跑的占位行不能显示成「失败」——理由列留空，状态由分数列表达
  const detail = pending ? ''
    : r.ok ? esc(r.why || '')
      : '<span style="color:var(--bad-ink)">' + esc(r.error || '没有结果') + '</span>';
  return '<tr data-batch-row="' + r.index + '">'
    + '<td class="num">' + r.index + '</td>'
    + '<td class="desc">' + esc(r.label) + '</td>'
    + '<td>' + batchScoreHtml(r) + '</td>'
    + '<td>' + (pending ? '—' : esc(verdictZh(r.verdict) || '—') + note) + '</td>'
    + '<td>' + esc(pending ? '—' : (r.tier || '—')) + '</td>'
    + '<td class="desc">' + detail + '</td>'
    + '<td class="act">'
    + '<button class="btn ghost sm" type="button" data-batch-fill="' + r.index + '">单独细看</button>'
    + '</td></tr>';
}

/**
 * 会话 → DOM。不在评估页时直接返回（和 paintEval 同一条规矩）：
 * 循环在别的页面上跑完时只更新会话，界面等切回来再补。
 */
function paintEvalBatch() {
  const out = $('#evBatchOut');
  if (!out) return;
  const s = S.evalSession;
  if (!s) return;
  const b = s.batch;

  const go = $('#evBatchGo');
  const stop = $('#evBatchStop');
  if (go) {
    go.disabled = !!b.running;
    go.textContent = b.running ? '批量初筛中…' : '开始批量初筛';
  }
  if (stop) stop.style.display = b.running ? '' : 'none';

  if (!b.rows.length) {
    out.innerHTML = '';
    return;
  }

  const finished = b.rows.filter((r) => r.state !== 'pending' && r.state !== 'running');
  const scored = finished.filter((r) => typeof r.score === 'number');
  const th = typeof S.evalThreshold === 'number' ? S.evalThreshold : null;
  const passed = th == null ? null : scored.filter((r) => r.score >= th).length;

  const head = b.running
    ? '<span class="spinner" aria-hidden="true"></span> 正在跑第 <b>' + (b.done + 1) + '/' + b.total
      + '</b> 个：' + esc(b.current || '')
    : b.done < b.total
      ? '已停止：跑完 <b>' + finished.length + '</b> / ' + b.total + ' 个'
      : '跑完 <b>' + scored.length + '</b> 个岗位'
        + (scored.length ? '，平均 <b>' + (scored.reduce((a, r) => a + r.score, 0) / scored.length).toFixed(1) + '</b>/5' : '')
        + (passed != null ? '，过门槛（' + th + '）<b>' + passed + '</b> 个' : '');

  out.innerHTML =
    '<div class="row tight" style="margin-top:14px;margin-bottom:8px">'
    + '<span class="hint" style="margin:0" role="status">' + head + '</span>'
    + '<span class="hint" style="margin:0">·</span>'
    + '<button class="btn ghost sm" type="button" data-batch-sort>'
    + (b.sortBy === 'score' ? '按分数排序' : '按粘贴顺序') + '</button>'
    + '<button class="btn ghost sm" type="button" data-batch-copy>复制为 Markdown</button>'
    + '<span class="hint" style="margin:0" id="evBatchCopyMsg">' + esc(b.copyMsg || '') + '</span>'
    + '</div>'
    + '<div class="table-wrap"><table class="data"><thead><tr>'
    + '<th style="width:36px">#</th><th>岗位</th><th style="width:74px">分数</th>'
    + '<th style="width:74px">结论</th><th style="width:92px">档位</th>'
    + '<th>理由</th><th style="width:88px"></th>'
    + '</tr></thead><tbody>'
    + sortBatchRows(b.rows, b.sortBy).map(batchRowHtml).join('')
    + '</tbody></table></div>';
}

/**
 * 跑一批。串行（不并发）：引擎侧本来就串行排队（withAiLock），
 * 前端再并发只会把「谁在跑」变得不可见，还容易踩到端口/资源竞争。
 */
async function runBatchEval() {
  const s = S.evalSession;
  if (!s) return;
  const b = s.batch;
  if (b.running) return;

  const parsed = splitBatchJds(b.text);
  if (!parsed.items.length) {
    toast('先粘至少一个岗位的 JD（多个岗位之间用单独一行的 --- 隔开）', 'warn');
    const ta = $('#evBatchJd');
    if (ta) ta.focus();
    return;
  }
  if (parsed.truncated) toast('识别出 ' + parsed.total + ' 个，超过上限，只跑前 ' + BATCH_MAX + ' 个', 'warn');

  b.items = parsed.items;
  // 先铺满占位行：用户马上看到「一共几条、还剩几条」，
  // 而不是跑一条冒一行。state 用来区分 待跑/跑着/跑完。
  // 占位行**不能**走 rowFromTriage —— 那会把还没有响应的行标成
  // 「失败：退出码 ?」，看起来像批量一开始就全挂了。
  b.rows = parsed.items.map((it) => ({
    index: it.index, label: it.label, jd: it.jd,
    score: null, verdict: '', tier: '', why: '', ok: false, ms: 0,
    skipped: !!it.tooLong,
    state: it.tooLong ? 'skipped' : 'pending',
    error: it.tooLong
      ? 'JD 过长（' + it.chars + ' 字符，上限 3 万）—— 删掉福利、公司介绍等段落再试'
      : '',
  }));
  b.done = b.rows.filter((r) => r.state === 'skipped').length;
  b.total = parsed.items.length;
  b.current = null;
  b.copyMsg = '';
  b.running = true;
  const myRun = ++b.runId;
  paintEvalBatch();

  for (let i = 0; i < parsed.items.length; i += 1) {
    if (myRun !== b.runId) return;                 // 被「停止」或新一批取代
    const it = parsed.items[i];
    if (it.tooLong) continue;                      // 占位行已经是 skipped 终态
    b.current = it.label;
    b.rows[i] = { ...b.rows[i], state: 'running' };
    paintEvalBatch();

    let r;
    try {
      r = await api('/api/eval', {
        method: 'POST',
        timeout: 360000,
        // 批量统一用原版简历（cv.md）—— 这是**有意的分歧**：批量跑的是「一批
        // 岗位各筛一遍」，要的是横向可比；而单条评估页有「选哪份简历」的下拉
        // （#evCvVer），那是「拿某一版简历去对口某一个岗」的场景。两边口径不同，
        // 别看着像漏改。
        body: { jd: it.jd, phase: 'triage', cvVersion: 'base' },
      });
    } catch (err) {
      r = { ok: false, code: -1, friendly: '请求失败：' + err.message };
    }
    if (myRun !== b.runId) return;

    b.rows[i] = { ...rowFromTriage(it, r), state: r.ok ? 'done' : 'failed' };
    b.done += 1;
    paintEvalBatch();
  }

  b.running = false;
  b.current = null;
  paintEvalBatch();

  const scored = b.rows.filter((r) => typeof r.score === 'number');
  if (scored.length) {
    const th = typeof S.evalThreshold === 'number' ? S.evalThreshold : null;
    const over = th == null ? null : scored.filter((r) => r.score >= th).length;
    toast('批量初筛完成：' + scored.length + ' 个岗位'
      + (over == null ? '' : '，过门槛 ' + over + ' 个'), 'ok');
  } else {
    toast('批量初筛跑完了，但一条分数都没解析出来 —— 展开日志看看原始输出', 'warn');
  }
}

// ══ 视图：岗位评估（mockup：简历评估.html）════════════════
// 版式照 mockup 固定：左栏 = 上传简历 + 粘贴 JD，右栏 = 评估报告卡
// （得分/100 + 徽标 + 六维雷达 + 三组标签 + 三个动作按钮）。
// 「开始AI评估」跑的是初筛（约半分钟），报告卡直接呈现匹配分析；
// 完整 A–H 报告（4–10 分钟）降级为报告卡下方的次级入口。
// 批量初筛与 AI 引擎卡不在这版版式里，迁到「全部脚本」页（VIEWS.tools）。
VIEWS.evaluate = async function (view) {
  const s = evalSession();

  let ai = { available: false };
  try { ai = await api('/api/ai-status'); } catch { /* 降级为不可用 */ }

  // 简历缺项只提醒不拦截：上传卡本身就是解决「简历从哪来」的入口，
  // 硬拦只会把人推去别处。缺项让分数偏低这一点，提示里说清楚就够。
  let cvMissing = [];
  try { cvMissing = (await api('/api/cv')).completeness.missing || []; } catch { /* 读不到就不提示 */ }

  // 简历版本列表：「用哪份简历做评估」下拉的选项（2026-10-12 用户要求）。
  // 拉不到就只留「原简历」那一项 —— 那正是默认行为，
  // 不该因为读不到版本列表把整页拖垮，更不该弹错误。
  let cvVers = [];
  try { cvVers = (await api('/api/cv/versions')).versions || []; } catch { /* 留空即可 */ }

  view.innerHTML =
    '<div class="ev-hero"><h1>岗位匹配评估</h1>'
    + '<p>上传简历 + 粘贴岗位JD，AI自动分析匹配度、能力短板与投递建议</p></div>'
    + (cvMissing.length
      ? '<div class="notice warn" style="margin-bottom:16px">简历还有 <b>' + cvMissing.length
        + '</b> 项没填（' + esc(cvMissing.join('、')) + '）——缺项会让分数偏低，先去'
        + '<button class="btn ghost sm" type="button" data-act="cv">简历编辑</button>补全。</div>'
      : '')
    + '<div class="ev-grid">'
    + '<div class="ev-col">'

    // ── 上传你的简历 ─────────────────────────────────────────
    + '<div class="card" id="evUploadCard"><h2>上传你的简历</h2>'
    + '<div class="ev-drop" id="evDrop" role="button" tabindex="0" aria-label="上传简历文件">'
    + '<svg class="ev-drop-icon" viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.6"/>'
    + '<path d="M12 18v-6M9.5 14.5 12 12l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>'
    + '<p class="ev-drop-main">拖拽文件到此处，或点击上传</p>'
    + '<p class="hint">支持 Word(.docx) / TXT / Markdown，最大 10MB</p>'
    + '<button class="btn sm" type="button" id="evFilePick">选择文件</button>'
    + '<input type="file" id="evFile" accept=".docx,.txt,.md,.text,.csv" hidden>'
    + '</div>'
    + '<div id="evCvFileInfo" aria-live="polite"></div>'
    + '<p class="ev-or"><span>或者：</span>'
    + '<button class="ev-link" type="button" id="evUseEditor">读取在线简历编辑器内容</button></p>'
    + '<p class="hint" id="evSrcNote" style="margin:6px 0 0"></p>'
    + '</div>'

    // ── 粘贴岗位描述（JD）────────────────────────────────────
    + '<div class="card"><h2>粘贴岗位描述（JD）</h2>'
    + '<textarea class="textarea" id="evJd" rows="8" '
    + 'placeholder="复制招聘网站上完整的岗位要求，包括岗位职责、任职要求"></textarea>'
    + '<div class="ev-go-row">'
    + '<button class="btn primary ev-go" id="evGo"' + (ai.available ? '' : ' disabled') + '>开始AI评估</button>'
    // 选哪份简历做评估（2026-10-12 用户要求，放在开始评估右边）。
    // 默认「原简历」；版本列表在 VIEWS.evaluate 里异步灌进来
    // （灌之前只有这一项，也正是默认行为）。
    + '<select class="select" id="evCvVer" title="用哪份简历做评估">'
    + '<option value="base">原简历</option>'
    + '</select>'
    + '</div>'
    + '<p class="hint" id="evCvVerNote" style="margin:6px 0 0"></p>'
    + (ai.available ? ''
      : '<p class="hint" style="margin:8px 0 0">AI 引擎当前不可用 —— 到「全部脚本」页顶部的'
        + 'AI 引擎卡切换或检测引擎后再来。</p>')
    + '</div>'

    + '</div>'

    // ── 评估报告 ─────────────────────────────────────────────
    + '<div><div class="card ev-report" id="evOutCard">'
    + '<div class="card-head"><span class="card-title">评估报告</span>'
    + '<span class="badge" id="evState">待评估</span></div>'
    + '<p class="hint" id="evHint" role="status" aria-live="polite"></p>'
    + '<pre class="log" id="evLog" style="display:none"></pre>'
    + '<div id="evResult"></div>'
    + '</div></div>'

    + '</div>'

    // ── AI 简历优化弹窗（mockup：#optimizeModal）──────────────
    + optModalHtml();

  // 引擎状态喂给 S：完整报告的「本地引擎写不了盘」拦截要用它
  // （引擎卡本体在「全部脚本」页，这里只借它的事实）。
  S.aiEngine = ai && ai.engines ? ai : null;
  const TH = ai.threshold != null ? Number(ai.threshold) : 3.0;

  // ── 上传简历：解析一个文件 → 会话（mockup 上传卡的核心动作）────
  // 格式按 doc-import 的真实能力来：.docx/.txt/.md 能读，PDF 读不了 ——
  // 提示里直说，并给出替代路径（转存或用编辑器内容），不静默失败。
  const handleCvFile = async (f) => {
    if (!f) return;
    const fail = (msg) => { s.cvErr = msg; s.cvFile = null; s.cvText = ''; paintEvalUpload(); };
    if (f.size > 10 * 1024 * 1024) {
      fail('文件超过 10MB 上限 —— 简历不需要这么大，检查是不是拖错了文件。');
      return;
    }
    if (!/\.(docx|txt|md|text|csv)$/i.test(f.name)) {
      fail('暂不支持这个格式（PDF 也读不了）。请转存为 Word(.docx) 或 TXT/Markdown，或直接用下方「读取在线简历编辑器内容」。');
      return;
    }
    const pick = $('#evFilePick');
    busy(pick, true, '读取中…');
    let r;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      r = await parseDocument(f.name, bytes);
    } catch (err) {
      r = { ok: false, error: err.message || '读取失败' };
    } finally {
      const p2 = $('#evFilePick');
      if (p2) busy(p2, false);
    }
    if (!r || !r.ok) { fail((r && r.error) || '这个文件读不出内容'); return; }
    const text = String(r.text || '').trim();
    if (!text) { fail('文件里没读到正文'); return; }
    if (text.length > 30000) {
      fail('简历正文过长（' + text.length.toLocaleString('zh-CN') + ' 字符，上限 3 万）—— 删掉无关段落再上传。');
      return;
    }
    s.cvText = text;
    s.cvErr = '';
    s.cvFile = { name: f.name, chars: text.length };
    paintEvalUpload();
    toast('已读取「' + f.name + '」，评估时将以上传内容为准', 'ok');
  };

  // ── 匹配报告（mockup 评估报告卡）：分数/100 + 徽标 + 雷达 + 三组标签 ──
  // 初筛结果卡（2026-10-12 用户给的新版式）：左雷达 + 右列（综合匹配 /
  // 三枚徽标 / JD 解读 / 耗时与引擎），下三组分析。meta = { ms, engineLabel }。
  // 匹配卡渲染提到顶层了（matchCardHtml）——初筛结果卡与报告详情卡共用同一套版式，
  // 两处各写一份迟早会分叉（今天报告详情就还停在旧版式）。
  const buildMatchReport = (t, th, meta) => matchCardHtml(t, th, meta);
  void buildMatchReport;

  // 报告卡底部的动作区：新版式三主按钮（2026-10-12 用户要求）——
  // 生成完整报告（A–H）/ AI 优化简历 / 换个岗位再评 + 底部说明。
  const matchActionsHtml = () => '<div class="ev-actions">'
    + '<button class="btn" type="button" data-act="full"'
    + (s.fullBg === 'running' ? ' disabled' : '') + '>'
    + (s.fullBg === 'running' ? '后台生成中…' : '生成完整报告（A–H）') + '</button>'
    + '<button class="btn primary" type="button" data-act="opt">AI 优化简历</button>'
    + '<button class="btn" type="button" data-act="again">换个岗位再评</button>'
    + '</div>'
    + '<p class="hint ev-foot-note">完整报告会写进「历史评估」，需要 CodeBuddy 登录。</p>'
    + '<div class="row tight ev-secondary">'
    + '<button class="btn ghost sm" type="button" data-act="report"'
    + (s.reportBtnShown ? '' : ' style="display:none"') + '>查看评估报告</button>'
    + '</div>';

  // ── 初筛结果：呈现新版式的匹配分析（2026-10-12）──────────────────
  const renderTriage = (r, th) => {
    s.state = { label: '评估完成', cls: 'badge ok' };
    // 耗时与引擎说明移进结果卡（.ev-meta），提示行不再重复
    s.hint = '';
    const t = r.triage || {};
    const score = t.score != null ? Number(t.score) : null;
    s.triageScore = score;
    s.reportBtnShown = false;
    // 新一轮初筛 = 旧的后台生成状态条作废；初筛 HTML 存会话，
    // 「生成报告」后台跑期间和完成后都靠它保留匹配分析。
    s.fullBgNotice = '';
    if (score == null) {
      s.triageHtml = '<div class="notice warn"><b>没能从 AI 输出里解析出分数</b>'
        + '<p>AI 返回了内容但格式不标准。原始输出在下方，可以直接看。</p></div>';
    } else {
      s.triageHtml = buildMatchReport(t, th, {
        ms: r.ms || 0,
        engineLabel: r.engine === 'ollama' ? '本地模型' : 'CodeBuddy',
      });
      // 成功了原始输出就没必要再占一屏（结果已经渲染成卡片），收起来
      s.logShown = false;
    }
    s.result = s.triageHtml + matchActionsHtml();
    paintEval();
    toast(score != null ? '评估完成：' + Math.round((score / 5) * 100) + '/100'
      : '评估完成', score != null && score < th ? 'warn' : 'ok');
  };

  // ── 完整评估（后台）完成：顶部状态条换成「已生成」+ 报告直达入口，
  // 初筛匹配分析原样保留 —— 不再像旧版那样把结果区整个换掉 ──────────
  const renderFull = async (r, myRun) => {
    s.state = { label: '报告已生成', cls: 'badge ok' };
    s.hint = '<b style="color:var(--ok-ink)">完整报告已生成</b>，'
      + '耗时 ' + (r.ms / 1000).toFixed(0) + ' 秒。'
      + (s.triageScore != null ? '初筛分 ' + s.triageScore + '/5，' : '')
      + '逐条评分依据见报告文件。';

    // 报告文件：优先用服务端对比出来的「本次新增」，退而取最新三个。
    let newFiles = [];
    try {
      const reps = await api('/api/reports');
      S.reports = reps;
      const want = new Set(r.newReports || []);
      const hit = reps.filter((f) => want.has(f.file));
      newFiles = hit.length ? hit : reps.slice(0, 3);
    } catch { /* 报告没写出来也不影响主流程 */ }
    if (myRun !== s.runId) return;   // 这期间被新一轮评估取代了

    s.fullBg = null;
    s.fullBgNotice = '<div class="notice ok"><b>完整报告已生成</b>'
      + '（耗时 ' + (r.ms / 1000).toFixed(0) + ' 秒）'
      + (s.triageScore != null ? '：初筛分 ' + s.triageScore + '/5' : '')
      + (newFiles.length
        ? '<div class="row tight" style="margin-top:8px">'
          + newFiles.map((f) => '<button class="btn sm" type="button" data-open-report="' + esc(f.file) + '">'
            + esc(f.title || f.file) + (f.score ? ' · ' + esc(f.score) : '') + '</button>').join('')
          + '</div>'
        : '<p class="hint" style="margin:8px 0 0">没在 reports/ 里发现新报告，'
          + 'AI 可能只给了评分没落盘——看下面的输出确认。</p>')
      + '</div>';
    s.result = s.fullBgNotice + (s.triageHtml || '') + matchActionsHtml();
    // 没找到落盘文件时才把原始输出亮出来（配合「看下面的输出确认」）；正常
    // 情况日志不显示 —— 几十 KB 的报告原文挂在页面上没有信息量
    if (!newFiles.length) s.logShown = true;

    s.reportBtnShown = true;
    paintEval();
    // 等 4–10 分钟才响一次的提醒：不自动消失（切到别的页也能看到），手动关
    toast(s.triageScore != null
      ? '完整报告已生成：' + s.triageScore + '/5，回评估页点报告名查看'
      : '完整报告已生成，回评估页查看', 'ok', { duration: 0 });
  };

  // ══ 评估主流程 ══════════════════════════════════════════
  // phase = 'triage' → 匹配分析（快，mockup 的「开始AI评估」）
  // phase = 'full'   → A–H 报告 + 写盘 + 台账（慢，次级入口）
  const runEval = async (phase) => {
    const isTriage = phase !== 'full';
    const j = (($('#evJd') || {}).value || s.jd || '').trim();

    // ── 就地校验 ────────────────────────────────────────────
    setFieldError($('#evJd'), '');
    if (!j) {
      setFieldError($('#evJd'), 'JD 是评估的输入 —— 先把岗位描述粘进来。');
      if ($('#evJd')) $('#evJd').focus();
      return;
    }
    if (j.length > 30000) {
      setFieldError($('#evJd'), 'JD 正文太长了（上限 3 万字符），删掉福利、公司介绍等无关段落再试。');
      return;
    }

    // ── 开跑：递增代次，上一轮结果作废 ───────────────────────
    s.runId += 1;
    s.jd = j;
    const myRun = s.runId;
    s.running = true;
    s.triageScore = isTriage ? null : s.triageScore;
    if (isTriage) {
      // 初筛是主流程：清空结果区出骨架屏，等结果
      s.state = { label: 'AI 评估中', cls: 'badge warn' };
      // 提示句已按用户要求删除，只留转圈（状态徽标同时显示「AI 评估中」）
      s.hint = '<span class="spinner" aria-hidden="true"></span>';
      s.fullBg = null;
      s.fullBgNotice = '';
      s.reportBtnShown = false;
      s.result = '';
    } else {
      // 完整报告**后台**生成（2026-09-26）：结果区原样保留初筛分析，
      // 只换顶部状态条 + 禁用「生成报告」按钮，完成后再提醒。
      s.state = { label: '后台生成中', cls: 'badge warn' };
      s.hint = '<span class="spinner" aria-hidden="true"></span> 完整报告正在后台生成'
        + '<b>（实测 4–10 分钟，好了会提醒你）</b>；上面的匹配分析可以继续看。';
      s.fullBg = 'running';
      s.fullBgNotice = '<div class="notice info"><b>完整报告正在后台生成…</b>'
        + '<p>实测 4–10 分钟，<b>好了会提醒你</b>。这份匹配分析不受影响，可以继续看；'
        + '切到别的页面也没关系。</p></div>';
      s.result = s.fullBgNotice + (s.triageHtml || '') + matchActionsHtml();
    }
    // 日志只给初筛开（等待时有陪伴感、失败时有诊断价值）；完整报告走后台，
    // 原始输出几十 KB 挂在页面上没有信息量（2026-09-26 用户要求删掉这个黑块）。
    s.logShown = isTriage;
    s.log = (isTriage ? '正在做匹配评估 …\n\n' : '正在后台生成完整报告 …\n\n')
      + 'JD：' + j.slice(0, 200) + (j.length > 200 ? ' …' : '') + '\n'
      + '简历来源：' + (s.cvFile ? s.cvFile.name : '在线简历编辑器内容（cv.md）') + '\n';
    paintEval();
    // 初筛滚到结果卡；后台生成**不抢滚动位置**，用户正在看分析
    const oc = $('#evOutCard');
    if (oc && isTriage) oc.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    try {
      const r = await api('/api/eval', {
        method: 'POST',
        timeout: isTriage ? 360000 : 1860000,
        // cvText：上传的简历正文（''/undefined = 服务端用 cv.md，行为同 base）
        // cvVersion：用哪份简历做评估（'base' = 原版 cv.md；其它 = 某个版本）。
        // 服务端优先级是 cvText > cvVersion > cv.md，所以两个一起发是安全的 ——
        // 上传了就用上传的，没上传才轮到这里的版本选择。
        body: { jd: j, phase, cvText: s.cvText || undefined,
                cvVersion: s.cvVersion || 'base' },
      });
      // 期间被新一轮评估取代，这次的结果已经不属于当前页面
      if (myRun !== s.runId) return;

      const body = [r.output, r.stderr].filter(Boolean).join('\n').trim();
      s.log = body || '（AI 没有返回内容）';

      if (!r.ok) {
        s.state = { label: '未完成', cls: 'badge bad' };
        s.hint = '<b style="color:var(--bad-ink)">'
          + esc(r.friendly || ('AI 退出码 ' + r.code)) + '</b>'
          + (r.friendly ? '' : ' 原始输出见下。');
        if (!isTriage) {
          // 后台生成失败：初筛分析原样保留，顶部换一条失败说明
          s.fullBg = null;
          s.fullBgNotice = '<div class="notice warn"><b>完整报告没有生成成功</b>'
            + '<p>' + esc(r.friendly || ('AI 退出码 ' + r.code))
            + '。上面的匹配分析不受影响，可以直接重试。</p></div>';
          s.result = s.fullBgNotice + (s.triageHtml || '') + matchActionsHtml();
        }
        paintEval();
        return;
      }

      if (isTriage) renderTriage(r, TH);
      else await renderFull(r, myRun);

      // 数据变了，清缓存让别的页面重新拉
      S.stats = null;
    } catch (err) {
      if (myRun !== s.runId) return;
      s.state = { label: '失败', cls: 'badge bad' };
      s.log = '✖ ' + err.message;
      s.hint = '<b style="color:var(--bad-ink)">请求失败。</b>'
        + (isTriage
          ? '评估一般不会超时，可以先刷新页面重试一次。'
          : '完整评估很慢，超时后它可能仍在后台跑——过一会儿去「评估报告」看看有没有新文件。');
      if (!isTriage) {
        s.fullBg = null;
        s.fullBgNotice = '<div class="notice warn"><b>完整报告请求失败</b>'
          + '<p>' + esc(err.message)
          + '。超时后它可能仍在后台跑，过一会儿去「评估报告」看看；'
          + '上面的匹配分析不受影响。</p></div>';
        s.result = s.fullBgNotice + (s.triageHtml || '') + matchActionsHtml();
      }
      paintEval();
    } finally {
      // 只有还是当前这一代才收尾：被取代过的话，忙态已经由新一轮清掉了
      if (myRun === s.runId) {
        s.running = false;
        paintEval();
      }
    }
  };

  // ── AI 简历优化（弹窗里的「开始AI优化」）─────────────────────
  // 只出稿：改写稿留在弹窗预览里，用户确认后带去「我的简历」页应用。
  const runOptimize = async () => {
    const j = (($('#evJd') || {}).value || s.jd || '').trim();
    if (!j) {
      s.optOpen = false;
      paintOptModal();
      toast('优化要贴着岗位写 —— 先回评估页把 JD 粘进输入框再优化', 'warn');
      return;
    }
    s.jd = j;
    const scope = $$('#optimizeModal input[name="optScope"]:checked').map((i) => i.value);
    const styleEl = $('#evOptStyle');
    const extraEl = $('#evOptExtra');
    s.optRunning = true;
    s.optResult = null;
    paintOptModal();
    try {
      const r = await api('/api/cv/optimize', {
        method: 'POST',
        timeout: 660000,
        body: { jd: j, target: 'base', opts: { scope, style: styleEl ? styleEl.value : '', extra: extraEl ? extraEl.value : '' } },
      });
      if (!r.ok || !r.parsed || !r.parsed.draft) {
        s.optResult = { error: r.friendly || (r.parsed && r.parsed.parseError)
          || 'AI 没有产出可用的改写稿，重试一次或稍后再来。' };
      } else {
        s.optResult = { summary: r.parsed.summary || '', issues: r.parsed.issues || [], draft: r.parsed.draft };
      }
    } catch (err) {
      s.optResult = { error: '请求失败：' + err.message };
    }
    s.optRunning = false;
    paintOptModal();
  };

  // 「用哪份简历做评估」下拉：灌版本选项、恢复上次选择、挂 change。
  // 放在事件绑定之前，选项和值都得在用户点之前就位。
  fillEvalCvVerSelect(s, cvVers);

  // ══ 事件绑定 ════════════════════════════════════════════
  const jd = $('#evJd');

  // 输入 → 会话。反向（会话 → 输入）只在 paintEval 里做，
  // 所以打字过程中不会被回填覆盖。
  jd.addEventListener('input', pullEvalInputs);

  // ── 上传区 ──────────────────────────────────────────────────
  const drop = $('#evDrop');
  const fileInput = $('#evFile');
  $('#evFilePick').addEventListener('click', (e) => {
    e.stopPropagation();          // 按钮在 dropzone 里，别让点击冒泡再开一次文件框
    fileInput.click();
  });
  drop.addEventListener('click', (e) => {
    if (e.target.closest('#evFilePick')) return;
    fileInput.click();
  });
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) handleCvFile(fileInput.files[0]);
    // 清空 value：连续两次选同一个文件也要能触发 change
    fileInput.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    drop.classList.add('is-dropping');
  });
  drop.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && drop.contains(e.relatedTarget)) return;
    drop.classList.remove('is-dropping');
  });
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-dropping');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) handleCvFile(files[0]);
  });
  // 「已读取 xxx」摘要区每次重绘都是新节点 → 事件委托（同 #evResult 的做法）
  $('#evCvFileInfo').addEventListener('click', (e) => {
    if (!e.target.closest('[data-act="clearCv"]')) return;
    s.cvText = ''; s.cvFile = null; s.cvErr = '';
    paintEvalUpload();
  });
  // mockup 的「或者：读取在线简历编辑器内容」：切回编辑器来源
  $('#evUseEditor').addEventListener('click', () => {
    const had = !!(s.cvFile || s.cvText);
    s.cvText = ''; s.cvFile = null; s.cvErr = '';
    paintEvalUpload();
    toast(had ? '已改用在线简历编辑器内容（cv.md）' : '本次评估将使用在线简历编辑器里的内容（cv.md）', 'ok');
  });

  // ── 开始AI评估 ──────────────────────────────────────────────
  $('#evGo').addEventListener('click', () => runEval('triage'));

  // 报告卡里的按钮是 innerHTML 重绘出来的 → 事件委托绑在容器上，
  // 重绘多少次都还能点。
  $('#evResult').addEventListener('click', (e) => {
    const ob = e.target.closest('[data-open-report]');
    if (ob) { openReport(ob.dataset.openReport); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'cv') { go('cv'); return; }
    // 换个岗位再评（2026-10-12 新版式）：清掉这一轮的结果，焦点回 JD 输入框
    if (act === 'again') {
      s.result = '';
      s.triageHtml = '';
      s.triageScore = null;
      s.fullBg = null;
      s.fullBgNotice = '';
      s.reportBtnShown = false;
      s.state = { label: '待评估', cls: 'badge' };
      s.hint = '';
      paintEval();
      const ta = $('#evJd');
      if (ta) { ta.focus(); if (ta.select) ta.select(); }
      return;
    }
    if (act === 'report') { go('reports'); return; }
    if (act === 'opt') {
      s.optOpen = true;
      paintOptModal();
      const first = $('#optimizeModal input, #optimizeModal select');
      if (first) first.focus();
      return;
    }
    if (act === 'full') {
      // 2026-10-12：完整报告不再跟随引擎卡 —— 服务端优先 CodeBuddy、本地兜底
      // （旧的「本地模型写不了盘」前置守卫已删：它按引擎卡的选择误拦，
      //  而 full 现在自己选引擎，拦了反而把能跑的一单挡掉）。
      runEval('full');
      return;
    }
    if (act === 'applyOpt') {
      if (!(s.optResult && s.optResult.draft)) return;
      S.pendingCvOptDraft = {
        draft: s.optResult.draft,
        summary: s.optResult.summary || '',
        issues: s.optResult.issues || [],
        jd: (s.jd || '').trim(),
      };
      s.optOpen = false;
      paintOptModal();
      go('cv');
      toast('改写稿已带到「我的简历」页，确认后点「应用」才会写回', 'ok');
    }
  });

  // ── AI 优化弹窗 ─────────────────────────────────────────────
  $$('[data-opt-close]', $('#optimizeModal')).forEach((b) => b.addEventListener('click', () => {
    s.optOpen = false;
    paintOptModal();
  }));
  $('#optimizeModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      s.optOpen = false;
      paintOptModal();
    }
  });
  $('#evOptGo').addEventListener('click', runOptimize);

  // 从别的页面切回来：把上次的输入、分数、日志、结论原样铺回来
  paintEval();
};

// ══ 批量初筛的事件绑定（「全部脚本」页用）══════════════════
// 批量卡已从「岗位评估」页迁到「全部脚本」页（VIEWS.tools），
// 绑定抽成独立函数：视图渲染完调一次，paintEvalBatch 重绘的只是
// 卡片内部的子节点，这里的绑定都挂在卡片自身的固定节点上，不受影响。
function wireEvalBatch() {
  const s = S.evalSession;
  if (!s || !$('#evBatchJd')) return;
  const bjd = $('#evBatchJd');
  bjd.value = s.batch.text;                 // 会话 → 输入框（只在进页面这一次）
  bjd.addEventListener('input', () => { s.batch.text = bjd.value; paintBatchCount(); });
  paintBatchCount();

  // ── 导入文档 ──────────────────────────────────────────────────
  const pick = $('#evBatchPick');
  const fileInput = $('#evBatchFile');
  pick.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    if (files && files.length) importBatchDocs(files);
    // 清空 value：不然连续两次选同一个文件不会再触发 change，
    // 用户会以为「第二次点导入没反应」
    fileInput.value = '';
  });

  // 拖拽导入绑在**整张卡片**上，不是只绑 textarea：拖文件的人瞄准的是
  // 「这块区域」，要求他精确落在输入框里没有必要。拖进来时给整张卡片描边。
  const card = $('#evBatchCard');
  card.addEventListener('dragover', (e) => {
    // 只接管文件。拖一段文字进来仍走浏览器默认行为（插到光标处）。
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    card.classList.add('is-dropping');
  });
  card.addEventListener('dragleave', (e) => {
    // 在子元素之间移动也会触发 dragleave，看 relatedTarget 是否还在卡片里
    if (e.relatedTarget && card.contains(e.relatedTarget)) return;
    card.classList.remove('is-dropping');
  });
  card.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    card.classList.remove('is-dropping');
    importBatchDocs(files);
  });

  // 摘要区每次都是重绘的新节点 → 事件委托（同 #evBatchOut 的做法）
  $('#evBatchImport').addEventListener('click', (e) => {
    if (!e.target.closest('#evBatchUndo')) return;
    const imp = s.batch.imported;
    if (!imp || !imp.prev) return;
    s.batch.text = imp.prev;
    bjd.value = imp.prev;
    // 只给一次撤销机会：撤完按钮就消失，避免反复横跳时自己也记不清哪份是哪份
    imp.prev = '';
    imp.names = []; imp.warnings = []; imp.failed = []; imp.blocks = 0;
    paintBatchImport(); paintBatchCount(); paintEvalBatch();
    toast('已恢复导入前的文本（导入的岗位已退出输入框）', 'ok');
  });

  $('#evBatchGo').addEventListener('click', () => { runBatchEval(); });

  $('#evBatchStop').addEventListener('click', () => {
    const b = s.batch;
    b.runId += 1;                           // 递增即让在跑的循环作废
    b.running = false; b.current = null;
    // 还没跑的占位行标成「已停」，而不是留着「待跑」——
    // 否则停止后表格看起来像还在排队等。
    b.rows = b.rows.map((r) => (r.state === 'pending' || r.state === 'running'
      ? { ...r, state: 'stopped' } : r));
    paintEvalBatch();
    toast('已停止。已经跑完的行仍然可以用。', 'warn');
  });

  $('#evBatchClear').addEventListener('click', () => {
    const b = s.batch;
    if (b.running) { b.runId += 1; b.running = false; }
    b.text = ''; b.items = []; b.rows = []; b.done = 0; b.total = 0;
    b.current = null; b.copyMsg = ''; b.sortBy = 'score';
    b.imported = null;                      // 清空 = 连「上次导入了什么」一起清掉
    bjd.value = '';
    paintBatchCount(); paintBatchImport(); paintEvalBatch();
  });

  $('#evBatchDemo').addEventListener('click', () => {
    bjd.value = BATCH_DEMO;
    s.batch.text = bjd.value;
    // 填入示例 = 换了一份输入，导入摘要（说的是另一份文件）必须跟着消失，
    // 否则卡片上会同时挂着「已读入 岗位清单.xlsx」和一段示例文本
    s.batch.imported = null;
    paintBatchCount(); paintBatchImport();
    bjd.focus();
  });

  // 批量结果区每次重绘都是新节点 → 事件委托（同 #evResult 的做法）
  $('#evBatchOut').addEventListener('click', (e) => {
    const b = s.batch;

    if (e.target.closest('[data-batch-sort]')) {
      b.sortBy = b.sortBy === 'score' ? 'order' : 'score';
      paintEvalBatch();
      return;
    }

    if (e.target.closest('[data-batch-copy]')) {
      // 只复制有结果的行：待跑/跑着的行复制出去没有意义
      const rows = b.rows.filter((r) => r.state !== 'pending' && r.state !== 'running');
      if (!rows.length) { toast('还没有可复制的结果', 'warn'); return; }
      const md = batchRowsToMarkdown(rows, { threshold: S.evalThreshold });
      const done = () => {
        b.copyMsg = '已复制 ' + rows.length + ' 行';
        paintEvalBatch();
        // 提示两秒后自己消失（再重绘一次即可）
        setTimeout(() => { b.copyMsg = ''; paintEvalBatch(); }, 2500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(md).then(done, () => toast('复制失败，请手动框选表格', 'warn'));
      } else {
        toast('这个浏览器不支持自动复制，手动框选表格吧', 'warn');
      }
      return;
    }

    const fill = e.target.closest('[data-batch-fill]');
    if (fill) {
      const row = b.rows.find((r) => String(r.index) === fill.dataset.batchFill);
      if (!row) return;
      // 批量只给分数和一句理由，想看细节得走单条评估。批量卡在「全部脚本」页，
      // 单条输入框在「岗位评估」页 —— 做成跨页交接：JD 写进会话，跳过去直接能评。
      s.jd = row.jd;
      go('evaluate');
      toast('已把「' + row.label + '」带到「岗位评估」页，可以直接开始AI评估', 'ok');
    }
  });

  paintEvalBatch();
}

// ══ 视图：登录 / 注册（用户端入口，管理端仅登录）══════════
// 按登录页选的入口校验身份：身份与入口不符会得到一句明确的提示，
// 而不是笼统的「密码错误」。成功后按角色分流 —— 管理员进后台，用户回首页。
// 「注册」只开在用户端：自助注册一律建普通用户账号，管理员账号必须由
// 管理员在后台创建（防止任何人把自己注册成管理员）。注册成功即自动登录。
VIEWS.login = async function (view) {
  // 已登录还点进登录页：直接送回各自的大本营。
  if (S.session) {
    location.replace(location.pathname + (S.session.role === 'admin' ? '#admin' : '#home'));
    return;
  }

  let role = 'user';   // 登录页签：按哪个入口校验身份
  let mode = 'login';  // 'login' | 'register'
  view.innerHTML = '<div class="login-wrap"><div class="card login-card" id="loginCard"></div></div>';
  const card = $('#loginCard', view);

  // 卡片在两种模式间整体重建 —— 事件都在 render() 里重挂，唯一共享的
  // Enter 监听挂在 card 上只挂一次（render 重跑不会叠加出双提交）。
  card.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    const btn = mode === 'login' ? $('#loginGo', card) : $('#regGo', card);
    if (btn) btn.click();
  });

  const brandHtml = (t, s) => '<div class="login-brand">'
    + '<span class="login-mark" aria-hidden="true">历</span>'
    + '<div class="login-brand-t"><b>' + t + '</b><span>' + s + '</span></div>'
    + '</div>';
  const backHtml = '<button class="btn sm ghost" type="button" id="loginBack">← 回到首页</button>';

  const render = () => {
    card.innerHTML = mode === 'login' ? (
      brandHtml('登录历琢', '用户端与管理端共用一个入口，按账号身份进入')
      + '<div class="login-roles" aria-label="登录身份">'
      + '<button class="login-role is-active" type="button" data-role="user" aria-pressed="true">用户端</button>'
      + '<button class="login-role" type="button" data-role="admin" aria-pressed="false">管理端</button>'
      + '</div>'
      + '<label class="login-field"><span>账号</span>'
      + '<input class="input" id="loginUser" autocomplete="username" placeholder="用户名"></label>'
      + '<label class="login-field"><span>密码</span>'
      + '<input class="input" type="password" id="loginPass" autocomplete="current-password" placeholder="密码"></label>'
      + '<div class="notice bad" id="loginErr" hidden></div>'
      + '<button class="btn lg primary login-go" type="button" id="loginGo">登 录</button>'
      + '<p class="login-hint">演示账号 —— 用户端：<code>demo / 123456</code>　管理端：<code>admin / admin123</code></p>'
      + '<div class="row tight" style="justify-content:space-between">'
      + '<button class="btn sm ghost" type="button" id="toReg">没有账号？注册一个</button>'
      + backHtml + '</div>'
    ) : (
      brandHtml('创建新账号', '注册即用户端账号，注册后自动登录')
      + '<label class="login-field"><span>用户名</span>'
      + '<input class="input" id="regUser" autocomplete="username" placeholder="小写字母 / 数字，2-20 位"></label>'
      + '<label class="login-field"><span>昵称（可空）</span>'
      + '<input class="input" id="regDisplay" autocomplete="nickname" placeholder="怎么称呼你"></label>'
      + '<label class="login-field"><span>密码</span>'
      + '<input class="input" type="password" id="regPass" autocomplete="new-password" placeholder="至少 6 位"></label>'
      + '<label class="login-field"><span>确认密码</span>'
      + '<input class="input" type="password" id="regPass2" autocomplete="new-password" placeholder="再输一遍"></label>'
      + '<div class="notice bad" id="loginErr" hidden></div>'
      + '<button class="btn lg primary login-go" type="button" id="regGo">注册并登录</button>'
      + '<div class="row tight" style="justify-content:space-between">'
      + '<button class="btn sm ghost" type="button" id="toLogin">已有账号？去登录</button>'
      + backHtml + '</div>'
    );

    const err = $('#loginErr', card);
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    $('#loginBack', card).addEventListener('click', () => go('home'));

    if (mode === 'login') {
      const setRole = (r) => {
        role = r;
        $$('.login-role', card).forEach((b) => {
          const on = b.dataset.role === r;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-pressed', String(on));
        });
      };
      $$('.login-role', card).forEach((b) => b.addEventListener('click', () => setRole(b.dataset.role)));
      $('#toReg', card).addEventListener('click', () => { mode = 'register'; render(); });

      const submit = async () => {
        const u = $('#loginUser', card).value.trim();
        const p = $('#loginPass', card).value;
        err.hidden = true;
        if (!u || !p) { fail('请输入账号和密码'); return; }
        const btn = $('#loginGo', card);
        busy(btn, true, '登录中…');
        try {
          const r = await api('/api/auth/login', { method: 'POST', body: { username: u, password: p, role } });
          saveSession(r.session);
          toast('欢迎回来，' + (r.session.name || r.session.username), 'ok');
          go(r.session.role === 'admin' ? 'admin' : 'home');
        } catch (e) {
          fail(e.message || '登录失败');
        } finally {
          busy(btn, false);
        }
      };
      $('#loginGo', card).addEventListener('click', submit);
    } else {
      $('#toLogin', card).addEventListener('click', () => { mode = 'login'; render(); });

      const submit = async () => {
        const u = $('#regUser', card).value.trim().toLowerCase();
        const d = $('#regDisplay', card).value.trim();
        const p = $('#regPass', card).value;
        const p2 = $('#regPass2', card).value;
        err.hidden = true;
        if (!u || !p) { fail('请填写用户名和密码'); return; }
        if (p.length < 6) { fail('密码至少 6 位'); return; }
        if (p !== p2) { fail('两次输入的密码不一致'); return; }
        const btn = $('#regGo', card);
        busy(btn, true, '注册中…');
        try {
          const r = await api('/api/auth/register', { method: 'POST', body: { username: u, displayName: d, password: p } });
          saveSession(r.session);
          toast('注册成功，欢迎加入，' + (r.session.name || r.session.username), 'ok');
          go('home');
        } catch (e) {
          fail(e.message || '注册失败');
        } finally {
          busy(btn, false);
        }
      };
      $('#regGo', card).addEventListener('click', submit);
    }
  };
  render();
};

// ══ 视图：管理后台（用户管理 / 用户反馈 / 使用情况）════════
// 进得来这里说明已经是管理员（门禁在 route()）。三个页签的数据在进页时一次
// 拉齐，写操作成功后整页重画 —— 数据量都是小几十条，不值得做增量更新。
function adminBars(series, tone) {
  // series: [{ label, v }]；tone 是 CSS 颜色令牌名。纯 CSS 柱状图，零 CDN。
  const max = Math.max(1, ...series.map((s) => s.v));
  return '<div class="admin-chart" aria-hidden="true">' + series.map((s) =>
    '<div class="admin-col" title="' + esc(s.label) + '：' + s.v + '">'
    + '<span class="admin-col-v">' + (s.v || '') + '</span>'
    + '<i class="admin-col-bar" style="height:'
    + Math.max(s.v ? 4 : 0, Math.round((s.v / max) * 70)) + '%;background:var(' + tone + ')"></i>'
    + '<span class="admin-col-l">' + esc(s.label) + '</span>'
    + '</div>').join('') + '</div>';
}

VIEWS.admin = async function (view) {
  const fetchData = () => Promise.all([
    api('/api/admin/users'), api('/api/admin/feedback'), api('/api/admin/usage'),
  ]).then(([u, f, g]) => { S.admin = { users: u.users, feedback: f.items, usage: g }; });
  try {
    await fetchData();
  } catch (err) {
    view.innerHTML = errorState(err, true);
    wireActions(view, [{ label: '重试', primary: true, onClick: () => route() }]);
    return;
  }

  view.innerHTML = '<div class="admin">'
    + '<div class="admin-head">'
    + '<div class="admin-tabs" role="tablist" aria-label="管理后台">'
    + '<button class="admin-tab is-active" type="button" role="tab" aria-selected="true" data-tab="users">用户管理</button>'
    + '<button class="admin-tab" type="button" role="tab" aria-selected="false" data-tab="feedback">用户反馈</button>'
    + '<button class="admin-tab" type="button" role="tab" aria-selected="false" data-tab="usage">使用情况</button>'
    + '</div>'
    + '<button class="btn sm" type="button" data-admin-go="home">回到用户端 →</button>'
    + '</div>'
    + '<div id="adminBody"></div>'
    + '</div>';

  // ── 页签 1：用户管理 ──────────────────────────────────────────
  const usersHtml = () => {
    const rows = S.admin.users.map((u) => {
      const ops = S.adminEditPw === u.id
        ? '<span class="pw-edit"><input class="input" type="text" id="pwInput" placeholder="新密码（至少 6 位）">'
          + '<button class="btn sm primary" type="button" data-pw-save="' + u.id + '">保存</button>'
          + '<button class="btn sm ghost" type="button" data-pw-cancel="1">取消</button></span>'
        : '<button class="btn sm" type="button" data-pw-edit="' + u.id + '">修改密码</button>';
      return '<tr><td><b>' + esc(u.username) + '</b></td>'
        + '<td>' + esc(u.displayName || '—') + '</td>'
        + '<td>' + (u.role === 'admin' ? '<span class="badge">管理员</span>' : '用户') + '</td>'
        + '<td class="dim">' + esc((u.createdAt || '').slice(0, 10) || '—') + '</td>'
        + '<td class="dim">' + esc(u.lastLogin ? fmtTime(new Date(u.lastLogin).getTime()) : '—') + '</td>'
        + '<td class="admin-ops">' + ops + '</td></tr>';
    }).join('');
    const addForm = S.adminAddOpen
      ? '<div class="card admin-add"><div class="admin-add-grid">'
        + '<label class="login-field"><span>用户名</span><input class="input" id="nuName" placeholder="小写字母/数字，2-20 位"></label>'
        + '<label class="login-field"><span>昵称</span><input class="input" id="nuDisplay" placeholder="显示名称（可空）"></label>'
        + '<label class="login-field"><span>初始密码</span><input class="input" id="nuPass" placeholder="至少 6 位"></label>'
        + '<label class="login-field"><span>身份</span><select class="select" id="nuRole"><option value="user">用户</option><option value="admin">管理员</option></select></label>'
        + '</div><div class="row tight">'
        + '<button class="btn sm primary" type="button" id="nuGo">创建用户</button>'
        + '<button class="btn sm ghost" type="button" id="nuCancel">取消</button></div></div>'
      : '';
    return '<div class="row tight" style="margin-bottom:12px">'
      + '<button class="btn sm primary" type="button" id="nuOpen">＋ 新增用户</button>'
      + '<span class="hint">共 ' + S.admin.users.length + ' 个账号；改密码立即生效，用户下次登录用新密码</span></div>'
      + addForm
      + '<div class="card" style="padding:0;overflow:hidden"><div class="table-wrap"><table class="data">'
      + '<thead><tr><th>用户名</th><th>昵称</th><th>身份</th><th>注册时间</th><th>最近登录</th><th>操作</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div></div>';
  };

  // ── 页签 2：用户反馈 ──────────────────────────────────────────
  const feedbackHtml = () => {
    const row = (x) => '<div class="card fb-item' + (x.status === 'pending' ? '' : ' is-done') + '">'
      + '<div class="fb-head"><span class="fb-status">' + (x.status === 'pending' ? '待处理' : '已处理') + '</span>'
      + '<span class="fb-meta">' + esc(x.user) + ' · ' + fmtTime(new Date(x.t).getTime()) + '</span></div>'
      + '<p class="fb-text">' + esc(x.text) + '</p>'
      + '<button class="btn sm' + (x.status === 'pending' ? '' : ' ghost') + '" type="button" data-fb-toggle="' + x.id + '">'
      + (x.status === 'pending' ? '标记已处理' : '标回待处理') + '</button></div>';
    const pend = S.admin.feedback.filter((x) => x.status === 'pending');
    const done = S.admin.feedback.filter((x) => x.status !== 'pending');
    return '<h3 class="admin-sec-t">待处理（' + pend.length + '）</h3>'
      + (pend.map(row).join('') || '<div class="card empty-ish">没有待处理的反馈</div>')
      + '<h3 class="admin-sec-t">已处理（' + done.length + '）</h3>'
      + (done.map(row).join('') || '<div class="card empty-ish">暂无</div>');
  };

  // ── 页签 3：使用情况 ──────────────────────────────────────────
  const usageHtml = () => {
    const g = S.admin.usage;
    const cards = [
      ['注册用户', g.totals.users, '个账号'],
      ['累计登录', g.totals.logins, '次'],
      ['评估报告', g.totals.reports, '份'],
      ['待处理反馈', g.totals.pending, '条'],
    ];
    return '<div class="stat-grid">' + cards.map(([k, v, u]) =>
      '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '<small>' + u + '</small></div></div>').join('') + '</div>'
      + '<div class="card"><h2>近 14 天登录</h2>' + adminBars(g.days.map((d) => ({ label: d.label, v: d.logins })), '--accent') + '</div>'
      + '<div class="card"><h2>近 14 天新增评估报告</h2>' + adminBars(g.days.map((d) => ({ label: d.label, v: d.reports })), '--accent-2') + '</div>'
      + '<div class="card" style="padding:0;overflow:hidden"><div class="table-wrap"><table class="data">'
      + '<thead><tr><th>用户</th><th>身份</th><th>登录次数</th><th>最近登录</th></tr></thead><tbody>'
      + g.userRows.map((r) => '<tr><td><b>' + esc(r.displayName || r.username) + '</b> <span class="dim">@' + esc(r.username) + '</span></td>'
        + '<td>' + (r.role === 'admin' ? '管理员' : '用户') + '</td>'
        + '<td>' + r.logins + '</td>'
        + '<td class="dim">' + esc(r.lastLogin ? fmtTime(new Date(r.lastLogin).getTime()) : '—') + '</td></tr>').join('')
      + '</tbody></table></div></div>';
  };

  const paintBody = () => {
    const tab = S.adminTab || 'users';
    $$('.admin-tab', view).forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    });
    const body = $('#adminBody', view);
    if (tab === 'users') body.innerHTML = usersHtml();
    else if (tab === 'feedback') body.innerHTML = feedbackHtml();
    else body.innerHTML = usageHtml();
    wireBody(body);
  };

  const reload = async () => {
    await fetchData();
    paintBody();
  };

  const wireBody = (body) => {
    const tab = S.adminTab || 'users';
    if (tab === 'users') {
      const open = $('#nuOpen', body);
      if (open) open.addEventListener('click', () => { S.adminAddOpen = true; paintBody(); });
      const cancel = $('#nuCancel', body);
      if (cancel) cancel.addEventListener('click', () => { S.adminAddOpen = false; paintBody(); });
      const nuGo = $('#nuGo', body);
      if (nuGo) nuGo.addEventListener('click', async () => {
        try {
          await api('/api/admin/users', { method: 'POST', body: {
            username: $('#nuName', body).value.trim(),
            displayName: $('#nuDisplay', body).value.trim(),
            password: $('#nuPass', body).value,
            role: $('#nuRole', body).value,
          } });
          toast('用户已创建', 'ok');
          S.adminAddOpen = false;
          await reload();
        } catch (e) { toast(e.message || '创建失败', 'bad'); }
      });
      $$('[data-pw-edit]', body).forEach((b) => b.addEventListener('click', () => {
        S.adminEditPw = b.dataset.pwEdit;
        paintBody();
      }));
      const cancelPw = $('[data-pw-cancel]', body);
      if (cancelPw) cancelPw.addEventListener('click', () => { S.adminEditPw = null; paintBody(); });
      $$('[data-pw-save]', body).forEach((b) => b.addEventListener('click', async () => {
        try {
          await api('/api/admin/users/password', { method: 'POST', body: { id: b.dataset.pwSave, password: $('#pwInput', body).value } });
          toast('密码已更新', 'ok');
          S.adminEditPw = null;
          await reload();
        } catch (e) { toast(e.message || '修改失败', 'bad'); }
      }));
    } else if (tab === 'feedback') {
      $$('[data-fb-toggle]', body).forEach((b) => b.addEventListener('click', async () => {
        const item = S.admin.feedback.find((x) => x.id === b.dataset.fbToggle);
        const next = item && item.status === 'pending' ? 'done' : 'pending';
        try {
          await api('/api/admin/feedback/status', { method: 'POST', body: { id: b.dataset.fbToggle, status: next } });
          await reload();
        } catch (e) { toast(e.message || '操作失败', 'bad'); }
      }));
    }
  };

  $$('.admin-tab', view).forEach((b) => b.addEventListener('click', () => { S.adminTab = b.dataset.tab; paintBody(); }));
  $$('[data-admin-go]', view).forEach((b) => b.addEventListener('click', () => go('home')));
  paintBody();
};

// ══ 视图：首页（网站首页落地页）═══════════════════════════
// 对照 mockup《网站首页.html》：Hero → 四大能力 → 三步流程 → 用户反馈 →
// CTA 带 → FAQ → 深色页脚。三处刻意的本地化改写（取舍见 style.css §27 头注）：
//   1. mockup 顶部的固定导航条不搬 —— 外壳顶栏已经承担导航；
//   2. hero 的 picsum 外链占位图不搬 —— 2026-09-26 按需求删除装饰插画，
//      hero 只留文字与按钮（本项目零 CDN、离线可用，页面无外部请求）；
//   3. 页内锚点不能用 <a href="#xxx">（改 hash 会触发路由），滚动跳转
//      用按钮 + scrollIntoView，视图切换一律走 go()。

VIEWS.home = async function (view) {
  const feat = (ico, title, desc) => '<div class="home-card">'
    + '<span class="home-ico" aria-hidden="true">' + icon(ico) + '</span>'
    + '<h3>' + esc(title) + '</h3>'
    + '<p>' + esc(desc) + '</p>'
    + '</div>';

  const step = (n, title, desc) => '<div class="home-step">'
    + '<span class="home-step-num" aria-hidden="true">' + n + '</span>'
    + '<h3>' + esc(title) + '</h3>'
    + '<p>' + esc(desc) + '</p>'
    + '</div>';

  const quote = (text, name, meta) => '<figure class="home-quote">'
    + '<blockquote>“' + esc(text) + '”</blockquote>'
    + '<figcaption><span class="home-avatar" aria-hidden="true">' + esc(name[0]) + '</span>'
    + '<span><b>' + esc(name) + '</b><small>' + esc(meta) + '</small></span></figcaption>'
    + '</figure>';

  // FAQ 用原生 <details>/<summary>：零 JS、键盘可达，展开状态浏览器自己管
  const faq = (q, a) => '<details class="home-faq"><summary>' + esc(q)
    + '<span class="home-faq-caret" aria-hidden="true"></span></summary>'
    + '<p>' + esc(a) + '</p></details>';

  const fgo = (label, id) => '<button class="home-foot-link" type="button" data-go-home="' + id + '">'
    + esc(label) + '</button>';

  view.innerHTML =
    // .home 包裹层：§27 的负边距（通栏色带 + 抵消 .content 内边距）全靠它，
    // 漏了这层规则会静默失效（页面"看着还在"，只是边距全丢）。
    '<div class="home">'
    // ── Hero ──────────────────────────────────────────────────────
    + '<section class="home-hero">'
    + '<span class="home-pill">本地优先 · AI 驱动的求职工作台</span>'
    + '<h1>用 AI 打造竞争力<br>高效拿下理想 offer</h1>'
    + '<p class="home-sub">智能简历编写、岗位匹配评估、批量自动投递、进阶规划。'
    + '从简历到 offer 的全套准备，都在你自己的电脑上完成，数据不出本地。</p>'
    + '<div class="home-cta-row">'
    // 落地页是纯门面：没登录时主按钮就是「免费开始」→ 进登录页；
    // 登录之后这里才真正「连接功能」→ 直接进简历编辑。
    + '<button class="btn lg primary" type="button" data-go-home="' + (S.session ? 'cv' : 'login') + '">'
    + (S.session ? '立即创建简历' : '免费开始') + '</button>'
    + '<button class="btn lg" type="button" data-home-jump>看看怎么用</button>'
    + '</div>'
    + '</section>'

    // ── 四大能力 ──────────────────────────────────────────────────
    // 卡片对齐项目**实际功能**（2026-09-28）：简历编辑（含 AI 优化与导出）/
    // 岗位评估（含 A–H 报告）/ 自动投递 / 进阶规划。
    + '<section class="home-band">'
    + '<div class="home-sec-head"><h2>四大核心能力，覆盖求职全链路</h2>'
    + '<p>不用来回切换工具，一个控制台搞定简历、评估与投递</p></div>'
    + '<div class="home-grid4">'
    + feat('cv', '简历编辑与导出',
      '表单化填写个人简介、核心能力与经历，右侧实时预览；AI 辅助润色，一键导出 PDF（与预览同一版式）。')
    + feat('reports', '岗位评估与报告',
      '粘贴 JD，A–H 多维评估打分并生成完整报告，先判断这个岗位值不值得投、差在哪。')
    + feat('apply', '批量自动投递',
      '按关键词与城市读 BOSS 岗位列表，套用过滤规则生成投递计划；默认只出计划，确认后才发送。')
    + feat('prep', '能力复盘与进阶规划',
      '对照岗位要求查漏补缺：学什么、做什么、看什么，逐项给出可执行清单。')
    + '</div></section>'

    // ── 三步流程 ──────────────────────────────────────────────────
    + '<section id="homeHow">'
    + '<div class="home-sec-head"><h2>三步开启求职准备</h2>'
    + '<p>简单操作，快速产出高质量的求职材料</p></div>'
    + '<div class="home-steps">'
    + step(1, '录入信息', '在「我的简历」完善个人简介、核心能力、经历与项目，随时预览成稿')
    + step(2, '评估与规划', '把目标岗位 JD 粘进「岗位评估」拿 A–H 报告；按报告在「进阶规划」生成补短板清单')
    + step(3, '投递与导出', '「自动投递」按城市与关键词出计划、确认后批量打招呼；简历一键导出 PDF 并下载到本机')
    + '</div></section>'

    // ── 本地优先（取代旧的虚构「用户反馈」：那是演示用的假引言，不真实）──
    + '<section class="home-band">'
    + '<div class="home-sec-head"><h2>本地优先，数据你说了算</h2>'
    + '<p>和把简历交给云服务不同，历琢把一切留在你自己的电脑上</p></div>'
    + '<div class="home-grid4">'
    + feat('check', '数据不出本机',
      '简历、评估报告、投递台账全部存在项目 data/ 目录，不经过任何第三方服务器。')
    + feat('box', '成本可控',
      '控制台脚本一键运行零 token；只有你主动触发的 AI 评估会按自己配置的模型计费。')
    + feat('shield', '账号自己管',
      '账号本机自管，支持在「账号安全中心」自助改密；会话存内存，控制台重启即失效。')
    + feat('apply', '投递有闸门',
      '默认只生成投递计划，逐条给过滤理由；确认后才真正发送，单日上限可设。')
    + '</div></section>'

    // ── CTA 带 ────────────────────────────────────────────────────
    + '<section class="home-cta-band">'
    + '<h2>准备好开启求职之路？</h2>'
    + '<p>简历、评估、备考 —— 全部在本地完成，现在就开始</p>'
    + '<button class="home-cta-btn" type="button" data-go-home="cv">立即完善我的简历</button>'
    + '</section>'

    // ── FAQ ───────────────────────────────────────────────────────
    + '<section>'
    + '<div class="home-sec-head"><h2>常见问题</h2></div>'
    + '<div class="home-faqs">'
    + faq('AI 生成的内容可以直接用吗？',
      'AI 生成的内容是参考草稿，建议对照自己的真实经历微调后再写入简历 —— 简历要经得起面试追问。')
    + faq('我的数据存在哪里，安全吗？',
      '全部数据存在你自己的电脑上（项目的 data/ 目录），评估与简历不经过任何第三方服务器；'
      + '只有你主动触发的 AI 评估会调用自己配置的模型。')
    + faq('自动投递会乱发消息吗？',
      '不会。它默认只生成投递计划——读到哪些岗位、哪些被过滤、为什么，一目了然；'
      + '你确认后才真正发送，发送间隔随机 8–25 秒，单日有上限，投过的岗位自动跳过。')
    + faq('支持导出 PDF 简历吗？',
      '支持。简历编辑页顶栏点「导出 PDF」就行 —— 导出的就是右边那份实时预览，'
      + '生成后自动下载到本机；版本卡片上也能按版本单独导出。')
    + '</div></section>'

    // ── 深色页脚 ──────────────────────────────────────────────────
    + '<footer class="home-footer">'
    + '<div class="home-foot-grid">'
    + '<div>'
    + '<div class="home-foot-brand"><span class="home-foot-mark" aria-hidden="true">历</span><b>历琢</b></div>'
    + '<p>本地优先的 AI 求职工作台：简历｜岗位评估｜自动投递</p>'
    + '</div>'
    + '<div><h4>产品</h4>' + fgo('我的简历', 'cv') + fgo('简历工具', 'cvkit')
    + fgo('评估岗位', 'evaluate') + fgo('进阶规划', 'prep') + fgo('自动投递', 'autoapply') + '</div>'
    + '<div><h4>数据</h4>' + fgo('评估报告', 'reports') + fgo('求职配置', 'profile')
    + fgo('账号安全中心', 'security') + '</div>'
    + '<div><h4>支持</h4>' + fgo('使用帮助', 'help') + fgo('全部脚本', 'tools') + fgo('回到首页', 'home') + '</div>'
    + '</div>'
    + '<div class="home-foot-bottom">© 2026 历琢 · 本地控制台 —— 数据不出你的电脑</div>'
    + '</footer>'
    + '</div>';

  // 页脚 / CTA 的视图跳转；「看看怎么用」平滑滚动到流程区（不能用 hash 锚点）
  $$('[data-go-home]', view).forEach((b) =>
    b.addEventListener('click', () => go(b.dataset.goHome)));
  const jump = $('[data-home-jump]', view);
  if (jump) jump.addEventListener('click', () => {
    const t = $('#homeHow');
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
};

// 台账 Report 列存的是 Markdown 链接，形如 `[003](../reports/003-贝壳-2026-09-17.md)`。
// 页面需要的是「文件名本身」，而直接 split('/').pop() 会把收尾的 `)` 一起带进来，
// 服务端按「文件名不合法」400 挡掉 —— 报告页就永远打不开。
// 取文件名这件事只在这一处收敛，台账行和 openReport 共用它。
function reportFileName(cell) {
  const raw = String(cell || '').trim();
  if (!raw || raw === '❌' || raw === '—' || raw === '-') return '';
  const link = raw.match(/\]\(([^)]+)\)/);        // [标签](路径) → 取路径
  const path = (link ? link[1] : raw).trim();
  const base = path.split(/[\\/]/).pop().split(/[?#]/)[0].trim();
  return /\.md$/i.test(base) ? base : '';
}

// ══ 跟进提醒 ══════════════════════════════════════════════
//
// 「现在该追谁」由服务端算（ui/followup-cn.mjs，节奏数学 import 自 core），
// 前端只负责投影 + 两个动作。为什么不在前端复算：跟进节奏依赖 profile.yml 的
// 覆盖值、钉日期、挂起指令和跨进程的文件状态，浏览器里拿不到完整的输入。

/** 今天（本地年历日）。不能用 toISOString()：东八区清早它会给出昨天。 */
function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 状态显示名走 /api/states 的权威表（cn 优先），认不出才回落台账原文。 */
function stateZhOf(stateId, raw) {
  const list = S.states || [];
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const meta = list.find((x) => norm(x.id) === norm(stateId))
    || list.find((x) => norm(x.label) === norm(raw))
    || list.find((x) => norm(x.cn) === norm(raw));
  return meta ? (meta.cn || meta.label || stateId) : (raw || stateId || '—');
}

/** 「下次跟进 9-23」/「已过 3 天」/「今天」。天数由服务端给，这里不重算。 */
function fuNextText(e) {
  if (!e.nextFollowupDate) return '暂无安排';
  const d = e.daysUntilNext;
  if (d == null) return e.nextFollowupDate;
  if (d === 0) return '今天（' + e.nextFollowupDate + '）';
  if (d === 1) return '明天（' + e.nextFollowupDate + '）';
  if (d > 1) return d + ' 天后（' + e.nextFollowupDate + '）';
  return '已过 ' + (-d) + ' 天（' + e.nextFollowupDate + '）';
}

function followupRowHtml(e) {
  const tone = URGENCY_TONE[e.urgency] || '';
  // 台账只有评估日期，没有「状态变更日期」。用评估日期推算出来的天数必须标出来 ——
  // 一个看起来精确、实际是推断的数字，比一个标着「推算」的数字危险得多。
  const inferred = e.appDateSource === 'evaluation-date-fallback';
  const last = e.followupCount === 0
    ? '还没追过'
    : '已追 ' + e.followupCount + ' 次 · 上次 ' + esc(e.followups[0].date);

  return '<div class="fu-row">'
    + '<div class="fu-main">'
    + '<div class="row tight">'
    + '<b>#' + esc(e.num) + ' ' + esc(e.company || '（未填公司）') + '</b>'
    + '<span class="badge info">' + esc(stateZhOf(e.stateId, e.status)) + '</span>'
    + '<span class="badge ' + tone + '">' + esc(URGENCY_ZH[e.urgency] || e.urgency) + '</span>'
    + '</div>'
    + '<div class="hint fu-meta">'
    + esc(e.role || '（未填岗位）')
    + ' · ' + (inferred ? '据评估日期推算已过 ' : '已过 ') + e.daysSinceApplication + ' 天'
    + ' · ' + last
    + ' · 下次跟进 ' + esc(fuNextText(e))
    + (e.contactLabel ? ' · 联系人 ' + esc(e.contactLabel) : '')
    + ' · ' + esc(FAMILY_LABEL[e.family] || '')
    + '</div></div>'
    + '<div class="fu-act">'
    + '<button class="btn sm primary" type="button" data-fulog="' + esc(e.num) + '"'
    + ' aria-label="记录一次对「' + esc(e.company || e.num) + '」的跟进">记一次跟进</button>'
    + '<button class="btn sm ghost" type="button" data-fudefer="' + esc(e.num) + '"'
    + ' aria-label="推迟「' + esc(e.company || e.num) + '」的下次跟进日期">推迟</button>'
    + '</div></div>';
}

/**
 * 跟进提醒卡片。没数据时返回一段说明而不是空字符串 —— 空卡片和不适用
 * 长得一模一样，而这里的「没有条目」有三种完全不同的原因，得说清楚是哪一种。
 */
function followupCardHtml(f) {
  if (!f || !f.analysis) {
    return '<div class="card" id="fuCard"><div class="hint">跟进提醒暂时读不出来。</div></div>';
  }
  const m = f.analysis.metadata || {};
  const cfg = f.analysis.cadenceConfig || {};
  const entries = f.analysis.entries || [];

  const head = '<div class="row" style="margin-bottom:10px">'
    + '<h3 style="margin:0;font-size:14.5px">跟进提醒</h3>'
    + (m.dueNow > 0
      ? '<span class="badge bad">现在该追 ' + m.dueNow + ' 条</span>'
      : '<span class="badge ok">今天没有该追的</span>')
    + '<span class="spacer" style="flex:1"></span>'
    + '<span class="hint">台账 ' + (m.trackerTotal || 0) + ' 条 · 在跟 '
      + (m.actionable || 0) + ' 条</span>'
    + '</div>';

  // 节奏说明用服务端下发的 cadenceConfig 生成，不写死数字 ——
  // 用户在 profile.yml 里改过节奏之后，这里的说法要跟着变。
  const rule = '<div class="hint" style="margin-top:10px">节奏：投递后 '
    + esc(cfg.applied_first) + ' 天首次跟进，之后每 ' + esc(cfg.applied_subsequent)
    + ' 天一次、最多 ' + esc(cfg.applied_max_followups) + ' 次；有回应后每 '
    + esc(cfg.responded_subsequent) + ' 天可再追一次。</div>';

  let bodyHtml = '';
  if (!entries.length) {
    bodyHtml = '<div class="hint">台账里还没有在跟的岗位。'
      + '状态改成「' + esc(stateZhOf('applied')) + '」或更靠后的阶段（笔试 / 初试 / 复试…）'
      + '之后，这里才会开始计跟进节奏 —— 「' + esc(stateZhOf('evaluated'))
      + '」只表示评估过、还没投出去，不需要跟进。</div>';
  } else {
    // 该追的排在前面（服务端已按紧急度排好），只截前 6 条。
    const shown = entries.slice(0, 6);
    bodyHtml = '<div class="fu-list">' + shown.map(followupRowHtml).join('') + '</div>';
    if (entries.length > shown.length) {
      bodyHtml += '<div class="hint" style="margin-top:8px">另有 '
        + (entries.length - shown.length) + ' 条还在等回应，未在此展开。</div>';
    } else if (m.dueNow === 0) {
      bodyHtml += '<div class="hint" style="margin-top:8px">'
        + '最近一条的下次跟进日在 ' + esc(fuNextText(entries[0])) + '。</div>';
    }
  }

  const inferredNote = m.inferredDates > 0
    // 这里用 <b> 不用 **：hint 是纯文本容器，Markdown 粗体不会被渲染，
    // 页面上会原样露出两个星号（真实数据下发现的，自检当时只断言了行内那句）。
    ? '<div class="hint" style="margin-top:8px">其中 ' + m.inferredDates
      + ' 条的天数是按<b>评估日期</b>推算的（台账没有记录状态变更日）。'
      + '如果实际投递日不同，在台账 Notes 里写一句 <code>Applied YYYY-MM-DD</code> 就会以它为准。</div>'
    : '';

  return '<div class="card" id="fuCard">' + head + bodyHtml + inferredNote + rule + '</div>';
}

/** 绑定卡片上的两个动作。事件委托到卡片根上，重画后不需要重新绑。 */
function wireFollowupCard(root) {
  const card = $('#fuCard', root);
  if (!card) return;
  card.addEventListener('click', (ev) => {
    const logBtn = ev.target.closest('[data-fulog]');
    if (logBtn) { askFollowupLog(logBtn.dataset.fulog); return; }
    const deferBtn = ev.target.closest('[data-fudefer]');
    if (deferBtn) askFollowupDefer(deferBtn.dataset.fudefer);
  });
}

/** 从会话里取某条待跟进项（动作按钮只带 num，其余信息从 S 里取）。 */
function followupEntryOf(num) {
  const list = (S.followups && S.followups.analysis && S.followups.analysis.entries) || [];
  return list.find((e) => String(e.num) === String(num)) || null;
}

/** 把两个动作共用的模态框外壳搭起来。 */
function fuModal({ title, target, fieldsHtml }) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', title);
  mask.innerHTML = '<div class="modal">'
    + '<div class="modal-head"><h3>' + esc(title) + '</h3><span class="spacer"></span>'
    + '<button class="btn ghost sm icon" type="button" id="fuX" aria-label="关闭">' + icon('x') + '</button></div>'
    + '<p class="hint">目标：<code>' + esc(target) + '</code></p>'
    + fieldsHtml
    + '<div class="foot"><button class="btn" type="button" id="fuCancel">取消</button>'
    + '<button class="btn primary" type="button" id="fuOk">保存</button></div></div>';
  document.body.appendChild(mask);
  return mask;
}

/** 「记一次跟进」：追加一行到 data/follow-ups.md（只追加，不改既有行）。 */
function askFollowupLog(num) {
  const e = followupEntryOf(num);
  if (!e) { toast('这条记录已经不在待跟进列表里了，刷新一下再试', 'warn'); return; }
  const target = '#' + e.num + ' ' + (e.company || e.role || '');

  const fields = '<label class="field"><span>跟进日期</span>'
    + '<input class="input" type="date" id="fuDate" value="' + esc(todayLocal()) + '"></label>'
    + '<label class="field"><span>通道</span><select class="select" id="fuCh">'
    + CHANNELS.map((c) => '<option value="' + esc(c) + '"'
        + (c === 'Email' ? ' selected' : '') + '>' + esc(CHANNEL_ZH[c] || c) + '</option>').join('')
    + '</select></label>'
    + '<label class="field"><span>联系人 <em>（可选）</em></span>'
    + '<input class="input" id="fuContact" placeholder="例如：张经理 / hr@example.com" value="'
    + esc(e.contactLabel || '') + '"></label>'
    + '<label class="field"><span>做了什么 <em>（可选，写进跟进记录）</em></span>'
    + '<input class="input" id="fuNote" placeholder="例如：邮件催了一次进度"></label>';

  const mask = fuModal({ title: '记一次跟进', target, fieldsHtml: fields });
  const close = wireModal(mask);
  $('#fuCancel', mask).addEventListener('click', close);
  $('#fuX', mask).addEventListener('click', close);
  mask.addEventListener('click', (ev) => { if (ev.target === mask) close(); });

  const okBtn = $('#fuOk', mask);
  okBtn.addEventListener('click', async () => {
    const date = $('#fuDate', mask).value.trim();
    if (!date) { toast('请选一个跟进日期', 'warn'); return; }
    busy(okBtn, true, '保存中…');
    try {
      const r = await api('/api/followups/log', {
        method: 'POST',
        body: {
          appNum: e.num, date,
          channel: $('#fuCh', mask).value,
          contact: $('#fuContact', mask).value.trim(),
          notes: $('#fuNote', mask).value.trim(),
        },
      });
      // 只写会话，不写 DOM —— 重画交给 route()，避免关闭中的旧视图被回填
      S.followups = r.followups;
      toast('已记录：' + (r.company || target) + '（编号 ' + r.num + '）', 'ok');
      close();
      route();
    } catch (err) {
      toast(err.message, 'bad');
      busy(okBtn, false);
    }
  });
}

/** 「推迟」：写一条 pin 指令，优先于算出来的节奏（连已转冷的也能救回来）。 */
function askFollowupDefer(num) {
  const e = followupEntryOf(num);
  if (!e) { toast('这条记录已经不在待跟进列表里了，刷新一下再试', 'warn'); return; }
  const target = '#' + e.num + ' ' + (e.company || e.role || '');

  const fields = '<label class="field"><span>推迟到哪天</span>'
    + '<input class="input" type="date" id="fuNext" min="' + esc(todayLocal()) + '" value="'
    + esc(e.nextFollowupDate && e.nextFollowupDate >= todayLocal() ? e.nextFollowupDate : '')
    + '"></label>'
    + '<p class="hint">推迟会写一条 <code>next #' + esc(e.num) + ' 日期</code> 指令，'
    + '它会盖过自动算出来的日期；之后再记一次跟进就恢复自动节奏。</p>';

  const mask = fuModal({ title: '推迟下次跟进', target, fieldsHtml: fields });
  const close = wireModal(mask);
  $('#fuCancel', mask).addEventListener('click', close);
  $('#fuX', mask).addEventListener('click', close);
  mask.addEventListener('click', (ev) => { if (ev.target === mask) close(); });

  const okBtn = $('#fuOk', mask);
  okBtn.addEventListener('click', async () => {
    const date = $('#fuNext', mask).value.trim();
    if (!date) { toast('请选一个日期', 'warn'); return; }
    busy(okBtn, true, '保存中…');
    try {
      const r = await api('/api/followups/defer', { method: 'POST', body: { appNum: e.num, date } });
      S.followups = r.followups;
      toast('已推迟到 ' + r.nextDate, 'ok');
      close();
      route();
    } catch (err) {
      toast(err.message, 'bad');
      busy(okBtn, false);
    }
  });
}

/**
 * 载入某份报告**已保存**的提升计划（2026-10-12 用户反馈：从「报告详情」点
 * 生成提升计划跳过来，看不到之前生成过的计划）。
 * 有就装进会话并返回 true；没有（404）就静静返回 false、页面保持空态 ——
 * 这是进页的常规探测，不是错误，所以不弹 toast、不刷错误计数。
 */
async function loadSavedPrepPlan(file) {
  const s = prepSession();
  if (!file) return false;
  try {
    const plan = await api('/api/prep/history/content?file=' + encodeURIComponent(file));
    s.file = plan.file || file;
    s.result = plan;
    s.state = 'done';
    s.error = null;
    return true;
  } catch {
    return false;
  }
}

// ══ 视图：面试备考建议 ════════════════════════════════════
// （原「投递台账」页 2026-09-22 撤下界面入口：data/applications.md、tracker.mjs、
//  merge-tracker.mjs、跟进提醒与 /api/tracker* 路由全部保留，只是不再有页面。
//
//  ⚠️ 因此 followupCardHtml() / wireFollowupCard() 这两个函数**当前没有调用方**。
//  它们不是漏删：跟进提醒的数据与接口都还在（/api/followups、followup-cn.mjs、
//  根目录的 followup-cadence.mjs），只是唯一渲染它们的页面被撤了。
//  刻意留着是为了「找到落点时一行就能接回来」——真要彻底清掉时，记得连同
//  /api/followups 一起评估，别只删渲染层。
//  想用跟进提醒现在走 CLI：node followup.mjs / node tracker.mjs。）
//
// 这一页要解决的问题：评估报告告诉你「这个岗位值不值得投」，但没告诉你
// 「差的那几块怎么补」。所以它把报告里的**岗位要求 + 能力评估结论**跟
// cv.md 里的经历技能做差距对比，输出三部分：
//   一、要补的知识点 —— 带优先级（P0/P1/P2）与掌握程度要求（了解 / 能上手 / 能讲原理）
//   二、能写进简历的实践项目 —— 项目目标 + 技术要点 + 对岗位的价值
//   三、每个知识点的学习资源 —— 视频课程 + 书籍，要具体到能被搜到
//
// ── 为什么前端不自己算 ────────────────────────────────────────────────
// 服务端 /api/prep/generate 负责读报告、读 cv.md、调引擎；算不出来就自动
// 降级到本地规则版（零 token），并把「为什么降级」回传。前端只做两件事：
// 画出来、复制/导出。这样 AI 挂了也不会整页报错 —— 只是结论糙一点。
//
// ── 状态为什么挂在 S 上 ───────────────────────────────────────────────
// 生成一次要等 AI 跑完（可能几分钟）。切去别的页再回来，视图会被整个重建，
// 状态要是放在 DOM 或闭包里就没了，用户会以为白等一场。所以 S.prep 是唯一
// 事实来源，异步回调只写 S，再由 paintPrep() 投影成 DOM。

/** 备考会话的完整形状。集中在一处，免得各处理散着判 null。 */
function prepSession() {
  if (!S.prep) {
    S.prep = {
      // ── 岗位列表（/api/prep/list）──
      loaded: false,      // 拉过没有；false 时每次进页面都重新拉
      items: [],          // 每份报告：能不能生成、缺什么、有几条差距
      defaultFile: '',
      cvChars: 0,
      cvMissing: false,   // 简历是空的 —— 全局性问题，单独提示一次
      listError: '',

      // ── 当前这一次生成 ──
      file: '',           // 选中的报告文件名
      engine: 'auto',     // 'auto' | 'local'
      state: 'idle',      // idle | loading | done | error
      result: null,       // /api/prep/generate 的完整响应
      error: null,        // { message, missing, needCv }

      // ── 已生成的提升计划（growth 页历史区，2026-10-12）──
      // 权威在服务端 data/prep/（生成即自动落盘，刷新/重进不丢）；
      // 这里只是最近一次拉到的列表快照，进 growth 页时重拉。
      history: [],        // [{ file, title, score, at, source, bytes }]
      runId: 0,           // 递增让在飞的旧请求作废
    };
  }
  return S.prep;
}

/** 下拉选项里放不下长标题，截一下。 */
function prepTrim(t, n = 32) {
  const s = String(t || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// downloadText / prepFileName 已随「导出 .md」下线删除（2026-10-11）。

/** 第一部分：要补的知识点（折叠面板：名称 + 优先级 + 掌握程度要求 + 为什么缺）。 */
function prepGapsHtml(gaps) {
  if (!gaps.length) return '<p class="hint">没有解析出知识点 —— 换一份报告，或重新生成一次。</p>';
  return gaps.map((g, i) => {
    const tone = PRIORITY_TONE[g.priority] || 'info';
    const pzh = PRIORITY_ZH[g.priority] || '';
    const lv = MASTERY_LEVELS.find((m) => m.id === g.mastery);
    const mzh = MASTERY_ZH[g.mastery] || g.mastery || '—';
    // 折叠面板（参照设计稿「待学习知识点详情」）：标题行给全关键字段，
    // 展开看「为什么缺 / 掌握到什么程度」。native details，不依赖 JS。
    return '<details class="prep-item prep-fold">'
      + '<summary class="prep-fold-sum">'
      + '<span class="prep-num">' + (i + 1) + '</span>'
      + '<b class="prep-fold-name">' + esc(g.name) + '</b>'
      + '<span class="spacer"></span>'
      + '<span class="badge ' + tone + '" title="优先级：' + esc(pzh) + '">'
      + esc(g.priority || '—') + (pzh ? ' ' + esc(pzh) : '') + '</span>'
      // 「掌握程度」这四个字必须**可见**，不能只塞 title ——
      // 需求要的是「标注优先级和掌握程度要求」，光显示「能讲原理」看不出
      // 这是掌握程度还是别的东西，跟旁边的「P0 必须掌握」也分不清谁是谁。
      + '<span class="badge" title="' + esc(lv ? lv.desc : '掌握程度要求') + '">'
      + '掌握程度 · ' + esc(mzh) + '</span>'
      // 删除（2026-10-11 用户要求）：每条计划都能单独摘掉。只改会话里的
      // parsed 数据（生成结果本就不落盘），重新生成一次即全部重来。
      + '<button class="prep-del" type="button" data-pdel="gaps" data-pidx="' + i + '"'
      + ' title="从计划中删除这一条" aria-label="删除 ' + esc(g.name) + '">✕</button>'
      + '</summary>'
      + '<div class="prep-fold-body">'
      + (g.why ? '<p class="prep-why"><b>为什么缺：</b>' + esc(g.why) + '</p>' : '')
      + (lv ? '<p class="prep-why"><b>掌握到什么程度：</b>' + esc(lv.desc) + '</p>' : '')
      + '<p class="hint" style="margin:8px 0 0">对应的学习资源见下方「'
      + esc(SECTION_TITLES.resources) + '」，按知识点名称对应。</p>'
      + '</div></details>';
  }).join('');
}

/** 第二部分：实践项目建议（目标 / 技术要点 / 对岗位的价值 / 工作量）。 */
function prepProjectsHtml(projects) {
  if (!projects.length) return '<p class="hint">没有生成项目建议 —— 换一份报告，或重新生成一次。</p>';
  // 对齐设计稿「能力复盘与进阶」的项目优化方向：两列卡片网格，每张 = 数字
  // 角标 + 项目名 + 一句目标导语 + • 要点列表（技术要点/价值/工作量）。
  return '<div class="prep-proj-grid">' + projects.map((p, i) => {
    const pts = [
      ['技术要点', p.tech],
      ['对岗位的价值', p.value],
      ['工作量估算', p.effort],
    ].filter(([, v]) => v && String(v).trim());
    return '<article class="prep-item prep-proj">'
      + '<div class="row prep-head">'
      + '<span class="prep-proj-num">' + (i + 1) + '</span>'
      + '<b>' + esc(p.name) + '</b>'
      + '<span class="spacer" style="flex:1"></span>'
      + '<button class="prep-del" type="button" data-pdel="projects" data-pidx="' + i + '"'
      + ' title="从计划中删除这一条" aria-label="删除 ' + esc(p.name) + '">✕</button>'
      + '</div>'
      + (p.goal && String(p.goal).trim()
        ? '<p class="prep-proj-goal">' + esc(p.goal) + '</p>' : '')
      + (pts.length
        ? '<ul class="prep-proj-points">' + pts.map(([k, v]) =>
            '<li><i>' + esc(k) + '</i><span>' + esc(v) + '</span></li>').join('') + '</ul>'
        : '')
      + '</article>';
  }).join('') + '</div>';
}

/** 第三部分：学习资源（按知识点分组，标出视频课程 / 书籍）。 */
function prepResourcesHtml(resources) {
  if (!resources.length) return '<p class="hint">没有给出学习资源 —— 换一份报告，或重新生成一次。</p>';
  const byTopic = new Map();
  // ⚠️ 分组会打乱顺序，但删除按钮操作的是 parsed.resources 原数组 ——
  //    所以每个条目要带上它在原数组里的下标，不能给「组内下标」。
  resources.forEach((it, i) => {
    const k = it.topic || '通用';
    if (!byTopic.has(k)) byTopic.set(k, []);
    byTopic.get(k).push({ it, i });
  });
  let out = '';
  for (const [topic, list] of byTopic) {
    out += '<div class="prep-topic"><b class="prep-topic-name">' + esc(topic) + '</b>'
      + '<ul class="prep-res">'
      + list.map(({ it, i }) => '<li>'
        + '<span class="badge">' + esc(RESOURCE_KIND_ZH[it.kind] || '资源') + '</span>'
        + '<span class="prep-res-title">' + esc(it.title) + '</span>'
        + (it.note ? '<span class="prep-res-note">' + esc(it.note) + '</span>' : '')
        + '<button class="prep-del" type="button" data-pdel="resources" data-pidx="' + i + '"'
        + ' title="从计划中删除这一条" aria-label="删除 ' + esc(it.title) + '">✕</button>'
        + '</li>').join('')
      + '</ul></div>';
  }
  return out;
}

/**
 * 把 S.prep 画成 DOM。
 *
 * 只在还停在 #prep 时画 —— 生成要跑几分钟，跑完时用户很可能已经切走了，
 * 那时候乱改 DOM 会把别的页面覆盖掉（这是这套代码里最容易出的回归）。
 */
function paintPrep() {
  // prep（能力复盘与进阶规划）与 growth（导航「提升计划」）共用这套工作台 ——
  // 2026-10-11 用户要求：提升计划页也用「下拉选岗位 + 直接生成」，结果放本页下方。
  const _h = location.hash.slice(1);
  if (_h !== 'prep' && _h !== 'growth') return;
  const view = $('#view');
  if (!view) return;
  const s = prepSession();

  // ── 列表都拉不到：给重试，别白屏 ──
  if (s.listError) {
    view.innerHTML = errorState(new Error(s.listError), true);
    wireActions(view, [{ label: '重试', primary: true, onClick: () => { s.loaded = false; route(); } }]);
    $('#topActions').innerHTML = '';
    return;
  }

  // ── 一份报告都没有：这功能没有输入，直接指路 ──
  if (!s.items.length) {
    const acts = [
      { label: '去评估岗位', primary: true, onClick: () => go('evaluate') },
      { label: '看使用帮助', onClick: () => go('help') },
    ];
    view.innerHTML = '<div class="card">' + emptyState({
      ico: 'prep',
      title: '还没有可以备考的岗位',
      desc: '备考建议要拿评估报告里的「岗位要求 + 能力评估结论」跟你的简历做差距对比。'
        + '先去「评估岗位」跑一次完整评估（初筛只出分数，要点「生成完整报告」），回来这里就有岗位可选了。',
      actions: acts,
    }) + '</div>';
    wireActions(view, acts);
    $('#topActions').innerHTML = '';
    return;
  }

  const cur = s.items.find((x) => x.file === s.file) || s.items[0];
  s.file = cur.file;
  const busyNow = s.state === 'loading';

  // ── 选岗位 + 选生成方式 + 生成按钮 ──
  // 不能生成的岗位在下拉里直接禁用并写明原因（灰着但看得见），
  // 比让人选完再弹一个错要好。
  const opts = s.items.map((x) => '<option value="' + esc(x.file) + '"'
    + (x.file === s.file ? ' selected' : '')
    + (x.canGenerate ? '' : ' disabled')
    + '>' + esc(prepTrim(x.title || x.file))
    + (x.score ? '（' + esc(x.score) + '）' : '')
    + (x.canGenerate ? '' : ' — 数据不足') + '</option>').join('');

  // 选中项的现状说明：**只保留功能性提示**（这个岗位为什么生成不了）。
  // 「依据：X 条差距项 + Y 条岗位要求，对照你的 cv.md（N 字）」这类说明句
  // 已按用户要求删除（2026-10-12）。
  let pickNote;
  if (!cur.canGenerate) {
    pickNote = '<b style="color:var(--bad-ink)">这个岗位的数据不够，生成不了。</b>'
      + esc(cur.blockHint || '');
  } else {
    pickNote = '';
  }

  view.innerHTML =
    // growth 页不再有总览条（2026-10-11 用户要求删除）—— 控件卡即页首
    '<div class="card prep-pick">'
    + '<div class="row prep-pick-row">'
    + '<label class="field prep-pick-1"><span>基于哪份评估报告</span>'
    + '<select class="select" id="pSel"' + (busyNow ? ' disabled' : '') + '>' + opts + '</select></label>'
    // 「生成方式」下拉已按用户要求删除（2026-10-11）：引擎固定走 auto
    // （能用 AI 就用 AI，AI 不可用自动回落本地规则），界面少一个要理解的概念。
    + '</div>'
    + '<p class="hint prep-pick-note">' + pickNote + '</p>'
    + '</div>'
    // 简历为空是**全局**问题：每个岗位都会报同一句话，所以提到工具条下面
    // 统一说一次，而不是等用户点了生成才弹。
    + (s.cvMissing
      ? '<div class="notice warn"><b>cv.md 是空的，差距对比做不准</b>'
      + '<p>备考建议要拿你的经历与技能去比岗位要求，简历空着就只能按「什么都没有」来推，'
      + '结论会偏。先去<a href="#cv">「我的简历」</a>填完再来。</p></div>'
      : '')
    + '<div id="pMsg"></div>'
    + '<div id="pOut"></div>';

  // ── 顶部操作：生成按钮常驻 + 「返回」（2026-10-11：复制全文/导出 .md 已按
  // 用户要求下线 —— 本页通常从「提升计划」卡片的「看结果」进来，看完就回）。
  $('#topActions').innerHTML =
    '<button class="btn primary" id="pGen" type="button"'
    + (busyNow || !cur.canGenerate ? ' disabled' : '') + '>'
    // growth 页用用户的词汇「提升计划」；prep 工作台保持「备考建议」
    + (busyNow ? '生成中…' : (s.result && s.result.file === s.file
      ? '重新生成'
      : (_h === 'growth' ? '生成提升计划' : '生成备考建议')))
    + '</button>'
    + '<button class="btn" id="pBack" type="button">返回</button>';

  // ── 绑定：视图 innerHTML 每次重建，所以监听器也每次重挂（旧节点会被回收）──
  $('#pSel').addEventListener('change', async (e) => {
    s.file = e.target.value;
    // 换了岗位先把上一份结果收起来，避免「标题是 A、内容是 B」的错觉；
    // 再试着把**这个岗位已保存过的计划**显示出来（没有就保持空态）。
    s.result = null;
    s.error = null;
    s.state = 'idle';
    paintPrep();
    if (await loadSavedPrepPlan(s.file)) paintPrep();
  });
  $('#pGen').addEventListener('click', () => runPrep());
  // 「返回」→ 提升计划列表（看结果的来路）
  $('#pBack').addEventListener('click', () => go('growth'));

  paintPrepBody();
}

/** growth 页「历史提升计划」卡（对齐历史评估卡 wz-res-card：标题两行截断 /
 *  分数徽标 / 按钮沉底）。数据来自服务端 data/prep/（生成即自动落盘）；
 *  看结果跳 prep 工作台看全文，删除移 trash（可恢复）。 */
function prepGeneratedCardHtml(g, i) {
  const v = wzScoreOf(g.score);
  return '<div class="card wz-res-card">'
    + '<div class="row-between mb"><div class="wz-res-title">' + esc(g.title) + '</div>'
    + '<span class="tag">' + (v != null ? v + ' 分' : '—') + '</span></div>'
    + '<p class="wz-res-meta" style="font-size:13px;color:var(--ink2);margin:0">'
    + esc(g.at || '') + '<br>提升计划已保存 · '
    + (g.source === 'ai' ? 'AI 生成' : '本地规则生成') + ' · 点「看结果」查看全文</p>'
    + '<div class="wz-res-actions" style="border-top:1px solid var(--line);margin-top:0;padding-top:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">'
    + '<span class="note">刷新/重进本页都不会丢</span>'
    + '<span class="row" style="gap:8px;margin:0;flex-wrap:nowrap">'
    + '<button class="btn sm" type="button" data-pgdel="' + i + '"'
    + ' aria-label="删除提升计划：' + esc(g.title) + '">删除</button>'
    + '<button class="btn sm pri" type="button" data-pgopen="' + i + '">看结果</button>'
    + '</span></div></div>';
}

/** 结果区 / 提示区的单独投影：它只依赖 state + result + error。 */
function paintPrepBody() {
  const msg = $('#pMsg');
  const out = $('#pOut');
  if (!msg || !out) return;
  const s = prepSession();
  const cur = s.items.find((x) => x.file === s.file) || s.items[0] || {};

  // ── 出错：把「缺哪几样」摊成清单，而不是一句话 ──
  if (s.state === 'error' && s.error) {
    out.innerHTML = '';
    const missing = (s.error.missing || []).filter(Boolean);
    msg.innerHTML = '<div class="notice bad"><b>没法生成这份备考建议</b>'
      + '<p>' + esc(s.error.message) + '</p>'
      + (missing.length ? '<ul>'
        + missing.map((m) => '<li>' + esc(m) + '</li>').join('') + '</ul>' : '')
      + (s.error.needCv ? '<p>简历在 <code>cv.md</code>，可以直接编辑，'
        + '也可以去<a href="#cv">「我的简历」</a>用表单填。</p>' : '')
      + '</div>';
    return;
  }

  // ── 生成中：只留骨架屏（提示句已按用户要求删除，2026-10-12；
  //    右上角按钮同时显示「生成中…」，进度感由它承担）──
  if (s.state === 'loading') {
    out.innerHTML = '<div class="skeleton sk-card" style="height:120px"></div>' + skLines(10);
    msg.innerHTML = '';
    return;
  }

  // ── growth（导航「提升计划」）：历史提升计划区（服务端持久化，2026-10-12）──
  // 生成过的计划自动落盘 data/prep/（一个岗位一份、重新生成覆盖），刷新/重进
  // 页面都在。看结果 = 从服务端读回全文带去 prep 工作台；删除 = 确认框后移
  // data/trash/（可恢复），评估报告不动。
  if (location.hash.slice(1) === 'growth') {
    if (!Array.isArray(s.history)) s.history = [];
    // 当前选中岗位**已有的计划**也显示在这一页（2026-10-12 用户反馈：从「报告详情」
    // 点「生成提升计划」跳过来，只看到历史卡片、看不到计划本身）。
    // 正文与 prep 工作台共用 prepResultHtml，两处一字不差；按钮也照工作台那样挂。
    const curPlan = (s.result && s.result.file === s.file) ? prepResultHtml(s.result) : null;
    msg.innerHTML = curPlan ? curPlan.overviewHtml : '';
    out.innerHTML = (curPlan
      ? '<div class="prep-cur-block">' + curPlan.bodyHtml + '</div>'
        + '<div class="prep-his-head"><b>历史提升计划</b></div>'
      : (s.history.length ? '<div class="prep-his-head"><b>历史提升计划</b></div>' : ''))
      + (s.history.length
        ? '<div class="g2">' + s.history.map((g, i) => prepGeneratedCardHtml(g, i)).join('') + '</div>'
        : '');
    if (curPlan) {
      // 正文区那两个跳转按钮与「每条计划的删除」，与工作台同款
      $$('[data-pgo]', msg).forEach((b) => b.addEventListener('click', () => go(b.dataset.pgo)));
      $$('[data-pdel]', out).forEach((b) => b.addEventListener('click', onPrepDelete));
    }
    // 看结果：从服务端读回这份计划（parsed/markdown 齐全），带去工作台看全文
    $$('[data-pgopen]', out).forEach((b) => b.addEventListener('click', async () => {
      const g = s.history[Number(b.dataset.pgopen)];
      if (!g) return;
      try {
        const plan = await api('/api/prep/history/content?file=' + encodeURIComponent(g.file));
        s.file = plan.file;
        s.result = plan;
        s.state = 'done';
        s.error = null;
        go('prep');
      } catch (err) {
        toast('打开失败：' + err.message, 'bad');
      }
    }));
    // 删除：确认框 → 服务端移 trash（报告不动）
    $$('[data-pgdel]', out).forEach((b) => b.addEventListener('click', async () => {
      const g = s.history[Number(b.dataset.pgdel)];
      if (!g) return;
      const sure = await confirmDialog({
        title: '删除这份提升计划？',
        desc: '「' + g.title + '」的计划文件会移到 data/trash/（可恢复）；对应的评估报告不受影响。',
        confirmLabel: '删除', danger: true,
      });
      if (!sure) return;
      try {
        await api('/api/prep/history/delete', { method: 'POST', body: { file: g.file } });
        s.history = s.history.filter((x) => x.file !== g.file);
        paintPrep();
        toast('已删除「' + g.title + '」的提升计划（在 data/trash/ 可恢复）', 'ok');
      } catch (err) {
        toast('删除失败：' + err.message, 'bad');
      }
    }));
    return;
  }

  // ── 还没生成过：不占地方（2026-10-11 用户要求删掉那段「还没生成」说明，
  //    控件卡 + 生成按钮本身已经把用法说清楚了）──
  if (!s.result) {
    out.innerHTML = '';
    msg.innerHTML = '';
    return;
  }

  // ── 出结果 ──
  const r = s.result;
  const parts = prepResultHtml(r);
  msg.innerHTML = parts.overviewHtml;
  out.innerHTML = parts.bodyHtml;

  // 总览区两个跳转按钮（返回评估报告 / 优化简历）。paintPrepBody 每次重画
  // 都会重建 #pMsg 内容，所以按钮也在这里每次重挂。
  $$('[data-pgo]', msg).forEach((b) => b.addEventListener('click', () => go(b.dataset.pgo)));

  // 每条计划的删除按钮（2026-10-11）。paintPrepBody 每次重画都重建 DOM，
  // 所以和上面 data-pgo 一样在这里重挂；删完 paintPrep() 全页重算
  // （计数徽标、雷达图都从 parsed 现算，自然跟着变）。
  $$('[data-pdel]', out).forEach((b) => b.addEventListener('click', onPrepDelete));
}

/**
 * 完整结果渲染（能力缺口总览 + 三小节 + 复习计划建议）。
 * prep 工作台与 growth 页的展开区共用同一份 —— 两处看到的内容一字不差。
 * @returns {{overviewHtml: string, bodyHtml: string}}
 *   overviewHtml 进 #pMsg（雷达图 + 短板清单 + 跳转按钮），
 *   bodyHtml 进 #pOut（三小节 + 复习计划 + 页脚提示）。
 */
function prepResultHtml(r) {
  const n = countParts(r.parsed);

  // ── 能力缺口总览（参照设计稿 能力复盘与进阶.html 的顶部区）──────────
  // 左：雷达图 —— 轴 = 优先级最高的几条差距项，半径 = 掌握程度映射
  // （了解概念 35 / 能上手用 65 / 能讲原理 90）。这是把**真实的分类数据**
  // 做成序数标度画出来的，轴和数字都有出处，不是编一套六维假分数；
  // 差距项不足 3 条时退回比例条（3 个点以下的雷达没有信息量）。
  // 右：本次评估识别短板清单（P0/P1，最多 5 条）+ 两个跳转按钮。
  const gaps = r.parsed.gaps || [];
  const p0 = gaps.filter((g) => g.priority === 'P0');
  const p1 = gaps.filter((g) => g.priority === 'P1');
  const p2 = gaps.filter((g) => g.priority === 'P2');
  const total = gaps.length || 1;
  const bar = (n2, cls) => n2
    ? '<i class="' + cls + '" style="width:' + (n2 / total * 100).toFixed(2) + '%"></i>' : '';
  const MASTERY_SCORE = { know: 35, use: 65, deep: 90 };
  const radarAxes = p0.concat(p1).concat(p2).slice(0, 6);
  const radarHtml = radarAxes.length >= 3
    ? radarSvg(
        radarAxes.map((g) => MASTERY_SCORE[g.mastery] || 50),
        radarAxes.map((g) => prepTrim(g.name || g.title || '（未命名）', 6)))
      + '<p class="hint" style="margin:8px 0 0">示意图 · 半径按掌握程度映射：'
      + '了解概念 35 / 能上手用 65 / 能讲原理 90。</p>'
    : '<div class="prep-ov-bar">' + bar(p0.length, 'is-p0') + bar(p1.length, 'is-p1') + bar(p2.length, 'is-p2') + '</div>'
      + '<div class="prep-ov-legend">'
      + (p0.length ? '<span class="prep-lg is-p0"><b>' + p0.length + '</b> P0 必须先补</span>' : '')
      + (p1.length ? '<span class="prep-lg is-p1"><b>' + p1.length + '</b> P1 尽量补</span>' : '')
      + (p2.length ? '<span class="prep-lg is-p2"><b>' + p2.length + '</b> P2 有余力再说</span>' : '')
      + '</div>';
  const overviewHtml = gaps.length
    ? '<div class="prep-ov">'
      + '<div class="prep-ov-chart">'
      + '<div class="prep-ov-title">能力缺口总览</div>'
      + radarHtml
      + '</div>'
      + '<div class="prep-ov-list">'
      + '<div class="prep-ov-title">本次评估识别短板</div>'
      + '<ul class="prep-ov-items">'
      + (p0.concat(p1).slice(0, 5).map((g) => '<li>'
        + '<span class="prep-dot is-' + String(g.priority || 'p2').toLowerCase() + '"></span>'
        + esc(g.name || g.title || '（未命名）') + '</li>').join('')
        || '<li class="hint">这次没识别出高优先级短板 —— 报告里的差距项都属「有余力再补」。</li>')
      + '</ul>'
      + '<div class="row tight prep-ov-actions">'
      + '<button class="btn" type="button" data-pgo="reports">返回岗位评估报告</button>'
      + '<button class="btn primary" type="button" data-pgo="cv">优化简历</button>'
      + '</div>'
      + '<p class="hint" style="margin:10px 0 0">共 ' + gaps.length + ' 条差距项，'
      + '对照 ' + (r.requirementCount || 0) + ' 条岗位要求。</p>'
      + '</div>'
      + '</div>'
    : '';

  // 复习计划建议（参照设计稿第三模块）：三阶段推进。阶段天数是经验默认值，
  // 条数来自这份真实结果。标题**不用** .prep-sec-head —— check-prep 断言
  // 结果区恰好三段（gaps/projects/resources），这一张是辅助卡，不进那个计数。
  const planHtml =
    '<section class="card prep-plan">'
    + '<div class="row prep-plan-head"><h2>复习计划建议</h2>'
    + '<span class="spacer" style="flex:1"></span>'
    + '<span class="badge">' + (n.gaps + n.projects) + ' 项待推进</span>'
    + '</div>'
    + '<div class="prep-plan-steps">'
    + '<div class="prep-plan-step"><span class="prep-plan-num">1</span>'
    + '<div><h3>第一阶段：项目改造（3~5 天）</h3>'
    + '<p>优先落地上面「' + esc(SECTION_TITLES.projects) + '」里的 ' + n.projects + ' 个项目建议，'
    + '把改动点和数据记录下来，准备面试口述素材。</p></div></div>'
    + '<div class="prep-plan-step"><span class="prep-plan-num">2</span>'
    + '<div><h3>第二阶段：知识点学习（7 天）</h3>'
    + '<p>逐个过「' + esc(SECTION_TITLES.gaps) + '」的 ' + n.gaps + ' 个知识点'
    + (n.p0 ? '（先补 ' + n.p0 + ' 项 P0）' : '')
    + '，每学完一块结合自己的项目写一段总结笔记。</p></div></div>'
    + '<div class="prep-plan-step"><span class="prep-plan-num">3</span>'
    + '<div><h3>第三阶段：复盘梳理（2 天）</h3>'
    + '<p>整理项目故事线，准备面试官深挖项目的问答，把优化成果转化为面试话术。</p></div></div>'
    + '</div></section>';

  const bodyHtml =
    '<section class="card prep-sec">'
    + '<div class="row prep-sec-head"><h2>' + esc(SECTION_TITLES.gaps) + '</h2>'
    + '<span class="spacer" style="flex:1"></span>'
    + '<span class="badge">' + n.gaps + ' 项</span>'
    + (n.p0 ? '<span class="badge bad">P0 ' + n.p0 + ' 项</span>' : '')
    + '</div>' + prepGapsHtml(r.parsed.gaps) + '</section>'
    + '<section class="card prep-sec">'
    + '<div class="row prep-sec-head"><h2>' + esc(SECTION_TITLES.projects) + '</h2>'
    + '<span class="spacer" style="flex:1"></span>'
    + '<span class="badge">' + n.projects + ' 个</span>'
    + '</div>' + prepProjectsHtml(r.parsed.projects) + '</section>'
    + '<section class="card prep-sec">'
    + '<div class="row prep-sec-head"><h2>' + esc(SECTION_TITLES.resources) + '</h2>'
    + '<span class="spacer" style="flex:1"></span>'
    + '<span class="badge">' + n.resources + ' 条</span>'
    + '</div>' + prepResourcesHtml(r.parsed.resources) + '</section>'
    + planHtml
    + '<p class="hint prep-foot">学习资源请自行核对是否仍可访问 —— 课程与书单会随时间下架或改版。</p>';

  return { overviewHtml, bodyHtml };
}

/** 摘掉一条计划：只改会话里的 s.result.parsed（生成结果本就不落盘），
 *  重新生成一次即全部重来，所以不需要确认弹窗，toast 说清删了谁即可。 */
function onPrepDelete(e) {
  // gaps 的按钮在 <summary> 里：不拦默认行为会把折叠面板一起开合
  e.preventDefault();
  e.stopPropagation();
  const sec = String(e.currentTarget.dataset.pdel || '');
  const idx = Number(e.currentTarget.dataset.pidx);
  const parsed = prepSession().result && prepSession().result.parsed;
  if (!parsed || !Array.isArray(parsed[sec])) return;
  if (!Number.isInteger(idx) || idx < 0 || idx >= parsed[sec].length) return;
  const gone = parsed[sec].splice(idx, 1)[0] || {};
  paintPrep();
  toast('已删除「' + (gone.name || gone.title || '这一条') + '」', 'ok');
}

/** 发起一次生成。往返期间只写 S，回来由 paintPrep 重画。 */
async function runPrep() {
  const s = prepSession();
  const cur = s.items.find((x) => x.file === s.file);
  if (!cur) { toast('先选一个岗位', 'warn'); return; }
  // 不能生成的岗位在下拉里已经禁用了，但键盘/脚本仍可能改到 value，兜一次
  if (!cur.canGenerate) { toast(cur.blockHint || '这个岗位的数据不够，生成不了', 'bad'); return; }

  s.state = 'loading';
  s.error = null;
  s.runId += 1;
  const myRun = s.runId;
  paintPrep();

  try {
    const r = await api('/api/prep/generate', {
      method: 'POST',
      // 服务端给 AI 的超时是 15 分钟，这里要比它宽，否则前端先断、
      // 用户看到「超时」而服务端其实还在跑。
      timeout: 960000,
      body: { file: cur.file, engine: s.engine },
    });
    if (myRun !== s.runId) return;          // 期间又点了生成，或换了岗位
    s.result = r;
    s.state = 'done';
    // 服务端已自动落盘（data/prep/，一个岗位一份）；用响应里的摘要更新历史列表
    if (r.plan) {
      const hi = s.history.findIndex((x) => x.file === r.plan.file);
      if (hi >= 0) s.history[hi] = r.plan; else s.history.unshift(r.plan);
    }
    toast(r.source === 'ai' ? '备考建议已生成' : '已用本地规则版生成', 'ok');
  } catch (err) {
    if (myRun !== s.runId) return;
    // api() 把服务端的结构化信息挂在 err.data 上（缺什么、要不要补简历），
    // 直接用它，别再从错误文案里猜。
    const d = (err && err.data) || {};
    s.error = {
      message: err.message,
      missing: d.missing || [],
      needCv: !!d.needCv,
    };
    s.state = 'error';
    s.result = null;
  } finally {
    if (myRun === s.runId) paintPrep();
  }
}

VIEWS.prep = async function (view) {
  const s = prepSession();
  // 「提升计划」页转交的岗位（growth 卡片的「生成提升计划」）：预选后
  // prep 页自己的下拉/会话照常工作，只是省一步手选。
  if (S.wzPrepFile) {
    s.file = S.wzPrepFile;
    S.wzPrepFile = '';
  }

  // 列表第一次进页面才拉；之后用 S 里的缓存 —— 切页回来要立刻有内容，
  // 不能每次都等一遍接口（报告多起来后会更明显）。
  if (!s.loaded) {
    try {
      const r = await api('/api/prep/list');
      s.items = r.items || [];
      s.defaultFile = r.defaultFile || '';
      s.cvChars = r.cvChars || 0;
      s.cvMissing = !!r.cvMissing;
      s.listError = '';
    } catch (err) {
      s.listError = err.message;
    }
    s.loaded = true;
  }

  // 选中项：优先沿用用户上次选的（跨页保留），它没了才回落到列表给的默认值
  if (!s.file || !s.items.some((x) => x.file === s.file)) {
    s.file = s.defaultFile || (s.items[0] || {}).file || '';
  }

  // 提升计划页：拉服务端保存的历史（生成即自动落盘，刷新/重进不丢）
  if (location.hash.slice(1) === 'growth') {
    try {
      const h = await api('/api/prep/history');
      s.history = h.items || [];
    } catch (err) {
      s.history = [];
      toast('历史提升计划读取失败：' + err.message, 'warn');
    }
  }

  // 进页自动显示「这份岗位已有的计划」（2026-10-12 用户反馈：从「报告详情」
  // 跳过来看不到之前生成过的计划）。只在当前没有结果时做，绝不覆盖用户刚生成的那份。
  if (!s.result && s.file) await loadSavedPrepPlan(s.file);

  paintPrep();
  // 测试钩子（AUTOTEST）：自检用这个入口固定引擎（生产环境不暴露）
  if (AUTOTEST) {
    window.__prepTest = {
      setEngine(v) { prepSession().engine = v; },
    };
  }
  void view;
};


// ══ 视图：评估报告 ════════════════════════════════════════
VIEWS.reports = async function (view) {
  const list = await api('/api/reports');
  S.reports = list;

  if (!list.length) {
    const acts = [
      { label: '去评估岗位', primary: true, onClick: () => go('evaluate') },
      { label: '看使用帮助', onClick: () => go('help') },
    ];
    view.innerHTML = '<div class="card">' + emptyState({
      ico: 'reports',
      title: '还没有评估报告',
      desc: '评估过的岗位会在这里显示完整的 A–H 分析。去「评估岗位」页粘链接或 JD 正文，跑一次就有报告了。',
      actions: acts,
    }) + '</div>';
    wireActions(view, acts);
    return;
  }

  const scoreVal = (s) => { const m = String(s || '').match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : null; };
  const badge = (s) => {
    const v = scoreVal(s);
    if (v == null) return '<span class="badge">—</span>';
    return '<span class="badge score ' + (v >= 4 ? 'ok' : v >= 3 ? 'warn' : 'bad') + '">' + v.toFixed(1) + '/5</span>';
  };

  view.innerHTML =
    '<div class="toolbar">'
    + '<label class="sr-only" for="rSearch">按公司或岗位搜索报告</label>'
    + '<input class="input tb-search" id="rSearch" placeholder="搜索公司或岗位…">'
    + '<span class="spacer"></span>'
    + '<span class="badge">' + list.length + ' 份</span></div>'
    + '<div id="rList">' + list.map((r) => {
      const v = scoreVal(r.score);
      return '<div class="card is-clickable report-item" data-name="' + esc((r.title + ' ' + r.archetype).toLowerCase()) + '"'
        + ' role="button" tabindex="0" aria-label="查看报告：' + esc(r.title) + '">'
        + '<div class="row"><b style="font-size:14px">' + esc(r.title) + '</b>'
        + '<span class="spacer" style="flex:1"></span>' + badge(r.score)
        + '<button class="btn sm danger" type="button" data-delrep="' + esc(r.file) + '"'
        + ' aria-label="删除报告：' + esc(r.title) + '">删除</button></div>'
        + '<div class="row tight" style="margin-top:6px;font-size:12.5px;color:var(--ink-3)">'
        + (r.date ? '<span>' + esc(r.date) + '</span>' : '')
        + (r.archetype ? '<span>· ' + esc(r.archetype) + '</span>' : '')
        + (r.legitimacy ? '<span>· 真实性 ' + esc(r.legitimacy) + '</span>' : '')
        + (v != null && v < 4 ? '<span class="badge warn">不建议投递</span>' : '')
        + '</div></div>';
    }).join('') + '</div>';

  $$('.report-item').forEach((el, idx) => {
    el.addEventListener('click', () => openReport(list[idx].file));
    // 声明成按钮就得能用键盘触发。但卡片里还有「删除」按钮：焦点落在它上面按
    // Enter／空格时事件会冒泡到卡片上，不判断来源就会「删完顺手把报告打开」。
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReport(list[idx].file); }
    });
  });

  // 卡片本身是「打开报告」，删除按钮必须拦住冒泡，否则点删除等于点打开
  $$('[data-delrep]', view).forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    askDeleteReport(b.dataset.delrep);
  }));

  const search = $('#rSearch');
  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      $$('.report-item').forEach((el, idx) => {
        const hit = !q || el.dataset.name.includes(q) || list[idx].file.toLowerCase().includes(q);
        el.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      if (!shown) {
        const reset = () => { search.value = ''; search.dispatchEvent(new Event('input')); };
        const acts = [{ label: '清空搜索', primary: true, onClick: reset }];
        $('#rList').innerHTML = emptyState({
          ico: 'search', title: '没有匹配的报告',
          desc: '换个关键词试试，或清空搜索框看全部。', actions: acts,
        });
        wireActions($('#rList'), acts);
      }
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// 视图：自动投递（BOSS 直聘）
//
// 设计上唯一重要的事：**别把用户的平台账号玩坏**。所以这一页的默认值
// 永远是「什么都不发」——
//   1. 「生成投递计划」= dry-run，只读岗位、应用过滤，一个字都不发给 HR；
//   2. 「确认并发送」要再过一次确认弹窗，且服务端还要求 body.confirm === true
//      才加 --confirm，前端绕过按钮也发不出去；
//   3. 上限、间隔、打招呼语长度在服务端各夹一次，界面传什么都越不了界。
// 真正开浏览器的是根目录的 auto-apply-run.mjs（Node + Playwright），
// 页面只发一个 POST，然后画结果。
//
// 状态同样挂在会话里（S.auto），DOM 只是投影：跑一次要几分钟，
// 中途切到别的页再回来，进度与结果都还在。
// ═══════════════════════════════════════════════════════════════════════
function autoSession() {
  if (!S.auto) {
    S.auto = {
      loaded: false,      // 配置拉过没有
      cfg: null,          // /api/auto-apply/config 的响应
      listError: '',
      // 表单值存在会话里：跑一次要几分钟，中途切页回来不能把输入冲掉
      form: {
        keyword: '',
        city: '',                       // 直接写城市名（北京/上海…），留空=全国；数字码也兼容
        cap: SAFE_DEFAULTS.dailyCap,
        sayHi: SAFE_DEFAULTS.sayHi,
      },
      state: 'idle',      // idle | running | done | error
      result: null,       // /api/auto-apply/start 的完整响应
      error: '',
      runId: 0,           // 递增让在飞的旧请求作废
    };
  }
  return S.auto;
}

VIEWS.autoapply = async function (view) {
  const s = autoSession();
  if (!s.loaded) {
    try {
      s.cfg = await api('/api/auto-apply/config');
      s.listError = '';
    } catch (err) {
      s.listError = err.message;
    }
    s.loaded = true;
  }
  paintAutoApply();
  void view;
};

function paintAutoApply() {
  if (location.hash.slice(1) !== 'autoapply') return;
  const view = $('#view');
  if (!view) return;
  const s = autoSession();

  if (s.listError) {
    view.innerHTML = errorState(new Error(s.listError), true);
    wireActions(view, [{ label: '重试', primary: true, onClick: () => { s.loaded = false; route(); } }]);
    $('#topActions').innerHTML = '';
    return;
  }

  const cfg = s.cfg || {};
  const f = s.form;
  const busy = s.state === 'running';
  const today = cfg.today || {};

  view.innerHTML =
    // ⚠ 起手必须是一个空串：删掉说明卡后，下面第一个 + 若紧跟三元，
    // 会被当成**一元加**（+'' → 数字 0），页面顶上就会渲染出一个孤零零的「0」。
    ''
    // ── 登录态：分两种「没就绪」，提示必须不一样 ──
    // ① 根本没有 cookie 文件 → 从没跑过 save-cookies
    // ② 有文件但里面没有登录态 cookie → 跑过，但当时没登录成功（最常见）
    //    只判「文件在不在」会给假绿：页面说没问题，跑起来什么都读不到。
    + (cfg.hasLogin ? ''
      : cfg.hasCookie
        ? '<div class="notice warn"><b>有 cookie 文件，但里面没有登录态</b>'
          + '<p><code>' + esc(cfg.cookiePath || '') + '</code> 里只有 ' + esc(String(cfg.cookieCount || 0))
          + ' 条匿名标识（缺 ' + esc((cfg.loginCookieNames || []).join(' / ')) + '），'
          + '说明保存时并没有登录成功 —— 多半是浏览器打开后没走完登录就按了回车。</p>'
          + '<p>重新跑一次 <code>node save-cookies-boss.mjs --persist</code>，'
          + '<b>这次一定要在弹出来的浏览器里真正登录进 BOSS 首页</b>（看到自己的头像/昵称），'
          + '再回终端按回车。</p></div>'
        : '<div class="notice warn"><b>还没保存 BOSS 登录态</b>'
          + '<p>没登录的话搜索页大概率什么都读不到。在项目根目录跑：</p>'
          + '<p><code>node save-cookies-boss.mjs --persist</code></p>'
          + '<p>它会打开浏览器，你在里面登录进 BOSS 首页（<b>右上角能看到自己的头像/昵称</b>），'
          + '再回终端按回车。登录态存到 '
          + '<code>' + esc(cfg.cookiePath || ('data/cookies/' + PLATFORM + '.json')) + '</code>。</p>'
          + '<p>如果浏览器窗口一直空白：看终端里它打印的「地址 / 标题 / 正文长度」——'
          + '标题含「验证」就是被风控拦了，在那个窗口手动过一次验证即可；'
          + '还不行就加 <code>--edge</code> 重跑。</p></div>')

    // ── 参数卡 ──
    + '<div class="card"><h2>投递条件</h2>'
    + '<div class="row tight" style="flex-wrap:wrap;gap:14px">'
    + '<label class="field" style="flex:1 1 240px"><span>搜索关键词</span>'
    + '<input class="input" id="aaKw" value="' + esc(f.keyword) + '"'
    + (busy ? ' disabled' : '') + ' placeholder="例如：Java 后端、测试开发"></label>'
    + '<label class="field" style="flex:0 1 170px"><span>城市</span>'
    + '<input class="input" id="aaCity" value="' + esc(f.city) + '"'
    + (busy ? ' disabled' : '') + ' placeholder="北京 / 上海（留空=全国）"></label>'
    + '<label class="field" style="flex:0 1 150px"><span>单次最多投</span>'
    + '<input class="input" id="aaCap" type="number" min="1" max="' + PLATFORM_DAILY_CAP + '"'
    + ' value="' + esc(String(f.cap)) + '"' + (busy ? ' disabled' : '') + '></label>'
    + '</div>'
    + '<label class="field" style="margin-top:12px"><span>打招呼语（BOSS 上限 150 字）</span>'
    + '<textarea class="input" id="aaHi" rows="2" maxlength="150"'
    + (busy ? ' disabled' : '') + '>' + esc(f.sayHi) + '</textarea></label>'
    + '</div>'

    // ── 额度 / 台账 ──
    + '<div class="card"><h2>今天的额度</h2>'
    + '<div class="row tight" style="flex-wrap:wrap">'
    + '<span class="badge' + (today.sent ? ' ok' : '') + '">今天已投 '
    + esc(String(today.sent || 0)) + ' / ' + esc(String(cfg.platformDailyCap || PLATFORM_DAILY_CAP)) + '</span>'
    + (today.failed ? '<span class="badge bad">失败 ' + esc(String(today.failed)) + '</span>' : '')
    + '<span class="badge">台账共 ' + esc(String(cfg.logTotal || 0)) + ' 条</span>'
    + '</div>'
    + '<p class="hint">已投过的岗位会记在本地台账 <code>' + esc(cfg.logPath || 'data/auto-apply/log.jsonl')
    + '</code> 里，下次遇到同一个岗位自动跳过 —— 不会重复打招呼。</p>'
    + paintApplyRecords(cfg.recent, cfg)
    + '</div>'

    + '<div id="aaMsg"></div>'
    + '<div id="aaOut"></div>';

  // ── 顶部操作：一屏只有一个主按钮，发送用 danger 表明它不可撤销 ──
  $('#topActions').innerHTML =
    '<button class="btn primary" id="aaPlan" type="button"' + (busy ? ' disabled' : '') + '>'
    + (busy ? '跑中…' : '生成投递计划') + '</button>'
    + '<button class="btn danger" id="aaSend" type="button"' + (busy ? ' disabled' : '') + '>'
    + '确认并发送</button>';

  // 表单值只回写会话、不重画 —— 重画会把焦点弄丢，输到一半的字也没了。
  // 真正提交时以**当前 DOM** 为准，所见即所发。
  const keep = (id, key, cast) => {
    const el = $(id);
    if (el) el.addEventListener('change', () => { f[key] = cast ? cast(el.value) : el.value; });
  };
  keep('#aaKw', 'keyword');
  keep('#aaCity', 'city');
  keep('#aaCap', 'cap', (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : SAFE_DEFAULTS.dailyCap; });
  keep('#aaHi', 'sayHi');

  $('#aaPlan').addEventListener('click', () => runAutoApply('plan'));
  $('#aaSend').addEventListener('click', () => runAutoApply('send'));

  paintAutoApplyBody();
}

/**
 * 「今天的额度」卡里的投递记录列表（cfg.recent = 台账最近 20 条，新的在上）。
 * 台账只记「真发过 / 发失败」两种 —— 计划里被过滤掉的岗位不算投递，不上台账。
 */
function paintApplyRecords(recent, cfg) {
  const list = Array.isArray(recent) ? recent : [];
  if (!list.length) {
    return '<p class="hint" style="margin-top:8px">还没有投递记录 —— '
      + '「确认并发送」真发过的岗位会逐条列在这里（失败会带原因）。</p>';
  }
  const zh = cfg.stateZh || {};
  const rows = list.slice(0, 10).map((e) => {
    const okSt = e.state === 'sent';
    let when = '';
    try {
      when = new Date(e.ts).toLocaleString('zh-CN',
        { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    } catch { when = String(e.ts || ''); }
    const why = (!okSt && e.note) ? '<span style="color:var(--bad-ink,#B42318)"> —— ' + esc(String(e.note)) + '</span>' : '';
    return '<div style="display:flex;gap:10px;align-items:baseline;padding:7px 0;'
      + 'border-bottom:1px solid var(--line)">'
      + '<span style="flex:0 0 92px;color:var(--ink-3);font-size:12px">' + esc(when) + '</span>'
      + '<span class="badge ' + (okSt ? 'ok' : 'bad') + '" style="flex:0 0 auto">'
      + esc(zh[e.state] || e.state || '') + '</span>'
      + '<span style="flex:1;min-width:0;font-size:13px;color:var(--ink)">'
      + esc(String(e.jobName || '（未取到岗位名）'))
      + (e.company ? '<span style="color:var(--ink-3)"> · ' + esc(String(e.company)) + '</span>' : '')
      + (e.salary ? '<span style="color:var(--ink-3)"> · ' + esc(String(e.salary)) + '</span>' : '')
      + why + '</span></div>';
  }).join('');
  return '<div style="margin-top:12px"><b style="font-size:13px">投递记录</b>'
    + '<div style="margin-top:4px">' + rows + '</div>'
    + (list.length > 10 ? '<p class="hint" style="margin-top:6px">只显示最近 10 条，完整台账见 '
      + esc(cfg.logPath || 'data/auto-apply/log.jsonl') + '。</p>' : '')
    + '</div>';
}

/** 结果区 / 提示区的单独投影：只依赖 state + result + error。 */
function paintAutoApplyBody() {
  const msg = $('#aaMsg');
  const out = $('#aaOut');
  if (!msg || !out) return;
  const s = autoSession();

  if (s.state === 'idle') { msg.innerHTML = ''; out.innerHTML = ''; return; }

  if (s.state === 'running') {
    msg.innerHTML = '<div class="notice info"><b>正在跑…</b>'
      + '<p><span class="spinner" aria-hidden="true"></span> 正在打开 BOSS 搜索页并逐个读取岗位。'
      + '岗位较多时要几分钟，可以切到别的页面等，回来进度还在。</p></div>';
    out.innerHTML = '';
    return;
  }

  if (s.state === 'error') {
    msg.innerHTML = '<div class="notice bad"><b>这次没跑成</b><p>' + esc(s.error || '未知错误') + '</p></div>';
    out.innerHTML = s.result && s.result.raw
      ? '<div class="card"><h2>执行器输出</h2><pre class="log">' + esc(s.result.raw) + '</pre></div>'
      : '';
    return;
  }

  // ── 完成 ──
  const r = s.result || {};
  const plan = r.plan || [];
  const sum = summarizePlan(plan);

  msg.innerHTML = '<div class="notice ' + (r.dryRun ? 'info' : 'ok') + '"><b>'
    + (r.dryRun
      ? '计划已生成（没有发送任何消息）'
      : '执行完成，共发送 ' + (r.sent || 0) + ' 条')
    + '</b><p>共读到 ' + sum.total + ' 个岗位：'
    + '<b>' + sum.pending + '</b> 个待投递、<b>' + sum.skipped + '</b> 个被过滤'
    + (sum.sent ? '、<b>' + sum.sent + '</b> 个已发送' : '')
    + (sum.failed ? '、<b>' + sum.failed + '</b> 个失败' : '') + '。</p>'
    + (r.dryRun
      ? '<p>确认这份计划没问题，再点右上角「确认并发送」。</p>'
      : '')
    + '</div>';

  out.innerHTML = autoPlanTable(plan) + autoEventLog(r.events || []);
}

/** 计划表：状态 + 岗位 + 公司 + 薪资 + HR 活跃度 + 跳过原因。 */
function autoPlanTable(plan) {
  if (!plan.length) return '';
  const tone = (st) => (st === ITEM_STATE.sent ? 'ok'
    : st === ITEM_STATE.failed ? 'bad'
      : st === ITEM_STATE.skipped ? '' : 'warn');
  return '<div class="card" style="padding:0;overflow:hidden"><div class="table-wrap"><table class="data">'
    + '<thead><tr><th>状态</th><th>岗位</th><th>公司</th><th>薪资</th>'
    + '<th>HR 活跃度</th><th>说明</th></tr></thead><tbody>'
    + plan.map((it) => {
      const reason = it.reason ? (FILTER_REASON_ZH[it.reason] || it.reason) : '';
      const name = esc(it.jobName || '—');
      return '<tr>'
        + '<td><span class="badge ' + tone(it.state) + '">'
        + esc(STATE_ZH[it.state] || String(it.state || '')) + '</span></td>'
        + '<td>' + (it.url
          ? '<a href="' + safeHref(it.url) + '" target="_blank" rel="noreferrer noopener">' + name + '</a>'
          : name) + '</td>'
        + '<td>' + esc(it.company || '—') + '</td>'
        + '<td>' + esc(it.salary || '—') + '</td>'
        + '<td>' + esc(it.hrActive || '—') + '</td>'
        + '<td style="color:var(--ink-3)">' + esc(reason) + '</td>'
        + '</tr>';
    }).join('')
    + '</tbody></table></div></div>';
}

/** 执行器日志（只看最后 40 条，够诊断又不会把页面拉得很长）。 */
function autoEventLog(events) {
  const lines = (events || [])
    .filter((e) => e.type === 'info' || e.type === 'warn' || e.type === 'error')
    .slice(-40)
    .map((e) => (e.type === 'error' ? '[错误] ' : e.type === 'warn' ? '[提醒] ' : '') + String(e.message || ''));
  if (!lines.length) return '';
  return '<div class="card"><h2>执行日志</h2>'
    + '<pre class="log">' + esc(lines.join('\n')) + '</pre></div>';
}

async function runAutoApply(mode) {
  const s = autoSession();
  if (s.state === 'running') return;

  // 取值以**当前 DOM** 为准：界面上看到什么就发什么，不拿会话里的旧值。
  const val = (id) => { const el = $(id); return el ? el.value : ''; };
  const capRaw = Number(val('#aaCap'));
  const form = {
    keyword: String(val('#aaKw') || '').trim(),
    city: String(val('#aaCity') || '').trim() || '100010000',
    cap: Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : SAFE_DEFAULTS.dailyCap,
    sayHi: String(val('#aaHi') || '').trim(),
  };
  s.form = form;

  if (!form.keyword) {
    toast('先填搜索关键词', 'warn');
    const el = $('#aaKw'); if (el) el.focus();
    return;
  }
  if (!form.sayHi) {
    toast('先写一句打招呼语', 'warn');
    return;
  }

  // 真实发送：二次确认。发出去的消息收不回来，这一步不能省。
  if (mode === 'send') {
    const ok = await confirmDialog({
      title: '真的要发送吗',
      desc: '会用「' + form.keyword + '」去 BOSS 搜岗位，并向符合条件的岗位逐条发送打招呼语，'
        + '本次最多 ' + form.cap + ' 条。发出去的消息收不回来；'
        + '投过的岗位有本地台账去重，不会重复发。',
      confirmLabel: '确认发送', cancelLabel: '再想想', danger: true,
    });
    if (!ok) return;
  }

  const myRun = ++s.runId;
  s.state = 'running';
  s.error = '';
  s.result = null;
  paintAutoApply();

  try {
    // timeout: 0 —— 这一跑可能十几分钟，前端不能自己掐断连接
    const r = await api('/api/auto-apply/start', {
      method: 'POST', timeout: 0,
      body: { mode, confirm: mode === 'send', ...form },
    });
    if (myRun !== s.runId) return;
    s.result = r;
    s.state = r.ok ? 'done' : 'error';
    s.error = r.ok ? '' : (r.error || '执行器没给出可用结果');

    // 发过之后「今天已投」变了，配置重拉一次
    try { s.cfg = await api('/api/auto-apply/config'); s.loaded = true; } catch { /* 不影响结果展示 */ }

    const sum = summarizePlan(r.plan || []);
    toast(r.dryRun
      ? '计划已生成：' + sum.total + ' 个岗位，' + sum.pending + ' 个待投递（未发送任何消息）'
      : '执行完成，已发送 ' + (r.sent || 0) + ' 条',
    r.ok ? 'ok' : 'warn');
  } catch (err) {
    if (myRun !== s.runId) return;
    s.state = 'error';
    s.error = String((err && err.message) || err);
  }
  if (myRun !== s.runId) return;
  paintAutoApply();
}

// ══ 删除记录（可恢复） ═══════════════════════════════════
// 报告删除遵循一条规矩：先把「会动到什么」讲清楚再动手，且服务端在动之前
// 已经把原始文件快照进 data/trash/，所以这里的「删」是可逆的。
//
// 「删台账某一行」的入口随投递台账页一起撤下了（界面没有了，行内的删除按钮
// 自然也没有宿主）。要删单行仍可走 CLI：node tracker.mjs delete --num N。
async function askDeleteReport(fileRaw) {
  const file = reportFileName(fileRaw) || String(fileRaw || '').trim();
  if (!file) { toast('这个报告名认不出来，删不了', 'bad'); return; }

  const meta = (S.reports || []).find((x) => x.file === file);
  // 引用它的投递记录行会被一起删掉 —— 这是确认过的语义，必须在确认框里点名
  // 说清楚，否则「删一份报告顺手删掉两行投递记录」就是一次静默的数据损失。
  // 台账页面撤下后，这份清单只能自己拉一次 /api/tracker 算出来
  // （接口与 data/applications.md 都还在，只是没有页面了）。
  let hits = [];
  try {
    const t = await api('/api/tracker');
    hits = (t.rows || []).filter((r) => reportFileName(r.report) === file);
  } catch { /* 台账读不到不阻塞删除：服务端照样会处理，并把实际删了几行回报上来 */ }

  const desc = '「' + (meta ? meta.title : file) + '」这份报告会移到 data/trash/（可恢复）。'
    + (hits.length
      ? '投递记录里引用它的 ' + hits.length + ' 行会一并删除：'
        + hits.map((r) => '第' + r.num + '行 ' + (r.company || '（无公司名）')).join('、') + '。'
      : '投递记录里没有引用它的行。');

  const sure = await confirmDialog({
    title: '删除这份评估报告？', desc, confirmLabel: '删除报告', danger: true,
  });
  if (!sure) return;

  try {
    const r = await api('/api/report/delete', { method: 'POST', body: { file } });
    S.reports = null;
    // 备考页的岗位下拉也是按报告列出来的，少了一份就得重新拉。
    // 只置 loaded=false 让列表重拉 —— 已经生成好的建议不动，那是用户的劳动成果。
    if (S.prep) {
      S.prep.loaded = false;
      if (S.prep.file === file) { S.prep.file = ''; S.prep.result = null; S.prep.state = 'idle'; S.prep.error = null; }
    }
    if (r.failedRows && r.failedRows.length) {
      toast('报告已删除，但有 ' + r.failedRows.length + ' 行投递记录没能自动删掉，需要手工处理', 'warn');
    } else {
      toast('已删除报告'
        + (r.removedRows && r.removedRows.length ? '，并移除投递记录 ' + r.removedRows.length + ' 行' : ''), 'ok');
    }
    await route({ keepScroll: true });
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function openReport(fileRaw) {
  // 再来一道收敛：调用方可能拿到的是 Markdown 链接、带引号的路径或完整路径。
  // 统一成文件名后再发给服务端，避免因一个 `)` 就报「文件名不合法」。
  const file = reportFileName(fileRaw) || String(fileRaw || '').trim();
  const view = $('#view');
  $('#pageTitle').textContent = '报告详情';
  $('#pageSub').textContent = file || '未指定';
  document.title = '报告详情 · 历琢 控制台';
  $('#topActions').innerHTML = '<button class="btn" id="rBack" type="button">返回列表</button>'
    + '<button class="btn danger" id="rDel" type="button">删除这份报告</button>';
  view.setAttribute('aria-busy', 'true');
  view.innerHTML = '<div class="skeleton sk-title"></div>' + skLines(10);
  $('#rBack').addEventListener('click', () => route());
  $('#rDel').addEventListener('click', () => askDeleteReport(file));

  try {
    if (!file) {
      // 台账 Report 列写了东西，但不像一个 .md 文件名（例如被手改成纯文字）。
      throw Object.assign(new Error('这一行的「报告」列不是 .md 文件名，无法打开'), { status: 400 });
    }
    const r = await api('/api/report?file=' + encodeURIComponent(file));
    // 报告详情也按初筛结果卡那套版式呈现（2026-10-12 用户要求）：顶部一张
    // 匹配卡（雷达 / 综合匹配 / 三徽标 / JD 解读 / 三组），下面是完整 A–H 正文。
    // 卡片字段由服务端从报告里解析（parseReportSummary），老报告缺字段的地方
    // 逐项降级（六维缺失→按总分折算并注明「示意」，硬门槛未过→显示「资格不符」）。
    const sum = r.summary;
    const infoLine = sum
      ? [
        sum.date ? '评估于 ' + sum.date : '',
        sum.archetype || '',
        sum.legitimacy ? '真实性：' + sum.legitimacy : '',
      ].filter(Boolean).join('　·　')
      : '';
    const cardHtml = sum
      ? '<div class="card ev-match-card">' + matchCardHtml({
        score: sum.score5,
        verdict: sum.gated ? 'FAIL' : null,
        tier: sum.tier,
        why: sum.why,
        dims: sum.dims,
        good: sum.good,
        gap: sum.gap,
        tip: sum.tip,
        gated: sum.gated,
      }, sum.threshold, { infoLine }) + '</div>'
      : '';
    view.innerHTML = cardHtml
      + '<div class="card"><div class="md md-report">' + mdToHtml(r.markdown) + '</div></div>';

    // 报告读出来了才挂「生成提升计划」：这份报告就是计划的输入，
    // 读不到它，跳过去也只会看到一个「数据不足」。
    $('#topActions').innerHTML = '<button class="btn primary" id="rPrep" type="button">'
      + '生成提升计划</button>'
      + '<button class="btn" id="rBack" type="button">返回列表</button>'
      + '<button class="btn danger" id="rDel" type="button">删除这份报告</button>';
    $('#rBack').addEventListener('click', () => route());
    $('#rDel').addEventListener('click', () => askDeleteReport(file));
    $('#rPrep').addEventListener('click', () => {
      // 2026-10-12 用户要求：按钮叫「生成提升计划」，点了去**提升计划页**
      //（历史计划列表在那一页；原来跳的是 prep 工作台，那页不看历史，
      // 用户会以为「之前生成的计划没了」）。计划早就落在服务端，
      // 进页会自动把这一个岗位的旧计划读回来显示，不会重复生成。
      const s = prepSession();
      if (s.file !== file) { s.result = null; s.error = null; s.state = 'idle'; }
      s.file = file;
      go('growth');
    });
  } catch (err) {
    if (err && err.status === 404) {
      // 报告文件被删/改名，台账还留着旧链接。指条明路，别只说「失败」。
      err.message = 'reports\\' + file + ' 不存在。台账里的链接可能已过期，'
        + '到「评估报告」页看看现有的报告，或重跑一次评估生成新报告。';
    }
    view.innerHTML = errorState(err, true);
    wireActions(view, [{ label: '重试', primary: true, onClick: () => openReport(file) }]);
  }
  view.setAttribute('aria-busy', 'false');
}

// 测试钩子（AUTOTEST）：报告详情不是 hash 路由（只能点列表项进），自检要能直接
// 打开指定的一份做断言。生产环境不暴露。
if (AUTOTEST) window.__reportTest = { open: (f) => openReport(f) };

// ══ 视图：简历编辑器 ══════════════════════════════════════
const CV_SCHEMA = {
  experience: {
    label: '工作 / 实习经历', empty: { company: '', role: '', location: '', dates: '', bullets: [] },
    title: (e) => e.company || e.role || '新经历',
    fields: [
      { k: 'role', l: '职位', w: 1 },
      { k: 'company', l: '公司 / 组织', w: 1 },
      { k: 'dates', l: '起止时间', ph: '2025.07 – 2025.09' },
      { k: 'location', l: '地点' },
      { k: 'bullets', l: '成果要点', t: 'bullets', ph: '每行一条。写清「做了什么 + 结果」，例如：\n用随机森林建模预测客户流失，AUC 达到 0.86' },
    ],
  },
  projects: {
    label: '项目', empty: { name: '', badge: '', description: '', tech: '', url: '', bullets: [] },
    title: (e) => e.name || '新项目',
    fields: [
      { k: 'name', l: '项目名称' },
      { k: 'badge', l: '标签', ph: '课程设计 / 开源 / 个人' },
      { k: 'description', l: '一句话说明', t: 'text' },
      { k: 'tech', l: '技术栈', ph: 'Python, Flask, Supabase' },
      { k: 'url', l: '链接' },
      { k: 'bullets', l: '亮点', t: 'bullets', ph: '每行一条' },
    ],
  },
  education: {
    label: '教育背景', empty: { title: '', org: '', location: '', year: '', description: '' },
    title: (e) => e.title || '新学历',
    fields: [
      { k: 'title', l: '学位 / 专业', ph: '数据科学与大数据技术 本科' },
      { k: 'org', l: '学校' },
      { k: 'location', l: '地点' },
      { k: 'year', l: '时间', ph: '2022 – 2026' },
      { k: 'description', l: '补充说明', t: 'text' },
    ],
  },
  certifications: {
    label: '证书', empty: { title: '', org: '', year: '' },
    title: (e) => e.title || '新证书',
    fields: [{ k: 'title', l: '名称' }, { k: 'org', l: '颁发机构' }, { k: 'year', l: '年份' }],
  },
  awards: {
    label: '荣誉奖项', empty: { title: '', org: '', year: '' },
    title: (e) => e.title || '新奖项',
    fields: [{ k: 'title', l: '名称' }, { k: 'org', l: '颁发方' }, { k: 'year', l: '年份' }],
  },
  skills: {
    label: '技能', empty: { category: '', items: [] },
    title: (e) => e.category || '新分类',
    fields: [
      { k: 'category', l: '分类名', ph: '编程语言 / 机器学习 / 工具' },
      { k: 'items', l: '具体技能', t: 'items', ph: '逗号或换行分隔，例如：Python, SQL, scikit-learn' },
    ],
  },
};

// ══ 简历多版本 ═══════════════════════════════════════════════
// 为什么要版本：「一份简历投所有岗位」是国内校招里最常见的失分点，但按岗位改一版
// 如果直接覆盖 cv.md，投到第三家时已经找不回投给第一家的那一份了。
//
// 分工：磁盘上 data/cv-versions/ 是唯一事实来源；S.cvVersions 只是它的一份缓存，
// 任何增删改都发请求 → 重新拉 → 重画，不在这里拼路径、也不往 localStorage 塞副本。
// 原版 = cv.md 本身，是这个页面唯一「不可删、不可改名」的一行。
const fmtDate = (ms) => (ms
  ? new Date(ms).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  : '—');

function versionsOf() { return (S.cvVersions && S.cvVersions.versions) || []; }
function versionById(id) { return versionsOf().find((v) => v.id === id) || null; }
function versionLabel(id) {
  if (!id || id === 'base') return '原版简历';
  const v = versionById(id);
  return v ? v.name : '版本 ' + id;
}

async function refreshVersions() {
  try { S.cvVersions = await api('/api/cv/versions'); } catch { S.cvVersions = null; }
  return S.cvVersions;
}

/** 增删改之后统一走这里：重拉列表 + 保持滚动位置重画。 */
async function afterVersionChange() {
  await refreshVersions();
  await route({ keepScroll: true });
}

/**
 * 版本名 / 适配岗位的输入弹层。新建与重命名共用。
 * 名称是必填的（服务端也拦一道），因为版本就是靠名字认的 ——
 * 允许空名等于允许用户造出几个长得一样的版本。
 */
function versionFormDialog({
  title, name = '', targetRole = '', desc = '', confirmLabel = '确定',
} = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    mask.setAttribute('aria-label', title);
    mask.innerHTML = '<div class="modal" style="max-width:520px">'
      + '<div class="modal-head"><h3>' + esc(title) + '</h3></div>'
      + (desc ? '<p class="hint">' + desc + '</p>' : '')
      + '<label class="field"><span>版本名称 <em>必填</em></span>'
      + '<input class="input" id="vfName" maxlength="60" autocomplete="off" '
      + 'placeholder="例如：腾讯-后端开发-2027校招" value="' + esc(name) + '"></label>'
      + '<label class="field"><span>适配岗位 <em>选填，便于日后辨认</em></span>'
      + '<input class="input" id="vfRole" maxlength="80" autocomplete="off" '
      + 'placeholder="例如：Java 后端开发工程师" value="' + esc(targetRole) + '"></label>'
      + '<p class="hint" id="vfErr" style="color:var(--bad-ink);display:none"></p>'
      + '<div class="foot"><button class="btn" type="button" id="vfNo">取消</button>'
      + '<button class="btn primary" type="button" id="vfYes">' + esc(confirmLabel) + '</button></div>'
      + '</div>';
    document.body.appendChild(mask);

    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const close = wireModal(mask, () => finish(null));

    const submit = () => {
      const n = $('#vfName', mask).value.trim();
      const err = $('#vfErr', mask);
      if (!n) {
        err.textContent = '版本名称不能为空 —— 版本就是靠名字认的。';
        err.style.display = 'block';
        $('#vfName', mask).focus();
        return;
      }
      finish({ name: n, targetRole: $('#vfRole', mask).value.trim() });
      close();
    };
    $('#vfNo', mask).addEventListener('click', () => { finish(null); close(); });
    $('#vfYes', mask).addEventListener('click', submit);
    mask.addEventListener('click', (e) => { if (e.target === mask) { finish(null); close(); } });
    // 回车直接提交：这是个只有两个字段的小表单，回车＝确认是符合直觉的
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
    });
  });
}

/** 查看某个版本的正文（渲染后的 Markdown + 原文折叠）。 */
async function openVersionPreview(id) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', '查看简历版本');
  mask.innerHTML = '<div class="modal" style="max-width:860px">'
    + '<div class="modal-head"><h3 id="vpTitle">' + esc(versionLabel(id)) + '</h3>'
    + '<span class="spacer"></span>'
    + '<button class="btn ghost sm icon" type="button" id="vpX" aria-label="关闭">' + icon('x') + '</button></div>'
    + '<div id="vpBody"><p class="hint">正在读取…</p></div></div>';
  document.body.appendChild(mask);
  const close = wireModal(mask);
  $('#vpX', mask).addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  try {
    const d = await api('/api/cv/versions/content?id=' + encodeURIComponent(id));
    if (!mask.isConnected) return;
    const warn = (d.audit && d.audit.broken && d.audit.broken.length)
      ? '<div class="notice warn"><b>这些章节解析不出内容：' + esc(d.audit.broken.join('、')) + '</b>'
        + '<p>文件本身没坏，是「我的简历」表单读不懂它们的写法。'
        + '要按这一版去改原版的话，建议先把这些标题改成常用叫法。</p></div>'
      : '';
    $('#vpTitle', mask).textContent = d.meta.name
      + (d.meta.targetRole ? '（' + d.meta.targetRole + '）' : '');
    $('#vpBody', mask).innerHTML = warn
      + '<p class="hint">创建于 ' + esc(fmtDate(d.meta.createdAt))
      + ' · 最近修改 ' + esc(fmtDate(d.meta.updatedAt))
      + ' · 完整度 ' + d.completeness.percent + '%'
      + ' · ' + esc(fmtBytes(d.meta.bytes || 0)) + '</p>'
      + '<div class="card" style="margin-top:10px"><div class="md">' + mdToHtml(d.markdown) + '</div></div>'
      + '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12.5px">'
      + '查看 Markdown 原文</summary><pre class="log" style="margin-top:10px;max-height:320px">'
      + esc(d.markdown) + '</pre></details>';
  } catch (err) {
    if (!mask.isConnected) return;
    $('#vpBody', mask).innerHTML = '<div class="notice bad"><b>读取失败</b><p>'
      + esc(err.message) + '</p></div>';
  }
}

/**
 * Diff 对比。默认配对规则（为什么要默认而不是让用户每次手选）：
 *   · 点的是某个岗位版本 → 「原版 ↔ 它」，因为这正是最常问的问题：
 *     「我为这个岗位到底改了什么」；
 *   · 点的是原版 → 「原版 ↔ 第一个岗位版本」，而不是原版跟自己比 ——
 *     自己跟自己比永远是「完全相同」，那是个什么都不告诉你的弹层。
 */
async function openVersionDiff(clickedId, otherId) {
  const list = versionsOf();
  const others = list.filter((v) => !v.base);
  let aId = 'base';
  let bId = clickedId;

  if (otherId) {
    aId = clickedId;
    bId = otherId;
  } else if (clickedId === 'base') {
    if (!others.length) {
      toast('现在只有原版，没有可对比的对象 —— 先「新建版本」建一个再来比', 'warn');
      return;
    }
    bId = others[0].id;
  }

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', '版本 Diff 对比');
  mask.innerHTML = '<div class="modal" style="max-width:980px">'
    + '<div class="modal-head"><h3>版本对比</h3><span class="spacer"></span>'
    + '<button class="btn ghost sm icon" type="button" id="vdX" aria-label="关闭">' + icon('x') + '</button></div>'
    + '<div class="row tight">'
    + '<label class="field" style="flex:1"><span>左侧（旧）</span>'
    + '<select class="select" id="vdA"></select></label>'
    + '<label class="field" style="flex:1"><span>右侧（新）</span>'
    + '<select class="select" id="vdB"></select></label>'
    + '</div>'
    + '<p class="hint" id="vdStat">正在对比…</p>'
    + '<div class="diffbox" id="vdBox"></div></div>';
  document.body.appendChild(mask);
  const close = wireModal(mask);
  $('#vdX', mask).addEventListener('click', close);
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });

  // 下拉里把所有版本（含原版）都列出来，任意两版都能比
  const opts = (sel, cur) => versionsOf().map((v) => '<option value="' + esc(v.id) + '"'
    + (v.id === cur ? ' selected' : '') + '>' + esc(v.name) + '</option>').join('');
  $('#vdA', mask).innerHTML = opts('vdA', aId);
  $('#vdB', mask).innerHTML = opts('vdB', bId);

  const run = async () => {
    const a = $('#vdA', mask).value;
    const b = $('#vdB', mask).value;
    $('#vdStat', mask).textContent = '正在对比…';
    $('#vdBox', mask).innerHTML = '';
    try {
      const d = await api('/api/cv/versions/diff', { method: 'POST', body: { a, b } });
      if (!mask.isConnected) return;
      $('#vdStat', mask).innerHTML = d.identical
        ? '<b>两份内容完全相同。</b>'
        : '新增 <b style="color:var(--ok-ink)">' + d.stats.added + '</b> 行，'
          + '删除 <b style="color:var(--bad-ink)">' + d.stats.removed + '</b> 行，'
          + '未改动 ' + d.stats.same + ' 行'
          + '　<span class="hint">左「' + esc(d.a.name) + '」 → 右「' + esc(d.b.name) + '」</span>';
      $('#vdBox', mask).innerHTML = d.identical
        ? '<p class="hint" style="padding:12px">没有差异，不用逐行看。</p>'
        : diffHtml(d.lines);
    } catch (err) {
      if (!mask.isConnected) return;
      $('#vdStat', mask).textContent = '对比失败';
      $('#vdBox', mask).innerHTML = '<p class="hint" style="padding:12px">' + esc(err.message) + '</p>';
    }
  };
  $('#vdA', mask).addEventListener('change', run);
  $('#vdB', mask).addEventListener('change', run);
  await run();
}

/**
 * 逐行 diff → HTML。
 * 长简历整体对比会有上百行「没变」的内容，全铺出来反而看不见真正的差异，
 * 所以只保留改动行前后各 3 行，其余折叠成一行提示。
 */
function diffHtml(lines) {
  const CTX = 3;
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t === ' ') return;
    for (let k = Math.max(0, i - CTX); k <= Math.min(lines.length - 1, i + CTX); k++) keep[k] = true;
  });

  const out = [];
  let skipped = 0;
  const flush = () => {
    if (!skipped) return;
    out.push('<div class="dline dskip">⋯ 省略 ' + skipped + ' 行未改动的内容</div>');
    skipped = 0;
  };
  lines.forEach((l, i) => {
    if (!keep[i]) { skipped++; return; }
    flush();
    const cls = l.t === '+' ? 'dadd' : l.t === '-' ? 'ddel' : l.t === '!' ? 'dnote' : 'dctx';
    out.push('<div class="dline ' + cls + '">'
      + '<span class="dno">' + (l.a != null ? l.a : '') + '</span>'
      + '<span class="dno">' + (l.b != null ? l.b : '') + '</span>'
      + '<span class="dsign">' + esc(l.t) + '</span>'
      + '<span class="dtxt">' + (l.text ? esc(l.text) : '&nbsp;') + '</span></div>');
  });
  flush();
  return out.join('');
}

/**
 * 版本卡标题「就地改名」（2026-10-12 用户要求：标题变成可编辑的）。
 * 点标题 → 原位变输入框 → Enter/失焦保存、Esc 取消。
 * ⚠️ rename 接口是**整条覆盖** name + targetRole：必须把原 targetRole 带回去，
 *    否则改个名字会把「适配岗位」清空（服务端 body.targetRole || '' 直接写回）。
 */
function startVersionTitleEdit(el, versions) {
  if (el.dataset.editing === '1') return;
  const id = el.dataset.verTitle;
  const v = (versions || []).find((x) => x.id === id);
  if (!v) return;
  el.dataset.editing = '1';
  el.classList.add('is-editing');
  el.innerHTML = '';
  const inp = document.createElement('input');
  inp.className = 'inp wz-ver-title-input';
  inp.value = v.name || '';
  inp.setAttribute('aria-label', '简历版本名称');
  el.appendChild(inp);
  inp.focus();
  inp.select();
  // 点输入框别冒泡回标题的 click（会再触发一次进入编辑）
  inp.addEventListener('click', (e) => e.stopPropagation());

  let done = false;
  const restore = () => { done = true; route({ keepScroll: true }); };
  const save = async () => {
    if (done) return;
    done = true;
    const name = String(inp.value || '').trim();
    if (!name) { toast('名字不能为空 —— 版本就是靠名字认的', 'warn'); restore(); return; }
    if (name === (v.name || '')) { restore(); return; }
    try {
      await api('/api/cv/versions/rename', {
        method: 'POST',
        body: { id, name, targetRole: v.targetRole || '' },
      });
      toast('已改名为「' + name + '」', 'ok');
      await afterVersionChange();
    } catch (err) {
      toast(err.message || '改名失败', 'bad');
      restore();
    }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); restore(); }
  });
  inp.addEventListener('blur', () => save());
}

/** 删除版本：先落回收目录，确认框里把版本名与适配岗位点明，避免删错。 */
async function askDeleteVersion(id) {
  const v = versionById(id);
  if (!v) { toast('找不到这个版本，刷新一下列表', 'bad'); return; }
  const sure = await confirmDialog({
    title: '删除版本「' + v.name + '」？',
    desc: (v.targetRole ? '适配岗位：' + v.targetRole + '。' : '')
      + '这份版本会移到 data/trash/（可恢复），原版 cv.md 与其它版本都不受影响。',
    confirmLabel: '删除版本', danger: true,
  });
  if (!sure) return;
  try {
    const r = await api('/api/cv/versions/delete', { method: 'POST', body: { id } });
    toast('已删除版本「' + (r.removed && r.removed.name ? r.removed.name : v.name) + '」'
      + '（回收目录里还能找回）', 'ok');
    await afterVersionChange();
  } catch (err) { toast(err.message, 'bad'); }
}

/**
 * 单版本导出 PDF（2026-10-11 改口径）：
 * 与顶栏「导出 PDF」**同一条管线**——用同一个预览渲染器渲染这一版的内容，
 * 再交给服务端打印，最后下载到本机。原来它走的是 `/api/pdf`（服务端另一套
 * 模板），导出的版式跟预览对不上，正是用户反馈过的那类问题。
 */
async function exportVersionPdf(id) {
  const v = versionById(id);
  const label = v ? v.name : '原版简历';
  toast('正在用「' + label + '」渲染 PDF…', 'info');
  try {
    const cur = await api('/api/cv/versions/content?id=' + encodeURIComponent(id));
    const form = cur.form || {};
    const name = String((form.candidate || {}).name || '简历');
    const r = await api('/api/cv/pdf-live', {
      method: 'POST', timeout: 300000,
      body: { html: await cvFormPrintHtml(form, name), name, page_format: 'a4' },
    });
    // 下载到本机（文件名带上版本名，同一版不同岗位各导一份不会混）
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const a = document.createElement('a');
    a.href = '/api/output?file=' + encodeURIComponent(r.file);
    a.download = '简历-' + name.replace(/[\/:*?"<>|]/g, '') + '-' + String(label).replace(/[\/:*?"<>|]/g, '').slice(0, 18) + '-' + stamp + '.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('「' + label + '」的 PDF 已开始下载（' + fmtBytes(r.size) + '）', 'ok');
  } catch (err) {
    toast('导出失败：' + ((err && err.message) || err), 'bad');
  }
}

/** 「简历版本」卡片：列表 + 每行操作。 */
// ── 折叠卡与分组标题（「我的简历」页的版面骨架）──────────────────────────
//
// 这一页原来是 13 个区块一路平铺 6500px：顶部「AI 优化」471px +「简历版本」
// 236px 两大面板压着正文，中间 9 个表单区块，底部 524px 预览。想改一个字段
// 要滚很久，而且看不出哪几块是一类。
//
// 改法是把「按需使用」的面板折起来（但仍在顶端 —— 缩到页脚没人会翻到），
// 再把 9 个表单区块折成三组、给一组跳转用的锚点。
//
// 开合状态存在 S.cvFolds：route() 每次切页都重建视图，状态只存在 DOM 上的话，
// 用户切走再回来，自己展开的面板会自己合上。
function foldCard(key, id, title, badge, hint, body, defaultOpen) {
  const open = S.cvFolds && key in S.cvFolds ? S.cvFolds[key] : defaultOpen;
  return '<details class="card fold"'
    + (id ? ' id="' + id + '"' : '')
    + ' data-fold="' + esc(key) + '"' + (open ? ' open' : '') + '>'
    + '<summary class="fold-sum">'
    + '<b class="fold-title">' + title + '</b>'
    + (badge || '')
    + '<span class="spacer"></span>'
    + (hint ? '<span class="fold-hint">' + hint + '</span>' : '')
    + '</summary>'
    + '<div class="fold-body">' + body + '</div>'
    + '</details>';
}

// 折叠开合写回会话。details 的 toggle 只在用户点击或程序改 open 时触发，
// 重建视图时用 open 属性生成不会回调，所以不会自己覆盖自己。
function wireFolds(view) {
  $$('details[data-fold]', view).forEach((d) => {
    d.addEventListener('toggle', () => {
      S.cvFolds = S.cvFolds || {};
      S.cvFolds[d.dataset.fold] = d.open;
    });
  });
}

// 打开「简历全局优化」（2026-10-09 改为独立页面）。
// 两条入口都会走到这里 —— 版本行的「AI 优化」和简历页的「下一步」（2026-10-11
// 用户要求把入口按钮文案改成「下一步」，点它跳到简历优化页）。
// 优化要跑 1–3 分钟且需要左右对照，右栏折叠卡放不下，故一律跳 cvopt 页。
// target 走会话传递，页面自己消费（和评估/简历草稿同一套路，不走 URL 传参）。
function openCvOptPanel() {
  const opt = cvOptSession();
  // 2026-10-09：这一页只做通用语句优化，恒定优化原版 cv.md。
  // 版本卡的「AI 优化」也统一跳到这里优化原版 —— 各岗位版本内容相同，
  // 措辞优化一次就够，按版本分别优化只是重复消耗额度。
  opt.target = 'base';
  opt.jd = '';
  opt.draft = ''; opt.summary = ''; opt.issues = []; opt.raw = ''; opt.parseError = '';
  opt.state = { label: '未开始', cls: 'badge' };
  // 提示行按用户要求删除（2026-10-12）：两栏是什么、该点哪个按钮，页面上
  // 本来就一眼可见，没必要再念一遍。这块如今只剩「出问题才写一句」的用途。
  opt.hint = '';
  go('cvopt');
}

function cvVersionsCard() {
  if (!S.cvVersions) {
    return '<div class="card"><h2>简历版本</h2>'
      + '<div class="notice warn"><b>版本列表读不出来</b>'
      + '<p>服务端没有返回 <code>data/cv-versions/</code> 的内容。刷新页面重试；'
      + '若一直这样，检查控制台服务是否正常。</p></div></div>';
  }
  const list = versionsOf();

  const rows = list.map((v) => {
    const ops = ['<button class="btn sm" data-vact="preview" data-vid="' + esc(v.id) + '">查看</button>'];
    ops.push('<button class="btn sm" data-vact="copy" data-vid="' + esc(v.id) + '">复制</button>');
    if (!v.base) ops.push('<button class="btn sm" data-vact="rename" data-vid="' + esc(v.id) + '">重命名</button>');
    ops.push('<button class="btn sm" data-vact="diff" data-vid="' + esc(v.id) + '">Diff</button>');
    ops.push('<button class="btn sm" data-vact="optimize" data-vid="' + esc(v.id) + '">AI 优化</button>');
    // 文案「导出」而不是「导出 PDF」：这一列最多 7 个按钮，长度是排得下与
    // 排不下「删除」的分界线（实测差 10px 就会把删除挤到第二行）。
    // 完整意思放进 title，鼠标停一下就能看到。
    ops.push('<button class="btn sm" data-vact="pdf" data-vid="' + esc(v.id)
      + '" title="导出「' + esc(v.name) + '」这一版的 PDF">导出</button>');
    if (!v.base) ops.push('<button class="btn sm danger" data-vact="delete" data-vid="' + esc(v.id) + '">删除</button>');

    const nameCell = '<b>' + esc(v.name) + '</b>'
      + (v.base ? ' <span class="badge info">原版</span>' : '')
      + (!v.exists ? ' <span class="badge bad">文件丢失</span>' : '')
      + (v.sourceName ? '<br><span class="hint">来自 ' + esc(v.sourceName) + '</span>' : '');

    return '<tr>'
      + '<td>' + nameCell + '</td>'
      + '<td>' + (v.targetRole ? esc(v.targetRole) : '<span class="hint">—</span>') + '</td>'
      + '<td class="num">' + esc(fmtDate(v.createdAt)) + '</td>'
      + '<td class="num">' + esc(fmtDate(v.updatedAt)) + '</td>'
      + '<td class="num">' + (v.bytes ? esc(fmtBytes(v.bytes)) : '—') + '</td>'
      + '<td class="act"><div class="ops">' + ops.join('') + '</div></td>'
      + '</tr>';
  }).join('');

  const nVer = list.filter((v) => !v.base).length;

  // 折起来。这一块是「查历史」用的，不是每次编辑简历都要看的；
  // 展开时那张表最多能占 400px，把正文顶出屏幕。summary 上的
  // 「N 个岗位版本」badge 保证收起时也知道里面有什么。
  return foldCard('versions', 'cvVersionsCard', '简历版本',
    '<span class="badge">' + (nVer ? nVer + ' 个岗位版本' : '只有原版') + '</span>',
    '按岗位留档 · 原版 cv.md 不动',
    '<p class="hint">为不同岗位各留一份定向简历。<b>原版 cv.md 永远不动</b> ——'
    + '定向优化出来的一律另存为新版本，投到哪一家都找得回来。'
    + 'AI 优化与导出 PDF 都是按单个版本独立进行的。</p>'
    + '<div class="table-wrap"><table class="data"><thead><tr>'
    + '<th>版本</th><th>适配岗位</th><th>创建时间</th><th>上次修改</th><th>大小</th><th></th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div class="row tight" style="margin-top:12px">'
    + '<button class="btn primary" id="cvVerNew" type="button">新建版本（从原版复制）</button>'
    + '<button class="btn" id="cvVerRefresh" type="button">刷新列表</button>'
    + '</div>',
    false);
}

// 卡片内所有按钮走事件委托：卡片会被 route() 反复重建，
// 逐个 addEventListener 每次都要重挂，漏一个就是「点了没反应」。
function wireVersionsCard(view) {
  const card = $('#cvVersionsCard', view);
  if (!card) return;

  $('#cvVerNew', card).addEventListener('click', async () => {
    const r = await versionFormDialog({
      title: '新建简历版本',
      desc: '会从<b>原版 cv.md</b> 复制一份内容作为起点，原版不受影响。'
        + '建好后可以单独对它做 AI 定向优化。',
      confirmLabel: '创建',
      name: '',
      targetRole: '',
    });
    if (!r) return;
    try {
      const res = await api('/api/cv/versions/create', {
        method: 'POST', body: { name: r.name, targetRole: r.targetRole, source: 'base' },
      });
      toast('已创建版本「' + res.version.name + '」', 'ok');
      await afterVersionChange();
    } catch (err) { toast(err.message, 'bad'); }
  });

  $('#cvVerRefresh', card).addEventListener('click', async () => {
    await refreshVersions();
    await route({ keepScroll: true });
    toast('版本列表已刷新', 'ok');
  });

  card.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-vact]');
    if (!btn) return;
    const id = btn.dataset.vid;
    const act = btn.dataset.vact;
    const v = versionById(id);

    if (act === 'preview') return openVersionPreview(id);

    if (act === 'copy') {
      const r = await versionFormDialog({
        title: '复制版本',
        desc: '从「' + esc(versionLabel(id)) + '」复制一份新版本。',
        confirmLabel: '复制',
        name: (v ? v.name : '版本') + ' 副本',
        targetRole: v ? v.targetRole || '' : '',
      });
      if (!r) return;
      try {
        const res = await api('/api/cv/versions/create', {
          method: 'POST', body: { name: r.name, targetRole: r.targetRole, source: id },
        });
        toast('已复制为「' + res.version.name + '」', 'ok');
        await afterVersionChange();
      } catch (err) { toast(err.message, 'bad'); }
      return;
    }

    if (act === 'rename') {
      const r = await versionFormDialog({
        title: '重命名版本',
        confirmLabel: '保存',
        name: v ? v.name : '',
        targetRole: v ? v.targetRole || '' : '',
      });
      if (!r) return;
      try {
        await api('/api/cv/versions/rename', {
          method: 'POST', body: { id, name: r.name, targetRole: r.targetRole },
        });
        toast('已改名', 'ok');
        await afterVersionChange();
      } catch (err) { toast(err.message, 'bad'); }
      return;
    }

    if (act === 'diff') return openVersionDiff(id);
    if (act === 'pdf') return exportVersionPdf(id);
    if (act === 'delete') return askDeleteVersion(id);

    if (act === 'optimize') {
      // 2026-10-09：优化页只做**通用语句优化**（无 JD 输入、无对象选择），
      // 恒定优化原版简历。各岗位版本的内容与原版一致，措辞优化一次就够 ——
      // 按版本分别优化只是重复消耗额度。所以这里忽略 id 直接跳过去。
      openCvOptPanel();
    }
  });
}

// ══ 简历优化会话：跨页面切换保留 ══════════════════════════════
// 和评估会话（S.evalSession）同一套路，原因也一样：route() 每次切页都会
// 重建整个视图（view.innerHTML = viewSkeleton(id)），写在 DOM 上的东西
// 一离开就没了。AI 优化要跑一两分钟，等待期间切去别的页面是常态——
// 回来发现清单和改写稿全空了最气人；更糟的是请求还在飞的时候切走，
// 回调会去写已经 detach 的旧节点（$('#cvOptGo') 拿到 null 直接抛错）。
//
// 所以：状态放会话，paintCvOpt() 是唯一的「会话 → DOM」出口，不在本页直接返回。
function newCvOptSession() {
  return {
    // 2026-10-09：这一页只做通用语句优化，恒定优化原版 cv.md。
    // jd / target 保留在会话里只为兼容旧书签与其它入口的传参，
    // 页面不再提供对应控件，VIEWS.cvopt 每次进来都会重置成下面这两个值。
    jd: '',
    target: 'base',
    // 原版内容是否已拉过（/api/cv 较重，进页面只拉一次）
    sourceLoaded: false,
    sourceErr: '',
    // 代次：重新优化之后，旧请求的结果不能再回填
    runId: 0,
    running: false,
    // 这一轮的改写稿是否已经替换回原简历（替换过就把按钮停掉，
    // 免得再点一次撞服务端的「与当前 cv.md 完全相同」拒绝）
    applied: false,
    // 同理，另存为新版本也只做一次（同一个名字存两份没意义）
    saved: false,
    state: { label: '未开始', cls: 'badge' },
    hint: '',
    summary: '', issues: [], draft: '', parseError: '', raw: '',
    mode: '',
  };
}

function cvOptSession() {
  if (!S.cvOpt) S.cvOpt = newCvOptSession();
  return S.cvOpt;
}

// ⚠️ 原来的 CV_OPT_LEVEL_CLS（严重度 → 徽标样式）随问题清单一起删掉了 ——
//    只剩定义行就是死引用，留着会让下一个人以为还有地方在用。

// ══ 简历全局优化（独立页 #cvopt，2026-10-09）═════════════════════
// 布局：左「原简历」右「AI 优化结果」两个预览框并排，两栏滚动同步。
// 两栏都走 renderCvVisual —— 同一份渲染器、同一套版式（.cvp-tplN），
// 所以左右长得一样，才能逐条对照；优化稿是 Markdown，先 markdownToCv
// 折回表单结构再渲染，避免「右栏是另一套排版，对照就没有意义」。
//
// 状态全在 S.cvOpt 会话里：切页回来还在；异步回调只写会话不写 DOM，
// 由 paintCvOpt() 统一投影 —— 和评估会话、简历草稿同一套路。
//
// AI 只出稿：调用既有的 POST /api/cv/optimize（codebuddy CLI 通道），
// 服务端会把改写稿交回；写回 cv.md 永远是用户手动确认后才做的事。

// AI 优化规则的**唯一权威在服务端** buildCvOptimizePrompt 的「硬性规则」段
// （只优化措辞 / 不增删内容项 / 保留结构与顺序）。前端不复述一份到提示词里——
// 两处各写一遍迟早分叉，页面显示的规则就会和 AI 实际收到的不是一回事。
// 下面文案只是把同一套口径讲给用户听，改动时两边一起改。

/** 左右两栏必须用**同一个**模板 id，否则版式不同就没法逐条对照。
 *  跟简历页预览一致：读会话里的 S.cvTpl（用户选的那套版式）。 */
/** 本页两栏预览要用「我的简历」当前的全套版式设置（模板 / 分区显隐 / 外观 / 字段行）。
 *
 *  VIEWS.cv 会把这四样依次准备好（服务端是权威值，会话只做缓存），但**直接进
 *  本页**时没人做过 —— 书签、刷新后停在 #cvopt、从报告页跳过来，都会命中：
 *  预览退回模板1，或者「稳重」系列只剩一句「正在载入模板…」，与编辑器里看到的
 *  不是同一份东西。本页的承诺是「右栏与左栏严格一致」，这四样就必须同源。
 *  ensure* 全是幂等的，已经准备好时只是几次空调用。 */
async function ensureCvOptPreview() {
  try {
    const tpls = await api('/api/cv/templates');
    if (tpls && Array.isArray(tpls.items)) S.cvTplItems = tpls.items;
    if (tpls && tpls.selected) S.cvTpl = tpls.selected;
  } catch { /* 拉不到就沿用会话现状，不拦着看预览 */ }
  await ensureCvNav();
  await ensureCvLook();
  await ensureCvFields();
  await ensureWzSrc(S.cvTpl);
}

function cvOptTplId() {
  return S.cvTpl || '1';
}

/** 优化结果 → 表单结构。解析失败返回 null（调用方如实显示原始文本，不硬凑）。 */
function cvOptForm() {
  const s = S.cvOpt;
  if (!s || !s.draft) return null;
  try {
    const f = markdownToCv(s.draft);
    // 改写稿是**纯文本 Markdown**，带不回头像图片路径（photo 是一个
    // /api/cv/asset/xxx.jpg 资源地址，不在正文里）。而「只优化措辞、不增删
    // 内容项」这条规则本来就不包含「把头像删掉」—— 所以从原简历把 photo
    // 接过来。不接的后果用户实测过：左栏有照片、右栏变成一个灰圆点，
    // 看着像「AI 优化把头像弄丢了」。
    const src = cvOptSourceForm();
    if (f && src && src.candidate && src.candidate.photo && !(f.candidate || {}).photo) {
      f.candidate.photo = src.candidate.photo;
    }
    return f;
  } catch {
    return null;
  }
}

/** 同步两栏滚动。左右内容高度不同，只靠 scrollTop 比例同步会漂。 */
function syncCvOptScroll(enable) {
  const L = $('#cvOptLeft'), R = $('#cvOptRight');
  if (!L || !R) return;
  if (enable === false) {
    L.removeEventListener('scroll', onCvOptScroll);
    R.removeEventListener('scroll', onCvOptScroll);
    return;
  }
  L.removeEventListener('scroll', onCvOptScroll);
  R.removeEventListener('scroll', onCvOptScroll);
  L.addEventListener('scroll', onCvOptScroll, { passive: true });
  R.addEventListener('scroll', onCvOptScroll, { passive: true });
}

// 同步时互相触发会死循环，用一个闸门挡一帧
let cvOptSyncing = false;
function onCvOptScroll() {
  if (cvOptSyncing) return;
  const L = $('#cvOptLeft'), R = $('#cvOptRight');
  if (!L || !R) return;
  const src = this === L ? L : R;
  const dst = this === L ? R : L;
  const srcMax = src.scrollHeight - src.clientHeight;
  const dstMax = dst.scrollHeight - dst.clientHeight;
  if (srcMax <= 0 || dstMax <= 0) return;
  cvOptSyncing = true;
  dst.scrollTop = (src.scrollTop / srcMax) * dstMax;
  requestAnimationFrame(() => { cvOptSyncing = false; });
}

/** 会话 → DOM。不在本页（切走了）时静默返回：只更新会话，切回来时补上。 */
function paintCvOpt() {
  const s = S.cvOpt;
  const view = $('#view');
  // ⚠️ 宿主选**操作条里的按钮**，别选 #cvOptGo —— 主操作「AI 优化」2026-10-13
  // 按用户要求上移到了页头（#topActions，在 #view 外面）。拿它当宿主，这个函数
  // 会在本页永远早退：按钮状态一个都不画，#cvOptApply 就一直停在初始的 disabled。
  if (!s || !view || !view.querySelector('#cvOptApply')) return;

  // 状态徽标（#cvOptState）与引擎徽标（#cvOptEngine）已按用户要求从操作条删除
  // （2026-10-12）—— 状态由按钮文案承担（见下面 paintBtn），引擎归属在评估
  // 结果卡等处可见，这里不再重复绘制。
  const hint = $('#cvOptHint');
  if (hint) hint.innerHTML = s.hint || '';

  // 「还在跑」只靠禁用态按钮上的「优化中…」+ 转圈表示。
  // 2026-10-13 用户要求**去掉已跑秒数**（原来是「优化中 15 秒…」）——
  // 这一页服务端是一次性返回、没有流式进度，秒数只是让数字在动，
  // 用户看着反而以为是进度条。干脆不显示。
  paintBtn($('#cvOptGo'), s.draft || s.running ? '重新优化' : 'AI 优化',
    'btn primary', s.running, '优化中…');

  // 「替换原简历」：只有右栏真有改写稿时才可点。
  // ⚠️ 这里**不走 paintBtn** —— 它把「禁用」实现成**忙碌态**（转圈 +「处理中…」），
  //    而「还没有改写稿」不是忙碌，只是暂时不可用；套上去会转出个假进度。
  // 「替换原简历」与「另存」共用一个前提（有改写稿、没在跑），各自再防一次
  // 重复操作（applied / saved）。「另存」不拦「替换」—— 那俩是互补的出口：
  // 另存是另立一份，替换是覆盖原版，同一份稿子两件事都可以做。
  const canUseDraft = !!(s.draft && !s.running);
  const applyBtn = $('#cvOptApply');
  if (applyBtn) {
    applyBtn.disabled = !canUseDraft || !!s.applied;
    applyBtn.title = s.applied
      ? '这一轮的改写稿已经替换过原简历了；要再改一次先重新优化'
      : (!canUseDraft
        ? '先点「AI 优化」拿到改写稿，才能替换原简历'
        : '用右边的优化结果覆盖原简历（原文件会先备份到 data/ 下）');
  }
  // 「另存」同样不走 paintBtn：见上面的说明（禁用 ≠ 忙碌）
  const saveAsBtn = $('#cvOptSaveAs');
  if (saveAsBtn) {
    saveAsBtn.disabled = !canUseDraft || !!s.saved;
    saveAsBtn.title = s.saved
      ? '这一轮的改写稿已经另存过了；要再存一份先重新优化'
      : (!canUseDraft
        ? '先点「AI 优化」拿到改写稿，才能另存'
        : '把右边的优化结果另存为一份新的独立简历（不动原简历）');
  }

  // ── 左栏：原简历（HTML 渲染，与简历页预览同一函数）────────────
  const L = $('#cvOptLeft');
  if (L) {
    const form = cvOptSourceForm();
    L.innerHTML = form
      ? renderCvVisual(form, cvOptTplId(), { nav: curCvNav(), look: curCvLook(), fields: curCvFields() })
      : '<p class="hint" style="padding:16px">'
        + (s.sourceErr ? '读不到简历内容：' + esc(s.sourceErr)
                        : '暂无简历内容，先去「我的简历」填写并保存。')
        + '</p>';
  }

  // ── 右栏：AI 优化结果（同一渲染器 + 同一模板，版式与左栏严格一致）────
  const R = $('#cvOptRight');
  if (R) {
    const f = cvOptForm();
    if (f) {
      R.innerHTML = renderCvVisual(f, cvOptTplId(), { nav: curCvNav(), look: curCvLook(), fields: curCvFields() });
    } else if (s.draft) {
      // 解析不出来就如实给原始文本，绝不拿半成品冒充结果
      R.innerHTML = '<div class="notice warn" style="margin:12px">'
        + '<b>没能把优化稿还原成简历结构</b>'
        + '<p>下面是 AI 的原始输出，可直接查看或复制。</p></div>'
        + '<pre class="log" style="max-height:none">' + esc(s.draft) + '</pre>';
    } else {
      R.innerHTML = '<div class="cvopt-empty">'
        + '<p class="hint">点「AI 优化」后，结果会渲染在这里。</p>'
        + '<p class="hint">规则：只优化措辞与专业性，<b>不增删任何内容项</b>，'
        + '保留模块结构、字段顺序与层级。</p></div>';
    }
  }

  // 内容重画后重新挂同步（innerHTML 换了但元素本身没换，监听器还在）
  syncCvOptScroll(true);
}

/** 左栏数据：优化对象是某版本时读那版，否则读磁盘上的原版。
 *  会话里存 srcForm —— 拉取是异步的（loadCvOptSource），渲染只读会话，
 *  绝不在 paint 里发请求（route() 重建视图时会重复触发）。 */
function cvOptSourceForm() {
  const s = S.cvOpt;
  if (s && s.srcForm) return s.srcForm;
  if (S.cvDraft) return S.cvDraft;         // 表单有未保存草稿时以草稿为准
  return S.cvForm || null;
}

/** 拉左栏正文。2026-10-09 起恒为原版 cv.md（页面不再提供优化对象选择），
 *  所以不必再分支去读某个版本。 */
async function loadCvOptSource() {
  const s = S.cvOpt;
  if (!s) return;
  try {
    const cv = await api('/api/cv');
    S.cv = cv;
    S.cvForm = cv.form;
    s.srcForm = cv.form;
    s.sourceLoaded = true;
    s.sourceErr = '';
  } catch (e) {
    s.sourceErr = e.message || '读不到简历内容';
  }
}

// ⚠️ 原来的 cvOptSummaryHtml（AI 总评 + 问题清单 + 「查看 AI 原始输出」折叠块）
//    已于 2026-10-09 按用户要求整块删除。
//    删它的理由不是「AI 总评没用」，而是它压在双栏**上方**：一屏放不下，
//    「左边原简历 / 右边优化稿」这对真正要逐条对照的东西反而被推到屏幕外。
//    数据本身没丢 —— 服务端照样返回 summary / issues / raw，需要时调接口就能拿到。
//
// ══ AI 润色本段（简历编辑器）══════════════════════════════════════════
// 接入来源：github.com/ThanosKa/magic-resume 的 AI polish（app/api/polish/route.ts
// + components/editor/ai-polish-dialog.tsx）。搬过来的是**两个交互形态**：
//   ① 按文体分三套提示词（职位名 / 自我评价 / 经历描述），不用一套通用提示词硬套
//   ② 弹窗左右并排「原文 | 改写稿」：逐字对照才看得出 AI 到底动了哪里
// 提示词本体在 ui/server.mjs 的 POLISH_MODE_RULES（服务端口径，前端不重复一份）。
//
// 与「AI简历全局优化」的分工：全局优化读磁盘上的整份 cv.md、出问题清单 +
// 改写稿，1–3 分钟；本段润色只吃当前表单里的一小段文字（不用先保存），
// 十几秒返回。状态放 S.cvPolish 会话 —— 等待期间切页回来，结果还在。
const POLISH_MODE_META = {
  title: { label: '职位 / 标题', hint: '2–6 个词的岗位名；不抬高也不压低职级，方向词只能取自原文' },
  summary: { label: '自我评价', hint: '两三句：你是谁 + 目标方向 + 最硬的一条优势；不写没有佐证的空话' },
  description: { label: '经历描述', hint: '动词开头 + 做了什么 + 工具方法 + 结果；行数不变，原文没有的数字不会替你编' },
};

/** 按字段路径推断默认文体。
 *  只认「求职意向」这类名称字段是 title —— 经历里的「职位」是用户自己填的
 *  事实字段，把它改得更响亮等于替他升职。推断错了用户可以手动切，不影响。 */
function polishModeOf(path) {
  const p = String(path || '');
  if (/(^|\.)intent$/.test(p) || /^targetRole$/i.test(p)) return 'title';
  if (/summary/i.test(p)) return 'summary';
  return 'description';
}

function polishSession() {
  if (!S.cvPolish) {
    S.cvPolish = {
      running: false, runId: 0, open: false,
      path: '', kind: '', label: '',   // 正在优化哪一段（模型路径 / 字段类型 / 展示名）
      original: '', result: '', err: '',
      mode: '',       // 本次实际用的文体（服务端会回报回落后的值）
      modeUser: '',   // 用户手动选过的文体；留空 = 每次都按字段自动推断
    };
  }
  return S.cvPolish;
}

/** 会话 → DOM 的唯一出口；不在本页时静默返回（异步回调安全）。 */
function paintCvPolish() {
  const st = polishSession();
  const mask = $('#cvPolishModal');
  if (!mask) return;
  if (st.open) mask.removeAttribute('hidden'); else mask.setAttribute('hidden', '');
  const t = $('#cvPolishTitle');
  if (t) t.textContent = 'AI 润色本段' + (st.label ? ' — ' + st.label : '');

  // 文体：三套按钮，选中态由 paint 统一投影（会话是唯一事实来源）。
  const mode = st.mode || 'description';
  const meta = POLISH_MODE_META[mode] || POLISH_MODE_META.description;
  $$('#cvPolishModes .polish-mode').forEach((b) => {
    const on = b.dataset.polishMode === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const mh = $('#cvPolishModeHint');
  if (mh) {
    // 用 innerHTML 是为了那行加粗的降级说明，所以文案必须自己 esc ——
    // AI 的输出会进 st.result，虽然不经过这里，但别把「以后往里塞什么」当成安全的。
    mh.innerHTML = esc(meta.hint
      + (st.running || !st.result ? '' : '。换个文体就点「重新生成」，按新文体再跑一次。'))
      // 服务端会自动换引擎（本地模型 ↔ CodeBuddy），但**绝不能静默** ——
      // 用户有权知道自己的简历原文交给了谁。
      + (st.degraded && st.result ? '<br><b>' + esc(st.degraded) + '</b>' : '');
  }

  // 左栏原文：只读，用 textContent 注入（AI 的输出里可能有尖括号，
  // 走 innerHTML 就等于把模型输出当 HTML 执行）。
  const orig = $('#cvPolishOrig');
  if (orig) orig.textContent = st.original || '（这一段还是空的）';

  const ta = $('#cvPolishText');
  if (ta) {
    // 用户正在手动改结果时不要覆盖输入框；运行中清空并给等待提示
    if (document.activeElement !== ta) ta.value = st.running ? '' : st.result;
    ta.disabled = st.running;
    ta.placeholder = st.running
      ? 'AI 正在改写这一段，通常十几秒到一分钟…'
      : '还没有结果 —— 点「开始润色」';
  }
  const err = $('#cvPolishErr');
  if (err) { err.textContent = st.err || ''; err.style.display = st.err ? 'block' : 'none'; }
  const retry = $('#cvPolishRetry');
  if (retry) {
    retry.disabled = st.running;
    // 第一次和「再抽一版」是两件事，按钮文字要跟着变（magic-resume 的 Polish/Regenerate）
    retry.textContent = st.running ? '润色中…' : (st.result ? '重新生成' : '开始润色');
  }
  const apply = $('#cvPolishApply');
  if (apply) apply.disabled = st.running || !st.result;
}

/** 跑一次本段润色。
 *  target 缺省 = 最近点进去的字段（S.cvPolishLast）。
 *  modeOverride = 用户在弹窗里手动选了文体（点「重新生成」时带上）。
 *  文体优先级：手动选 > 按字段自动推断 —— 换一段文字就该换一套规则，
 *  所以「手动选」只在用户显式点过文体按钮之后才生效。 */
async function runCvPolish(target, modeOverride) {
  const st = polishSession();
  const last = target || S.cvPolishLast;
  if (!last || !last.path) {
    toast('先点进要优化的那段文字（比如某条经历的「成果要点」），再点这个按钮', 'warn');
    return;
  }
  // 当前值从草稿模型里取 —— 它是事实来源；AI 只润色，不落盘
  const cur = last.path.split('.').reduce((a, k) => (a == null ? '' : a[k]), S.cvDraft || {});
  const text = Array.isArray(cur) ? cur.join('\n') : String(cur || '');
  if (!text.trim()) { toast('这一段还是空的，先写点内容再让 AI 优化', 'warn'); return; }
  if (text.length > 4000) {
    toast('这段太长（超过 4000 字符）。一键优化按「段」来，拆小一点再试', 'warn');
    return;
  }

  const mode = modeOverride || st.modeUser || polishModeOf(last.path);

  const myRun = ++st.runId;
  st.running = true; st.open = true;
  st.path = last.path; st.kind = last.kind || ''; st.label = last.label || '';
  st.original = text; st.result = ''; st.err = ''; st.degraded = '';
  st.mode = mode;
  paintCvPolish();

  let r = null, failed = null;
  try {
    r = await api('/api/ai/polish',
      { method: 'POST', body: { text, hint: st.label, mode }, timeout: 330000 });
  } catch (err) { failed = err; }

  // 期间用户又点了一次（或切页重开）：旧回调作废，不回填
  if (myRun !== st.runId) return;
  st.running = false;
  if (failed) {
    st.err = failed.message;
  } else if (!r.ok || !r.text) {
    st.err = r.friendly || 'AI 没有返回内容，稍后再试一次';
  } else {
    st.result = r.text;
    st.err = '';
    // 换了引擎要说出来（见 paintCvPolish 里那行加粗提示）
    st.degraded = r.degraded || '';
    // 服务端回报实际用的文体（白名单外的值在那边回落到 description）——
    // 用它对齐按钮选中态，不让界面显示的和真正跑的是两套。
    if (r.mode) st.mode = r.mode;
  }
  paintCvPolish();
}

/** 把弹窗里的改写结果写回对应字段（用户显式触发；bullets/items 按类型拆行）。 */
async function applyCvPolish() {
  const st = polishSession();
  const ta = $('#cvPolishText');
  if (!st.path || !ta) return;
  const val = ta.value;
  if (!val.trim()) { toast('改写结果是空的', 'warn'); return; }
  const v = st.kind === 'bullets' ? linesToArr(val)
    : st.kind === 'items' ? val.split(/[\n,，、]/).map((x) => x.trim()).filter(Boolean)
    : val;
  setPath(S.cvDraft, st.path, v);
  S.cvDirty = true;   // 打字也算改动，AI 应用当然更算 —— 不标记会被草稿优先规则忽略
  st.open = false;
  paintCvPolish();
  toast('已应用到「' + (st.label || st.path) + '」', 'ok');
  // 整体重画：预览、完整度、徽标全部跟着走（保留滚动位置）
  await route({ keepScroll: true });
  cvAutoSaveSoon();   // 实时保存：AI 改写稿也自动落盘
}

// ══ 分区导航（2026-10-09，交互范式参照 github.com/ThanosKa/magic-resume）══
// 一份状态被三个地方读：编辑区左侧的导航列表、实时预览、Word 导出。
// 权威值在服务端 data/cv-nav.json，会话里 S.cvNav 只是缓存 —— 与模板库
// （cvTpl / cv-templates.json）同一套口径：不在前端拼第二份事实。
//
// ⚠️ 隐藏**只影响预览与导出**，不改 cv.md。用户为了「投这家先不写项目经历」
// 点一下眼睛，不会因为看了眼预览就把素材弄丢（见 ui/cv-nav.mjs 的语义说明）。

/** 读当前导航（同步，永不返回 null —— 没拉过就用默认）。 */
function curCvNav() {
  return normalizeCvNav(S.cvNav || defaultCvNav());
}

/** 会话内只拉一次。拉不到就用默认：顺序与显隐都不是关键路径，不该拦着人编辑。 */
async function ensureCvNav() {
  if (S.cvNav) return S.cvNav;
  try {
    const r = await api('/api/cv/nav');
    S.cvNav = normalizeCvNav(r.nav);
  } catch {
    S.cvNav = defaultCvNav();
  }
  return S.cvNav;
}

/** 写回服务端。先更会话再发请求 —— 界面立刻动，落盘失败最多是下次打开回到旧顺序。 */
async function saveCvNav(nav) {
  const next = normalizeCvNav(nav);
  S.cvNav = next;
  try {
    const r = await api('/api/cv/nav', { method: 'POST', body: { nav: next } });
    S.cvNav = normalizeCvNav(r.nav);
  } catch (e) {
    toast('导航设置没存上（' + (e && e.message ? e.message : '网络错误') + '），刷新后会回到上次的样子', 'warn');
  }
  return S.cvNav;
}

// ══ 撤销 / 重做（2026-10-09，参照 magicv.art 顶栏）══════════════════════
// 只覆盖**表单内容**（含头像路径），不覆盖外观设置 —— 调字号把写了一半的经历
// 一起撤销回去是错的，那是两件事。
//
// 机制：cvLastSnap 保存「上一次已提交的状态」。任何改动之后调 cvCommitUndo()，
// 压进去的是 cvLastSnap（即改动**之前**那份），再把 cvLastSnap 更新成当前 ——
// 这样不需要在每次改动前抢先记录，也就不用去改每一处改动点。
const CV_UNDO_MAX = 40;
let cvLastSnap = null;
let cvUndoTimer = 0;

// ⚠️ 这两个图标必须是**模块级**：VIEWS.cv 里 `$('#topActions').innerHTML = …`
// 出现在视图内那些 const 之前，写在视图里会撞上 TDZ
// （`Cannot access 'ICON_UNDO' before initialization`，整页只剩错误态）。
const ICON_UNDO = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
  + '<path d="M6 4 3 7l3 3" fill="none" stroke="currentColor" stroke-width="1.4"'
  + ' stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M3 7h6a3.5 3.5 0 0 1 0 7H6.5" fill="none" stroke="currentColor"'
  + ' stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_REDO = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
  + '<path d="M10 4l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.4"'
  + ' stroke-linecap="round" stroke-linejoin="round"/>'
  + '<path d="M13 7H7a3.5 3.5 0 0 0 0 7h2.5" fill="none" stroke="currentColor"'
  + ' stroke-width="1.4" stroke-linecap="round"/></svg>';

function cvSnapshotNow() {
  try { return JSON.stringify(S.cvDraft || {}); } catch { return '{}'; }
}
/** 换了一份草稿（从服务端重新载入 / 保存完）→ 撤销栈作废：旧快照属于上一份。 */
function cvResetUndoBaseline() {
  S.cvUndo = [];
  S.cvRedo = [];
  cvLastSnap = cvSnapshotNow();
  paintCvUndoButtons();
}
function cvCommitUndo() {
  const now = cvSnapshotNow();
  if (cvLastSnap === null) { cvLastSnap = now; return; }
  if (now === cvLastSnap) return;
  S.cvUndo.push(cvLastSnap);
  if (S.cvUndo.length > CV_UNDO_MAX) S.cvUndo.shift();
  S.cvRedo = [];              // 新的改动会把「重做」那条分支砍掉（标准语义）
  cvLastSnap = now;
  paintCvUndoButtons();
}
/** 连续打字合并成一步：700ms 内不再输入才算一次改动。 */
function cvUndoSoon() {
  clearTimeout(cvUndoTimer);
  cvUndoTimer = setTimeout(cvCommitUndo, 700);
}
function paintCvUndoButtons() {
  const u = $('#cvUndo');
  const r = $('#cvRedo');
  if (u) u.disabled = !S.cvUndo.length;
  if (r) r.disabled = !S.cvRedo.length;
}
/** 顶栏状态徽标。实时保存之后它就是一个「保存到哪了」的仪表：
 *  编辑中（还在防抖窗口里）→ 保存中 → 已自动保存，另有一个被守卫拦下的状态。 */
function paintCvSaveState() {
  const el = $('#cvSaveState');
  if (!el) return;
  let text = '已自动保存';
  let cls = '';
  if (S.cvSaveBlocked) {
    text = '有章节待确认';
    cls = ' is-danger';
    el.title = '这次保存会让简历里的某些章节整节消失 —— 点一下确认';
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
  } else {
    if (S.cvSaving) { text = '保存中…'; cls = ' is-saving'; }
    else if (S.cvDirty) { text = '编辑中…'; cls = ' is-dirty'; }
    el.title = '内容会自动保存到 cv.md';
    el.removeAttribute('role');
    el.removeAttribute('tabindex');
  }
  el.textContent = text;
  el.className = 'cv-save-state' + cls;
}

// ══ 实时保存（2026-10-09 用户要求）══════════════════════════════════════
// 之前必须点顶栏的「保存并生成 Word」才写盘 —— 不点就一直是内存里的草稿，
// 关掉页面、换个浏览器就白打了。现在改成**停止输入后自动落盘**。
//
// 触发点只有一个：markDirty()。它是「内容变了」的单点 —— 打字、增删条目、
// 上移下移、换头像、应用 AI 润色、撤销重做、从 Word 导入全从那里过。
//
// ⚠️ 走的是**裸 api 调用而不是 saveCvForm**：saveCvForm 在 409（这次保存会让
//    某个章节整节消失）时会弹确认框。自动保存不能弹模态框 —— 用户正在打字，
//    框一跳出来就是灾难。所以这里让 409 原样抛出，转成「待确认」状态等用户点徽标。
const CV_AUTOSAVE_DELAY = 800;
let cvAutoSaveTimer = 0;
let cvAutoSaveBusy = false;

/** 排一次自动保存（防抖）。挡住 blocked 状态，避免反复撞同一面墙。 */
function cvAutoSaveSoon() {
  if (S.cvSaveBlocked) return;
  clearTimeout(cvAutoSaveTimer);
  cvAutoSaveTimer = setTimeout(() => { cvAutoSaveNow(); }, CV_AUTOSAVE_DELAY);
}

/** 立刻落盘（导出前、离开编辑区前用）。返回是否「磁盘与草稿已一致」。 */
async function cvAutoSaveNow() {
  clearTimeout(cvAutoSaveTimer);
  if (!S.cvDirty) return true;
  if (cvAutoSaveBusy || S.cvSaveBlocked) return false;
  cvAutoSaveBusy = true;
  const snap = cvSnapshotNow();
  S.cvSaving = true;
  paintCvSaveState();
  try {
    // 编辑对象是独立版本时写回版本文件（saveCvForm 内部按 S.cvEditTarget 分流，
    // 且版本路径不会 409 —— 守卫保护的是主简历）。
    const tgt = S.cvEditTarget;
    if (tgt && tgt.kind === 'version') {
      await api('/api/cv/versions/save', { method: 'POST', body: { id: tgt.id, form: S.cvDraft } });
      if (cvSnapshotNow() === snap) { S.cvDirty = false; S.cvSaveBlocked = false; }
      return !S.cvDirty;
    }
    await api('/api/cv', { method: 'POST', body: { form: S.cvDraft } });
    // ⚠️ 只把「发起这次请求时那一份」算作已保存：请求飞行期间用户可能又敲了几个字，
    //    那些字还在草稿里没落盘 —— 一律清脏会让它们永远等不到保存。
    if (cvSnapshotNow() === snap) { S.cvDirty = false; S.cvSaveBlocked = false; }
    return !S.cvDirty;
  } catch (err) {
    if (err && err.status === 409) {
      S.cvSaveBlocked = true;
      S.cvSaveBlockedDropped = (err.data && err.data.dropped) || [];
      toast('这次保存会让简历里的某些章节整节消失 —— 点顶栏的状态徽标确认', 'warn');
    } else {
      toast('自动保存失败（' + ((err && err.message) || '网络错误') + '），改动还在，稍后重试', 'bad');
    }
    return false;
  } finally {
    cvAutoSaveBusy = false;
    S.cvSaving = false;
    paintCvSaveState();
    // 飞行期间又改了 → 再存一次（这条不能省：漏掉就出现「最后一次改动永远不落盘」）
    if (S.cvDirty && !S.cvSaveBlocked) cvAutoSaveSoon();
  }
}

/** 被守卫拦下后的确认流程：用户点头才 force 写盘。 */
async function cvResolveSaveBlock() {
  if (!S.cvSaveBlocked) return;
  const dropped = S.cvSaveBlockedDropped || [];
  const good = await confirmDialog({
    title: '这次保存会删掉简历里的章节',
    desc: 'cv.md 里这些章节会整节消失：' + (dropped.join('、') || '（未知）')
      + '。如果只是表单没读全，先点「用 cv.md 覆盖表单」再改；确实要删就继续。',
    confirmLabel: '仍然保存',
    danger: true,
  });
  if (!good) return;
  S.cvSaveBlocked = false;
  S.cvSaving = true;
  paintCvSaveState();
  try {
    await api('/api/cv', { method: 'POST', body: { form: S.cvDraft, force: true } });
    S.cvDirty = false;
    toast('已保存（章节已按你的确认删除）', 'ok');
  } catch (err) {
    toast((err && err.message) || '保存失败', 'bad');
  } finally {
    S.cvSaving = false;
    paintCvSaveState();
  }
}
/** 撤销：把当前状态收进重做栈，恢复上一步。 */
async function cvUndo() {
  cvCommitUndo();                    // 先把还没提交的改动收进去，否则最后一次改不了
  if (!S.cvUndo.length) return;
  const prev = S.cvUndo.pop();
  S.cvRedo.push(cvSnapshotNow());
  S.cvDraft = JSON.parse(prev);
  S.cvDirty = true;
  cvLastSnap = prev;
  paintCvUndoButtons();
  await route({ keepScroll: true });
  cvAutoSaveSoon();      // 撤销也是一次内容改动 → 实时保存
  toast('已撤销', 'ok');
}
async function cvRedo() {
  if (!S.cvRedo.length) return;
  const next = S.cvRedo.pop();
  S.cvUndo.push(cvSnapshotNow());
  S.cvDraft = JSON.parse(next);
  S.cvDirty = true;
  cvLastSnap = next;
  paintCvUndoButtons();
  await route({ keepScroll: true });
  cvAutoSaveSoon();      // 同上
  toast('已重做', 'ok');
}

/** 浏览器侧导出文本文件（Markdown / JSON 备份用）。 */
// ══ 外观设置（主题色 / 排版 / 间距 / 模式）══════════════════════════
// 与分区导航同一套口径：权威值在服务端 data/cv-look.json，会话里只缓存。
// 归一化一律走 cv-look.mjs —— 前端不重复解释一遍这些数字，否则预览和导出的
// Word 迟早对不上（同一类事故在章节顺序上已经踩过一次）。
function curCvLook() {
  return normalizeCvLook(S.cvLook || CV_LOOK_DEFAULTS);
}

/** 会话内只拉一次。拉不到就用默认：外观不是关键路径，不该拦着人编辑。 */
async function ensureCvLook() {
  if (S.cvLook) return S.cvLook;
  try {
    const r = await api('/api/cv/look');
    S.cvLook = normalizeCvLook(r.look);
  } catch {
    S.cvLook = CV_LOOK_DEFAULTS;
  }
  return S.cvLook;
}

/** 写回服务端。先更会话再发请求 —— 界面立刻动，落盘失败最多是下次打开回到旧样式。 */
async function saveCvLook(look) {
  const next = normalizeCvLook(look);
  S.cvLook = next;
  try {
    const r = await api('/api/cv/look', { method: 'POST', body: { look: next } });
    S.cvLook = normalizeCvLook(r.look);
  } catch (e) {
    toast('外观设置没存上（' + (e && e.message ? e.message : '网络错误') + '），刷新后会回到上次的样子', 'warn');
  }
  return S.cvLook;
}

// ══ 基本信息字段行（2026-10-09，交互范式参照 magicv.art 编辑区的「基础字段」）══
// 「一行一个字段：拖拽手柄 + 图标 + 字段名 + 输入框 + 眼睛」这套形态要能站住，
// 手柄和眼睛就**必须真的有用** —— 一个点了没反应的开关比不给更糟（用户会反复点，
// 然后怀疑整页坏了）。所以顺序与显隐都落盘，并被预览和 Word 导出读到。
// 权威值在服务端 data/cv-fields.json，S.cvFields 只是缓存，与 cvNav / cvLook 同口径。

/** 读当前字段设置（同步，永不返回 null —— 没拉过就用默认）。 */
function curCvFields() {
  return normalizeCvFields(S.cvFields || defaultCvFields());
}

/** 会话内只拉一次。拉不到就用默认：顺序与显隐不是关键路径，不该拦着人编辑。 */
async function ensureCvFields() {
  if (S.cvFields) return S.cvFields;
  try {
    const r = await api('/api/cv/fields');
    S.cvFields = normalizeCvFields(r.fields);
  } catch {
    S.cvFields = defaultCvFields();
  }
  return S.cvFields;
}

/** 写回服务端。先更会话再发请求 —— 界面立刻动，落盘失败最多是下次打开回到旧样子。 */
async function saveCvFields(fields) {
  const next = normalizeCvFields(fields);
  S.cvFields = next;
  try {
    const r = await api('/api/cv/fields', { method: 'POST', body: { fields: next } });
    S.cvFields = normalizeCvFields(r.fields);
  } catch (e) {
    toast('字段设置没存上（' + (e && e.message ? e.message : '网络错误') + '），刷新后会回到上次的样子', 'warn');
  }
  return S.cvFields;
}

/**
 * 取一套「稳重」模板的原始 HTML（会话内缓存，取一次就够）。
 *
 * 取不到不抛 —— 返回空串，让调用方渲染一句提示。理由：模板文件读不出来属于
 * 「这份资产没了」，不该连带整页简历打不开（那才是真正不可用）。
 */
async function ensureWzSrc(tplId) {
  const meta = wzTpl(tplId);
  if (!meta) return '';
  if (S.cvWzSrc[meta.id]) return S.cvWzSrc[meta.id];
  try {
    const r = await fetch('/tpl-wz/' + encodeURIComponent(meta.file));
    if (!r.ok) return '';
    const text = await r.text();
    S.cvWzSrc[meta.id] = text;
    return text;
  } catch { return ''; }
}

/** 这套模板用到哪些简历字段（表单据此只展示填得上的那些，参照 dualTplGroups 的做法）。 */
async function wzGroups(tplId) {
  const src = await ensureWzSrc(tplId);
  if (!src) return [];
  const f = wzTemplateFields(src);
  const out = [];
  if (f.scalars.length) {
    out.push({ name: '基本信息', key: 'basic', fields: f.scalars.map((p) => ({ key: p, label: WZ_FIELD_LABEL[p] || p.split('.').pop() })) });
  }
  if (f.lists.length) {
    out.push({ name: '简历正文', key: 'body', fields: f.lists.map((k) => ({ key: k, label: cvNavLabel(k), list: true })) });
  }
  return out;
}
const WZ_FIELD_LABEL = {
  'candidate.name': '姓名', 'candidate.intent': '求职意向', 'candidate.age': '年龄',
  'candidate.gender': '性别', 'candidate.birthday': '生日', 'candidate.native': '籍贯',
  'candidate.political': '政治面貌', 'candidate.height': '身高', 'candidate.location': '所在城市',
  'candidate.phone': '手机', 'candidate.email': '邮箱', 'candidate.wechat': '微信',
  'candidate.degree': '学历', 'candidate.major': '专业', summary: '个人简介',
};

/**
 * 把外观设置套到预览宿主上。
 * 排版类走内联 CSS 变量挂在 .cvp 根节点（渲染器已带），
 * **页边距必须挂宿主**：预览容器就是 `.cv-paper`（#cvVisual 有 cv-paper 类），
 * 它的 padding 才是真正的纸边距；给 .cvp 加 padding 只会变成「内容再缩一圈」。
 */
function applyCvLookHost(host, look) {
  if (!host) return;
  const L = normalizeCvLook(look);
  host.style.padding = L.margin ? L.margin + 'px' : '';
}

/** 当前选中的模板显示名（模板库里的名字，如「稳重03 · 深色左栏」）。 */
function curCvTplName() {
  try { return resolveCvTplStyle(S.cvTpl || '1', S.cvTplItems).name || '模板1'; } catch { return '当前模板'; }
}

/**
 * 把「实时预览」打包成一份自包含的打印 HTML（2026-10-11）。
 *
 * 用途：导出 PDF 时**与预览用同一份版式**。原来导出走服务端
 * templates/cv-template.*.html —— 那是另一套设计（跟色系/稳重/双栏这三类
 * 预览模板都没关系），用户选了「稳重03」导出的却是另一份版式。
 *
 * 两个要点：
 *   · 样式要整页搬过去：色系模板的版式在 style.css 里，稳重/双栏模板的版式在
 *     渲染器**内联**的 <style> 里（随预览节点一起被克隆），少一份都会掉版式；
 *   · 用 `zoom` 把预览宽度等比映射到 A4 宽（210mm）——这样**断行位置与预览
 *     完全一致**，只是整体放大到真实纸张尺寸。zoom 在 Chromium 打印里参与
 *     排版与分页，比 transform: scale 靠谱（后者打印分页会出问题）。
 */
/** 网页里所有样式表拍平成一段 CSS（跨域取不到的跳过，不影响同源那份）。 */
function cvAllCssText() {
  return [...document.styleSheets].map((ss) => {
    try { return [...ss.cssRules].map((r) => r.cssText).join('\n'); } catch { return ''; }
  }).join('\n');
}

/** 打印前把图片内联成 dataURL：打印页是本地文件，相对路径（/api/cv/asset/…）
 *  在 file:// 下解析不了，导出会变成裂图/占位。取不到就退回绝对 URL。 */
async function cvInlineImages(root) {
  await Promise.all([...root.querySelectorAll('img')].map(async (img) => {
    const src = img.getAttribute('src') || '';
    if (!src || /^data:/i.test(src)) return;
    try {
      const r = await fetch(src, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      img.setAttribute('src', await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result || ''));
        fr.onerror = () => rej(new Error('读取图片失败'));
        fr.readAsDataURL(blob);
      }));
    } catch {
      try { img.setAttribute('src', new URL(src, location.origin).href); } catch { /* 保持原样 */ }
    }
  }));
}

/** 摊平 Shadow DOM：docx 保真模板的预览是「页图 + Shadow DOM」，而 outerHTML
 *  **不序列化 shadow 内容** —— 不摊平的话导出的 PDF 是一片空白。 */
function cvFlattenShadow(root) {
  const walk = (node) => {
    for (const child of [...(node.children || [])]) {
      if (child.shadowRoot) {
        const box = document.createElement('div');
        box.innerHTML = child.shadowRoot.innerHTML;        // 页图与 shadow 内的样式一起搬出来
        child.replaceWith(box);
        walk(box);
      } else {
        walk(child);
      }
    }
  };
  walk(root);
}

/** 把「一段预览 HTML」包成自包含的打印文档（宽按 A4 等比缩放，见 zoom 注释）。 */
function cvPrintHtmlDoc(innerHtml, widthPx, name) {
  const W = Math.round(widthPx) || 794;
  const A4 = (210 / 25.4) * 96;                         // 210mm → px（96dpi）
  const zoom = Math.min(2.4, Math.max(0.6, A4 / W));
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>' + esc(String(name || '简历')) + '</title><style>' + cvAllCssText() + '\n'
    + '@page { size: A4; margin: 0 }\n'
    + 'html, body { margin: 0; padding: 0; background: #fff; }\n'
    + '.cv-paper { width: ' + W + 'px; min-height: 0; margin: 0 auto;'
    + ' border: 0; border-radius: 0; box-shadow: none; zoom: ' + zoom.toFixed(4) + '; }\n'
    + '* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }\n'
    + '</style></head><body>' + innerHtml + '</body></html>';
}

/** 编辑器：把**当前实时预览**打包成打印 HTML。 */
async function cvPreviewPrintHtml(name) {
  const vis = $('#cvVisual');
  if (!vis) return '';
  const clone = vis.cloneNode(true);
  // 说明文字、分页辅助节点不该被印到简历上（#cvVisual 自己的 id 也要摘掉）
  clone.querySelectorAll('#cvPreviewNote, .cv-page-tag, .cv-page-hint').forEach((n) => n.remove());
  clone.removeAttribute('id');
  clone.removeAttribute('aria-label');
  await cvInlineImages(clone);
  cvFlattenShadow(clone);
  return cvPrintHtmlDoc(clone.outerHTML, vis.clientWidth, name);
}

/** 任意一份简历内容：用**同一个预览渲染器**渲染后打包成打印 HTML。
 *  版本卡片的「导出 PDF」走这里 —— 于是所有出口都是同一套版式。 */
async function cvFormPrintHtml(form, name) {
  const inner = renderCvVisual(form, S.cvTpl || '1', {
    nav: curCvNav(), look: curCvLook(), fields: curCvFields(),
  });
  const sheet = document.createElement('div');
  sheet.className = 'cv-paper';
  sheet.innerHTML = inner;
  await cvInlineImages(sheet);
  cvFlattenShadow(sheet);
  const W = ($('#cvVisual') || {}).clientWidth || 794;   // 与编辑器同一栏宽 → 断行一致
  return cvPrintHtmlDoc(sheet.outerHTML, W, name);
}


// 简历全局优化页：左原简历 / 右 AI 结果，滚动同步。
// 2026-10-09 用户要求：去掉「优化对象」下拉与「目标岗位 JD」输入，
// 默认就用 CodeBuddy 做**通用语句优化** —— 不必先想清楚投哪个岗位。
// 所以这一页没有输入区，只有「AI 优化」按钮；左栏恒为磁盘上的原版 cv.md。
VIEWS.cvopt = async function (view) {
  const opt = cvOptSession();
  // 恒定优化对象：原版 cv.md。留着会话字段是为了旧书签/别的入口
  // 传进来时能识别，但页面不提供切换入口。
  opt.target = 'base';
  opt.jd = '';
  await loadCvOptSource();
  // 版式同源：两栏预览必须跟「我的简历」用同一套模板/外观/字段行，
  // 否则直接进本页时会退回默认模板（详见 ensureCvOptPreview 的注释）。
  await ensureCvOptPreview();

  // 「AI 优化」放页头右侧（与「AI 定向优化」标题同一行，2026-10-13 用户要求）——
  // 它是这一页的**主操作**，不该和「另存 / 替换 / 下一步」挤在下方操作条里。
  // route() 每次切页都会清空 #topActions，视图在清空之后执行，塞进去是安全的
  // （「我的简历」页的「+ 新建简历」用的就是这个位置）。
  const topActions = $('#topActions');
  if (topActions) {
    topActions.innerHTML = '<button class="btn primary" id="cvOptGo" type="button">AI 优化</button>';
  }

  view.innerHTML =
    // ── 操作条 ────────────────────────────────────────────────────
    // 2026-10-13 用户要求：主操作「AI 优化」上移页头，它原来的位置换成「另存」。
    // 这一条现在只放**拿到结果之后做什么**：另存为新版本 / 替换原简历 / 下一步。
    '<div class="cvopt-bar">'
    + '<span class="spacer"></span>'
    // 「另存」（2026-10-13 用户要求，占原「AI 优化」的位置）：把右栏的改写稿
    // 存成一份**新的独立简历**，原简历一个字不动。和「替换原简历」是同一份稿子
    // 的两个出口 —— 替换是覆盖，另存是另立一份，两件事可以都做。
    + '<button class="btn" id="cvOptSaveAs" type="button" disabled>另存</button>'
    // 「替换原简历」（2026-10-12 用户要求）：把右栏的改写稿写回 cv.md。
    // 这一页 2026-10-09 曾按「只看不改」把写回入口整块删掉，现在按用户要求
    // 加回来 —— 但只做一件事：覆盖原版，且**写回前先备份**（服务端负责）。
    // 位置按工作流排：优化 → 替换 → 下一步；没有改写稿时禁用
    //（禁用不走 paintBtn 的忙碌态，原因见 paintCvOpt 里的注释）。
    + '<button class="btn" id="cvOptApply" type="button" disabled>替换原简历</button>'
    // 「下一步」（2026-10-11 用户要求）：流程的下一站是岗位评估 ——
    // 简历编辑「下一步」→ 本页 → 「下一步」→ 评估，三页串成一条线。
    + '<button class="btn" id="cvOptNext" type="button">下一步</button>'
    + '</div>'
    // ⚠️ 2026-10-09 用户要求删掉的：降级提示条（#cvOptDegrade）、「AI 总评 +
    //    问题清单 + 查看 AI 原始输出」（#cvOptSummary）、以及成功后的那句
    //    「优化完成，用时 N 秒…」。原先这三块全堆在双栏上方，把真正要看的
    //    「左边原简历 / 右边优化稿」压到屏幕外。
    //
    //    「本次用的是哪个引擎」也没删：降级信息收在评估结果卡的 .ev-meta 里
    //    （操作条上那颗 #cvOptEngine 徽标已于 2026-10-12 按用户要求移除）。
    //
    // 2026-10-12 用户要求再删掉常显的提示行（「正在通读你的简历…」+
    //    「通常 30 秒 – 3 分钟…」两行）。现在这块**只在出问题时才写**：
    //    重试中 / 失败原因 + 下一步 / 从评估页带过来的改写稿提醒。
    //    正常流程里恒为空，靠下面的 :empty 规则不占位、不显示。
    + '<p class="hint cvopt-hint" id="cvOptHint"></p>'
    // 双预览：两栏同高、内部各自滚动，由 onCvOptScroll 同步 scrollTop
    + '<div class="cvopt-dual">'
    + '<section class="cvopt-pane">'
    + '<header><b>原简历</b><span class="hint">磁盘上的 cv.md</span></header>'
    + '<div class="cvopt-scroll" id="cvOptLeft"></div></section>'
    + '<section class="cvopt-pane">'
    + '<header><b>AI 优化结果</b>'
    + '<span class="hint">仅措辞与专业性优化 · 不增删内容</span></header>'
    + '<div class="cvopt-scroll" id="cvOptRight"></div></section>'
    + '</div>';


  // ── 事件 ────────────────────────────────────────────────────────
  // 2026-10-09：JD 输入与优化对象选择都已移除，这里不再有可拉取的输入控件。
  // 「下一步」→ 目标岗位（2026-10-11 用户改的口径：先定岗位再看评估）。
  $('#cvOptNext').addEventListener('click', () => go('jobs'));

  // 「替换原简历」：把右栏的改写稿写回 cv.md。
  //
  // 服务端 /api/cv/optimize/apply 已经把这件危险事做全了：长度守卫、解析体检
  // （解析不出的章节会被拦成 422）、**先备份**、重建 cv-form.json 缓存、
  // 汇报「少了哪些章节」。所以这里不重复实现，只负责三件事 —— 问一句、
  // 发请求、把本地缓存刷成新状态。
  $('#cvOptApply').addEventListener('click', async () => {
    if (!cvOptForm()) { toast('还没有可用的优化结果', 'warn'); return; }
    const sure = await confirmDialog({
      title: '用优化结果替换原简历？',
      desc: '会覆盖「我的简历」里的原文件 cv.md（原文件先备份到 data/ 下，可回退）。'
        + '想保留原版，也可以先去「简历工具」把这份结果另存为新版本。',
      confirmLabel: '替换', danger: true,
    });
    if (!sure) return;

    const btn = $('#cvOptApply');
    btn.disabled = true;
    try {
      const r = await api('/api/cv/optimize/apply', {
        method: 'POST', body: { target: 'base', draft: opt.draft },
      });
      // 写回后编辑器那边的缓存必须一起作废，否则它下次一保存就把旧内容写回来
      //（服务端已经重建了 cv-form.json，内存里这份是脏的）。
      S.cv = null;
      S.cvDraft = null;
      S.cvDirty = false;
      opt.applied = true;
      // 左栏「原简历」重新拉一遍 —— 现在它就是刚替换进去的那一份
      await loadCvOptSource();
      paintCvOpt();
      const warn = (r.warnings || []).join('；');
      toast('已替换原简历' + (r.backup ? '（备份：' + r.backup + '）' : '（未生成备份）')
        + (warn ? '。注意：' + warn : ''), warn ? 'warn' : 'ok');
    } catch (err) {
      toast('替换失败：' + err.message, 'bad');
    } finally {
      // 失败时要还回来；成功时 paintCvOpt 已按 applied 置成禁用，这里不覆盖它
      if (!opt.applied) btn.disabled = false;
    }
  });

  // 「另存」：把右栏的改写稿存成一份**新的独立简历**，原简历一个字不动
  // （服务端 target:'new' 分支，走 /api/cv/optimize/apply，同样有解析体检）。
  // 和「替换原简历」是同一份稿子的两个出口，互补，不互斥。
  $('#cvOptSaveAs').addEventListener('click', () => {
    if (!cvOptForm()) { toast('还没有可用的优化结果', 'warn'); return; }
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.setAttribute('role', 'dialog');
    mask.setAttribute('aria-modal', 'true');
    mask.setAttribute('aria-label', '另存为新简历');
    mask.innerHTML = '<div class="modal">'
      + '<div class="modal-head"><h3>另存为新简历</h3><span class="spacer"></span>'
      + '<button class="btn ghost sm icon" type="button" id="cvOptAsX" aria-label="关闭">'
      + icon('x') + '</button></div>'
      + '<p class="hint">给这份优化后的简历起个名字。它是**独立的**一份简历 —— '
      + '原简历与其它版本都不受影响。</p>'
      + '<label class="field"><span>简历名称</span>'
      + '<input class="input" id="cvOptAsName" maxlength="60" '
      + 'placeholder="如：Java后端_通用版 / 大族数控-算法岗"></label>'
      + '<div class="row" style="justify-content:flex-end;margin-top:8px">'
      + '<button class="btn" type="button" id="cvOptAsCancel">取消</button>'
      + '<button class="btn pri" type="button" id="cvOptAsGo">另存</button></div>'
      + '</div>';
    document.body.appendChild(mask);
    const close = () => mask.remove();
    const inp = mask.querySelector('#cvOptAsName');
    setTimeout(() => inp.focus(), 60);
    mask.querySelector('#cvOptAsX').addEventListener('click', close);
    mask.querySelector('#cvOptAsCancel').addEventListener('click', close);
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    mask.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    const save = async () => {
      const name = (inp.value || '').trim();
      if (!name) { toast('先给这份简历起个名字', 'warn'); inp.focus(); return; }
      const goBtn = mask.querySelector('#cvOptAsGo');
      goBtn.disabled = true;
      try {
        const r = await api('/api/cv/optimize/apply', {
          method: 'POST',
          body: { target: 'new', name, draft: opt.draft, note: '由「AI 定向优化」另存' },
        });
        const id = (r.version || {}).id;
        if (!id) throw new Error('另存失败：服务端没返回版本 id');
        opt.saved = true;
        close();
        paintCvOpt();
        const warn = (r.warnings || []).join('；');
        toast('已另存为「' + name + '」—— 在「我的简历」里能看到它'
          + (warn ? '。注意：' + warn : ''), warn ? 'warn' : 'ok');
      } catch (err) {
        goBtn.disabled = false;
        toast('另存失败：' + err.message, 'bad');
      }
    };
    mask.querySelector('#cvOptAsGo').addEventListener('click', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  });
  $('#cvOptGo').addEventListener('click', async () => {
    const jd = '';                 // 恒为通用优化：不需要岗位 JD
    const srcId = 'base';          // 恒为原版简历
    const myRun = ++opt.runId;
    opt.running = true;
    opt.summary = ''; opt.issues = []; opt.draft = ''; opt.parseError = ''; opt.raw = '';
    opt.degraded = ''; opt.engine = ''; opt.ms = 0;   // 上一轮的引擎信息清掉，别串台
    opt.state = { label: '优化中', cls: 'badge info' };
    // 运行中不再写提示行、也不再报秒数（两样都是用户要求删掉的，
    // 2026-10-12 删提示行、2026-10-13 删秒数）。在跑的表示只剩按钮上的
    //「优化中…」+ 转圈。
    opt.hint = '';
    opt.applied = false;       // 新一轮：允许再替换一次
    opt.saved = false;         // 也允许再另存一次
    paintCvOpt();

    let r = null, failed = null;
    // 拿不到改写稿就自动重试一次（最多 2 次）。
    // 为什么必须有兜底：CLI 会出现「退出码 0、stdout 为空」的静默失败 ——
    // 多数是登录态瞬时失效或端口占用。这一页的存在意义就是「给出改写后的版本」，
    // 空着等于功能没完成，所以宁可多等一次，也不要把「无结果」甩给用户。
    // 登录态过期（authFailed）也重试：用户可能刚在另一个窗口登录过，
    // 重试一次就能拿到结果，省得再手动点一次。
    // 两次都失败才按 r.authFailed 给出可执行的下一步（重新登录），不假装成功。
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (myRun !== opt.runId) return;
      if (attempt > 1) {
        opt.hint = '第一次没拿到结果，正在重试…';
        paintCvOpt();
      }
      try {
        // 复用既有接口与既有 AI 通道（CodeBuddy CLI），不新增服务。
        // engine:'cli' 让服务端锁 codebuddy，不受 data/ai-engine.json 影响
        // （那份配置当前是 ollama，会把简历原文交给本地模型并弹出启动提示）。
        r = await api('/api/cv/optimize',
          { method: 'POST', body: { jd, target: srcId, engine: 'cli' }, timeout: 700000 });
        failed = null;
      } catch (err) { failed = err; r = null; }
      if (failed) break;                       // HTTP 报错：重试无意义
      if (r && (r.parsed?.draft || '').trim()) break;   // 拿到稿就收工
      if (attempt < 2) await new Promise((res) => setTimeout(res, 2500));
    }

    if (myRun !== opt.runId) return;   // 期间又点了一次：旧结果丢弃
    opt.running = false;

    if (failed) {
      opt.state = { label: '优化失败', cls: 'badge bad' };
      opt.hint = failed.message;
      paintCvOpt();
      toast('优化失败：' + failed.message, 'bad');
      return;
    }

    const p = r.parsed || {};
    opt.summary = p.summary || '';
    opt.issues = p.issues || [];
    opt.draft = p.draft || '';
    opt.parseError = p.parseError || '';
    opt.raw = r.output || '';
    // 本次用的是哪个引擎、有没有降级（见服务端那段注释：降级是自动的，但绝不能静默）
    opt.engine = r.cli || '';
    opt.degraded = r.degraded || '';
    opt.ms = r.ms || 0;

    if (!opt.draft.trim()) {
      // 走到这里说明两个引擎都没给出稿子。**不显示「无结果」**——那是个死胡同，
      // 用户既看不到问题在哪，也没法往下走。改成「原因 + 可执行的下一步」。
      //
      // ⚠️ 下一步**不能只靠服务端**：服务端的 friendly 解释的是「为什么」，
      //    「那就重新登录」这句是本项目的口径。而且自检用的桩返回的是极短的
      //    「登录态过期」，照抄的话页面上就只剩一句没有出路的话（2026-10-09 实测红过）。
      const why = r.degraded || r.friendly || opt.parseError || '这次没拿到改写稿。';
      const hasNext = /双击|重试|登录CodeBuddy|启动Ollama/.test(why);
      opt.state = { label: '待重试', cls: 'badge warn' };
      opt.hint = why + (hasNext ? '' : ' 下一步：双击项目根目录的<b>「登录CodeBuddy.cmd」</b>'
        + '重新登录后点「重新优化」；或确认本地模型在运行（双击<b>「启动Ollama.cmd」</b>）。'
        + '简历原文不会离开本机。');
      paintCvOpt();
      toast('没拿到优化结果，请按页面提示处理后重试', 'warn');
      return;
    }

    opt.state = { label: '已完成', cls: 'badge ok' };
    // 2026-10-09 按用户要求，成功后**不再写 hint**。结果已经摆在右栏了，
    // 再加一句「用时 N 秒，右边是优化后的版本」是纯重复。降级信息也没有丢 ——
    // 它收在操作条上的引擎徽标里（本地模型时徽标变提醒色）。
    opt.hint = '';
    paintCvOpt();
    toast(opt.degraded ? '优化完成（已改用本地模型出稿）' : '优化完成', opt.degraded ? 'warn' : 'ok');
  });

  paintCvOpt();
  // 测试钩子：只在自动化环境（AUTOTEST）暴露，让探针能灌一份改写稿去验
  // 「右栏有内容时两栏滚动是否真的同步」—— 真实点一次AI 要跑 1–3 分钟，
  // 探针等不起，也不想为了测滚动去烧 AI 额度。生产环境不挂这个钩子。
  if (AUTOTEST) {
    window.__cvOptTest = {
      setDraft(draft) {
        opt.draft = String(draft || '');
        opt.running = false;
        opt.applied = false;      // 换了一份稿子，允许再替换
        opt.saved = false;
        paintCvOpt();
      },
      session: opt,
      paint: paintCvOpt,
    };
  }
};

VIEWS.cv = async function (view) {
  // 编辑对象（2026-10-10）：默认 = 主简历（cv.md）；S.cvEditTarget 指向某个
  // 版本时（「+ 新建简历」建的空白简历 / 版本卡「编辑」进来的），加载并保存
  // 都落到**那个版本** —— 主简历与其它版本不受影响。
  const tgt = (S.cvEditTarget && S.cvEditTarget.kind === 'version') ? S.cvEditTarget : null;
  let cv;
  if (tgt) {
    const c = await api('/api/cv/versions/content?id=' + encodeURIComponent(tgt.id))
      .catch(() => null);
    if (c) {
      cv = {
        markdown: c.markdown, form: c.form,
        completeness: c.completeness, hasMd: true, hasForm: true,
      };
      // 名字以服务端为准（重命名后卡片名会变）
      if (c.meta && c.meta.name) tgt.name = c.meta.name;
    } else {
      // 版本被删了/读不到：退回主简历，别把用户扔在错误页上
      S.cvEditTarget = null;
      toast('那份简历读不到了（可能已删除），已切回主简历', 'warn');
      cv = await api('/api/cv');
    }
  } else {
    cv = await api('/api/cv');
  }
  S.cv = cv;
  // 页头副标题动态化：编辑独立简历时让用户一眼看到「现在改的是哪份」
  const sub = $('#pageSub');
  if (sub) sub.textContent = tgt ? '正在编辑独立简历「' + tgt.name + '」，保存不影响主简历' : TITLES.cv[1];
  // 版本列表：优化面板的「优化对象」下拉要用。读不到不该让整页打不开 ——
  // 失败时把 S.cvVersions 置空，下拉变空、版本管理本身在「简历工具」页有告警。
  await refreshVersions();
  // 模板库（2026-09-30）：同步「当前选中 + 自定义清单」。服务端 selected 是
  // 权威值（跨会话持久），会话里没显式换过就跟它对齐；拉失败不拦编辑 ——
  // S.cvTplItems 留 null，自定义 id 解析时自动回落模板1，预览不会崩。
  try {
    const tpls = await api('/api/cv/templates');
    S.cvTplItems = tpls.items || [];
    if (tpls.selected) S.cvTpl = tpls.selected;
  } catch { /* 拉不到就沿用会话现状 */ }

  // 分区导航（章节顺序 + 显隐）。与模板库同样口径：服务端是权威值，会话里只缓存。
  // 拉不到就用默认顺序 —— 顺序与显隐都不是关键路径，不该拦着人编辑。
  await ensureCvNav();
  // 外观设置（主题色 / 排版 / 间距 / 模式）。同样：服务端是权威值，会话只缓存。
  await ensureCvLook();
  // 基本信息字段行的顺序与显隐。同上：服务端 data/cv-fields.json 是权威值。
  await ensureCvFields();
  // 「稳重」模板的原始 HTML（2026-10-09）：渲染器是同步的，源必须先取回来。
  await ensureWzSrc(S.cvTpl);

  // 草稿优先：有未保存改动时一律以本地草稿为准，服务端那份只用于首次载入。
  //
  // 这里原来是 `const form = cv.form`，配合 rerender() 里「重新拉 /api/cv
  // 再整体覆盖 form」，造成一个很隐蔽的 bug：点「+ 添加证书」→ 新条目 push
  // 进数组 → rerender() 拉回服务端那份（还是空数组）→ 覆盖 → 条目当场消失，
  // 表现就是「点了添加没反应」。教育背景 / 证书 / 荣誉奖项 / 工作经历全中招。
  // 更糟的是：只要点一次上移或删除，用户已经敲进表单里的文字也会一起被冲掉。
  if (!S.cvDraft || !S.cvDirty) {
    S.cvDraft = JSON.parse(JSON.stringify(cv.form));
    S.cvDirty = false;
    // 换了一份草稿（首次载入 / 保存完成）→ 撤销栈作废：旧快照属于上一份内容，
    // 拿它们撤销会把用户的简历换成另一个状态。
    cvResetUndoBaseline();
  }
  const form = S.cvDraft;

  // 顶栏（2026-10-09 实时保存改造）：状态徽标 + 撤销/重做 + 导入简历 + 导出。
  //
  // 「保存并生成 Word」这颗主操作按钮**已删**：填写改成实时保存（见
  // cvAutoSaveSoon 那一段），不再需要人惦记着点保存。导出 Word 走「导出 ▾」。
  // 腾出来的主操作位给了「导入简历」—— 它原先只在最右侧那条贴边的竖工具条里，
  // 而「手上已有一份 Word 简历」是这一页最常见的起点，不该藏那么深。
  $('#topActions').innerHTML =
    // 文案与类名一律交给 paintCvSaveState()：徽标现在有四态（编辑中/保存中/
    // 已自动保存/有章节待确认），在这里再拼一份必然会和它漂移。
    '<span class="cv-save-state" id="cvSaveState"></span>'
    + '<button class="btn icon" id="cvUndo" type="button" title="撤销" aria-label="撤销">' + ICON_UNDO + '</button>'
    + '<button class="btn icon" id="cvRedo" type="button" title="重做" aria-label="重做">' + ICON_REDO + '</button>'
    + '<button class="btn" id="cvImport" type="button" title="从已有的 Word 简历导入，覆盖当前表单">导入简历</button>'
    // 导出只剩一条路（2026-10-11 用户要求「导出功能只导出 PDF，支持下载到本地」）：
    // 直接打印右边那份实时预览 → 自动下载到本机。菜单、Word/Markdown/JSON 三条
    // 出口一并撤掉 —— 少一个下拉就少一次「导出的不是预览那套」的误会。
    + '<button class="btn" id="cvExportBtn" type="button" title="把当前预览导出成 PDF 并下载到本机">导出 PDF</button>'
    // 返回放**最右**（2026-10-11 用户要求）：回「我的简历」列表。编辑独立简历
    // 时返回前自动 flush 一次 —— 不然刚敲的字还在防抖窗口里，列表里看是旧的。
    + '<button class="btn" id="cvBack" type="button">← 返回</button>';
  paintCvSaveState();
  // 返回：独立简历先把手头的改动落盘（saveCvForm 会按编辑对象写回版本文件），
  // 再回列表 —— 否则「改完立刻返回」会丢最后 800ms 的输入。
  $('#cvBack').addEventListener('click', async () => {
    const backBtn = $('#cvBack');
    backBtn.disabled = true;
    try {
      if (S.cvDirty && S.cvDraft) {
        await saveCvForm(S.cvDraft);
        S.cvDirty = false;
        S.cvDraft = null;          // 回列表再进时按编辑对象重新载入
      }
      S.cvEditTarget = null;
      go('resumes');
    } catch (err) {
      backBtn.disabled = false;
      toast(err.message || '保存失败，还留在编辑页', 'bad');
    }
  });

  // 完整度：没改动就用服务端算好的；有改动（草稿和服务端已不一致）时
  // 让服务端按草稿重算一次。规则只在 cv-model.mjs 一处，前端不重复实现。
  let comp = cv.completeness;
  if (S.cvDirty) {
    try {
      comp = (await api('/api/cv/preview', { method: 'POST', body: { form } })).completeness;
    } catch { /* 算不出来就沿用服务端那份，不影响编辑本身 */ }
  }
  const field = (path, label, opts) => {
    const o = opts || {};
    const val = path.split('.').reduce((a, k) => (a == null ? '' : a[k]), form);
    const attrs = 'data-path="' + path + '"';
    if (o.t === 'bullets' || o.t === 'items') {
      const text = o.t === 'bullets' ? arrToLines(val) : (Array.isArray(val) ? val.join(', ') : '');
      return '<label class="field"><span>' + esc(label) + (o.hint ? ' <em>' + esc(o.hint) + '</em>' : '') + '</span>'
        + '<textarea class="textarea" ' + attrs + ' data-kind="' + o.t + '" placeholder="' + esc(o.ph || '') + '">' + esc(text) + '</textarea></label>';
    }
    if (o.t === 'text') {
      return '<label class="field"><span>' + esc(label) + '</span><textarea class="textarea" style="min-height:60px" '
        + attrs + ' placeholder="' + esc(o.ph || '') + '">' + esc(val || '') + '</textarea></label>';
    }
    return '<label class="field"><span>' + esc(label) + '</span><input class="input" ' + attrs
      + ' value="' + esc(val || '') + '" placeholder="' + esc(o.ph || '') + '"></label>';
  };

  // 当前是否选中了双栏模板（base 4）。表单据此在「模板字段清单」与
  // 「标准六段」之间切换 —— 判据走 resolveCvTplStyle，自定义模板回落也不会错。
  const isDualTpl = () => resolveCvTplStyle(S.cvTpl || '1', S.cvTplItems).base === DUAL_TPL_BASE;

  // ② 按模板字段生成表单（2026-10-09）
  // 模板有哪些槽位就问哪些，不再让用户对着模板里没有的栏目发愁。
  // 每个字段都直接落在 form 的真实路径上（data-path），所以后面的
  // markDirty / refreshPreview / 保存 cv.md 一条都不用改。
  // 单个分组的表单。分区导航每次只渲染**当前分组**，所以按组分出这个函数
  //（原来是 dualTplFormHtml() 一次返回全部 5 组，随导航改造拆开）。
  const dualTplGroupHtml = (g) => {
      // 卡片型字段（list / skills，自带标题+条目块）要通栏；
      // 普通字段（text / longtext / tags）走两列。混在一个 grid 里
      // 卡片会被挤成半宽，条目里的输入框跟着变形。
      const cards = [];
      const plain = [];
      g.fields.forEach((f) => {
        if (f.kind === 'list') {
          const items = form[f.key] || [];
          const body = items.map((it, i) => {
            const inner = f.fields.map((sub) => field(
              f.key + '.' + i + '.' + sub.path, sub.label,
              { t: sub.kind === 'longtext' ? 'text' : (sub.kind === 'bullets' ? 'bullets' : ''), ph: sub.ph },
            )).join('');
            return '<div class="entry"><div class="entry-head"><b>' + esc(f.itemLabel) + ' #' + (i + 1) + '</b>'
              + '<span class="spacer"></span>'
              + '<button class="btn sm" data-up="' + f.key + '" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>上移</button>'
              + '<button class="btn sm" data-down="' + f.key + '" data-i="' + i + '"' + (i === items.length - 1 ? ' disabled' : '') + '>下移</button>'
              + '<button class="btn sm danger" data-del="' + f.key + '" data-i="' + i + '">删除</button>'
              + '</div>' + inner + '</div>';
          }).join('');
          cards.push('<div class="card" id="cvSec' + f.key + '"><h2>' + esc(f.label) + ' <span class="badge">'
            + items.length + '</span></h2>'
            + (f.hint ? '<p class="hint" style="margin:0 0 10px">' + esc(f.hint) + '</p>' : '')
            + body
            + '<button class="btn" data-add="' + f.key + '">' + esc(f.addLabel) + '</button></div>');
          return;
        }
        if (f.kind === 'skills') {
          // 技能 = 名字 + 熟练度，渲染成进度条，需要两个输入框
          const items = form.skills || [];
          const body = items.map((it, i) => {
            const cat = it.category || '';
            const lv = it.level == null ? 80 : it.level;
            return '<div class="entry"><div class="entry-head"><b>技能 #' + (i + 1) + '</b>'
              + '<span class="spacer"></span>'
              + '<button class="btn sm" data-up="skills" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>上移</button>'
              + '<button class="btn sm" data-down="skills" data-i="' + i + '"' + (i === items.length - 1 ? ' disabled' : '') + '>下移</button>'
              + '<button class="btn sm danger" data-del="skills" data-i="' + i + '">删除</button>'
              + '</div><div class="grid2">'
              + '<input class="input" data-path="skills.' + i + '.category" value="' + esc(cat) + '" placeholder="软件 / 技能名称">'
              + '<label class="field"><span>熟练度 0-100</span>'
              + '<input class="input" type="number" min="0" max="100" data-path="skills.' + i + '.level" value="'
              + esc(lv) + '"></label></div></div>';
          }).join('');
          cards.push('<div class="card" id="cvSecSkills"><h2>' + esc(f.label) + ' <span class="badge">'
            + items.length + '</span></h2>'
            + (f.hint ? '<p class="hint" style="margin:0 0 10px">' + esc(f.hint) + '</p>' : '')
            + body
            + '<button class="btn" data-add="skills">' + esc(f.addLabel || '+ 添加技能') + '</button></div>');
          return;
        }
        // 证件照（2026-10-09）：走和标准模板同一套上传控件 —— 双栏模板的
        // 字段清单里本来就有 candidate.photo，但之前只是渲染成一个「填 URL 的
        // 输入框」，用户根本没有地方把图传上来。
        // 放进 plain 是为了复用两列栅格，靠 CSS 的 grid-column:1/-1 占满整行。
        if (f.kind === 'photo') { plain.push(photoBlock()); return; }
        // text / longtext / tags
        if (f.kind === 'tags') {
          plain.push(field(f.key, f.label, { t: 'items', ph: f.hint || '用空格或逗号分隔' }));
          return;
        }
        if (f.kind === 'longtext') {
          plain.push(field(f.key, f.label, { t: 'text', ph: f.hint }));
          return;
        }
        plain.push(field(f.key, f.label, {}));
      });
      // 普通字段两列排；卡片型字段通栏排在后面（视觉上更整齐）
      return '<div class="cv-tpl-group"><h3 class="cv-tpl-group-t">' + esc(g.name) + '</h3>'
        + (plain.length ? '<div class="grid2">' + plain.join('') + '</div>' : '')
        + cards.join('')
        + '</div>';
  };

  const entryBlock = (kind, items) => {
    const spec = CV_SCHEMA[kind];
    return (items || []).map((item, i) => {
      const body = spec.fields.map((f) => {
        const w = f.w ? '' : '';
        return field(kind + '.' + i + '.' + f.k, f.l, { t: f.t, ph: f.ph, hint: f.hint });
      }).join('');
      return '<div class="entry"><div class="entry-head"><b>' + esc(spec.label) + ' #' + (i + 1) + '</b>'
        + '<span style="color:var(--ink-3);font-size:12.5px">' + esc(spec.title(item)) + '</span>'
        + '<span class="spacer"></span>'
        + '<button class="btn sm" data-up="' + kind + '" data-i="' + i + '"' + (i === 0 ? ' disabled' : '') + '>上移</button>'
        + '<button class="btn sm" data-down="' + kind + '" data-i="' + i + '"' + (i === items.length - 1 ? ' disabled' : '') + '>下移</button>'
        + '<button class="btn sm danger" data-del="' + kind + '" data-i="' + i + '">删除</button>'
        + '</div>' + body + '</div>';
    }).join('');
  };

  const section = (kind) => {
    const spec = CV_SCHEMA[kind];
    const items = form[kind] || [];
    // id 供页面顶部的跳转条定位（cvSecExperience 这种拼法）。
    return '<div class="card" id="cvSec' + kind[0].toUpperCase() + kind.slice(1) + '">'
      + '<h2>' + cvSecIcon(kind) + '<span>' + esc(spec.label) + '</span>'
      + '<span class="badge">' + items.length + '</span></h2>'
      + entryBlock(kind, items)
      + '<button class="btn" data-add="' + kind + '">+ 添加' + esc(spec.label) + '</button></div>';
  };

  // 「AI 润色本段」的结果弹窗（参照设计稿：AI 出稿 → 用户核对 → 手动应用）。
  // 「AI 润色本段」结果弹窗。形态参照 magic-resume 的 ai-polish-dialog：
  // 左「原文」只读 / 右「改写稿」可改，并排逐字对照 —— 单框 textarea 只能看到
  // AI 给了什么，看不到它改掉了什么，而「它悄悄动了我哪个字」正是最该盯的地方。
  const polishModal =
      '<div class="modal-mask" id="cvPolishModal" role="dialog" aria-modal="true"'
      + ' aria-label="AI 润色本段" hidden>'
      + '<div class="modal modal-wide">'
      + '<div class="modal-head"><h3 id="cvPolishTitle">AI 润色本段</h3></div>'
      + '<p class="hint">AI 只出稿，<b>不会直接写进简历</b>。核对下面的改写结果'
      + '（小心 AI 编造的数字与经历），确认后点「应用到本段」。</p>'
      // 文体三选一。默认按字段自动推断，用户可改 —— 三套提示词规则不同，
      // 用错文体最容易出现的症状是「经历被写成了自我评价」。
      + '<div class="polish-modes" id="cvPolishModes" role="group" aria-label="改写文体">'
      + '<button class="polish-mode" type="button" data-polish-mode="title" aria-pressed="false">职位 / 标题</button>'
      + '<button class="polish-mode" type="button" data-polish-mode="summary" aria-pressed="false">自我评价</button>'
      + '<button class="polish-mode" type="button" data-polish-mode="description" aria-pressed="false">经历描述</button>'
      + '</div>'
      + '<p class="hint polish-mode-hint" id="cvPolishModeHint"></p>'
      + '<div class="polish-dual">'
      + '<section class="polish-col"><h4>原文</h4>'
      + '<div class="polish-orig" id="cvPolishOrig"></div></section>'
      + '<section class="polish-col"><h4>AI 改写 <em>可以在框里再改</em></h4>'
      + '<textarea class="textarea" id="cvPolishText" rows="12"></textarea></section>'
      + '</div>'
      + '<p class="hint" id="cvPolishErr" style="display:none;color:var(--bad-ink)"></p>'
      + '<div class="foot">'
      + '<button class="btn" type="button" data-act="polishClose">放弃</button>'
      + '<button class="btn" type="button" data-act="polishRetry" id="cvPolishRetry">开始润色</button>'
      + '<button class="btn primary" type="button" data-act="polishApply" id="cvPolishApply">应用到本段</button>'
      + '</div>'
      + '</div></div>';

  // 页面骨架（参照设计稿 简历编辑.html）：**左表单 + 右实时预览**。
  // 宽屏两栏并排、预览 sticky 跟着滚；窄屏落单栏且预览排到表单**下面**
  // （先改后看，顺序不能反）。
  //
  // 左栏顺序是有意的：完整度 → 正文四段（基本信息 / 教育背景 / 工作与项目 /
  // 技能，设计稿里露脸的都在明面上）。「AI简历全局优化」已移到右栏预览下方
  //（2026-09-26），「更多内容」折叠区同日删除。
  // 「AI 润色本段」挂在左栏顶部标题行；「写进 cv.md 的原文预览」已于
  // 2026-09-26 按用户要求整块删掉 —— 右栏的视觉预览才是用户要看的。
  // 版本卡已迁到「简历工具」页（#cvkit）—— 编辑页只管编辑。
  // 表单主体：选中双栏模板时用「模板字段清单」，否则用标准六段。
  // 单独算成一个字符串再拼进骨架 —— 之前直接写进 view.innerHTML 的表达式里，
  // 结果三层三元套在一起少一个括号就整页 SyntaxError（浏览器只报
  // "Unexpected token ':'"，不给行号，很难定位）。拆开后每段都能单独看。
  const dualPicked = isDualTpl();
  const compNotice = comp.missing.length
    ? '<div class="notice warn"><b>简历完整度 ' + comp.percent + '%</b>'
      + '<p>还缺：' + comp.missing.map(esc).join('、') + '</p></div>'
    // 这里原来把 100% 写死了。当前算法下「没有缺失」确实等于 100%，
    // 但那是把百分比规则抄了第二份——将来调整权重就会静默说错话。
    : '<div class="notice ok"><b>简历完整度 ' + comp.percent + '%</b>'
      + '<p>关键字段都填齐了。</p></div>';

  // 双栏模板的填写提示条 + 字段清单
  // （编号 ①② 随左栏选择器一起去掉了 —— 那个「先选模板」步骤已删，
  //   这里只是一句说明，不再是流程里的第二步。）
  const dualTip = '<div class="cv-tpl-tip"><b>按「' + esc(DUAL_TPL.name)
    + '」的可编辑内容填写</b><span>下面这些栏目就是这份模板会用到的位置。'
    + '想换模板点右栏的「选择模板」。</span></div>';

  // ── 分区导航 + 分区表单（2026-10-09 改造）──────────────────────────────
  // 交互范式参照 github.com/ThanosKa/magic-resume 的 components/editor/section-tabs：
  // 左侧分区列表（可拖拽排序 + 眼睛显隐），点哪个分区就改哪个分区。
  //
  // 改造前是一长条堆叠表单（十个卡片摞在一起，想改「技能」得从头滚下去）。
  //
  // ⚠️ 只渲染当前分区**不会丢数据**：输入边打边回写进 S.cvDraft（form2），
  //    保存读的也是 S.cvDraft —— 与此刻 DOM 里显示的是哪一段无关。
  //
  // 双栏模板走它自己的 5 个字段分组：那套版式是固定的（技能条、时间轴各占
  // 一个定位），排序与隐藏没有意义，所以只给「切换」，不给手柄和眼睛 ——
  // 给一个点了没反应的开关，比不给更糟。
  if (dualPicked && !/^g\d+$/.test(String(S.cvNavActive || ''))) S.cvNavActive = 'g0';
  if (!dualPicked && /^g\d+$/.test(String(S.cvNavActive || ''))) S.cvNavActive = CV_NAV_BASIC;

  const NAV_GRIP = '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">'
    + '<circle cx="3" cy="4" r="1.15" fill="currentColor"/><circle cx="7" cy="4" r="1.15" fill="currentColor"/>'
    + '<circle cx="3" cy="8" r="1.15" fill="currentColor"/><circle cx="7" cy="8" r="1.15" fill="currentColor"/>'
    + '<circle cx="3" cy="12" r="1.15" fill="currentColor"/><circle cx="7" cy="12" r="1.15" fill="currentColor"/>'
    + '</svg>';
  const NAV_EYE_ON = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
    + '<path d="M1.4 8S3.9 4.2 8 4.2 14.6 8 14.6 8 12.1 11.8 8 11.8 1.4 8 1.4 8Z"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>';
  const NAV_TRASH = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">'
    + '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.2h5.6l.7-8.2" fill="none"'
    + ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const NAV_EYE_OFF = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">'
    + '<path d="M1.4 8S3.9 4.2 8 4.2 14.6 8 14.6 8 12.1 11.8 8 11.8 1.4 8 1.4 8Z"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<path d="M2.8 13.2 13.2 2.8" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';

  // ── 模块图标（2026-10-09，参照参考站：模块列表每一项前面带一个图标）────
  // 用 emoji 而不是再画一批 SVG：参考站那排就是彩色图标，而项目铁律是不引 CDN、
  // 不打包字体，emoji 是唯一能做到「彩色 + 零依赖」的选项。
  // 模块标题里那个单色 SVG（cvSecIcon）保持不动 —— 标题上的图标要跟着主色走。
  const NAV_ICONS = {
    [CV_NAV_BASIC]: '🧑',
    summary: '📝',
    competencies: '⚡',
    education: '🎓',
    experience: '💼',
    projects: '🚀',
    skills: '🛠️',
    certifications: '📜',
    awards: '🏆',
  };
  // 双栏模板的分区是 g0…g4（那套版式的固定分组），给它一个通用图标。
  const navIcon = (key) => NAV_ICONS[key] || '📄';

  // 「这一节现在有内容吗」（2026-10-11）——分区导航用它给**空章节**加提示。
  // 用户实测踩过：点「证书」那一行的垃圾桶，预览没变化，因为那一节本来就是空的
  // （证书文字写在「专业技能」的条目里）。空章节上点删除确实没有可见效果，
  // 但界面一声不吭就等于「这按钮坏了」——所以空章节标一个「空」字，
  // 点删除时也不再装作删掉了东西。
  const _live = cvLiveItems(form);
  const secHasContent = (k) => {
    if (k === CV_NAV_BASIC) return true;
    if (k === 'summary') return !!String(form.summary || '').trim();
    return (_live[k] || []).length > 0;
  };

  const navItem = (key, o) => {
    const opts = o || {};
    const on = S.cvNavActive === key;
    const hid = !!opts.draggable && isCvSectionHidden(curCvNav(), key);
    const blank = !!opts.draggable && !secHasContent(key);
    return '<div class="cv-nav-item' + (on ? ' on' : '') + (hid ? ' off' : '')
      + (blank ? ' is-blank' : '') + '"'
      + ' data-nav-key="' + esc(key) + '"'
      + (opts.draggable ? ' draggable="true"' : '') + '>'
      + (opts.draggable
        ? '<span class="cv-nav-grip" aria-hidden="true">' + NAV_GRIP + '</span>'
        : '<span class="cv-nav-grip is-empty" aria-hidden="true"></span>')
      + '<span class="cv-nav-ico" aria-hidden="true">' + navIcon(key) + '</span>'
      + '<button class="cv-nav-go" type="button" data-nav-go="' + esc(key) + '">'
      + esc(opts.label)
      + (blank ? '<span class="cv-nav-blank" title="这一节还没有内容">空</span>' : '')
      + '</button>'
      + (opts.draggable
        ? '<button class="cv-nav-eye" type="button" data-nav-eye="' + esc(key) + '"'
          + ' aria-pressed="' + (hid ? 'true' : 'false') + '" title="'
          + (hid ? '在预览与导出里显示这一节' : '在预览与导出里隐藏这一节（内容保留在简历里）')
          + '">' + (hid ? NAV_EYE_OFF : NAV_EYE_ON) + '</button>'
        // 垃圾桶 = 把这一节从简历上撤下来。**它做的其实就是"隐藏"**，不是删内容：
        // cv.md 是唯一数据源，真删了就没法撤销。按钮做成垃圾桶是因为用户找的
        // 就是「把这块拿掉」这个动作，但会在确认框里把后果说清楚。
        + '<button class="cv-nav-del" type="button" data-nav-del="' + esc(key)
        + '" title="从简历中移除这一节">' + NAV_TRASH + '</button>'
        : '')
      + '</div>';
  };

  const cvNavHtml = () => {
    if (dualPicked) {
      return '<nav class="cv-nav" id="cvNav" aria-label="简历分区">'
        + '<div class="cv-nav-list" id="cvNavList">'
        + dualTplGroups().map((g, i) => navItem('g' + i, { label: g.name })).join('')
        + '</div>'
        + '<p class="cv-nav-note">双栏模板的栏目由版式固定，不可排序或隐藏。</p>'
        + '</nav>';
    }
    const nav = curCvNav();
    const hidN = nav.hidden.length;
    return '<nav class="cv-nav" id="cvNav" aria-label="简历分区">'
      + navItem(CV_NAV_BASIC, { label: cvNavLabel(CV_NAV_BASIC) })
      + '<div class="cv-nav-list" id="cvNavList">'
      + nav.order.map((k) => navItem(k, { label: cvNavLabel(k), draggable: true })).join('')
      + '</div>'
      + '<p class="cv-nav-note">拖动排序 · 点眼睛隐藏'
      + (hidN ? '<em>' + hidN + ' 节已隐藏：只在预览与导出里不显示，内容没删</em>' : '')
      + '</p></nav>';
  };

  // 基本信息卡（固定项，永远在导航最上面 —— 它就是简历页眉）
  // ── 模块图标（2026-10-09，参照参考站在模块标题前放一个图标）──────────
  // 统一 16×16 + currentColor：颜色交给 CSS（跟着主色走），这里只画形状。
  const SEC_ICONS = {
    basic: '<circle cx="8" cy="5.6" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/>'
      + '<path d="M3.4 13.4c.6-2.7 2.4-4 4.6-4s4 1.3 4.6 4" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3" stroke-linecap="round"/>',
    summary: '<path d="M3 4.2h10M3 8h10M3 11.8h6.4" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3" stroke-linecap="round"/>',
    competencies: '<path d="M8 2.4 9.6 6.2 13.4 8 9.6 9.8 8 13.6 6.4 9.8 2.6 8 6.4 6.2z"'
      + ' fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>',
    education: '<path d="M8 3.2 14.2 6.2 8 9.2 1.8 6.2z" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3" stroke-linejoin="round"/>'
      + '<path d="M4.6 7.6v3c0 .9 1.5 1.6 3.4 1.6s3.4-.7 3.4-1.6v-3" fill="none"'
      + ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    experience: '<rect x="2.4" y="5.6" width="11.2" height="7.2" rx="1.4" fill="none"'
      + ' stroke="currentColor" stroke-width="1.3"/>'
      + '<path d="M6 5.6V4.5c0-.6.4-1 1-1h2c.6 0 1 .4 1 1v1.1" fill="none"'
      + ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
    projects: '<path d="M2.4 4.8c0-.6.4-1 1-1h2.9l1.4 1.6h5.3c.6 0 1 .4 1 1v6'
      + 'c0 .6-.4 1-1 1H3.4c-.6 0-1-.4-1-1z" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3" stroke-linejoin="round"/>',
    skills: '<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/>'
      + '<path d="M8 2.6v1.8M8 11.6v1.8M2.6 8h1.8M11.6 8h1.8M4.2 4.2l1.3 1.3M10.5 10.5l1.3 1.3'
      + 'M11.8 4.2l-1.3 1.3M5.5 10.5l-1.3 1.3" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3" stroke-linecap="round"/>',
    certifications: '<circle cx="8" cy="6.4" r="3.6" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3"/>'
      + '<path d="M5.9 9.6 5.1 14l2.9-1.6 2.9 1.6-.8-4.4" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3" stroke-linejoin="round"/>',
    awards: '<path d="M5.4 2.8h5.2v3a2.6 2.6 0 0 1-5.2 0z" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3" stroke-linejoin="round"/>'
      + '<path d="M5.4 3.8H3.6v.9a2 2 0 0 0 2 2M10.6 3.8h1.8v.9a2 2 0 0 1-2 2" fill="none"'
      + ' stroke="currentColor" stroke-width="1.3"/>'
      + '<path d="M8 8.4v2.4M5.8 13.2h4.4" fill="none" stroke="currentColor"'
      + ' stroke-width="1.3" stroke-linecap="round"/>',
  };
  const cvSecIcon = (key) => '<span class="cv-sec-ico" aria-hidden="true">'
    + '<svg viewBox="0 0 16 16" width="16" height="16">'
    + (SEC_ICONS[key] || SEC_ICONS.summary) + '</svg></span>';

  // 头像上传（2026-10-09 图片插入，参照 magicv.art 的「头像设置」）。
  // 三种入口都留：点选 / 拖进来 / 粘贴链接 —— 用户在别的页面看到一张图，
  // 最顺手的是直接复制链接，逼他去另存再上传只会让人放弃。
  const photoBlock = () => {
    const cur = String((form.candidate || {}).photo || '');
    const isUrl = /^https?:\/\//i.test(cur);
    return '<div class="cv-photo-box" id="cvPhotoBox">'
      + '<div class="cv-photo-prev' + (cur ? ' has' : '') + '"'
      + (cur ? ' style="background-image:url(&quot;' + esc(cur) + '&quot;)"' : '')
      + '><span>' + (cur ? '' : '未设置') + '</span></div>'
      + '<div class="cv-photo-side">'
      + '<p class="hint">头像 / 证件照：PNG · JPG · WebP，2MB 以内。也可以直接拖进来。</p>'
      + '<div class="cv-photo-btns">'
      + '<button class="btn sm" type="button" id="cvPhotoPick">选择图片</button>'
      + (cur ? '<button class="btn sm" type="button" id="cvPhotoClear">移除头像</button>' : '')
      + '</div>'
      + '<input class="input" type="text" id="cvPhotoUrl" autocomplete="off"'
      + ' placeholder="或粘贴图片链接 https://…" value="' + (isUrl ? esc(cur) : '') + '">'
      + '</div>'
      + '<input type="file" id="cvPhotoFile" hidden'
      + ' accept="image/png,image/jpeg,image/webp,image/gif">'
      + '</div>';
  };

  // ── 基本信息：「布局 / 资料 / 基础字段」三段（2026-10-09 重做）──────────
  // 参照 magicv.art 编辑区右侧：把一个平铺的字段网格拆成
  //   ① 布局 —— 证件照放哪（左 / 上 / 右）
  //   ② 资料 —— 头像本身
  //   ③ 基础字段 —— 一行一个字段：手柄 + 图标 + 字段名 + 输入框 + 眼睛
  //
  // 平铺网格（原来的 .grid2）的问题不是不好看，是**每一格长得一模一样**：
  // 一眼扫过去分不清「手机」和「兴趣爱好」哪个是简历上真会显示的、哪个是给
  // 模板兜底的。拆成字段行之后，图标给了辨识度，眼睛把「这一项现在上不上简历」
  // 直接摆在行尾 —— 不用点开、不用猜。
  //
  // ⚠️ 值的路径没变（data-path 仍是 candidate.<key>），输入监听那条委托照旧命中，
  //    所以「边打边回写 S.cvDraft」这条链路一行都没改。
  //
  // 2026-10-09：三段中的「布局」（证件照位置三选一）按用户要求整段删除。
  //    HL_SVG / hlPick() / CV_LOOK_HEADER_LAYOUTS import 一并清掉（只剩定义行
  //    就是死引用）。模型字段 headerLayout **故意保留**在 cv-look.mjs 里 ——
  //    跟删「模式」卡时留下 iconMode/subCenter/longTitle 同一个做法：用户之前
  //    若设过 left/center，预览和 Word 导出还得照原来的样子渲染，删字段 =
  //    外观静默变化。只是从此不再提供切换入口（空串 = 默认「头像在右」）。

  // 一个字段行。眼睛的实际含义见文件顶部的语义说明：只影响预览与导出。
  const fieldRow = (key) => {
    const f = cvBasicField(key);
    if (!f) return '';
    const hid = isCvFieldHidden(curCvFields(), key);
    const val = (form.candidate || {})[key] || '';
    return '<div class="cv-fr' + (hid ? ' off' : '') + '" data-fr-key="' + esc(key) + '" draggable="true">'
      + '<span class="cv-fr-grip" aria-hidden="true">' + NAV_GRIP + '</span>'
      + '<span class="cv-fr-ico" aria-hidden="true">' + f.icon + '</span>'
      + '<span class="cv-fr-label">' + esc(f.label) + '</span>'
      + '<input class="input cv-fr-input" type="text" data-path="candidate.' + esc(key) + '"'
      + ' value="' + esc(val) + '" placeholder="' + esc(f.ph) + '">'
      + '<button class="cv-fr-eye" type="button" data-fr-eye="' + esc(key) + '"'
      + ' aria-pressed="' + (hid ? 'true' : 'false') + '" title="'
      + (hid ? '在预览与导出里显示这个字段' : '在预览与导出里隐藏这个字段（内容保留在简历里）')
      + '">' + (hid ? NAV_EYE_OFF : NAV_EYE_ON) + '</button>'
      + '</div>';
  };

  // 「资料」区块：头像单独一段。它不参与字段排序（参考站也是固定在最上面），
  // 但显隐和字段行共用同一份设置 —— 拆两份存储只会让「点眼睛只写了一半」有地方发生。
  const photoRow = () => {
    const hid = isCvFieldHidden(curCvFields(), CV_FIELD_PHOTO);
    return '<div class="cv-fr-wrap' + (hid ? ' off' : '') + '" data-fr-key="' + CV_FIELD_PHOTO + '">'
      + '<div class="cv-fr cv-fr-static">'
      + '<span class="cv-fr-grip is-empty" aria-hidden="true"></span>'
      + '<span class="cv-fr-ico" aria-hidden="true">🖼</span>'
      + '<span class="cv-fr-label">头像</span>'
      + '<span class="spacer"></span>'
      + '<button class="cv-fr-eye" type="button" data-fr-eye="' + CV_FIELD_PHOTO + '"'
      + ' aria-pressed="' + (hid ? 'true' : 'false') + '" title="'
      + (hid ? '在预览与导出里显示头像' : '在预览与导出里隐藏头像（图片不会删掉）')
      + '">' + (hid ? NAV_EYE_OFF : NAV_EYE_ON) + '</button>'
      + '</div>'
      + '<div class="cv-fr-body">' + photoBlock() + '</div>'
      + '</div>';
  };

  const basicCard = '<div class="card" id="cvSecBasic"><h2>'
    + cvSecIcon('basic') + '<span>基本信息</span></h2>'
    + '<div class="progress" style="margin-bottom:14px"><i style="width:' + comp.percent + '%"></i></div>'
    + '<section class="cv-eblock"><h3 class="cv-eblock-h">资料</h3>' + photoRow() + '</section>'
    + '<section class="cv-eblock"><h3 class="cv-eblock-h">基础字段</h3>'
    + '<div class="cv-frows" id="cvFieldRows">'
    + curCvFields().order.map(fieldRow).join('')
    + '</div></section>'
    + '</div>';

  // 个人简介 / 核心能力（2026-09-27 恢复编辑入口）。数据层一直都在
  //（cv-model.mjs 的 summary / competencies），只是 2026-09-26 随折叠区被删了入口。
  const summaryCard = '<div class="card" id="cvSecSummary"><h2>'
    + cvSecIcon('summary') + '<span>个人简介</span></h2>'
    + field('summary', '个人简介', { t: 'text', ph: '两三句话：你是谁、目标岗位、最核心的优势。可点上方「AI 润色本段」润色' })
    + '</div>';
  const competenciesCard = '<div class="card" id="cvSecCompetencies"><h2>'
    + cvSecIcon('competencies') + '<span>核心能力</span></h2>'
    + field('competencies', '核心能力', { t: 'bullets', ph: '一行一条，写「能力 + 佐证」，例如：\n熟悉 Python 数据分析与可视化，完成客户流失预测全流程建模\n写完可点上方「AI 润色本段」润色' })
    + '</div>';

  // 当前分区 → 表单正文。双栏模板按它的字段分组取，标准模板按章节 key 取。
  const cvSectionBody = () => {
    if (dualPicked) {
      const g = dualTplGroups()[Number(String(S.cvNavActive).replace(/^g/, ''))];
      return g ? dualTplGroupHtml(g) : '';
    }
    const key = S.cvNavActive;
    if (key === CV_NAV_BASIC) return basicCard;
    if (key === 'summary') return summaryCard;
    if (key === 'competencies') return competenciesCard;
    // 其余章节（教育 / 经历 / 项目 / 技能 / 证书 / 奖项）都走 CV_SCHEMA 的通用卡片。
    // 证书与奖项原来在编辑页没有入口（2026-09-26 随折叠区一起删了），现在随分区
    // 导航回来了 —— 它们本来就在 cv.md 和预览里，没有入口等于看得见改不了。
    return CV_SCHEMA[key] ? section(key) : '';
  };

  // ── 图标 + 右侧竖排工具条（2026-10-09，参照 magicv.art 最右那条）────────
  const ICON_RAIL_PHOTO = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
    + '<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<circle cx="5.6" cy="6.4" r="1.1" fill="currentColor"/>'
    + '<path d="M2.6 11.4 6 8.6l2.4 2.2L11 9l2.4 2.4" fill="none" stroke="currentColor"'
    + ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_RAIL_AI = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
    + '<path d="M8 2.2 9.4 6 13.2 7.4 9.4 8.8 8 12.6 6.6 8.8 2.8 7.4 6.6 6z"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>'
    + '<path d="M12.4 11.2l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" fill="currentColor"/></svg>';
  const ICON_RAIL_IMPORT = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
    + '<path d="M8 10.5V2.8M5.4 5.4 8 2.8l2.6 2.6" fill="none" stroke="currentColor"'
    + ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M2.6 10v2.2c0 .7.5 1.2 1.2 1.2h8.4c.7 0 1.2-.5 1.2-1.2V10"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const ICON_RAIL_EXPORT = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
    + '<path d="M8 2.8v7.7M5.4 8 8 10.5 10.6 8" fill="none" stroke="currentColor"'
    + ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<path d="M2.6 10.6v1.6c0 .7.5 1.2 1.2 1.2h8.4c.7 0 1.2-.5 1.2-1.2v-1.6"'
    + ' fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  const ICON_RAIL_HELP = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">'
    + '<circle cx="8" cy="8" r="5.9" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.4.2-.7.5-.7 1v.3" fill="none"'
    + ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>'
    + '<circle cx="8" cy="11.4" r=".8" fill="currentColor"/></svg>';

  const railBtn = (act, label, svg) => '<button class="cv-rail-btn" type="button" data-rail="'
    + act + '" title="' + esc(label) + '" aria-label="' + esc(label) + '">' + svg + '</button>';

  const cvRailHtml = () => '<div class="cv-rail" id="cvRail" role="toolbar" aria-label="简历工具">'
    + railBtn('photo', '插入图片（头像）', ICON_RAIL_PHOTO)
    + railBtn('polish', 'AI 润色本段', ICON_RAIL_AI)
    + railBtn('import', '从 Word 导入', ICON_RAIL_IMPORT)
    + railBtn('export', '导出', ICON_RAIL_EXPORT)
    + railBtn('preview', S.cvSideHidden ? '展开预览面板' : '收起预览面板',
      S.cvSideHidden ? NAV_EYE_OFF : NAV_EYE_ON)
    + railBtn('help', '使用帮助', ICON_RAIL_HELP)
    + '</div>';

  // ── 左栏：外观设置卡（2026-10-09 参照 magicv.art 魔方简历）──────────────
  // 五张卡：布局 / 主题色 / 排版 / 间距 / 模式。
  // 参数口径与归一化全在 ui/cv-look.mjs 一处 —— 这里只负责画控件和把值写回会话。
  const swatch = (val, cur, label) => '<button type="button" class="cv-swatch'
    + (val === cur ? ' on' : '') + '" data-accent="' + esc(val) + '"'
    + (val ? ' style="--sw:' + esc(val) + '"' : '')
    + ' title="' + esc(label) + '" aria-label="' + esc(label) + '"></button>';

  // 字号下拉：0 = 不覆盖，交给模板的默认值。这样"没调过"和"调回默认"是同一个状态。
  const sizeSel = (id, cur, opts) => '<select class="select" id="' + id + '">'
    + opts.map((n) => '<option value="' + n + '"' + (String(n) === String(cur) ? ' selected' : '')
      + '>' + (n === 0 ? '默认' : n + ' px') + '</option>').join('') + '</select>';

  // 间距用「− 值 +」而不是滑块：间距要的是「再加 4px」这种可复现的步进，
  // 滑块在一个几十像素的区间里根本对不准。
  const stepper = (key, label) => '<div class="cv-set-row inline"><span>' + label + '</span>'
    + '<div class="cv-stepper">'
    + '<button type="button" data-look-step="' + key + '" data-dir="-1" aria-label="减少">−</button>'
    + '<b id="cvLookVal' + key + '">0</b>'
    + '<button type="button" data-look-step="' + key + '" data-dir="1" aria-label="增加">+</button>'
    + '</div></div>';

  const cvPanelHtml = () => {
    const L = curCvLook();
    const nav = curCvNav();
    return '<div class="cv-set-card">'
        + '<div class="cv-set-head">布局</div>'
        + cvNavHtml()
        + '<button class="btn sm cv-set-add" type="button" id="cvAddModule">+ 添加模块</button>'
        + '<div class="cv-addmenu" id="cvAddMenu" hidden>'
        + (nav.hidden.length
          ? nav.hidden.map((k) => '<button type="button" data-unhide="' + esc(k) + '">'
            + navIcon(k) + ' ' + esc(cvNavLabel(k)) + '</button>').join('')
          : '<p class="hint">八个模块都在简历里了。要精简，点模块右侧的眼睛或垃圾桶。</p>')
        + '</div>'
      + '</div>'

      + '<div class="cv-set-card">'
        + '<div class="cv-set-head">主题色'
        + '<button class="cv-set-link" type="button" id="cvLookAccentCustom">自定义</button></div>'
        // 第一格是「跟随模板」：空值 —— 调色板不该把模板自带的主色一并吃掉
        + '<div class="cv-swatches" id="cvLookAccent">'
        + swatch('', L.accent, '跟随模板')
        + CV_LOOK_ACCENTS.map((c) => swatch(c, L.accent, c)).join('')
        + '</div>'
        + '<input type="color" class="cv-colorpick" id="cvLookAccentPick"'
        + ' value="' + esc(L.accent || '#165DFF') + '" aria-label="自定义主题色">'
      + '</div>'

      + '<div class="cv-set-card">'
        + '<div class="cv-set-head">排版</div>'
        + '<label class="cv-set-row"><span>字体</span>'
        + '<select class="select" id="cvLookFont">'
        + CV_LOOK_FONTS.map((f) => '<option value="' + esc(f.id) + '"'
          + (f.id === L.font ? ' selected' : '') + '>' + esc(f.label) + '</option>').join('')
        + '</select></label>'
        + '<label class="cv-set-row"><span>行高</span>'
        + '<div class="cv-set-ctl">'
        + '<input type="range" class="cv-range" id="cvLookLh" min="1.2" max="2.6" step="0.1"'
        + ' value="' + (L.lineHeight || 1.7) + '">'
        + '<b class="cv-set-val" id="cvLookLhVal">' + (L.lineHeight || '默认') + '</b>'
        + '</div></label>'
        + '<label class="cv-set-row"><span>基础字号</span>'
        + sizeSel('cvLookBase', L.baseSize, [0, 11, 12, 13, 14, 15, 16]) + '</label>'
        + '<label class="cv-set-row"><span>模块标题字号</span>'
        + sizeSel('cvLookTitle', L.titleSize, [0, 13, 14, 15, 16, 18, 20]) + '</label>'
        + '<label class="cv-set-row"><span>模块项标题字号</span>'
        + sizeSel('cvLookItemTitle', L.itemTitleSize, [0, 12, 13, 14, 15, 16, 18]) + '</label>'
      + '</div>'

      + '<div class="cv-set-card">'
        + '<div class="cv-set-head">间距</div>'
        + stepper('margin', '页边距')
        + stepper('moduleGap', '模块间距')
        + stepper('paraGap', '段落间距')
      + '</div>';
  };

  view.innerHTML =
      // 两栏骨架（style.css §18a .cv-split）：左 .cv-edit 表单 / 右 .cv-side
      // 实时预览。宽屏并排、预览 sticky 跟滚；窄屏单栏、预览排到表单**下面**
      //（先改后看，顺序不能反）。
      // 预览可收起（参照参考站的「收起预览面板」）：收起后表单占满整行，
      // 状态记在会话里，重画不会弹回来。
      '<div class="cv-split' + (S.cvSideHidden ? ' is-preview-hidden' : '') + '">'
    + '<div class="cv-edit">'
    + '<div class="cv-edit-head">'
      + '<h2>简历内容编辑</h2>'
      + '</div>'

    // 表单主体：左「分区导航」+ 右「当前分区的表单」（2026-10-09 改造）。
    //
    // 分区导航的章节表、顺序与显隐口径在 ui/cv-nav.mjs 一处 —— 预览
    //（renderCvVisual）与 Word 导出（cvFormToWordHtml）读的是同一份，
    // 所以「预览里看不到的」在导出的 Word 里也不会有。
    // 工作区两列（2026-10-09 参照 magicv.art 魔方简历）：
    //   左 = 外观设置卡（布局 / 主题色 / 排版 / 间距 / 模式）
    //   右 = 当前分区的表单
    // 设置卡只改变「长什么样」、表单只改变「写了什么」，两者互不干扰；
    // 右栏预览跟着两边实时走。窄屏落单列（见 style.css §18f 的媒体查询）。
    + '<div class="cv-work">'
    + '<aside class="cv-panel" id="cvPanel">' + cvPanelHtml() + '</aside>'
    + '<div class="cv-form-col">'
    + compNotice
    + (dualPicked ? dualTip : '')
    + '<div class="cv-form" id="cvForm">' + cvSectionBody() + '</div>'
    + '</div>'
    + '</div>'
    // 「更多内容」折叠区（个人简介/核心能力/证书/荣誉奖项）已于 2026-09-26
    // 按用户要求整块删掉。数据模型层不动：cv.md 里已有的值仍能解析、
    // 评估与导出照常带上，只是编辑页不再提供这四段的入口。
    + '</div>'
    // ── 右栏：实时预览 ────────────────────────────────────────────
    + '<aside class="cv-side">'
    + '<div class="cv-side-inner">'
    + '<div class="cv-side-head">'
    + '<h2>简历实时预览</h2>'
    + '<span class="cv-side-hint">改左边，这里立刻跟着变</span>'    // 模板库入口（2026-09-30）：原来的 模板1/2/3 快切升级为「导入 / 选择」双入口。
    // 选择去独立模板库页（每套都是真实成稿的缩小预览），导入收自定义版式；
    // 两个动作都不碰表单 —— 「选模板不动简历数据」的口径在这里看得见。
    + '<div class="cv-tpl-actions" role="group" aria-label="简历模板">'
    + '<span class="cv-tpl-now" id="cvTplNow">当前模板：'
    + esc(resolveCvTplStyle(S.cvTpl || '1', S.cvTplItems).name) + '</span>'
    + '<button type="button" class="tpl-btn" id="cvTplImport">导入模板</button>'
    + '<button type="button" class="tpl-btn" id="cvTplPick">选择模板</button>'
    + '</div>'
    + '</div>'
    + '<div class="cv-paper-host"><div class="cv-paper" id="cvVisual" aria-label="简历实时预览"></div></div>'
    // 「简历全局优化」2026-10-09 改为独立页面：这里只留一个入口按钮。
    // 旧实现是在右栏展开一张折叠卡（表单 + 日志 + 改写稿 pre），但优化要跑
    // 1–3 分钟，右栏宽度不够看左右对照，也塞不下双预览框 —— 独立页更好。
    //
    // ⚠️ 编辑对象是独立版本时这张入口卡**不渲染**（2026-10-10）：优化页读的
    //    恒为磁盘上的主简历 cv.md —— 在「编辑某版本」的语境里点它，优化的是
    //    另一份简历，用户会以为改的是眼前这份。
    + (tgt ? '' : '<div class="card cv-opt-entry">'
    + '<div class="cv-opt-entry-txt"><b>简历全局优化</b>'
    + '<p class="hint">左右并排看原简历与 AI 优化结果，逐条对照后再决定要不要用。</p></div>'
    + '<button class="btn primary" id="cvOptEntry" type="button">下一步</button>'
    + '</div>')
    + '</div>'
    + '</aside>'
    + '</div>'
    // 贴着视图右缘的竖排工具条（参照参考站最右那条）：把最常用的几个动作
    // 从顶栏/面板里提出来，免得为了一次「传头像」先滚回顶部。
    + cvRailHtml()
    + polishModal;

  // 输入即更新模型（不重渲染，避免焦点丢失）
  // ── 分区导航交互（2026-10-09）────────────────────────────────────────
  // 三件事：切分区（换左边编辑的内容）、点眼睛（显隐，影响预览与导出）、
  // 拖拽（排序）。三者都改会话 + 服务端，然后 route() 整页重画 —— 与
  // 「+ 添加 / 上移 / 删除」同一套做法（那几个也是整页重画）。
  //
  // ⚠️ 切分区**不 markDirty**：它不是改简历内容。走 route() 而不是 rerender()，
  //    否则每次点个分区名都会把简历标成「有未保存改动」。
  const cvNavEl = $('#cvNav');
  if (cvNavEl) {
    cvNavEl.addEventListener('click', async (e) => {
      const go = e.target.closest('[data-nav-go]');
      if (go) {
        const k = go.dataset.navGo;
        if (k === S.cvNavActive) return;
        S.cvNavActive = k;
        await route({ keepScroll: true });
        return;
      }
      const del = e.target.closest('[data-nav-del]');
      if (del) {
        const k = del.dataset.navDel;
        // 从简历上「拿掉」这件事必须说清后果再动手：cv.md 是唯一数据源，
        // 真删内容是不可逆的，所以垃圾桶做的是**移除显示**，不是销毁内容。
        const yes = await confirmDialog({
          title: '把「' + cvNavLabel(k) + '」从简历上移除？',
          desc: '内容不会被删除，仍完整保存在简历里 —— 只是预览和导出的 Word 里'
            + '不再显示这一节。想加回来：点「+ 添加模块」，或再点一次这一行的眼睛。',
          confirmLabel: '从简历中移除',
        });
        if (!yes) return;
        const navD = curCvNav();
        const wasBlank = !secHasContent(k);
        if (!navD.hidden.includes(k)) {
          await saveCvNav({ order: navD.order, hidden: toggleCvSection(navD.hidden, k) });
        }
        await route({ keepScroll: true });
        // 空章节上「移除」没有可见变化 —— 必须说清楚，否则等于按钮坏了。
        toast(wasBlank
          ? '「' + cvNavLabel(k) + '」现在是空的，移除它不会改变预览。'
            + '如果你要删的那段文字还在，它写在别的小节里（点「空」旁边的名字进去改）。'
          : '已把「' + cvNavLabel(k) + '」从简历上移除，内容仍保留',
        wasBlank ? 'warn' : 'ok');
        return;
      }

      const eye = e.target.closest('[data-nav-eye]');
      if (eye) {
        const k = eye.dataset.navEye;
        const nav = curCvNav();
        await saveCvNav({ order: nav.order, hidden: toggleCvSection(nav.hidden, k) });
        await route({ keepScroll: true });
      }
    });

    // HTML5 拖拽排序。用 dragKey 记住被拖的那一行；dragover 只做提示高亮，
    // 真正的重排在 drop 里一次算完（中途反复移动数组会让顺序抖）。
    let dragKey = null;
    cvNavEl.addEventListener('dragstart', (e) => {
      const it = e.target.closest('[data-nav-key]');
      if (!it || it.getAttribute('draggable') !== 'true') return;
      dragKey = it.dataset.navKey;
      it.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox 不设 data 就根本不触发拖拽（不是可选参数）
        e.dataTransfer.setData('text/plain', dragKey);
      }
    });
    cvNavEl.addEventListener('dragend', () => {
      dragKey = null;
      $$('.cv-nav-item', cvNavEl).forEach((x) => x.classList.remove('dragging', 'drop-hint'));
    });
    cvNavEl.addEventListener('dragover', (e) => {
      if (!dragKey) return;
      e.preventDefault();   // 不 preventDefault 就不会触发 drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const over = e.target.closest('[data-nav-key]');
      $$('.cv-nav-item', cvNavEl).forEach((x) => x.classList.remove('drop-hint'));
      if (over && over.dataset.navKey !== dragKey) over.classList.add('drop-hint');
    });
    cvNavEl.addEventListener('drop', async (e) => {
      const from = dragKey;
      dragKey = null;
      if (!from) return;
      e.preventDefault();
      const over = e.target.closest('[data-nav-key]');
      if (!over || over.dataset.navKey === from) return;
      const nav = curCvNav();
      const i = nav.order.indexOf(from);
      const j = nav.order.indexOf(over.dataset.navKey);
      if (i < 0 || j < 0) return;
      await saveCvNav({ order: moveCvSection(nav.order, i, j), hidden: nav.hidden });
      await route({ keepScroll: true });
    });
  }

  // ── 基本信息字段行交互（2026-10-09）──────────────────────────────────
  // 三件事：点「布局」三选一（证件照位置）、点眼睛（字段显隐）、拖拽（字段排序）。
  //
  // ⚠️ 显隐 / 排序走 route() 整页重画（与分区导航同一套做法），但**不 markDirty**：
  //    它们改的是「哪一项上简历」，不是简历内容 —— 把它们算成未保存改动，
  //    保存徽标就会说谎（用户以为内容变了，其实 cv.md 一个字没动）。
  //
  // ⚠️ 挂在 #cvForm 上而不是 #cvFieldRows 上：整页重画后 #cvForm 是同一个宿主，
  //    但内部的 #cvFieldRows 会换掉，事件委托挂内层会随重画一起丢。
  const cvFormHost = $('#cvForm');
  if (cvFormHost) {
    cvFormHost.addEventListener('click', async (e) => {
      // 「布局」三选一（证件照位置）已按用户要求删除（2026-10-09）——
      // 点眼睛（字段显隐）、拖拽（字段排序）继续在这里处理。
      const eye = e.target.closest('[data-fr-eye]');
      if (eye) {
        const f = curCvFields();
        await saveCvFields({ order: f.order, hidden: toggleCvField(f.hidden, eye.dataset.frEye) });
        await route({ keepScroll: true });
      }
    });

    // HTML5 拖拽排序。与分区导航同一套写法：dragKey 记住被拖的那一行，
    // dragover 只做提示，真正的重排在 drop 里一次算完（中途反复移动数组会让顺序抖）。
    let fDragKey = null;
    // ⚠️ 只认 .cv-fr[draggable="true"]：头像那一行也带 data-fr-key（它要共用显隐），
    //    但它是静态的、不参与排序 —— 不限定选择器的话它会被当成合法的落点。
    const frAt = (t) => t.closest('.cv-fr[draggable="true"]');
    cvFormHost.addEventListener('dragstart', (e) => {
      const it = frAt(e.target);
      if (!it) return;
      fDragKey = it.dataset.frKey;
      it.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', fDragKey);   // Firefox 不设 data 不触发拖拽
      }
    });
    cvFormHost.addEventListener('dragend', () => {
      fDragKey = null;
      $$('.cv-fr', cvFormHost).forEach((x) => x.classList.remove('dragging', 'drop-hint'));
    });
    cvFormHost.addEventListener('dragover', (e) => {
      if (!fDragKey) return;
      e.preventDefault();   // 不 preventDefault 就不会触发 drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const over = frAt(e.target);
      $$('.cv-fr', cvFormHost).forEach((x) => x.classList.remove('drop-hint'));
      if (over && over.dataset.frKey !== fDragKey) over.classList.add('drop-hint');
    });
    cvFormHost.addEventListener('drop', async (e) => {
      const from = fDragKey;
      fDragKey = null;
      if (!from) return;
      e.preventDefault();
      const over = frAt(e.target);
      if (!over || over.dataset.frKey === from) return;
      const f = curCvFields();
      const i = f.order.indexOf(from);
      const j = f.order.indexOf(over.dataset.frKey);
      if (i < 0 || j < 0) return;
      await saveCvFields({ order: moveCvField(f.order, i, j), hidden: f.hidden });
      await route({ keepScroll: true });
    });
  }

  // ── 外观设置交互（2026-10-09）────────────────────────────────────────
  // 拖滑块 / 点色板要**立刻看到预览变化**，所以不走 route() 整页重画：
  // 直接改会话 → 重画右栏预览 → 更新数值标签；落盘另走 400ms 防抖
  // （拖一次滑块会连发十几个 input，全发出去等于把服务端当草稿纸用）。
  let lookSaveTimer = 0;
  function paintLookValues() {
    const L = curCvLook();
    const lh = $('#cvLookLhVal');
    if (lh) lh.textContent = L.lineHeight || '默认';
    ['margin', 'moduleGap', 'paraGap'].forEach((k) => {
      const el = $('#cvLookVal' + k);
      if (el) el.textContent = L[k];
    });
    $$('#cvLookAccent .cv-swatch').forEach((b) => {
      b.classList.toggle('on', (b.dataset.accent || '') === L.accent);
    });
  }
  function pushLook(patch) {
    S.cvLook = normalizeCvLook(Object.assign({}, curCvLook(), patch));
    paintPlainPreview();     // 重画预览（paintPlainPreview 内部已经带上 look）
    paintLookValues();
    clearTimeout(lookSaveTimer);
    lookSaveTimer = setTimeout(() => { saveCvLook(curCvLook()); }, 400);
  }

  const panelEl = $('#cvPanel');
  if (panelEl) {
    panelEl.addEventListener('click', async (e) => {
      const sw = e.target.closest('.cv-swatch');
      if (sw) { pushLook({ accent: sw.dataset.accent || '' }); return; }

      const stp = e.target.closest('[data-look-step]');
      if (stp) {
        const k = stp.dataset.lookStep;
        const dir = Number(stp.dataset.dir) < 0 ? -1 : 1;
        // 步进与上限必须和 cv-look.mjs 的归一化区间一致：超出会被那边夹回去，
        // 用户看到的却是「点了没反应」—— 那种"点了不动"最难排查。
        const MAX = { margin: 60, moduleGap: 40, paraGap: 24 };
        const STEP = { margin: 4, moduleGap: 2, paraGap: 2 };
        const cur = curCvLook()[k] || 0;
        pushLook({ [k]: Math.min(MAX[k], Math.max(0, cur + dir * STEP[k])) });
        return;
      }

      if (e.target.closest('#cvLookAccentCustom')) {
        const pick = $('#cvLookAccentPick');
        if (pick) pick.click();
        return;
      }

      const un = e.target.closest('[data-unhide]');
      if (un) {
        const navU = curCvNav();
        await saveCvNav({ order: navU.order, hidden: toggleCvSection(navU.hidden, un.dataset.unhide) });
        await route({ keepScroll: true });
        toast('已把「' + cvNavLabel(un.dataset.unhide) + '」加回简历', 'ok');
        return;
      }

      if (e.target.closest('#cvAddModule')) {
        const menu = $('#cvAddMenu');
        if (menu) menu.hidden = !menu.hidden;
      }
    });

    panelEl.addEventListener('input', (e) => {
      const r = e.target.closest('#cvLookLh');
      if (r) {
        const v = Number(r.value);
        // 拖回 1.7（默认值）就等于"没调过" → 存 0。
        // 否则会留下一条"看着调过、其实和默认一模一样"的设置 —— 将来改默认值它不跟。
        pushLook({ lineHeight: Math.abs(v - 1.7) < 0.05 ? 0 : v });
        return;
      }
      // 「模式」卡（图标模式 / 副标题居中 / 长标题模式）已于 2026-10-09 按用户
      // 要求整张删掉。cv-look.mjs 里那三个字段**保留**（与「微信 / LinkedIn 撤下
      // 表单」同一个做法）：老简历里如果已经开了其中一个，预览还得照着渲染，
      // 只是不再提供关闭入口。当前值全是默认 false，视觉上没有任何残留。
    });

    panelEl.addEventListener('change', (e) => {
      const f = e.target.closest('#cvLookFont');
      if (f) { pushLook({ font: f.value }); return; }
      const cp = e.target.closest('#cvLookAccentPick');
      if (cp) { pushLook({ accent: String(cp.value || '').toUpperCase() }); return; }
      const sel = e.target.closest('#cvLookBase, #cvLookTitle, #cvLookItemTitle');
      if (sel) {
        const key = sel.id === 'cvLookBase' ? 'baseSize'
          : sel.id === 'cvLookTitle' ? 'titleSize' : 'itemTitleSize';
        pushLook({ [key]: Number(sel.value) || 0 });
      }
    });
  }
  paintLookValues();

  // ── 图片插入：头像（2026-10-09）──────────────────────────────────────
  // 上传走服务端存文件，表单里只留一个应用内路径 —— 为什么不塞 base64，
  // 见 ui/server.mjs 的 /api/cv/asset 注释（那会把 cv.md 变成没法读的文本）。
  function setPhoto(url) {
    setPath(form2, 'candidate.photo', String(url || ''));
    markDirty();        // 换头像是改简历内容，必须标脏 —— 否则保存时会被服务端旧值覆盖
    refreshPreview();
    rerender();         // 缩略图与「移除头像」按钮要跟着重画
  }
  async function uploadPhoto(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast('请选择图片文件（PNG / JPG / WebP）', 'warn'); return; }
    if (file.size > 2 * 1024 * 1024) { toast('图片大小不能超过 2MB，请先压缩再上传', 'warn'); return; }
    const dataUrl = await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result || ''));
      fr.onerror = () => rej(new Error('读取图片失败'));
      fr.readAsDataURL(file);
    });
    const btn = $('#cvPhotoPick');
    if (btn) busy(btn, true, '上传中…');
    try {
      const r = await api('/api/cv/asset', { method: 'POST', body: { dataUrl }, timeout: 60000 });
      setPhoto(r.url);
      toast('头像已上传', 'ok');
    } catch (err) {
      toast((err && err.message) || '上传失败', 'bad');
    } finally {
      if (btn) busy(btn, false);
    }
  }

  view.addEventListener('click', (e) => {
    if (e.target.closest('#cvPhotoPick')) {
      const fi = $('#cvPhotoFile');
      if (fi) fi.click();
      return;
    }
    if (e.target.closest('#cvPhotoClear')) { setPhoto(''); toast('已移除头像', 'ok'); }
  });
  view.addEventListener('change', (e) => {
    const fi = e.target.closest('#cvPhotoFile');
    if (fi && fi.files && fi.files[0]) { uploadPhoto(fi.files[0]); return; }
    // 链接用 change（失焦 / 回车）而不是 input：否则每敲一个字符就重画一次预览，
    // 敲到一半的 "https://ab" 还会被当成有效地址去验证。
    const pu = e.target.closest('#cvPhotoUrl');
    if (pu) {
      const v = String(pu.value || '').trim();
      if (v && !/^https?:\/\//i.test(v)) { toast('图片链接要以 http:// 或 https:// 开头', 'warn'); return; }
      setPhoto(v);
    }
  });
  // 拖进来即上传（对齐参考站的「拖拽或点击上传图片」）
  view.addEventListener('dragover', (e) => {
    const box = e.target.closest ? e.target.closest('#cvPhotoBox') : null;
    if (!box) return;
    e.preventDefault();
    box.classList.add('drop');
  });
  view.addEventListener('dragleave', (e) => {
    const box = e.target.closest ? e.target.closest('#cvPhotoBox') : null;
    if (box) box.classList.remove('drop');
  });
  view.addEventListener('drop', (e) => {
    const box = e.target.closest ? e.target.closest('#cvPhotoBox') : null;
    if (!box) return;
    e.preventDefault();
    box.classList.remove('drop');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) uploadPhoto(f);
  });

  const form2 = form;
  $$('[data-path]', view).forEach((el) => {
    el.addEventListener('input', () => {
      const kind = el.dataset.kind;
      const v = kind === 'bullets' ? linesToArr(el.value)
        : kind === 'items' ? el.value.split(/[\n,，、]/).map((x) => x.trim()).filter(Boolean)
        : el.value;
      setPath(form2, el.dataset.path, v);
      markDirty();        // 打字也算改动，否则重画一次就白打了
      cvUndoSoon();       // 连续打字合并成一步撤销（700ms 内不再输入才算一次）
      refreshPreview();
    });
  });

  // ── 模板实时预览：全部走 HTML 渲染（2026-10-09 用户要求）─────────────
  // 旧实现是「Word COM Find & Replace → 转 PDF → 页图进 Shadow DOM」，本质
  // 是**图片**：改一个字要等服务端重合成十几秒、首屏空白、无版式语义、无法选中
  // 复制文字，也没法在浏览器里直接比对。现在统一用 renderCvVisual() 输出
  // 真正的 HTML —— 版式仍由模板 id 决定（resolveCvTplStyle → .cvp-tplN），
  // 所以换模板看到的仍是不同排版，只是不再经过 Word。
  let fillTimer = 0;

  function paintPlainPreview() {
    const box = $('#cvVisual');
    if (!box) return;
    box.innerHTML = renderCvVisual(form2, S.cvTpl || '1', { nav: curCvNav(), look: curCvLook(), fields: curCvFields() });
    // 页边距挂在**宿主**（#cvVisual 本身就是 .cv-paper）—— 见 applyCvLookHost 注释
    applyCvLookHost(box, curCvLook());
    // 头像取不到（文件被删 / 外链失效）就把 <img> 摘掉：留一个碎图图标在简历
    // 页眉上，比干脆没有头像更难看。渲染器只吐字符串，所以监听挂在这里；
    // complete && naturalWidth===0 兼顾「插进 DOM 之前就已经失败」的情况
    // （那时 error 事件可能已经错过了）。
    const phImg = box.querySelector('.cvp-photo');
    if (phImg) {
      const drop = () => phImg.remove();
      phImg.addEventListener('error', drop);
      if (phImg.complete && phImg.naturalWidth === 0) drop();
    }
  }

  /** 预览区脚注：说明预览与导出的关系，以及 Word 导出仍走模板保真合成 */
  function paintPreviewNote() {
    const box = $('#cvVisual');
    if (!box) return;
    const old = $('#cvPreviewNote');
    if (old) old.remove();
    const hit = docxTplEntry(S.cvTpl || '');
    // ⚠️ 2026-10-13 用户要求删掉这句：「预览为 HTML 实时渲染；顶栏「导出 PDF」
    //    打印的就是这份预览（所见即所得）。」—— 2026-10-11 起导出只剩 PDF 一条路，
    //    而 PDF 打印的就是这份预览，这句话已经是废话。
    //    非 docx 模板**直接不插这个脚注**（不是插一个空的 <p> —— 空的照样占一行）。
    //    docx 保真模板那条必须留着：它带着「查看模板原貌」按钮，不解释的话
    //    用户不知道预览为什么和模板长得不一样。
    if (!hit) return;
    const note = document.createElement('p');
    note.id = 'cvPreviewNote';
    note.className = 'hint cvp-docx-note';
    note.innerHTML = '预览为表单内容 + 色系版式（不是 Word 原版式）；「导出 PDF」打印这份预览，'
      + '原版式长什么样可以点右边查看。'
      + '<button class="btn sm" type="button" id="cvTplPeek">查看模板原貌</button>';
    const host = box.querySelector('.cvp');
    if (host) box.insertBefore(note, host.nextSibling);
    else box.appendChild(note);
  }

  function refreshPreview() {
    // 右栏视觉预览读当前 form。HTML 渲染是纯同步操作，打字即出，
    // 不再有防抖合成、不再有加载态，也不需要落地校验。
    const vis = $('#cvVisual');
    if (!vis) return;
    paintPlainPreview();
    paintPreviewNote();
  }
  refreshPreview();

  // 预览区「查看模板原貌」—— cvTplPeek 按钮随 refreshPreview 每次打字重建，
  // 必须走事件委托（挂 view，本页只挂一次）。
  view.addEventListener('click', (e) => {
    if (e.target.closest('#cvTplPeek')) openTplOriginalModal();
  });

  // 模板入口（2026-09-30 模板库）：导入 = 自定义版式入库（导入≠生效，去库里选）；
  // 选择 = 去模板库页挑，选定后服务端持久化、hash 跳回本页，refreshPreview
  // 会按新模板重画右栏。两个入口都不碰表单。
  const cvTplImportBtn = $('#cvTplImport');
  if (cvTplImportBtn) cvTplImportBtn.addEventListener('click', () => openCvTplImportModal());
  const cvTplPickBtn = $('#cvTplPick');
  if (cvTplPickBtn) cvTplPickBtn.addEventListener('click', () => go('templates'));

  wireFolds(view);

  // ── AI 润色本段 ──────────────────────────────────────────
  // 「本段」= 最近点进去的那个字段。focusin 走事件委托（重画换节点也不丢），
  // 状态放 S.cvPolish，runCvPolish / applyCvPolish 是模块级函数（见 paintCvOpt 附近）
  // —— 异步回调只写会话，出口 paintCvPolish() 带「不在本页 return」。
  view.addEventListener('focusin', (e) => {
    const el = e.target.closest ? e.target.closest('[data-path]') : null;
    if (!el) return;
    const label = el.closest('label.field');
    const title = label ? label.querySelector(':scope > span') : null;
    // <span>标签 <em>提示</em></span> —— 第一个文本节点才是纯字段名
    S.cvPolishLast = {
      path: el.dataset.path,
      kind: el.dataset.kind || '',
      label: title && title.firstChild && title.firstChild.nodeType === 3
        ? title.firstChild.textContent.trim()
        : (title ? title.textContent.trim() : el.dataset.path),
    };
  });

  // 「AI 润色本段」的入口按钮已按用户要求删除（2026-10-11）：runCvPolish /
  // 弹窗 / 应用链路仍然保留 —— 去掉的只是那个按钮，不是能力本身。
  // focusin 仍记录「最近点过的字段」，将来要恢复入口时状态是现成的。

  // 弹窗按钮走事件委托（弹窗随视图重建）。
  view.addEventListener('click', (e) => {
    // 文体切换：只改会话里的选择（modeUser = 用户显式选过，之后不再按字段推断），
    // **不自动重跑** —— 一次误点就白烧一次 AI 额度。要按新文体跑，点「重新生成」。
    const mb = e.target.closest('[data-polish-mode]');
    if (mb) {
      const st = polishSession();
      const m = mb.dataset.polishMode;
      if (POLISH_MODE_META[m] && st.modeUser !== m) {
        st.modeUser = m;
        st.mode = m;
        paintCvPolish();
      }
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'polishClose') {
      const st = polishSession();
      st.open = false;
      paintCvPolish();
    }
    if (act === 'polishRetry') {
      const st = polishSession();
      runCvPolish({ path: st.path, kind: st.kind, label: st.label }, st.modeUser || st.mode);
    }
    if (act === 'polishApply') applyCvPolish();
  });

  // 增删排序
  // 列表型字段的空壳构造。
  // 标准六段走 CV_SCHEMA[kind].empty；双栏模板的字段（experience/education/
  // skills/certifications/awards 名字虽同，但字段集不同 —— 比如技能多了 level、
  // 少了 items）走 DUAL_TPL_FIELDS 的定义按需现造。
  // 之前这里直接 CV_SCHEMA[k].empty，撞到双栏独有的 key 就抛 TypeError，
  // 表现为「点添加按钮整页报错」。
  const emptyItem = (k) => {
    const spec = CV_SCHEMA[k];
    if (spec && spec.empty) return JSON.parse(JSON.stringify(spec.empty));
    const f = DUAL_TPL_FIELDS.find((x) => x.key === k);
    if (f && f.kind === 'list') {
      const o = {};
      for (const sub of f.fields) o[sub.path] = sub.kind === 'bullets' ? [] : '';
      return o;
    }
    if (f && f.kind === 'skills') {
      return { category: '', level: (f.fields.find((x) => x.path === 'level') || {}).def || 80 };
    }
    return {};
  };
  $$('[data-add]', view).forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.add;
    form2[k] = form2[k] || [];
    form2[k].push(emptyItem(k));
    rerender();
  }));
  $$('[data-del]', view).forEach((b) => b.addEventListener('click', () => {
    form2[b.dataset.del].splice(Number(b.dataset.i), 1);
    rerender();
  }));
  const move = (k, i, d) => {
    const a = form2[k];
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    const t = a[i]; a[i] = a[j]; a[j] = t;
    rerender();
  };
  $$('[data-up]', view).forEach((b) => b.addEventListener('click', () => move(b.dataset.up, Number(b.dataset.i), -1)));
  $$('[data-down]', view).forEach((b) => b.addEventListener('click', () => move(b.dataset.down, Number(b.dataset.i), 1)));

  // 内容变了的单点：标脏 → 更新徽标 → 重排自动保存。
  // ⚠️ cvAutoSaveSoon() **不在** `if (!S.cvDirty)` 里面：防抖窗口要从「最后一次
  //    输入」算起。放进判断里的话，第一次改动定下 800ms 的闹钟，之后每敲一个字
  //    都不重排 —— 边打字边被保存，请求数翻倍且语义变成了「打字时也在存」。
  const markDirty = () => {
    if (!S.cvDirty) {
      S.cvDirty = true;
      paintCvSaveState();
    }
    cvAutoSaveSoon();         // 实时保存：停止输入 800ms 后落盘
  };

  // 结构变化（增 / 删 / 上移 / 下移）：标记改动 → 重画。
  //
  // 重画走 route()，但**保留滚动位置**。「+ 添加教育背景」按钮在页面靠下的
  // 位置，滚回顶部会让人以为「点了没反应」——这个 bug 一开始就是被这么误报的。
  //
  // 关键：这里**不再重新拉 /api/cv 覆盖 form2**。草稿已经在 S.cvDraft 里，
  // 重画时 VIEWS.cv 会识别出 dirty 并继续用它，新条目才留得住。
  async function rerender() {
    // 增 / 删 / 上移 / 下移 / 应用润色 / 换头像都从这里过 —— 先记一步撤销再重画。
    // 压进去的是「改动之前」那份（cvCommitUndo 内部用 cvLastSnap 实现）。
    cvCommitUndo();
    markDirty();
    await route({ keepScroll: true });
  }

  // 顶部动作（2026-10-09 实时保存改造）
  //
  // 「保存并生成 Word」这颗按钮**已删**：它做的两件事现在各归其位 ——
  // 写 cv.md 交给实时保存；出文件交给顶栏「导出 PDF」（2026-10-11 起
  // 导出只剩 PDF 一条路，Word/Markdown/JSON 三条出口按用户要求下线）。
  const cvImportBtn = $('#cvImport');
  if (cvImportBtn) {
    cvImportBtn.addEventListener('click', () => openCvImport(cvImportBtn));
  }

  // 状态徽标平时只是个指示器；被服务端守卫拦下时它变成「唯一能推进这件事的地方」，
  // 所以那一刻它得可点、可聚焦、能被键盘触发。
  const saveStateEl = $('#cvSaveState');
  if (saveStateEl) {
    const onState = () => { if (S.cvSaveBlocked) cvResolveSaveBlock(); };
    saveStateEl.addEventListener('click', onState);
    saveStateEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onState(); }
    });
  }

  // 「从 Word 导入」：动态建 <input type=file> 选 .docx → 浏览器侧解析
  //（doc-import 的 zip 解压 + cv-model 的 markdown 解析，文件不上传）→
  // 确认框点名解析结果 → 覆盖表单草稿。
  // sourceBtn：从哪颗按钮点进来的。顶栏的「导入简历」和右侧工具条那颗图标
  // 都会调这里 —— busy 的 loading 得画在用户真点的那颗上。
  function openCvImport(sourceBtn) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = WORD_ACCEPT;
    inp.addEventListener('change', async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      if (file.size > WORD_MAX_BYTES) {
        toast('文件超过 8MB —— 确认选的是简历文档本身，而不是扫描件或图片包', 'bad');
        return;
      }
      // 兜底：调用方没给按钮（或那颗按钮随重画没了）就回落工具条那颗。
      // 都取不到 = 用户已经离开这一页，此时中止，别去动已经换掉的界面。
      const btn = (sourceBtn && sourceBtn.isConnected ? sourceBtn : null) || $('[data-rail="import"]');
      if (!btn) return;
      busy(btn, true, '解析中…');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { form: parsed, warnings } = await docxToCvForm(bytes);
        const cnt = '姓名「' + (parsed.candidate.name || '（空）') + '」，'
          + '教育 ' + parsed.education.length + ' 条、经历 ' + parsed.experience.length
          + ' 条、项目 ' + parsed.projects.length + ' 条、技能 ' + parsed.skills.length + ' 条';
        const okGo = await confirmDialog({
          title: '用「' + file.name + '」覆盖当前表单？',
          desc: '表单里还没保存的改动会丢失。解析到：' + cnt + '。'
            + (warnings.length ? '提示：' + warnings.join(' ') : '确认后可在下方逐项核对。'),
          confirmLabel: '覆盖表单',
          danger: true,
        });
        if (!okGo) { busy(btn, false); return; }
        // 求职意向是编辑页没有的字段：导入不覆盖它，保留用户当前值
        parsed.targetRole = form2.targetRole || parsed.targetRole || '';
        // 草稿里放导入结果，**保持脏标记**：此时表单与服务端 cv.md 确实不一致，
        // dirty=true 才能让 VIEWS.cv 的「草稿优先」规则保住导入内容 ——
        // 置 false 的话 route() 会判定「不脏 → 重拉服务端」，导入被当场冲掉。
        // 副作用是保存按钮显示「有未保存改动」，这正是事实（还没存盘）。
        S.cvDraft = parsed;
        S.cvDirty = true;
        S.cvSaveBlocked = false;      // 导入是一份全新的表单，上一次的「待确认」作废
        toast('已从 Word 导入，正在自动保存…', 'ok');
        cvAutoSaveSoon();
        route();
      } catch (err) {
        toast(err.message || '导入失败', 'bad');
        busy(btn, false);
      }
    });
    inp.click();
  }

  // ── 右侧工具条 + 导出菜单 + 撤销重做 的交互（2026-10-09）─────────────
  const railEl = $('#cvRail');
  if (railEl) {
    railEl.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-rail]');
      if (!b) return;
      const act = b.dataset.rail;
      if (act === 'photo') {
        // 头像在「基本信息」分区里：先切过去再把它滚进视野并闪一下，
        // 只切不定位的话用户还得自己在表单里找。
        S.cvNavActive = CV_NAV_BASIC;
        await route({ keepScroll: true });
        const box = $('#cvPhotoBox');
        if (box) {
          box.scrollIntoView({ behavior: 'smooth', block: 'center' });
          box.classList.add('flash');
          setTimeout(() => box.classList.remove('flash'), 1200);
        }
        return;
      }
      if (act === 'polish') { runCvPolish(); return; }
      if (act === 'import') { openCvImport(b); return; }
      // 竖工具条的「导出」与顶栏同一个动作（2026-10-11 起只有导出 PDF 一条路）
      if (act === 'export') { exportCvPdf(cvExportBtn); return; }
      if (act === 'preview') { S.cvSideHidden = !S.cvSideHidden; await route({ keepScroll: true }); return; }
      if (act === 'help') { go('help'); }
    });
  }

  // 导出 PDF（2026-10-11 用户要求：只导出 PDF，并下载到本机）。
  //
  // 三条老出口（Word 简历 / Markdown / JSON）已按用户要求撤掉：
  //   · Word 版式与预览对不上（Word 认不了 HTML 模板的双栏/色块），留着只会误导；
  //   · Markdown / JSON 是备份用途，不是「导出简历」。
  // 现在只有一条路，也就不需要下拉菜单与二次确认弹窗：点一下 → 生成 → 自动下载。
  //
  // 导的是**右边那份实时预览**（cvPreviewPrintHtml 打包 HTML + 整页样式），
  // 所以主简历与独立版本一视同仁 —— 不再有「PDF 只对主简历开放」的限制。
  // 顶栏按钮与右侧竖工具条的「导出」共用这一个动作（函数声明会提升，
  // 竖工具条那边的引用在点击时才求值，位置无所谓）。
  async function exportCvPdf(btn) {
    if (!btn || btn.disabled) return;
    const name = String((form2.candidate || {}).name || '简历');
    // 下载文件名：简历-姓名-YYYYMMDD.pdf（与磁盘上那份同一口径）
    const fileBase = '简历-' + name.replace(/[\/:*?"<>|]/g, '') + '-'
      + new Date().toISOString().slice(0, 10).replace(/-/g, '');
    busy(btn, true, '生成中…');
    try {
      // 先把还在防抖窗口里的改动落盘：cv.md 与预览保持一致，
      // 用户随后用别的工具打开时不会是旧内容。
      await cvAutoSaveNow();
      const r = await api('/api/cv/pdf-live', {
        method: 'POST',
        timeout: 300000,
        body: {
          html: await cvPreviewPrintHtml(name),
          name,
          page_format: 'a4',
        },
      });
      // 下载到本机：同源链接 + download 属性 → 落到浏览器下载目录，
      // 文件名用「简历-姓名-日期.pdf」（而不是服务端的中间文件名）。
      const a = document.createElement('a');
      a.href = '/api/output?file=' + encodeURIComponent(r.file);
      a.download = fileBase + '.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('PDF 已开始下载（' + fmtBytes(r.size) + '），也留在「最近输出」里', 'ok');
    } catch (err) {
      toast('导出失败：' + ((err && err.message) || err), 'bad');
    } finally {
      busy(btn, false);
    }
  }
  const cvExportBtn = $('#cvExportBtn');
  if (cvExportBtn) cvExportBtn.addEventListener('click', () => exportCvPdf(cvExportBtn));

  const cvUndoBtn = $('#cvUndo');
  if (cvUndoBtn) cvUndoBtn.addEventListener('click', () => cvUndo());
  const cvRedoBtn = $('#cvRedo');
  if (cvRedoBtn) cvRedoBtn.addEventListener('click', () => cvRedo());
  paintCvUndoButtons();

  // 优化面板已独立成页（#cvopt），这里只剩一个跳转入口（2026-10-09）。
  const cvOptEntryBtn = $('#cvOptEntry');
  if (cvOptEntryBtn) {
    cvOptEntryBtn.addEventListener('click', () => openCvOptPanel());
  }
  // 从「岗位评估」页跳过来的改写稿要灌进会话后再跳转，不能先跳后灌（页面已渲染完）。
  if (S.pendingCvOptDraft) {
    const p = S.pendingCvOptDraft;
    S.pendingCvOptDraft = null;
    const opt = cvOptSession();
    // 只接改写稿本身；JD 不再往会话里带（2026-10-09 起这一页不接受岗位输入）。
    // 注意 VIEWS.cvopt 只重置 target/jd，不清 draft/issues，所以这里灌的能留住。
    opt.summary = p.summary || '';
    opt.issues = p.issues || [];
    opt.draft = p.draft || '';
    opt.applied = false;           // 新带过来的稿子还没替换过
    opt.saved = false;
    opt.parseError = ''; opt.raw = '';
    opt.state = { label: '已优化', cls: 'badge ok' };
    opt.hint = '来自「岗位评估」页的 AI 改写稿。右边是优化结果，'
      + '请逐条核对（<b>AI 可能编造经历或数字</b>），确认后再用。';
    go('cvopt');
  }

  paintCvPolish();

  // 点视图里别处 → 收起导出菜单（比给 document 挂监听更干净，见上面的注释）
  view.addEventListener('click', (e) => {
    // （原来这里是「点视图别处收起导出菜单」；导出改成单按钮后菜单下线）
  });
};


/**
 * 「我的简历」页的**视觉预览**（右栏那份排版好的简历）。
 *
 * ⚠️ 章节标题与顺序必须继续跟 CV_SECTION_TITLES_ZH 对齐（教育在实习前）——
 * 「写进 cv.md 的文本」由 ui/cv-model.mjs 的 cvToMarkdown() 在保存时统一生成，
 * 这里只负责给人看的成稿效果；两边读同一个 form，不会互相矛盾。
 */
function renderCvVisual(form, tpl, opts) {
  const f = form;

  // base '4'（双栏黄·图文，2026-10-09 接入）走**另一套结构**的渲染器：
  // 两栏 + 头像 + 技能进度条 + 时间轴，与下面这套单栏章节流没有共用结构，
  // 硬塞进 .cvp-tplN 三档只会让三档 CSS 变成分支堆。详见 ui/cv-tpl-dual.mjs。
  const st0 = resolveCvTplStyle(tpl || S.cvTpl || '1', S.cvTplItems);
  // 外观设置（2026-10-09）：主色 / 字体 / 字号 / 行高 / 间距 / 模式。
  // 只产出**用户真调过**的项，其余留给 style.css 的默认值 ——
  // 没动过设置时渲染结果与本改造之前逐像素一致（回归安全网，别改成"总是输出"）。
  const lk = cvLookRootAttrs(opts && opts.look);
  const lkCls = lk.cls ? ' ' + lk.cls : '';
  if (st0.base === DUAL_TPL_BASE) {
    return dualCvHasContent(f)
      ? renderDualCv(f, lk, (opts && opts.nav && opts.nav.hidden) || [])
      : '<style>' + DUAL_TPL_CSS + '</style>'
        + '<div class="cvp cvp-dual' + lkCls + '"'
        + (lk.style ? ' style="' + lk.style + '"' : '') + '>'
        + '<div class="cvp-empty"></div></div>';
  }

  // 「稳重」系列 10 套（2026-10-09）：用**模板自己的原版式**渲染，内容来自简历。
  // 与双栏模板同属「结构由模板决定」的一类，所以放在同一处判断里。
  if (st0.base === WZ_PREFIX) {
    const meta = wzTpl(tpl || S.cvTpl || '');
    const src = meta ? (S.cvWzSrc[meta.id] || '') : '';
    if (!src) {
      return '<div class="cvp cvp-empty">正在载入「'
        + (meta ? meta.name : '这套模板') + '」…</div>';
    }
    if (!wzHasContent(f)) {
      // 占位句已按用户要求删除（2026-10-13）。元素保留：.cvp-empty 自带
      // padding，留着它预览框的高度不变，只是不再写一行说明。
      return '<div class="cvp"><div class="cvp-empty"></div></div>';
    }
    return renderWzCv(f, src, (f.candidate || {}).photo || '', lk,
      (opts && opts.nav && opts.nav.hidden) || []);
  }

  const c = f.candidate || {};
  const e2 = (s) => esc(s == null ? '' : String(s));
  const out = [];

  // ── 页眉：头像 + 姓名 + 求职意向 + 信息行 ──────────────────────
  // 组成、顺序与显隐全部来自 ui/cv-fields.mjs 的三个纯函数（Word 导出读同一份）：
  //   cvHeaderPhoto  —— 头像要不要显示（填了图 + 没被眼睛关掉）
  //   cvHeaderRole   —— 求职意向：表单里显式填的优先，其次回落简历对象的目标岗位
  //   cvHeaderValues —— 信息行：按用户排的顺序，跳过被隐藏的与空值
  //
  // ⚠️ 默认设置下 headerVals = [phone, email, location]，与本改造之前一字不差
  //   （学历/年龄/兴趣爱好在默认顺序里排在最后，且多数简历没填，自然不出现）。
  const cFields = opts && opts.fields;
  const head = [];
  const photo = cvHeaderPhoto(c, cFields);
  // 头像：**只在真填了图时输出** —— 空着还在简历上留一个方框，比没有头像更难看。
  // 定位与让位在 style.css 的 .cvp-photo 段；左/上/右三态见 .cvp-hl-*。
  if (photo) head.push('<img class="cvp-photo" src="' + e2(photo) + '" alt="">');
  if (!isCvFieldHidden(cFields, 'name')) {
    const nm = String(c.name == null ? '' : c.name).trim();
    head.push('<h1>' + (nm ? e2(nm) : '<span class="cvp-ph">（未填写姓名）</span>') + '</h1>');
  }
  // 求职意向只在真有数据时显示。原来这里 fallback 到 c.location，会把
  // 所在城市渲染成「求职：西安」—— 表单里根本没有「求职岗位」字段。
  const role = cvHeaderRole(c, f.targetRole, cFields);
  if (role) head.push('<p class="cvp-role">求职：' + e2(role) + '</p>');
  const headerVals = cvHeaderValues(c, cFields);
  if (headerVals.length) {
    head.push('<div class="cvp-contact">'
      + headerVals.map((x) => '<span>' + e2(x) + '</span>').join('') + '</div>');
  }
  // 一条都没剩下（姓名与头像都被眼睛关掉、也没有联系方式）时**整个页眉不输出** ——
  // 否则会留下一道没有内容的横线，看着像渲染坏了。
  // headPushCount 记下页眉占了几条，末尾判「是不是空简历」要用（见该处注释）。
  const headPushCount = head.length ? 1 : 0;
  if (head.length) out.push('<div class="cvp-head">' + head.join('') + '</div>');

  const sec = (title, body) => {
    if (!body) return;
    out.push('<div class="cvp-sec"><h3>' + title + '</h3>' + body + '</div>');
  };

  // ── 章节渲染表：key → 该节的 HTML（空串 = 这一节没内容，不输出）──────
  //
  // ⚠️ **顺序不在这张表里** —— 由分区导航的 order 决定（ui/cv-nav.mjs）。
  // 这是 magic-resume 那套「章节可拖拽排序 / 可单独隐藏」的落点：
  // 改顺序 = 改数据，不是改代码。Word 导出（cv-word.mjs 的 cvFormToWordHtml）
  // 用**同一份 key 与同一套顺序** —— 两处各写一份，迟早出现
  // 「预览里有、导出的 Word 里没有」这种静默不一致。
  // 各章节里「不是全空」的条目。口径在 cv-model.mjs 的 cvLiveItems 一处 ——
  // Word 导出（cv-word.mjs 的 cvFormToWordHtml）读的是同一份，所以
  // 「预览里有的、导出的 Word 里没有」不会发生。
  // 空条目（用户点了「+ 添加」还没填）**不渲染**：渲染出来会是一个带标题的空章节。
  const live = cvLiveItems(f);

  const bodies = {
    summary: () => (f.summary ? '<p>' + e2(f.summary) + '</p>' : ''),

    competencies: () => (live.competencies.length
      ? '<ul class="cvp-tags">' + live.competencies.map((x) => '<li>' + e2(x) + '</li>').join('') + '</ul>'
      : ''),

    education: () => (live.education.length ? live.education.map((e) => {
      const meta = [e.org, e.location].filter(Boolean).join(' · ');
      return '<div class="cvp-item">'
        + '<div class="cvp-item-head"><span class="cvp-t">' + e2(e.title || '（未填写）') + '</span>'
        + (e.year ? '<span class="cvp-d">' + e2(e.year) + '</span>' : '') + '</div>'
        + (meta ? '<p class="cvp-meta">' + e2(meta) + '</p>' : '')
        + (e.description ? '<p>' + e2(e.description) + '</p>' : '')
        + '</div>';
    }).join('') : ''),

    experience: () => (live.experience.length ? live.experience.map((e) => {
      const title = [e.role, e.company].filter(Boolean).join(' — ');
      const meta = [e.dates, e.location].filter(Boolean).join(' · ');
      return '<div class="cvp-item">'
        + '<div class="cvp-item-head"><span class="cvp-t">' + e2(title || '（未填写）') + '</span>'
        + (e.dates ? '<span class="cvp-d">' + e2(e.dates) + '</span>' : '') + '</div>'
        + (meta && meta !== e.dates ? '<p class="cvp-meta">' + e2(meta) + '</p>' : '')
        + ((e.bullets || []).length
          ? '<ul>' + e.bullets.map((b) => '<li>' + e2(b) + '</li>').join('') + '</ul>' : '')
        + '</div>';
    }).join('') : ''),

    projects: () => (live.projects.length ? live.projects.map((p) => {
      return '<div class="cvp-item">'
        + '<div class="cvp-item-head"><span class="cvp-t">' + e2(p.name || '（未填写）') + '</span>'
        + (p.badge ? '<span class="cvp-d">' + e2(p.badge) + '</span>' : '') + '</div>'
        + (p.description ? '<p>' + e2(p.description) + '</p>' : '')
        + (p.tech ? '<p class="cvp-meta">技术栈：' + e2(p.tech) + '</p>' : '')
        + ((p.bullets || []).length
          ? '<ul>' + p.bullets.map((b) => '<li>' + e2(b) + '</li>').join('') + '</ul>' : '')
        + (p.url ? '<p class="cvp-meta">' + e2(p.url) + '</p>' : '')
        + '</div>';
    }).join('') : ''),

    skills: () => (live.skills.length
      ? '<ul>' + live.skills.map((s) => '<li>' + (s.category ? '<b>' + e2(s.category) + '：</b> ' : '')
        + e2((s.items || []).join('、')) + '</li>').join('') + '</ul>'
      : ''),

    certifications: () => (live.certifications.length
      ? '<ul>' + live.certifications.map((e) => '<li>' + e2(e.title)
        + ([e.org, e.year].filter(Boolean).length
          ? ' — ' + e2([e.org, e.year].filter(Boolean).join(' · ')) : '')
        + '</li>').join('') + '</ul>'
      : ''),

    awards: () => (live.awards.length
      ? '<ul>' + live.awards.map((e) => '<li>' + e2(e.title)
        + ([e.org, e.year].filter(Boolean).length
          ? ' — ' + e2([e.org, e.year].filter(Boolean).join(' · ')) : '')
        + '</li>').join('') + '</ul>'
      : ''),
  };

  // 按分区导航的顺序输出；被隐藏的章节跳过（内容仍在表单 / cv.md 里，没丢）。
  const nav = normalizeCvNav(opts && opts.nav);
  const hid = new Set(nav.hidden);
  for (const k of nav.order) {
    if (hid.has(k)) continue;
    const build = bodies[k];
    const body = build ? build() : '';
    if (body) sec(cvNavLabel(k), body);
  }

  // 模板解析（2026-09-30 模板库）：tpl 可能是内置 '1'/'2'/'3'，也可能是自定义
  // 'tpl_xxx'。resolveCvTplStyle 对任何脏 id 一路回落到模板1，预览永远不会崩；
  // 版式差异挂在 .cvp-tplN 类（style.css），自定义强调色以 --cvp-accent 内联
  // 在根节点（存储侧已校验，这里再验一道 #RRGGBB，杜绝 style 属性注入）。
  const st = resolveCvTplStyle(tpl || S.cvTpl || '1', S.cvTplItems);
  // 主色优先级：**用户在外观里显式选的主色 > 模板自带的主色**。
  // 「外观」就是用来覆盖模板默认值的，反过来的话调色板点了没反应。
  const styleParts = [];
  if (/^#[0-9a-fA-F]{6}$/.test(st.accent || '')) styleParts.push('--cvp-accent:' + st.accent);
  if (lk.style) styleParts.push(lk.style);
  // esc() 是纵深防御：字体栈已经刻意不带引号了，但将来谁往变量值里塞一个 `"`
  // 就会把整个 style 属性截断（后面的变量全丢），所以这里再过一道。
  const styleAttr = styleParts.length ? ' style="' + esc(styleParts.join(';')) + '"' : '';
  const rootCls = 'cvp cvp-tpl' + st.base + lkCls;
  // 「空简历」= 除了页眉之外没有任何章节输出。原来是 `out.length <= 1`
  //（当时页眉必然被 push，等价于写死「只数到页眉为止」）；现在页眉在
  // 「姓名与头像都被眼睛关掉、又没有联系方式」时整个不输出，所以改成用
  // headPushCount 记账 —— 否则表单全空时会连占位都不显示，白白一张白纸。
  if (out.length <= headPushCount) {
    // 占位句已按用户要求删除（2026-10-13）；元素保留，高度与从前一致。
    return '<div class="' + rootCls + '"' + styleAttr + '>'
      + '<div class="cvp-empty"></div></div>';
  }
  return '<div class="' + rootCls + '"' + styleAttr + '>' + out.join('') + '</div>';
}

/**
 * 保存简历。服务端有「这次保存会不会让某个章节整节消失」的守卫，
 * 被拦下（409）时问过用户再强制写。
 *
 * 三个入口共用这一份逻辑：导出 PDF 前的自动保存、右侧工具条的「AI 润色」写回，
 * 以及（实时保存之前的）「保存并生成 Word」按钮。
 * 只在按钮那里做确认、让 PDF 流程直接写盘的话，用户会在「导出一份 PDF」的
 * 名义下丢掉半个简历——这正是 2026-09-18 那次事故的形态。
 *
 * ⚠️ 实时保存（cvAutoSaveNow）**不走这个函数**：它要的是「409 原样抛出」，
 *    不能在这里弹确认框（用户正在打字）。
 */
async function saveCvForm(form) {
  // 编辑对象是独立版本时（「+ 新建简历」建的空白简历 / 从版本卡进来的定向版本），
  // 保存写回**版本文件**，cv.md 与其它版本都不动 —— 「新建不影响原简历」的落点。
  // 版本没有主简历那条「整节消失」守卫：它保护的是 cv.md。
  const tgt = S.cvEditTarget;
  if (tgt && tgt.kind === 'version') {
    return await api('/api/cv/versions/save', { method: 'POST', body: { id: tgt.id, form } });
  }
  try {
    return await api('/api/cv', { method: 'POST', body: { form } });
  } catch (err) {
    const dropped = err.data && err.data.dropped;
    if (err.status !== 409 || !dropped || !dropped.length) throw err;
    const ok = await confirmDialog({
      title: '这次保存会删掉简历里的章节',
      desc: 'cv.md 里这些章节会整节消失：' + dropped.join('、')
        + '。如果只是表单没读全，先点「用 cv.md 覆盖表单」再改；确实要删就继续。',
      confirmLabel: '仍然保存',
      danger: true,
    });
    if (!ok) throw new Error('已取消保存，cv.md 未改动');
    return await api('/api/cv', { method: 'POST', body: { form, force: true } });
  }
}

// ══ 视图：求职配置 ════════════════════════════════════════
// ══ 简历模板库（2026-09-30）════════════════════════════════
// 「导入模板」弹窗：我的简历页与模板库页共用，只收「上传文件」一种方式
//   （.pdf/.doc/.docx 或图片 png/jpg/webp/bmp/gif，≤20MB，支持拖拽）：
//   本机解析出「标题/字段/占位符/段落」结构（图片走 Windows 自带 OCR 按行
//   识别，标题层级认不出，靠人工校正）→ **先预览识别结果、可逐行校正**
//   → 确认才入库。
// 文件内容不出本机：解析/识别都在本机完成，确认时提交的是结构化数据。
// 导入 ≠ 生效 —— 入库后去「选择模板」里选用，选择权归用户。
// 重复导入：服务端按内容指纹查重（409 duplicate），确认后 force 再入一份。
// onImported(template)：模板库页传「重拉列表重画」，简历页不传（toast 即可）。
const TPL_ROW_LABEL = {
  h1: '标题1（分节）', h2: '标题2（分节）', h3: '小标题',
  field: TPL_KIND_ZH.field, placeholder: TPL_KIND_ZH.placeholder, paragraph: TPL_KIND_ZH.paragraph,
};
const TPL_EDITOR_MAX_ROWS = 150;

// docx 保真模板：带原文件（file.saved）的那部分 —— 模板库页库卡缩略直接渲染
// 原 docx（导入什么样就什么样）；简历页实时预览不再渲染原文件（2026-09-30：
// 原文件文字全在图形文本框里，装不下用户内容），改为表单内容 + 模板色系版式。
// 没有原文件的（内置 1/2/3、pdf/doc/图片导入）仍走 3 套 CSS 版式。S.cvTplItems
// 进库页/简历页都会同步。
function docxTplEntry(tplId) {
  const hit = (S.cvTplItems || []).find((x) => x && x.id === tplId);
  return hit && hit.file && hit.file.saved ? hit : null;
}

/**
 * 按当前选中的 docx 模板导出 Word（2026-10-04）。
 * 与右侧预览**同一条服务端合成管线**（同一份模板副本 + 同一批替换对），
 * 只是出口从 PDF 换成 docx —— 所以「预览长什么样，导出的 Word 就是什么样」。
 * 依赖本机 Word/WPS（COM）；失败由调用方回退到色系版式。
 * @returns {Promise<string>} 提示文案（给 toast）
 */
function openTplOriginalModal() {
  const hit = docxTplEntry(S.cvTpl || '');
  if (!hit) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', '模板原貌');
  mask.innerHTML = '<div class="modal" style="max-width:860px">'
    + '<div class="modal-head"><h3>模板原貌 · ' + esc(hit.name) + '</h3></div>'
    + '<p class="hint">这是模板文件本来的样子（含示例内容）。您的简历内容会按它的色系版式在简历页预览。</p>'
    + '<div class="cvp-docx-host tpl-peek-host" id="cvTplPeekHost"></div>'
    + '<div class="foot"><button class="btn" type="button" data-act="peekClose">关闭</button></div>'
    + '</div>';
  document.body.appendChild(mask);
  const close = wireModal(mask, null);
  mask.querySelector('[data-act="peekClose"]').addEventListener('click', close);
  renderDocxTemplate(mask.querySelector('#cvTplPeekHost'), hit.id, { fit: 'all' }).catch(() => {});
}

// 大 Uint8Array → base64（分块 btoa，避开 apply 参数上限）
function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += btoa(String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)));
  }
  return s;
}

function openCvTplImportModal(onImported) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.setAttribute('role', 'dialog');
  mask.setAttribute('aria-modal', 'true');
  mask.setAttribute('aria-label', '导入自定义模板');
  mask.innerHTML = '<div class="modal" style="max-width:580px">'
    + '<div class="modal-head"><h3>导入自定义模板</h3></div>'

    // ── 上传文件（唯一方式；手动填写版已于 2026-09-30 按需求移除）──
    + '<div id="cvTplFilePane">'
    + '<p class="hint">模板 = 一套版式（基底 + 强调色），<b>不含简历内容</b> —— '
    + '导入后去「选择模板」里选用，简历数据不会被动。</p>'
    + '<p class="hint">支持 <b>PDF / Word（.doc、.docx）</b>或<b>图片（.png/.jpg/.webp/.bmp/.gif）</b>，单个文件 ≤ 20MB。'
    + '文件在本机解析、不上传（图片用 Windows 自带 OCR 识别，约需数秒到数十秒）；'
    + '解析结果先预览校正，确认后才入库。</p>'
    + '<div class="tpl-drop" id="cvTplDrop" tabindex="0" role="button" aria-label="选择或拖入模板文件">'
    + '<input type="file" id="cvTplFile" accept="' + TPL_FILE_ACCEPT + '" style="display:none">'
    + '<b>点击选择或把文件拖到这里</b>'
    + '<span class="hint" style="margin:0">.pdf / .doc / .docx / 图片 · ≤ 20MB</span>'
    + '</div>'
    + '<div class="tpl-prog" id="cvTplProg" style="display:none" role="status">'
    + '<div class="tpl-prog-bar"><i id="cvTplProgBar"></i></div>'
    + '<span class="hint" id="cvTplProgText" style="margin:0">读取文件…</span>'
    + '</div>'
    + '<div class="notice" id="cvTplWarn" style="display:none"><p></p></div>'
    + '<div id="cvTplEditor" style="display:none">'
    + '<p class="hint"><b>识别结果（可校正）</b> —— 改文字、改类型、删掉识别错的行；'
    + '「标题1/2」决定小节划分。确认无误后点下方按钮入库。</p>'
    + '<div class="tpl-rows" id="cvTplRows"></div>'
    + '</div>'
    + '</div>'

    // ── 共用：名称 / 基底 / 强调色 ──
    + '<label class="field"><span>模板名称 <em>30 字以内</em></span>'
    + '<input class="input" id="cvTplName" maxlength="30" placeholder="例如：清爽蓝左线"></label>'
    + '<label class="field"><span>版式基底</span>'
    + '<select class="input" id="cvTplBase">'
    + CV_TPL_BASES.map((b) => '<option value="' + b.base + '">' + esc(b.label) + ' — ' + esc(b.desc) + '</option>').join('')
    + '</select></label>'
    + '<label class="field"><span>强调色 <em>默认跟随主题主色</em></span>'
    + '<span class="tpl-acc-row"><input type="checkbox" id="cvTplAccChk">'
    + '<input type="color" id="cvTplAccent" value="#165DFF" disabled>'
    + '<span class="hint" style="margin:0">勾选后自定强调色</span></span></label>'
    + '<div class="notice bad" id="cvTplErr" style="display:none" role="alert"><b>导入失败</b><p></p></div>'
    + '<div class="foot"><button class="btn" type="button" id="cvTplCancel">取消</button>'
    + '<button class="btn primary" type="button" id="cvTplSave">导入到模板库</button></div></div>';
  document.body.appendChild(mask);
  const close = wireModal(mask);

  const $m = (sel) => $(sel, mask);
  const showErr = (msg, hint) => {
    const box = $m('#cvTplErr');
    box.style.display = '';
    box.querySelector('p').textContent = msg + (hint ? '　' + hint : '');
  };
  const clearErr = () => { $m('#cvTplErr').style.display = 'none'; };

  // ── 强调色 ────────────────────────────────────────────────────────
  const accChk = $m('#cvTplAccChk');
  const accPick = $m('#cvTplAccent');
  accChk.addEventListener('change', () => { accPick.disabled = !accChk.checked; });

  // ── 上传：拖拽 + 选择 + 进度 + 解析 ────────────────────────────────
  // parsed = { file:{name,kind,size}, rows:[{kind,text}] }；rows 可被编辑，
  // 确认时用 tplRowsToStructure 重建结构（与解析时同一套分节规则）。
  let parsed = null;
  const drop = $m('#cvTplDrop');
  const fileInput = $m('#cvTplFile');

  const setProg = (pct, text) => {
    const box = $m('#cvTplProg');
    box.style.display = '';
    $m('#cvTplProgBar').style.width = Math.max(4, Math.min(100, pct)) + '%';
    $m('#cvTplProgText').textContent = text || '处理中…';
  };
  const hideProg = () => { $m('#cvTplProg').style.display = 'none'; };
  const showWarn = (list) => {
    const box = $m('#cvTplWarn');
    if (!list || !list.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.className = 'notice';
    box.querySelector('p').textContent = list.join(' ');
  };

  const renderRows = () => {
    const wrap = $m('#cvTplRows');
    const rows = parsed.rows;
    const shown = rows.length > TPL_EDITOR_MAX_ROWS;
    wrap.innerHTML = rows.slice(0, TPL_EDITOR_MAX_ROWS).map((r, i) => {
      return '<div class="tpl-row">'
        + '<select class="input tpl-row-kind" data-i="' + i + '" aria-label="条目类型">'
        + TPL_ROW_KINDS.map((k) => '<option value="' + k + '"' + (k === r.kind ? ' selected' : '') + '>' + TPL_ROW_LABEL[k] + '</option>').join('')
        + '</select>'
        + '<input class="input tpl-row-text" data-i="' + i + '" value="' + esc(r.text) + '" aria-label="条目文字">'
        + '<button type="button" class="btn sm tpl-row-del" data-i="' + i + '" aria-label="删除这一行">删</button>'
        + '</div>';
    }).join('')
      + (shown ? '<p class="hint">内容较长，编辑器只显示前 ' + TPL_EDITOR_MAX_ROWS + ' 行（共 '
        + rows.length + ' 行）；超出部分不会导入，建议精简文件后重新解析。</p>' : '');
    $$('.tpl-row-kind', wrap).forEach((sel) => sel.addEventListener('change', () => {
      rows[Number(sel.dataset.i)].kind = sel.value;
    }));
    $$('.tpl-row-text', wrap).forEach((inp) => inp.addEventListener('input', () => {
      rows[Number(inp.dataset.i)].text = inp.value;
    }));
    $$('.tpl-row-del', wrap).forEach((btn) => btn.addEventListener('click', () => {
      rows.splice(Number(btn.dataset.i), 1);
      if (!rows.length) { parsed = null; $m('#cvTplEditor').style.display = 'none'; return; }
      renderRows();
    }));
  };

  const handleFile = async (file) => {
    clearErr();
    showWarn(null);
    $m('#cvTplEditor').style.display = 'none';
    parsed = null;
    const pf = tplFilePreflight(file.name, file.size);
    if (pf) { showErr(pf.error); return; }
    const isImg = TPL_IMAGE_EXTS.includes((file.name.split('.').pop() || '').toLowerCase());
    try {
      setProg(6, isImg ? '读取图片…' : '读取文件…');
      const r = await readTplFile(file, (p) => setProg(p, (isImg ? '读取图片 ' : '读取文件 ') + p + '%'));
      let kind, warnings = [], rows;
      if (isImg) {
        // ── 图片模板：本机 Windows OCR ──────────────────────────────
        // 先在浏览器侧压到最长边 2600px（省带宽也快），再以 base64 送
        // 本机服务 /api/tpl/ocr（服务端驱动 Windows 自带 OCR 引擎）。
        setProg(35, '预处理图片（压到适合识别的尺寸）…');
        await new Promise((res) => setTimeout(res, 30));
        let payload = r.bytes;
        try {
          const blob = await downscaleTplImage(r.bytes);
          if (blob) payload = new Uint8Array(await blob.arrayBuffer());
        } catch { /* 压不动（如个别动图帧）就按原图识别 */ }
        const u8 = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
        // OCR 可能十几秒：进度条缓慢爬到 90% 停住，给用户「还在跑」的确定感
        setProg(55, '图片识别中…（本机 OCR，约需数秒到数十秒）');
        let pct = 55;
        const creep = setInterval(() => { pct = Math.min(90, pct + 3); setProg(pct); }, 1500);
        let ocr;
        try {
          let b64 = '';
          for (let i = 0; i < u8.length; i += 0x8000) {
            b64 += btoa(String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)));
          }
          ocr = await api('/api/tpl/ocr', { method: 'POST', body: { dataBase64: b64 } });
        } finally {
          clearInterval(creep);
        }
        const lines = (ocr.lines || []).map((t) => String(t || '').trim()).filter(Boolean);
        if (!lines.length) {
          hideProg();
          showErr('没能从图片里识别出文字。', '换一张更清晰的图片，或改用 PDF / Word 导入。');
          return;
        }
        kind = 'image';
        warnings = ['图片按行识别，标题层级认不出来 —— 请把章节名一行改成「标题1/2」来划分小节。'];
        rows = lines.map((t) => ({ kind: classifyTplItem(t), text: t }));
      } else {
        // ── PDF / Word：浏览器侧解析 ────────────────────────────────
        setProg(100, '解析中…（PDF / Word 逐段提取）');
        // 让进度帧先画上去再进同步解析
        await new Promise((res) => setTimeout(res, 30));
        const pr = await parseTplFile(r.name, r.bytes);
        if (!pr.ok) { hideProg(); showErr(pr.error, pr.hint); return; }
        // 结构拍平成可编辑行（节标题 → h1 行；节内 heading → h3 行）
        kind = pr.kind;
        warnings = pr.warnings;
        rows = [];
        for (const s of pr.structure.sections) {
          if (s.title) rows.push({ kind: 'h1', text: s.title });
          for (const it of s.items) rows.push({ kind: it.kind === 'heading' ? 'h3' : it.kind, text: it.text });
        }
        // docx 保真：原文件字节随确认一并上送（只进本机服务落盘，不出本机）
        // —— 库卡缩略与预览按原文件渲染，导入什么样就什么样。
        const docxB64 = kind === 'docx' ? u8ToB64(r.bytes) : null;
      }
      parsed = { file: { name: r.name, kind, size: r.size }, rows, docxB64 };
      hideProg();
      showWarn(warnings);
      if (!$m('#cvTplName').value.trim()) {
        $m('#cvTplName').value = r.name.replace(/\.[^.]+$/, '').slice(0, 30) || '导入的模板';
      }
      $m('#cvTplEditor').style.display = '';
      renderRows();
    } catch (err) {
      hideProg();
      showErr((err && err.message) || '文件读取失败，请重试。');
    }
  };

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('drag')));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) handleFile(f);
    fileInput.value = '';
  });

  // ── 确认导入 ─────────────────────────────────────────────────────
  const saveBtn = $m('#cvTplSave');
  $m('#cvTplCancel').addEventListener('click', () => close());
  saveBtn.addEventListener('click', async () => {
    clearErr();
    const name = $m('#cvTplName').value;
    const base = $m('#cvTplBase').value;
    const accent = accChk.checked ? accPick.value : '';
    const body = { name, base, accent };
    {
      if (!parsed || !parsed.rows.length) {
        showErr('请先选择并解析一个模板文件。');
        return;
      }
      let structure;
      try {
        structure = tplRowsToStructure(parsed.rows);
      } catch (err) {
        showErr((err && err.message) || '模板结构不合法');
        return;
      }
      body.from = 'file';
      body.file = parsed.file;
      body.structure = structure;
      body.fingerprint = await tplStructureFingerprint(structure);
      // docx 保真：原文件字节随导入一并落盘（服务端魔数校验后存 cv-tpl-files/）
      if (parsed.file.kind === 'docx' && parsed.docxB64) body.docxB64 = parsed.docxB64;
    }
    saveBtn.disabled = true;
    try {
      const r = await api('/api/cv/templates/import', { method: 'POST', body });
      S.cvTplItems = r.items || [];
      close();
      toast('已导入「' + r.template.name + '」（识别 '
        + (r.template.structure ? r.template.structure.sections.length : 0) + ' 个小节）'
        + '，去「选择模板」里选用', 'ok');
      if (typeof onImported === 'function') onImported(r.template);
    } catch (err) {
      const dup = err && err.status === 409 && err.data && err.data.code === 'duplicate' ? err.data : null;
      if (!dup) {
        showErr((err && err.message) || '导入失败，请稍后再试');
        return;
      }
      // 重复导入：同一份内容（指纹一致）已在库里 —— 用户确认后强制再入一份
      //（改完校正结果再导、或故意要多份迭代版本，都是合法诉求）。
      const ok2 = await confirmDialog({
        title: '库里已有相同内容的模板',
        desc: '「' + (dup.existing && dup.existing.name || '') + '」和这次识别的内容一致'
          + '（已导入于 ' + (dup.existing && dup.existing.createdAt
            ? new Date(dup.existing.createdAt).toLocaleString('zh-CN', { hour12: false }) : '之前') + '）。'
          + '仍然再导入一份吗？',
        confirmLabel: '仍要导入',
      });
      if (!ok2) return;
      try {
        const r2 = await api('/api/cv/templates/import', { method: 'POST', body: { ...body, force: true } });
        S.cvTplItems = r2.items || [];
        close();
        toast('已再次导入「' + r2.template.name + '」，去「选择模板」里选用', 'ok');
        if (typeof onImported === 'function') onImported(r2.template);
      } catch (err2) {
        showErr((err2 && err2.message) || '导入失败，请稍后再试');
      }
    } finally {
      saveBtn.disabled = false;
    }
  });
}

// 「简历模板库」：从「我的简历」→「选择模板」进入（不占主导航座位，
// NAV_GROUPS 5 栏 7 项契约不动）。每张卡用同一份样例简历渲染**真实成稿的
// 缩小版** —— 用户选的是看得到的版式，不是一个名字。匿名（自动化探针）
// 也能浏览：内置清单不涉隐私，GET 走全局空间、不会 401 打红自检。
VIEWS.templates = async function (view) {
  let data = null;
  try { data = await api('/api/cv/templates'); } catch { data = null; }
  const items = (data && data.items) || [...BUILTIN_CV_TEMPLATES];
  const selId = (data && data.selected) || S.cvTpl || '1';
  // 同步会话缓存：回简历页后 renderCvVisual 要按这套解析自定义 id。
  S.cvTplItems = items;
  if (data && data.selected) S.cvTpl = data.selected;

  $('#topActions').innerHTML =
    '<button class="btn" id="tplBack">返回我的简历</button>'
    + '<button class="btn primary" id="tplImport">导入模板</button>';

  // 「稳重」系列（2026-10-09）：缩略图走的是**同步**渲染器，而模板源要 fetch。
  // 不先把源取回来，十张缩略图上只会写着「正在载入」。
  await Promise.all(items.filter((t) => wzTpl(t.id)).map((t) => ensureWzSrc(t.id)));

  const cur = resolveCvTplStyle(selId, items);
  view.innerHTML = ''
    + '<div class="notice info"><b>挑一套版式，简历内容一个字都不会动</b>'
    + '<p>模板决定版式，内容永远来自「我的简历」里填的那份，切换模板不会改数据。'
    + '选定后回到「我的简历」，右栏预览立刻切换。</p></div>'
    + '<div class="tpl-grid" id="tplGrid">'
    + items.map((t) => {
        const st = resolveCvTplStyle(t.id, items);
        const isSel = t.id === cur.id;
        const desc = t.desc || (CV_TPL_BASES.find((b) => b.base === st.base) || {}).label || '';
        const docxMode = !!(t.file && t.file.saved);
        const badge = docxMode ? '原版样式'
          : (t.from === 'file' ? '文件导入' : (t.source === 'custom' ? '自定义' : '内置'));
        return '<div class="tpl-card' + (isSel ? ' selected' : '') + '">'
          + '<div class="tpl-thumb' + (docxMode ? ' tpl-thumb-docx' : '') + '" aria-hidden="true">'
          + (docxMode
            ? '<div class="docx-host" data-docx-tpl-id="' + esc(t.id) + '"></div>'
            : renderCvVisual(CV_TPL_SAMPLE_FORM, t.id))
          + '</div>'
          + '<div class="tpl-card-meta">'
          + '<div class="tpl-card-title"><b>' + esc(t.name || '未命名模板') + '</b>'
          + '<span class="badge">' + badge + '</span>'
          + (st.accent ? '<i class="tpl-dot" style="background:' + esc(st.accent) + '" title="强调色 ' + esc(st.accent) + '"></i>' : '')
          + '</div>'
          + (docxMode
            ? '<p class="hint">docx 原文件保真渲染' + (t.from === 'file' ? ' · 来自 ' + esc(t.file.name) : '') + '</p>'
            : (t.from === 'file' && t.file
              ? '<p class="hint">来自 ' + esc(t.file.name) + (t.structure ? ' · ' + t.structure.sections.length + ' 个小节' : '') + '</p>'
              : (desc ? '<p class="hint">' + esc(desc) + '</p>' : '')))
          + '</div>'
          + '<div class="tpl-card-foot">'
          + '<button class="btn' + (isSel ? '' : ' primary') + '" data-tpl-use="' + esc(t.id) + '"'
          + (isSel ? ' disabled' : '') + '>' + (isSel ? '当前使用' : '使用这套') + '</button>'
          + '</div></div>';
      }).join('')
    + '</div>';

  // docx 保真缩略懒渲染：进入视口才渲染原文件（103 份全量渲不可接受），
  // 渲染过的进模块缓存 —— 切换/回看毫秒级。失败回落 CSS 版式，不空白。
  const docxHosts = $$('[data-docx-tpl-id]', view);
  if (docxHosts.length && isDocxRendererReady()) {
    const io = new IntersectionObserver((ents) => {
      ents.forEach((en) => {
        if (!en.isIntersecting) return;
        const host = en.target;
        io.unobserve(host);
        renderDocxTemplate(host, host.dataset.docxTplId, { fit: 'firstPage' }).then((r) => {
          if (!r.ok && r.error !== 'stale') {
            host.innerHTML = renderCvVisual(CV_TPL_SAMPLE_FORM, host.dataset.docxTplId);
            host.classList.add('docx-fallback');
          }
        }).catch(() => {});
      });
    }, { rootMargin: '320px' });
    docxHosts.forEach((h) => io.observe(h));
  }

  $('#tplBack').addEventListener('click', () => go('cv'));
  $('#tplImport').addEventListener('click', () => openCvTplImportModal(() => {
    // 导入成功后重拉列表重画 —— 但只在用户还停在模板库页时（可能中途跳走了）
    if ((location.hash.slice(1) || 'home') === 'templates') VIEWS.templates(view);
  }));

  // 事件委托挂在 #tplGrid 上（导入回调可能整卡区重画，节点会换）。
  // 选择成功 → 服务端持久化 + 会话同步 → 回简历页，预览立刻按新模板重排。
  $('#tplGrid').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tpl-use]');
    if (!b || b.disabled) return;
    try {
      const r = await api('/api/cv/templates/select', { method: 'POST', body: { id: b.dataset.tplUse } });
      S.cvTpl = r.selected || b.dataset.tplUse;
      S.cvTplItems = r.items || S.cvTplItems;
      const hit = (r.items || []).find((x) => x.id === S.cvTpl);
      toast('已选用「' + ((hit && hit.name) || S.cvTpl) + '」，正在回到「我的简历」', 'ok');
      go('cv');
    } catch (err) {
      toast((err && err.message) || '选择失败，请稍后再试', 'bad');
    }
  });
};

VIEWS.profile = async function (view) {
  const [prof, portals] = await Promise.all([api('/api/profile'), api('/api/portals')]);
  S.profile = prof;
  S.portals = portals;
  const p = prof.parsed || {};
  const get = (path, dflt) => {
    const v = path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), p);
    return v == null ? (dflt === undefined ? '' : dflt) : v;
  };

  $('#topActions').innerHTML = '<button class="btn primary" id="pfSave">保存配置</button>';

  const f = (path, label, hint) => '<label class="field"><span>' + esc(label)
    + (hint ? ' <em>' + esc(hint) + '</em>' : '') + '</span>'
    + '<input class="input" data-scalar="' + path + '" value="' + esc(get(path)) + '"></label>';

  const area = (path, label, hint, rows) => '<label class="field"><span>' + esc(label)
    + (hint ? ' <em>' + esc(hint) + '</em>' : '') + '</span>'
    + '<textarea class="textarea" data-list="' + path + '" style="min-height:' + ((rows || 3) * 24 + 20) + 'px">'
    + esc((Array.isArray(get(path)) ? get(path) : []).join('\n')) + '</textarea></label>';

  const tier = get('spend_tier', 'standard');

  view.innerHTML =
    '<div class="notice bad" id="pfError" style="display:none" role="alert">'
    + '<span class="notice-ico" aria-hidden="true">' + icon('alert') + '</span>'
    + '<div class="notice-body"><b>保存失败</b><p></p>'
    + '<p>配置文件是全部评估的事实来源，写入前会重新解析一遍 —— 产生非法 YAML 时会被拒绝，磁盘上的原文件不受影响。</p>'
    + '</div></div>'
    + '<div class="card"><h2>求职目标</h2>'
    + '<p class="hint">这些字段直接决定 AI 怎么给你打分。改了不保存等于没改。</p>'
    + '<div class="grid2">'
    + f('candidate.full_name', '姓名')
    + f('candidate.email', '邮箱')
    + f('candidate.phone', '手机')
    + f('candidate.location', '所在城市', '会印在简历页眉上')
    + '</div>'
    + area('target_roles.primary', '目标岗位', '一行一个，越靠前权重越高', 3)
    + '</div>'

    + '<div class="card"><h2>个人叙事</h2>'
    + '<p class="hint">AI 会把这些内容当作你的「求职人设」，用来判断岗位契合度和写定制材料。</p>'
    + f('narrative.headline', '一句话定位', '例如：数据科学应届生，专注机器学习落地')
    + '<label class="field"><span>你的故事</span>'
    + '<textarea class="textarea" data-scalar="narrative.exit_story" style="min-height:76px">' + esc(get('narrative.exit_story')) + '</textarea></label>'
    + area('narrative.superpowers', '核心优势', '一行一个', 4)
    + '</div>'

    + '<div class="card"><h2>身份与地点 —— 资格检查的依据</h2>'
    + '<div class="notice info"><b>这一组字段决定「这个岗位能不能投」</b>'
    + '<p>国内招聘是门槛制：学历、专业、城市、工作年限（校招另看届次），任一条不满足就直接判「资格不符」，'
    + '不打分、不生成定制简历。判据全部来自下面这些字段，所以填准比填多重要。</p></div>'
    + '<div class="grid2">'
    + '<label class="field"><span>学历层次 <em>资格检查第 1 条</em></span>'
    + '<select class="select" data-scalar="location.degree_level">'
    + ['大专', '本科', '硕士', '博士']
      .map((v) => '<option value="' + v + '"' + (get('location.degree_level') === v ? ' selected' : '') + '>' + v + '</option>').join('')
    + '</select></label>'
    + f('location.graduation_year', '毕业年份', '只填年份，如 2027；已毕业填毕业那一年')
    + f('location.city', '目标城市', '主要想去的城市，用于报告里的地点判断')
    + '<label class="field"><span>是否接受要求经验的岗位 <em>校招/社招的分界</em></span>'
    + '<select class="select" data-scalar="location.accept_experienced_roles">'
    + [['false', '不接受（要求 X 年经验的岗位一律判资格不符）'],
      ['true', '接受（有经验要求的岗位也投）']]
      .map(([v, l]) => '<option value="' + v + '"' + (String(get('location.accept_experienced_roles')) === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('')
    + '</select></label>'
    + '</div>'
    + area('location.acceptable_cities', '可接受的城市', '一行一个。不在这张清单里的城市 → 直接判资格不符，所以别写太窄', 7)
    + area('location.acceptable_majors', '允许的专业要求', '一行一个。JD 不写专业限制时无论这里写什么都通过', 6)
    + '</div>'

    + '<div class="card"><h2>薪资（仅参考，不参与评分）</h2>'
    + '<div class="notice warn"><b>国内薪资不参与打分</b>'
    + '<p>国内 JD 普遍不披露薪资，校招岗位常按城市 + 学历统一定级、谈薪空间小。'
    + '按欧美标准「薪资缺失就扣分」会把大量优质国内岗位压到门槛线下，所以这里只用于报告里的陈述。</p></div>'
    + '<div class="grid2">'
    + f('compensation.target_range', '期望薪资区间', '填大致范围即可，不要纠结')
    + f('compensation.currency', '币种')
    + '</div>'
    + '<p class="hint">岗位地点写在上面那张城市清单里，不要写在这里。</p>'
    + '</div>'

    + '<div class="card"><h2>语言与模型</h2>'
    + '<div class="grid2">'
    + '<label class="field"><span>输出语言 <em>控制报告/简历/求职信用什么语言写</em></span>'
    + '<select class="select" data-scalar="language.output">'
    + ['zh-CN', 'en'].map((v) => '<option value="' + v + '"' + (get('language.output', 'en') === v ? ' selected' : '') + '>'
      + (v === 'zh-CN' ? '简体中文（zh-CN，同时启用中文 PDF 排版）' : 'English (en)') + '</option>').join('')
    + '</select></label>'
    + '<label class="field"><span>市场模式 <em>决定按哪个市场的规则判断</em></span>'
    + '<select class="select" data-scalar="language.modes_dir">'
    + '<option value=""' + (!get('language.modes_dir') ? ' selected' : '') + '>默认（英文模式，海外市场）</option>'
    + '<option value="modes/zh"' + (get('language.modes_dir') === 'modes/zh' ? ' selected' : '') + '>中国大陆模式（modes/zh）</option>'
    + '</select></label>'
    + '<label class="field"><span>模型花费档位</span>'
    + '<select class="select" data-scalar="spend_tier">'
    + [['economy', 'economy —— 最便宜最快，适合大量筛岗'],
      ['standard', 'standard —— 平衡（默认）'],
      ['premium', 'premium —— 最强，适合特别在意的岗位']]
      .map(([v, l]) => '<option value="' + v + '"' + (tier === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('')
    + '</select></label>'
    + '<label class="field"><span>简历 PDF 模板</span>'
    + '<select class="select" data-scalar="cv.template">'
    + [['', '默认'], ['zh-minimal', 'zh-minimal（中文极简）'], ['modern', 'modern'], ['compact', 'compact'], ['executive', 'executive'], ['leadership', 'leadership'], ['jake', 'jake']]
      .map(([v, l]) => '<option value="' + v + '"' + (get('cv.template') === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('')
    + '</select></label>'
    + '</div>'
    + '<div class="notice info" style="margin-top:6px"><b>关于中文模式</b>'
    + '<p>输出语言设为 zh-CN 后，报告、简历、文案全部用中文写，并启用中文 PDF 排版（标点、断行）。</p>'
    + '<p>「市场模式」保持<b>默认</b>即可 —— 中国大陆的招聘规则（评分体系、文化信号、硬门槛、投递流程）'
    + '已经写在 <code>modes/_profile.md</code> 里，它的优先级高于任何语言包，不需要再切 modes/zh。</p></div>'
    + '</div>'

    + '<div class="card"><h2>岗位源配置 <span class="badge">' + (portals.companies || 0) + ' 家公司</span></h2>'
    + '<div class="notice warn"><b>国内求职用不上这一页</b>'
    + '<p>内置岗位源全是海外招聘系统（Greenhouse / Lever / Ashby / Workday 等），'
    + '<b>不包含牛客、BOSS直聘、应届生、拉勾、猎聘</b>。国内岗位请按「<b>使用帮助</b>」页里的渠道清单手动找，'
    + '找到后把 JD 粘到「评估岗位」页。'
    + '这一页保留给需要投外企 / 海外岗位的情况。</p></div>'
    + '<details><summary style="cursor:pointer;font-size:13px;color:var(--accent)">展开编辑 portals.yml 原文</summary>'
    + '<textarea class="textarea md" id="ptRaw" style="margin-top:12px">' + esc(portals.raw) + '</textarea>'
    + '<button class="btn primary" id="ptSave" style="margin-top:10px">保存 portals.yml</button></details>'
    + '</div>'

    + '<div class="card"><h2>profile.yml 原文</h2>'
    + '<p class="hint">上面的表单只覆盖常用字段。这里可以直接看完整文件（注释会被保留）。</p>'
    + '<pre class="log" style="max-height:340px">' + esc(prof.raw) + '</pre>'
    + (prof.parseError ? '<div class="notice bad" style="margin-top:12px"><b>YAML 解析失败</b><p>' + esc(prof.parseError) + '</p></div>' : '')
    + '</div>';

  $('#pfSave').addEventListener('click', async () => {
    const btn = $('#pfSave');
    const scalars = {}, lists = {};
    $$('[data-scalar]', view).forEach((el) => { scalars[el.dataset.scalar] = el.value; });
    $$('[data-list]', view).forEach((el) => { lists[el.dataset.list] = linesToArr(el.value); });
    busy(btn, true, '保存中…');
    try {
      const r = await api('/api/profile', { method: 'POST', body: { scalars, lists } });
      if (r.parseError) throw new Error('保存后 YAML 解析失败：' + r.parseError);
      S.profile = r;
      toast('配置已保存', 'ok');
      route();
    } catch (err) {
      // 配置写坏会影响全部评估，错误要留在页面上而不只是闪一下
      toast(err.message, 'bad');
      const box = $('#pfError');
      if (box) { box.style.display = ''; box.querySelector('p').textContent = err.message; }
      busy(btn, false);
    }
  });

  const ptSave = $('#ptSave');
  if (ptSave) {
    ptSave.addEventListener('click', async () => {
      busy(ptSave, true, '保存中…');
      try {
        await api('/api/portals', { method: 'POST', body: { raw: $('#ptRaw').value } });
        toast('portals.yml 已保存', 'ok');
      } catch (err) {
        toast(err.message, 'bad');
        busy(ptSave, false);
      }
    });
  }
};

// ══ 视图：工具箱 ══════════════════════════════════════════
const GROUP_LABEL = {
  diagnose: '诊断 · 检查数据是否健康',
  maintain: '维护 · 修复与整理数据',
  analyze:  '分析 · 从已有数据里找规律',
  query:    '查询 · 按条件找记录',
  action:   '执行 · 抓取岗位信息',
  cv:       '简历与投递材料',
};

// 分组展示顺序（与后端返回顺序无关，保证页面稳定）
const GROUP_ORDER = ['diagnose', 'analyze', 'action', 'cv', 'query', 'maintain'];

/** 渲染某个参数的表单控件。 */
function renderParam(p, idx) {
  const id = 'p_' + idx + '_' + p.name;
  const req = p.required ? '<span class="req" title="必填">*</span>' : '';
  // multi（一批链接这类）独占整行，其余参数在宽屏下并排两列
  const cls = 'param' + (p.type === 'checkbox' ? ' chk' : '') + (p.multi ? ' wide' : '');
  let ctrl;
  if (p.type === 'checkbox') {
    ctrl = '<input type="checkbox" id="' + id + '" data-param="' + esc(p.name) + '"'
      + (p.default === true || p.default === 'true' ? ' checked' : '') + '>'
      + '<label for="' + id + '">' + esc(p.hint || p.label) + req + '</label>';
    return '<div class="' + cls + '">' + ctrl + '</div>';
  }
  ctrl = '<input class="input" type="text" id="' + id + '" data-param="' + esc(p.name) + '"'
    + (p.pattern ? ' data-pattern="' + esc(p.pattern) + '"' : '')
    + ' placeholder="' + esc(p.hint || '') + '"'
    + ' value="' + esc(p.default || '') + '"'
    + ' autocomplete="off" spellcheck="false">';
  return '<div class="' + cls + '">'
    + '<label for="' + id + '">' + esc(p.label) + req + '</label>' + ctrl
    + (p.hint ? '<p class="param-hint">' + esc(p.hint) + '</p>' : '') + '</div>';
}

/**
 * 工具面板的 HTML（**只产字符串，不绑定事件**）。
 *
 * 渲染与绑定拆开，是为了让面板能插进折叠区或卡片内部（「简历工具」页就是这么用的）：
 * 它必须和「全部脚本」页共用同一份渲染逻辑 —— 各写一份的话，参数表单、徽标、
 * 空分组这些细节迟早会走形，而且是那种「只有一边对」的走形。
 */
function toolPanelHtml(scripts, filterGroups) {
  const groups = {};
  scripts.forEach((s) => {
    if (filterGroups && !filterGroups.includes(s.group)) return;
    (groups[s.group] = groups[s.group] || []).push(s);
  });

  const ordered = GROUP_ORDER.filter((g) => groups[g])
    .concat(Object.keys(groups).filter((g) => !GROUP_ORDER.includes(g)));

  const shown = ordered.reduce((n, g) => n + groups[g].length, 0);

  return '<div class="notice info"><b>' + (
      filterGroups
        ? '本页共 ' + shown + ' 个脚本'
        : '共 ' + shown + ' 个本地脚本，全部零 token、不消耗 AI 额度'
    ) + '</b>'
    + '<p>需要填参数的脚本会展开表单。输出显示在页面底部。</p></div>'

    + ordered.map((g) => {
      const list = groups[g];
      return '<div class="card"><div class="card-head"><span class="card-title">'
        + esc(GROUP_LABEL[g] || g) + '</span>'
        + '<span class="badge">' + list.length + '</span></div>'
        + '<div class="tools-grid">' + list.map((s) => {
          const hasParams = s.params && s.params.length;
          return '<div class="tool' + (hasParams ? ' has-params' : '') + '" data-tool="' + esc(s.key) + '">'
            + '<h4>' + esc(s.label)
            + (s.slow ? ' <span class="badge warn">较慢</span>' : '')
            + (hasParams ? ' <span class="badge">需填参数</span>' : '')
            + '</h4>'
            + '<p>' + esc(s.desc) + '</p>'
            + (hasParams
              ? '<div class="param-grid" data-params="' + esc(s.key) + '">'
                + s.params.map((p, i) => renderParam(p, i)).join('')
                + '</div>'
              : '')
            + '<div class="tool-foot">'
            + '<button class="btn sm" type="button" data-run="' + esc(s.key) + '"'
            + ' aria-label="运行脚本：' + esc(s.label) + '">运行</button>'
            + '</div></div>';
        }).join('')
        + '</div></div>';
    }).join('')

    + '<div class="card" id="logCard"><div class="card-head">'
    + '<span class="card-title">运行输出</span>'
    + '<button class="btn sm ghost" type="button" id="clearLog">清空</button></div>'
    + '<p class="hint" id="logHint" role="status" aria-live="polite">点上面的「运行」按钮，结果显示在这里。</p>'
    + '<p class="hint" id="invokedHint" style="display:none"></p>'
    + '<pre class="log" id="toolLog" style="display:none"></pre></div>';
}

/**
 * 绑定工具面板的交互。参数是 scripts 而不是从闭包里取 ——
 * 现在有两个调用方（「全部脚本」整页、「简历工具」按 `['cv']` 过滤后），
 * 闭包取不到对方的作用域。
 */
function bindToolPanel(view, scripts) {
  $('#clearLog')?.addEventListener('click', () => {
    const log = $('#toolLog');
    log.textContent = '';
    log.style.display = 'none';
    $('#invokedHint').style.display = 'none';
    $('#logHint').textContent = '已清空。点上面的「运行」按钮重新执行。';
  });

  $$('[data-run]', view).forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.run;
    const meta = scripts.find((s) => s.key === key) || {};
    const log = $('#toolLog');
    const hint = $('#logHint');
    const invHint = $('#invokedHint');

    // ── 收集并校验参数 ───────────────────────────────────────────
    const params = {};
    const wrap = $('[data-params="' + key + '"]', view);
    if (wrap) {
      let bad = null;
      $$('[data-param]', wrap).forEach((el) => {
        const name = el.dataset.param;
        const val = el.type === 'checkbox' ? el.checked : el.value.trim();
        params[name] = val;
        const spec = (meta.params || []).find((p) => p.name === name);
        if (spec && spec.required && (val === '' || val === false) && !bad) {
          bad = '请填写「' + spec.label + '」';
          el.classList.add('field-bad');
        } else if (spec && spec.pattern && val && !new RegExp(spec.pattern).test(String(val))) {
          if (!bad) bad = '「' + spec.label + '」格式不合法';
          el.classList.add('field-bad');
        } else {
          el.classList.remove('field-bad');
        }
      });
      if (bad) {
        log.style.display = 'block';
        log.textContent = '✖ ' + bad;
        hint.innerHTML = '<b style="color:var(--bad-ink)">参数校验未通过。</b>请检查高亮的输入框。';
        invHint.style.display = 'none';
        return;
      }
    }

    log.style.display = 'block';
    log.textContent = '正在运行 ' + (meta.label || key) + ' …';
    invHint.style.display = 'none';
    hint.innerHTML = '<span class="spinner" aria-hidden="true"></span> 执行中'
      + (meta.slow ? '，这一步可能要几十秒到几分钟' : '') + '…';
    busy(b, true, '运行中…');
    try {
      // 扫岗等脚本可能跑很久，给 10 分钟
      const r = await api('/api/run', {
        method: 'POST', timeout: 600000, body: { key, params },
      });
      const body = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
      log.textContent = body || '（无输出）';
      if (r.invoked) {
        invHint.style.display = 'block';
        invHint.innerHTML = '实际执行：<code>node ' + esc(r.invoked) + '</code>';
      }
      if (r.timeout) {
        hint.innerHTML = '<b style="color:var(--bad-ink)">超时被中断。</b>这类脚本建议在终端里跑。';
      } else if (r.ok) {
        hint.innerHTML = '<b style="color:var(--ok-ink)">执行完成</b>，耗时 '
          + (r.ms / 1000).toFixed(1) + ' 秒。';
      } else {
        hint.innerHTML = '<b style="color:var(--bad-ink)">退出码 ' + r.code + '</b>，输出见下。'
          + '不一定是错误——有些脚本用非零退出码表示「发现了问题」。';
      }
      // 可能改变数据的脚本，清掉缓存让其他页面重新拉取
      if (['scan', 'scanhn', 'scanfull', 'verify', 'doctor', 'normalize', 'dedup',
        'merge', 'reconcile', 'archive'].includes(key)) {
        S.stats = null;
      }
    } catch (err) {
      log.textContent = '✖ ' + err.message;
      hint.innerHTML = '<b style="color:var(--bad-ink)">执行失败。</b>';
    } finally {
      busy(b, false);
    }
  }));
}

/**
 * 渲染整页工具面板。filterGroups 为 null 时显示全部分组，否则只显示指定分组。
 * = 「全部脚本」页（null）与「简历工具」页（['cv']）共用。
 */
function renderToolPanel(view, scripts, filterGroups) {
  view.innerHTML = toolPanelHtml(scripts, filterGroups);
  bindToolPanel(view, scripts);
}

// 「账号安全中心」：从身份胶囊的「系统设置」菜单进入（2026-09-27）。
// 自助改密走 /api/auth/change-password（旧密码必须验对，服务端另加盐重存）；
// 账号信息从 /api/auth/me 现拉（它带注册时间与上次登录）。
VIEWS.security = async function (view) {
  // 未登录（或自动化探针的匿名跑）不发注定 401 的请求 —— 浏览器会把
  // 401 记进控制台错误，自检会被它打红；给一句引导即可。
  if (!S.session) {
    view.innerHTML = '<div class="card"><h2>账号安全中心</h2>'
      + '<p class="hint">请先登录：点右上角「登录」进入登录页，登录后这里会显示'
      + '账号信息与修改密码。</p></div>';
    return;
  }
  let me = {};
  try { me = await api('/api/auth/me'); } catch { /* 会话过期等：展示空值即可 */ }

  const s = S.session || {};
  const row = (k, v) => '<div class="sec-row"><span class="k">' + esc(k) + '</span>'
    + '<span class="v">' + esc(v || '—') + '</span></div>';
  const fmt = (iso) => {
    try { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : ''; } catch { return String(iso || ''); }
  };

  view.innerHTML =
    '<div class="card"><h2>账号信息</h2>'
    + '<p class="hint">这一份身份存在本机 <code>data/users.json</code> 里 —— 本地优先，不出本机。</p>'
    + row('用户名', me.username || s.username)
    + row('昵称', me.name || s.name)
    + row('身份', (me.role || s.role) === 'admin' ? '管理员' : '用户端')
    + row('注册时间', fmt(me.createdAt))
    + row('上次登录', fmt(me.lastLogin))
    + '</div>'

    + '<div class="card"><h2>修改密码</h2>'
    + '<p class="hint">改密要先验对当前密码；新密码至少 6 位。改完当前登录会话仍然有效，其他端下次登录用新密码。</p>'
    + '<div class="notice bad" id="secError" style="display:none" role="alert"><b>改密失败</b><p></p></div>'
    + '<div class="grid2">'
    + '<label class="field"><span>当前密码</span><input class="input" id="secOld" type="password" autocomplete="current-password"></label>'
    + '<label class="field"><span>新密码 <em>至少 6 位</em></span><input class="input" id="secNew" type="password" autocomplete="new-password"></label>'
    + '<label class="field"><span>确认新密码</span><input class="input" id="secNew2" type="password" autocomplete="new-password"></label>'
    + '</div>'
    + '<button class="btn primary" id="secSave" type="button">更新密码</button>'
    + '</div>'

    + '<div class="card"><h2>会话安全</h2>'
    + '<p class="hint">登录会话保存在服务端内存里，<b>控制台进程重启即全部失效</b>；'
    + '本机的登录凭证只存在这台电脑的浏览器会话里，不落盘、不同步。</p>'
    + '<button class="btn danger" id="secLogout" type="button">退出登录（本机）</button>'
    + '</div>';

  $('#secLogout').addEventListener('click', () => doLogout());

  $('#secSave').addEventListener('click', async () => {
    const errBox = $('#secError');
    errBox.style.display = 'none';
    const oldPassword = $('#secOld').value;
    const newPassword = $('#secNew').value;
    const again = $('#secNew2').value;
    const fail = (m) => { errBox.style.display = ''; errBox.querySelector('p').textContent = m; };
    if (!oldPassword) return fail('先填当前密码。');
    if (newPassword.length < 6) return fail('新密码至少 6 位。');
    if (newPassword !== again) return fail('两次输入的新密码不一致。');
    const btn = $('#secSave');
    btn.disabled = true;
    btn.textContent = '更新中…';
    try {
      await api('/api/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } });
      $('#secOld').value = '';
      $('#secNew').value = '';
      $('#secNew2').value = '';
      toast('密码已更新');
    } catch (e) {
      fail(e.message || '改密失败，稍后再试。');
    } finally {
      btn.disabled = false;
      btn.textContent = '更新密码';
    }
  });
};

// 「全部脚本」与「简历工具」两页共用同一套面板渲染
// （原先是三处，第三处「数据洞察」已随该页整体下线）
// 「全部脚本」页。评估页改成 mockup 版式（只有上传 + JD + 报告三张卡）之后，
// AI 引擎卡与批量初筛这两件「评估基础设施」迁到这里：引擎怎么选、批量怎么跑
// 都是「配置/工具」性质的动作，本来就不该占评估页的版面。
VIEWS.tools = async function (view) {
  // 引擎状态 + 门槛分在这里拉：引擎卡要显示，批量复制 Markdown 要门槛分色。
  let ai = { available: false, cli: '', threshold: null };
  try { ai = await api('/api/ai-status'); } catch { /* 降级为不可用 */ }
  S.aiEngine = ai && ai.engines ? ai : null;
  S.evalThreshold = ai.threshold != null ? Number(ai.threshold) : null;

  const scripts = await api('/api/scripts');
  S.scripts = scripts;

  // 引擎卡 + 批量初筛在前，脚本工具面板接在后面
  const s = evalSession();
  view.innerHTML =
    '<div class="card" id="aiEngineCard">' + aiEngineCardHtml() + '</div>'
    + batchCardHtml(s);

  wireAiEngineCard();
  wireEvalBatch();

  const panel = document.createElement('div');
  view.appendChild(panel);
  renderToolPanel(panel, scripts, null);
};

// ── 求职信（求职信 / 自荐信 / 网申开放题）───────────────────────────────
//
// 规则来源是系统层的 modes/cover.md（服务端读、整份内联进 prompt）。
// 这里只做「收输入 → 调 /api/cover → 显示稿子」，**不做写回**：
// 求职信的下一站是邮件正文或网申文本框，落盘没有用；更要紧的是别让人把
// AI 稿误当成「已经发出去了」的记录（与简历优化同一条规矩：只出稿）。
function coverState() {
  if (!S.cover) {
    S.cover = {
      company: '', role: '', jd: '', question: '', target: '',
      output: '', log: '', running: false, runId: 0, cvLabel: '',
      hint: '填上公司和 JD，点「生成求职信」。用哪份简历可以选 —— 按岗位定制过的版本通常更贴。',
    };
  }
  return S.cover;
}

function coverCardHtml(c) {
  const list = versionsOf().length ? versionsOf() : [{ id: 'base', name: '原版简历', base: true }];
  const opts = list.map((v) => '<option value="' + esc(v.id) + '"'
    + (v.id === (c.target || 'base') ? ' selected' : '') + '>'
    + esc(v.base ? '原版简历（cv.md）' : v.name + (v.targetRole ? ' · ' + v.targetRole : ''))
    + '</option>').join('');

  return '<div class="card" id="clCard">'
    + '<div class="card-head"><span class="card-title">生成求职信</span>'
    + '<span class="badge info">只出稿，不会自动保存</span></div>'
    + '<p class="hint">按岗位写一封能直接发出去的求职信（规则来自 <code>modes/cover.md</code>：'
    + '不许编造、不许写空话、每段都贴着这个岗位的要求）。'
    + '国内网申常要求的开放题，填在下面可以一起生成。</p>'

    + '<div class="row">'
    + '<label class="field"><span>公司 <em>选填</em></span>'
    + '<input class="input" id="clCompany" autocomplete="off" placeholder="例如：某某科技"></label>'
    + '<label class="field"><span>岗位 <em>选填</em></span>'
    + '<input class="input" id="clRole" autocomplete="off" placeholder="例如：后端开发工程师"></label>'
    + '</div>'

    + '<label class="field"><span>岗位 JD <em>必填，求职信要贴着它写</em></span>'
    + '<textarea class="textarea" id="clJd" rows="8" spellcheck="false" '
    + 'placeholder="把这个岗位的 JD 整段粘进来（职责 + 任职要求）"></textarea></label>'

    + '<label class="field"><span>网申开放题 <em>选填</em></span>'
    + '<input class="input" id="clQuestion" autocomplete="off" '
    + 'placeholder="例如：为什么选择我们公司 / 你最大的优势是什么"></label>'

    + '<label class="field"><span>用哪份简历 <em>默认原版</em></span>'
    + '<select class="input" id="clTarget">' + opts + '</select></label>'

    + '<div class="row tight">'
    + '<button class="btn primary" id="clGo">生成求职信</button>'
    + '<button class="btn ghost" id="clCopy" style="display:none">复制正文</button>'
    + '<button class="btn ghost" id="clClear">清空</button>'
    + '</div>'
    + '<p class="hint" id="clHint" role="status" aria-live="polite">' + esc(c.hint) + '</p>'
    + '<pre class="log" id="clLog" style="display:none"></pre>'
    + '<div id="clOut"></div>'
    + '</div>';
}

/** 会话 → DOM。不在本页时直接返回（异步回来时用户可能已经切走了）。 */
function paintCover() {
  const hint = $('#clHint');
  if (!hint) return;
  const c = coverState();

  hint.className = 'hint';
  hint.innerHTML = c.hint;

  const go = $('#clGo');
  if (go) {
    go.disabled = !!c.running;
    go.textContent = c.running ? '写着呢…' : '生成求职信';
  }
  const copy = $('#clCopy');
  if (copy) copy.style.display = c.output ? '' : 'none';

  const log = $('#clLog');
  if (log) {
    log.style.display = c.log ? '' : 'none';
    log.textContent = c.log || '';
  }
  const out = $('#clOut');
  if (out) {
    out.innerHTML = c.output
      ? '<div class="md" style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">'
        + mdToHtml(c.output) + '</div>'
      : '';
  }
}

async function runCover() {
  const c = coverState();
  if (c.running) return;
  if (!c.jd.trim()) {
    c.hint = '<b style="color:var(--bad-ink)">先把 JD 粘进来。</b>'
      + '求职信的价值全在「贴着这个岗位写」——没有 JD 就只能生成通用信，'
      + '而通用信在校招里基本等于减分项。';
    paintCover();
    const box = $('#clJd');
    if (box && box.focus) box.focus();
    return;
  }

  c.running = true;
  c.log = '';
  // 提示句已按用户要求删除（2026-10-12），只留转圈（按钮同时显示「生成中…」）
  c.hint = '<span class="spinner" aria-hidden="true"></span>';
  paintCover();
  const myRun = ++c.runId;

  try {
    const r = await api('/api/cover', {
      method: 'POST',
      timeout: 660000,
      body: {
        jd: c.jd, company: c.company, role: c.role,
        question: c.question, target: c.target || 'base',
      },
    });
    if (myRun !== c.runId) return;              // 期间点了清空或又点了一次
    if (!r.ok) {
      c.hint = '<b style="color:var(--bad-ink)">'
        + esc(r.friendly || ('AI 退出码 ' + r.code)) + '</b>';
      c.log = [r.output, r.stderr].filter(Boolean).join('\n').trim();
      paintCover();
      return;
    }
    c.output = r.output || '';
    c.cvLabel = r.cvLabel || '';
    c.log = [r.stderr].filter(Boolean).join('\n').trim();
    c.hint = '<b style="color:var(--ok-ink)">写好了</b>（用的是'
      + esc(r.cvLabel || '原版 cv.md') + '，耗时 ' + Math.round((r.ms || 0) / 1000) + ' 秒）。'
      + '正文照着改一改再发 —— <b>AI 只出稿，发不发、怎么改由你决定。</b>';
    paintCover();
    toast('求职信已生成', 'ok');
  } catch (err) {
    if (myRun !== c.runId) return;
    c.hint = '<b style="color:var(--bad-ink)">请求失败。</b>'
      + '求职信这种长文生成本来就慢，超时后可以过一会儿再试一次，或改成短一点的 JD。';
    c.log = '✖ ' + err.message;
    paintCover();
  } finally {
    if (myRun === c.runId) { c.running = false; paintCover(); }
  }
}

/** 绑定 + 恢复。每次进这一页都要跑一遍（视图是重建的）。 */
function wireCoverCard() {
  const c = coverState();
  const bind = (sel, key) => {
    const el = $(sel);
    if (!el) return null;
    el.value = c[key] || '';
    el.addEventListener('input', () => { c[key] = el.value; });
    return el;
  };
  bind('#clCompany', 'company');
  bind('#clRole', 'role');
  bind('#clJd', 'jd');
  bind('#clQuestion', 'question');
  const sel = $('#clTarget');
  if (sel) {
    sel.value = c.target || 'base';
    sel.addEventListener('change', () => { c.target = sel.value; });
  }

  const go = $('#clGo');
  if (go) go.addEventListener('click', () => { runCover(); });

  const copy = $('#clCopy');
  if (copy) {
    copy.addEventListener('click', () => {
      if (!c.output) return;
      const done = () => toast('求职信正文已复制', 'ok');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(c.output).then(done, () => toast('复制失败，请手动框选', 'warn'));
      } else {
        toast('这个浏览器不支持自动复制，手动框选吧', 'warn');
      }
    });
  }

  const clear = $('#clClear');
  if (clear) {
    clear.addEventListener('click', () => {
      c.runId += 1;                       // 让在跑的这次作废
      c.running = false; c.output = ''; c.log = ''; c.cvLabel = '';
      c.company = ''; c.role = ''; c.jd = ''; c.question = '';
      c.hint = '填上公司和 JD，点「生成求职信」。';
      $$('#clCard input, #clCard textarea').forEach((el) => { el.value = ''; });
      if (sel) sel.value = c.target || 'base';
      paintCover();
    });
  }

  paintCover();
}

VIEWS.cvkit = async function (view) {
  const scripts = await api('/api/scripts');
  S.scripts = scripts;
  // 求职信要选「用哪份简历」，版本列表走和评估页同一个缓存
  await refreshVersions();
  renderToolPanel(view, scripts, ['cv']);
  // 版本卡从「我的简历」页迁过来（2026-09-23 版式重构，参照设计稿 简历编辑.html）：
  // 编辑页只管编辑，版本管理集中在工具页。afterbegin 让它排在面板最上面 ——
  // 版本操作（AI 优化除外）都在本页完成；点「AI 优化」由 wireVersionsCard 跳去简历页。
  view.insertAdjacentHTML('afterbegin', cvVersionsCard());
  wireVersionsCard(view);
  view.insertAdjacentHTML('beforeend', coverCardHtml(coverState()));
  wireCoverCard();
};

// ══ 视图：帮助 ════════════════════════════════════════════
VIEWS.help = async function (view) {
  // 探测一下 AI 命令行的真实状态：帮助页写死「需要装 XX」很容易过期，
  // 本机到底装没装、装的是哪个，直接让服务端说。
  let ai = null;
  try { ai = await api('/api/ai-status'); } catch { /* 探测失败不影响帮助页 */ }

  const rows = [
    ['评估一个岗位（全流程）', '/career-ops {JD}', '粘贴链接或 JD 正文'],
    ['只评估，不生成 PDF', '/career-ops oferta', '跑 A–H 评估'],
    ['对比多个岗位', '/career-ops ofertas', '横向排序'],
    ['生成定制简历 PDF', '/career-ops pdf', '按岗位定制'],
    ['生成 Markdown 简历', '/career-ops text', '不出 PDF'],
    ['中文简历规范自检', '（本地脚本）', '一页 / 教育前置 / 量化 / 反虚构。零 token，见「简历工具」页'],
    ['生成面试准备包', '（本地脚本）', '技术八股 / 项目深挖 / HR 面 20 问 / 反问清单。零 token'],
    ['面试准备文档', '/career-ops interview-prep', '针对某家公司的深挖；国内流程用上面的准备包'],
    ['模拟面试', '/career-ops interview/practice', '一问一答带反馈'],
    ['公司深度调研', '/career-ops deep', '六维度研究（业务、融资、新闻）'],
    ['被拒规律分析', '/career-ops patterns', '按渠道统计推进率'],
    ['技能缺口分析', '/career-ops upskill', '汇总报告中的缺口；也可以直接用页面的「面试备考建议」'],
    ['投递进度', '/career-ops tracker', '状态总览；界面入口已撤下，请用 CLI'],
    ['生成求职信', '/career-ops cover', '国内投递一般不需要求职信'],
    ['生成投递邮件草稿', '/career-ops email', '国内以网申表单为主，邮件投递少见'],
    ['找 HR / 招聘经理', '/career-ops contacto', '欧美冷邮件那套；国内用 BOSS直聘 直接打招呼'],
    ['扫岗', '/career-ops scan', '仅海外平台，国内岗位扫不到'],
  ];

  view.innerHTML =
    '<div class="notice ok"><b>评估已经可以在页面里直接做了</b>'
    + '<p>去「<b>评估岗位</b>」页，粘贴链接或 JD 正文，点一下就出报告——'
    + '不用切到终端敲命令。控制台会自动拉起 AI 完成读取、打分、写报告的全过程。</p>'
    + '<div class="row tight" style="margin-top:8px">'
    + '<button class="btn sm primary" type="button" id="hpEval">去评估岗位</button>'
    + '</div></div>'

    + '<div class="notice info"><b>还有哪些活儿要在 AI 对话里做</b>'
    + '<p>评估、以及下面这些「需要读懂 JD 和你的简历才能判断」的任务——'
    + '写求职信、面试准备、公司调研、改简历——都在 AI 对话里说一句话即可。'
    + '控制台负责管理数据、查看结果、运行零成本的本地脚本。</p></div>'

    + '<div class="card"><h2>按岗位留多版本简历</h2>'
    + '<p class="hint">一份简历投所有岗位是国内校招里最常见的失分点。'
    + '但「按岗位改一版」如果直接覆盖原文件，投到第三家时就找不回投给第一家的那一份了。'
    + '所以这里的规矩是：<b>原版 cv.md 只读，定向优化出来的一律另存为新版本</b>，按岗位命名。</p>'
    + '<div class="table-wrap"><table class="data">'
    + '<thead><tr><th>想做的事</th><th>在哪儿做</th></tr></thead><tbody>'
    + [
      ['从一次岗位评估直接派生一份定向简历',
        '评估结果里初筛 <b>≥ 3 分</b>时会多出一个「<b>简历对应优化</b>」按钮。'
        + '点它跳到「我的简历」，JD 与岗位名都替你填好了，优化完点「另存为新版本」即可'],
      ['新建 / 复制版本', '「我的简历」→「简历版本」表格：新建从原版复制，复制可从任意一版派生'],
      ['改名字 / 改适配岗位', '版本行的「重命名」。原版不可改名 —— 它的名字就是 cv.md 这个事实'],
      ['看两版差在哪', '版本行的「Diff」，两侧下拉都能换，默认「原版 ↔ 你点的那一版」'],
      ['只优化某一个版本', '版本行的「AI 优化」，或面板顶部的「优化对象」下拉。只读，不会碰别的版本'],
      ['按版本导出 PDF', '版本行的「导出」，导出的是那一版，不是原版'],
      ['删掉不要的版本', '版本行的「删除」。和其它删除一样先进 <code>data/trash/</code>，能翻回来'],
    ].map(([a, b]) => '<tr><td><b>' + esc(a) + '</b></td><td>' + b + '</td></tr>').join('')
    + '</tbody></table></div>'
    + '<p class="hint" style="margin-top:10px">每个版本都记着创建时间、上次修改时间和适配岗位；'
    + '正文本体在 <code>data/cv-versions/</code>，一份版本一个 <code>.md</code>，'
    + '与索引对不上时界面会直接标「文件丢失」，不会静默消失。</p>'
    + '<div class="row tight" style="margin-top:8px">'
    + '<button class="btn sm primary" type="button" id="hpCv">去我的简历</button>'
    + '</div></div>'

    + '<div class="card"><h2>中国大陆：去哪里找岗位</h2>'
    + '<p class="hint">内置的自动扫岗（100 个岗位源）全是海外招聘系统，国内一个都扫不到。'
    + '国内岗位（校招 / 社招 / 实习）按下面的渠道手动找，找到后把 JD 粘到「评估岗位」页。'
    + '标「校招」「社招」的是该渠道的主力场景，不是只能用在那里。</p>'
    + '<div class="table-wrap"><table class="data">'
    + '<thead><tr><th>渠道</th><th>主力场景 / 适合找什么</th><th>怎么用</th></tr></thead><tbody>'
    + [
      ['公司招聘官网', '通用 · 最权威，流程与时间线以它为准', '搜「公司名 + 招聘」，校招与社招是不同入口，用页面里的「投递截止时间」倒排计划'],
      ['牛客网', '校招 · 内推码、面经、笔试真题', '按公司/岗位搜，重点看内推帖；社招岗位也有但少'],
      ['BOSS直聘', '社招 + 实习 · 中小厂、部分大厂技术岗', '直接和 HR / 技术负责人对话；打招呼语有 150 字上限，要写具体的'],
      ['拉勾 / 猎聘', '社招 · 互联网与中高端岗位', '投递前按 JD 改一遍简历的项目顺序与关键词'],
      ['实习僧', '实习 · 实习转正是进大厂性价比最高的路径', '在校期间早点开始，实习经历是正式岗简历上最硬的一条'],
      ['应届生求职网', '校招 · 国企 / 央企 / 事业单位 / 银行', '这类单位主战场，很多只在自家官网和这里发'],
      ['智联招聘 / 前程无忧', '通用 · 传统企业、国企、制造业', '网申表单较长，提前准备好成绩单与证书扫描件'],
      ['学校就业网 / 就业办', '校招 · 只对本校开放的名额、宣讲会', '这类机会竞争最小，别漏'],
      ['企业招聘公众号 / 宣讲会', '通用 · 第一手时间线，现场常有内推', '关注目标公司招聘公众号，宣讲会去要内推码'],
    ].map(([a, b, c]) => '<tr><td><b>' + esc(a) + '</b></td><td>' + esc(b) + '</td>'
      + '<td style="color:var(--ink-3)">' + esc(c) + '</td></tr>').join('')
    + '</tbody></table></div>'
    + '<p class="hint" style="margin-top:10px">国内平台普遍有登录墙与反爬，<b>不要指望自动抓取</b>。'
    + '粘贴一条 JD 大约 30 秒，比维护抓取规则划算得多 —— 评估走这条路最稳。</p>'
    + '<p class="hint">唯一的例外是 BOSS 直聘：它有一个需要登录态的<b>半自动</b>通路，'
    + '只用来批量发打招呼语（省掉重复劳动），不做抓取也不做筛选 —— '
    + '见「自动投递」页。要不要投这个岗位，仍然得先跑一份评估报告来判断。</p>'
    + '</div>'

    + '<div class="card"><h2>中国大陆：求职时间线</h2>'
    + '<h3 style="margin:0 0 8px;font-size:14px">校招（按届次分批）</h3>'
    + '<div class="table-wrap"><table class="data">'
    + '<thead><tr><th>时间</th><th>该做什么</th></tr></thead><tbody>'
    + [
      ['大三下（3–6 月）', '找暑期实习。实习转正是性价比最高的路径，也是秋招简历上最硬的一条'],
      ['7–8 月', '提前批。部分大厂提前批不影响正式批，可以放心投'],
      ['9–10 月', '秋招主战场。简历筛选多在 9 月中基本结束，<b>投递要赶早</b>'],
      ['11–12 月', '补录与收尾。补招岗位通常是前一批没招满的'],
      ['次年 3–4 月', '春招。岗位少、节奏快，是秋招没拿到理想 offer 的第二次机会'],
    ].map(([a, b]) => '<tr><td><b>' + esc(a) + '</b></td><td>' + esc(b) + '</td></tr>').join('')
    + '</tbody></table></div>'
    + '<h3 style="margin:16px 0 8px;font-size:14px">社招（全年滚动）</h3>'
    + '<div class="table-wrap"><table class="data">'
    + '<thead><tr><th>时间</th><th>该做什么</th></tr></thead><tbody>'
    + [
      ['3–4 月 / 9–10 月', '「金三银四」「金九银十」，放出的岗位最多，是社招投递的最佳窗口'],
      ['2 月 / 6–7 月', '年后与年中各有一波补员，竞争比旺季小一些'],
      ['其余时间', '全年滚动招聘。没有固定批次，<b>看到合适的就投</b>，不用等窗口'],
      ['单个岗位的节奏', '从投递到 offer 通常 2–6 周：简历筛选 → 初试 → 复试 → 终面 → 谈薪'],
    ].map(([a, b]) => '<tr><td><b>' + esc(a) + '</b></td><td>' + esc(b) + '</td></tr>').join('')
    + '</tbody></table></div>'
    + '<p class="hint" style="margin-top:10px">校招按<b>届次</b>卡人：你是哪一届，就只能投对应届次的岗位。'
    + '把毕业年份填准（「求职配置」页 → 身份与地点），资格检查会据此判断能不能投。'
    + '<b>社招不看届次，看年限</b> ——「是否接受要求经验的岗位」那一项就是给这个用的。</p>'
    + '</div>'

    + '<div class="card"><h2>在 AI 对话里怎么用</h2>'
    + '<p class="hint">支持斜杠命令的工具（CodeBuddy、Qwen、Kimi、Claude Code）直接敲命令。'
    + '不支持的工具（Codex）用大白话说同样的话，效果一样。</p>'
    + '<div class="table-wrap"><table class="data">'
    + '<thead><tr><th>想做什么</th><th>斜杠命令</th><th>说明</th></tr></thead><tbody>'
    + rows.map(([a, b, c]) => '<tr><td>' + esc(a) + '</td><td><code>' + esc(b) + '</code></td><td style="color:var(--ink-3)">' + esc(c) + '</td></tr>').join('')
    + '</tbody></table></div></div>'

    + '<div class="card"><h2>日常工作流</h2>'
    + '<p class="hint">顺序很重要：<b>先把简历做出来，再拿去评估岗位</b>。'
    + '简历是评估的输入 —— 缺项时 AI 不认识你，分数会偏低。</p>'
    + '<ol style="margin:0;padding-left:20px">'
    + '<li>先在「<b>我的简历</b>」页把内容填完整（页面顶部会显示完整度）；'
    + '顺手跑一次「简历工具 → 中文简历自检」，把不符合国内规范的写法改掉</li>'
    + '<li>在「<b>评估岗位</b>」页粘贴岗位链接或 JD 正文，点「只做初筛」</li>'
    + '<li>等半分钟拿到分数；过了门槛 3.0 再点「生成完整报告」（实测 4–10 分钟）</li>'
    + '<li>回「评估报告」看全文，<b>优先关注 4.0 分以上的</b>（3.0 是门槛线）</li>'
    + '<li>对高分岗位，先在「分析 → 面试备考建议」生成一份补强清单：'
    + '还缺哪些知识点、补什么项目、看什么课和书</li>'
    + '<li>在 AI 对话里让它按岗位生成定制简历 PDF；先跑一次「简历工具 → 中文简历自检」</li>'
    + '<li>投递、笔试、面试的进度用 CLI 维护：<code>node tracker.mjs</code> 看总览，'
    + '<code>node tracker.mjs set --num N --status applied</code> 推状态'
    + '（简历筛选 → 笔试 / 测评 → 初试 → 复试 → 终面 → 谈薪）。'
    + '<b>卡在哪一环一眼能看出来</b>，这是最该盯的东西</li>'
    + '<li>投出去 3 周没回音，把状态改成「无回应」归档，别再挂着</li>'
    + '<li>用「全部脚本」里的脚本定期检查数据健康和被拒规律</li>'
    + '</ol></div>'

    + '<div class="card"><h2>五个最容易踩的坑</h2>'
    + '<ol style="margin:0;padding-left:20px">'
    + '<li><b>中国大陆求职不能用自动扫岗。</b>内置岗位源全是海外招聘系统，没有牛客 / BOSS直聘 / 应届生 / 拉勾 / 猎聘。手动粘贴 JD 是唯一路径（渠道清单见上方卡片）。</li>'
    + '<li><b>改配置别改错文件。</b>「你是谁、想找什么工作」只能写进 <code>cv.md</code>、<code>config/profile.yml</code>、<code>modes/_profile.md</code>。'
    + '写进 <code>modes/_shared.md</code> 会在下次升级时被覆盖。</li>'
    + '<li><b>前几次评估一定很离谱。</b>系统还不认识你。把简历填完整、把「个人简介」和「核心优势」写具体，评分才会准。</li>'
    + '<li><b>它永远不会替你投递。</b>AI 只负责评估和起草，提交动作永远由你做。JD 里的文字是「数据」不是「指令」，'
    + '有些 JD 会藏提示词注入攻击，工具会把它当作异常信号而不是照着执行。</li>'
    + '<li><b>分数要分清两个线。</b>门槛线 <b>3.0</b>——低于它直接筛掉、不建议投。'
    + '值得投入定制精力的线是 <b>4.0</b>——3.0~3.9 可以投，但属补投位，别在这儿花大量时间。'
    + '这个工具的设计初衷是筛选而不是海投。</li>'
    + '</ol></div>'

    + '<div class="card"><h2>为什么需要 AI 才能用</h2>'
    + '<p>历琢本身不含 AI。它的 <code>modes/*.md</code> 是一套提示词工程，'
    + '需要 AI 编程工具来读取并执行——页面里的「评估岗位」也是靠它。</p>'
    + (ai && ai.available
      ? '<div class="notice ok"><b>本机已检测到可用的 AI 命令行：' + esc(ai.cli || '') + '</b>'
        + '<p>入口：<code>' + esc(ai.entry || '') + '</code>。评估岗位可以直接在页面里跑，不用切到终端。</p></div>'
      : '<div class="notice warn"><b>没有检测到 AI 命令行</b>'
        + '<p>评估岗位、改简历、面试准备这些需要 AI 的操作暂时用不了（控制台其它功能不受影响）。</p></div>')
    + '<p style="margin-top:12px"><b>推荐：CodeBuddy Code（腾讯）</b> —— 国内站直接登录、有免费额度、'
    + '零配置读取项目根目录的 <code>AGENTS.md</code>。</p>'
    + '<p>另外三条零成本路线（不经过 AI CLI，直接调模型）：</p>'
    + '<ul style="margin:0;padding-left:20px">'
    + '<li><b>本地模型（Ollama）</b> —— <code>npm run ollama:eval</code>，完全离线免费</li>'
    + '<li><b>任意 OpenAI 兼容接口</b> —— <code>npm run openai:eval</code>，可指向 DeepSeek、智谱 GLM 等</li>'
    + '<li><b>OpenRouter 免费模型</b> —— <code>npm run or:eval</code></li>'
    + '</ul>'
    + '<p class="hint" style="margin-top:10px">注意：这三个走的是 <code>*-eval.mjs</code> 独立评估器，'
    + '读的规则文件与页面里那套一致，但不会写报告到 <code>reports/</code>。</p>'
    + '</div>'

    + '<div class="card"><h2>进一步阅读</h2>'
    + '<ul style="margin:0;padding-left:20px">'
    + '<li><code>README.cn.md</code> —— 项目中文说明</li>'
    + '<li><code>docs/SETUP.md</code> —— 完整安装指南</li>'
    + '<li><code>docs/WINDOWS.md</code> —— Windows 专章（最值得看）</li>'
    + '<li><code>docs/RUNNING_ON_A_BUDGET.md</code> —— 省钱方案</li>'
    + '<li><code>modes/zh/README.md</code> —— 中文模式说明</li>'
    + '</ul></div>'

    // 自动投递：这一页要写清楚的不是「怎么点」，而是「默认不会发」和
    // 「哪些事它绝不会替你做」—— 账号安全比省几次点击重要得多。
    + '<div class="card"><h2>自动投递（BOSS 直聘）</h2>'
    + '<p class="hint">入口在导航「系统」栏。它替你做的是<b>重复劳动</b>：'
    + '按关键词打开 BOSS 搜索页、逐个读岗位、套用过滤规则、逐条发打招呼语。'
    + '<b>判断这个岗位值不值得投，仍然得你自己来</b> —— 先去「评估岗位」跑一份报告，'
    + '分数够再来批量投。</p>'
    + '<div class="table-wrap"><table class="data">'
    + '<thead><tr><th>它做什么</th><th>它<b>不</b>做什么</th></tr></thead><tbody>'
    + [
      ['默认只出计划：跑一遍给你看「打算投谁、哪些被过滤、为什么」，'
        + '<b>一个字都不会发给 HR</b>',
        '不会替你决定投不投，也不会改你的简历'],
      ['真实发送要过两道：点「确认并发送」弹一次确认框，服务端还要求'
        + '显式 confirm 才执行 —— 绕过按钮也发不出去',
        '不会绕过平台风控硬闯：遇到滑块验证<b>立即停止</b>'],
      ['投过的岗位记进本地台账，下次遇到同一个自动跳过',
        '不会重复给同一个 HR 发第二次'],
      ['岗位之间随机停顿 8–25 秒（固定节奏本身就是风控特征）',
        '不会为了快而连发 —— 连发是最容易被限流的行为'],
      ['上限在服务端再夹一次：单次最多 '
        + PLATFORM_DAILY_CAP + '（平台上限），建议 '
        + SAFE_DEFAULTS.dailyCap + ' 以内',
        '不会帮你突破平台每日额度'],
    ].map(([a, b]) => '<tr><td>' + a + '</td><td style="color:var(--ink-3)">' + b + '</td></tr>').join('')
    + '</tbody></table></div>'
    + '<p class="hint" style="margin-top:10px">第一次用要先保存登录态：在项目根目录跑 '
    + '<code>node save-cookies-boss.mjs --persist</code>，登录态存到 '
    + '<code>data/cookies/boss.json</code>。没有登录态的话搜索页基本读不到内容。</p>'
    + '<div class="row tight" style="margin-top:8px">'
    + '<button class="btn sm primary" type="button" id="hpAuto">去自动投递</button>'
    + '</div></div>'

    // 意见反馈：登录用户直填，POST /api/feedback 进管理端的「用户反馈」页签
    // —— 这条链路是演示闭环的用户侧出口（帮助页在门禁之后，进来必是登录态）。
    + '<div class="card"><h2>意见反馈</h2>'
    + '<p class="hint">用着哪里不顺、想要什么功能，直接写下来 —— 管理端会收到并处理。</p>'
    + '<textarea class="textarea" id="fbText" rows="3" maxlength="500" placeholder="至少 1 个字，最多 500 字"></textarea>'
    + '<div class="row tight" style="margin-top:8px">'
    + '<button class="btn sm primary" type="button" id="fbGo">提交反馈</button>'
    + '<span class="hint" id="fbMsg"></span></div></div>';

  $('#hpEval').addEventListener('click', () => go('evaluate'));
  $('#hpCv').addEventListener('click', () => go('cv'));
  const hpAuto = $('#hpAuto');
  if (hpAuto) hpAuto.addEventListener('click', () => go('autoapply'));

  // 意见反馈提交：令牌由 api() 自动带上；服务端限 1-500 字
  const fbBtn = $('#fbGo');
  const fbMsg = $('#fbMsg');
  fbBtn.addEventListener('click', async () => {
    const text = $('#fbText').value.trim();
    if (!text) { fbMsg.textContent = '先写点内容再提交'; return; }
    busy(fbBtn, true, '提交中…');
    try {
      await api('/api/feedback', { method: 'POST', body: { text } });
      $('#fbText').value = '';
      fbMsg.textContent = '已提交，谢谢反馈！';
      toast('反馈已提交', 'ok');
    } catch (e) {
      fbMsg.textContent = e.message || '提交失败';
    } finally {
      busy(fbBtn, false);
    }
  });
};

// ══ 启动 ══════════════════════════════════════════════════
// 用箭头包一层：route 现在收 opts，直接把它挂上去会把 hashchange 的
// Event 对象当参数传进去（里面碰巧没有 keepScroll，但这是靠运气）。
window.addEventListener('hashchange', () => route());

// 简历有未保存改动时，关页面/刷新前提醒一句。
// 页内切换不用拦——草稿存在 S.cvDraft 里，换个页面再回来改动还在。
window.addEventListener('beforeunload', (e) => {
  if (!S.cvDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

// 全局 Esc：优先收起移动端抽屉。弹层自己的 Esc 由 wireModal 处理。
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen()) setDrawer(false);
});

initShell();

// 旧会话校验（先于首次 route()）：服务重启后内存会话表清空，localStorage 里
// 的 token 已失效 —— 不清的话用户停在受保护页面，每个请求都 403。只有明确
// 401 才清（连不上服务 ≠ token 失效，别误伤）；给 2.5 秒上限，不让首屏干等。
const bootSessionCheck = (S.session && S.session.token)
  ? Promise.race([
      fetch('/api/auth/me', { headers: { 'x-lizhuo-token': S.session.token } })
        .then((r) => { if (r.status === 401) saveSession(null); })
        .catch(() => { /* 网络失败：保留会话，等恢复后再说 */ }),
      new Promise((done) => setTimeout(done, 2500)),
    ])
  : Promise.resolve();
bootSessionCheck.then(() => route());

// ═══════════════════════════════════════════════════════════════════
// ══ 「简历工坊」新界面（2026-10-10，源自桌面 index.html 原型）══════
//
// 壳与导航已换成原型样式；这里把五个核心页面按原型的布局重写，并接
// **真实接口**（reports / tracker / prep / cv / versions —— 字段清单
// 全部来自 server.mjs 的实际返回，不猜）：
//   工作台 home        ← /api/reports + /api/tracker + /api/prep/list
//   我的简历 resumes   ← /api/cv + /api/cv/versions（「新建简历」→ #cv）
//   目标岗位 jobs      ← JD 输入（转交评估页）+ 岗位卡 = reports
//   提升计划 growth    ← /api/prep/list
//   投递记录 applications ← /api/tracker
//
// ⚠️ 简历编辑页（VIEWS.cv）**一行没动** —— 用户明确要求保留原界面。
// ⚠️ 旧的 VIEWS.home（落地页）在上方保留未删：JS 对象属性后赋值覆盖，
//    旧函数体成了死代码，等新界面稳定后再清理（避免一次改动过大）。
// ═══════════════════════════════════════════════════════════════════

// 原型的流水线进度条：now = 当前进行到第几步（0 基）。
function wzPipeline(now) {
  const steps = ['选岗定位', '适配度评估', 'AI 优化', '再评估', '打招呼'];
  let h = '<div class="pipeline">';
  for (let i = 0; i < steps.length; i++) {
    const cls = i < now ? 'pnode done' : (i === now ? 'pnode now' : 'pnode');
    h += '<div class="' + cls + '"><div class="dot">' + (i < now ? '&#10003;' : (i + 1)) + '</div>'
      + '<div class="lbl">' + esc(steps[i]) + '</div></div>';
  }
  return h + '</div>';
}

// 报告分数 → 数字（"4.2/5" / "78" 都能取到）。
function wzScoreOf(s) {
  const m = String(s == null ? '' : s).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// 投递状态 → 原型的 tag 颜色类。
function wzStatusCls(status) {
  const s = String(status || '');
  if (/已回复|已沟通|responded/i.test(s)) return 'green';
  if (/已查看|已读/i.test(s)) return 'green';
  if (/未查看|未读/i.test(s)) return 'amber';
  if (/待发送|未发送/i.test(s)) return 'gray';
  if (/不合适|拒绝|关闭|结束/i.test(s)) return 'gray';
  return 'gray';
}

// ══ 工作台 ═══════════════════════════════════════════════════════
VIEWS.home = async function (view) {
  // 三个数据源并行拉；任何一个挂了都降级成空数组，页面照常渲染
  // （工作台是门面页，接口抖一下就白屏比显示空数据糟得多）。
  const [reports, tracker, prep] = await Promise.all([
    api('/api/reports').catch(() => []),
    api('/api/tracker').catch(() => ({ rows: [] })),
    api('/api/prep/list').catch(() => ({ items: [] })),
  ]);
  S.reports = Array.isArray(reports) ? reports : [];
  const rows = (tracker && Array.isArray(tracker.rows)) ? tracker.rows : [];
  const prepItems = (prep && Array.isArray(prep.items)) ? prep.items : [];

  const latest = S.reports[0] || null;
  const latestScore = latest ? wzScoreOf(latest.score) : null;
  // 「在投」= 台账里还没走到终态（不合适/拒绝/关闭）的
  const activeApps = rows.filter((x) => !/不合适|拒绝|关闭|结束/.test(x.status || '')).length;
  // 流水线进行到哪一步：没评估过 = 选岗定位；评估过 = AI 优化；
  // 台账里已有发出去的 = 打招呼。
  const sent = rows.some((x) => /已发送|已查看|已回复|已读/i.test(x.status || ''));
  const pipeNow = !latest ? 0 : (sent ? 4 : 2);

  // ── 下一步建议卡 ──
  let suggest;
  if (latest) {
    const when = latest.date ? ' · ' + esc(latest.date) : '';
    suggest = '<div class="card mb">'
      + '<div class="row-between">'
      + '<div><div class="kicker">下一步建议</div>'
      + '<div style="font-size:17px;font-weight:600">最近评估：' + esc(latest.title) + '，'
      + (latestScore != null ? latestScore + ' 分' : '已出结果') + '</div>'
      + '<div class="note" style="margin-top:4px">' + when
      + (latest.archetype ? ' · ' + esc(latest.archetype) : '')
      + ' · 优化措辞后可再评估对比</div></div>'
      + '<div class="row">'
      + '<button class="btn" type="button" data-wz-go="cvopt">查看优化</button>'
      + '<button class="btn pur" type="button" data-wz-go="jobs">评估新岗位</button>'
      + '</div></div>'
      + wzPipeline(pipeNow)
      + '</div>';
  } else {
    suggest = '<div class="card mb">'
      + '<div class="row-between">'
      + '<div><div class="kicker">下一步建议</div>'
      + '<div style="font-size:17px;font-weight:600">从一份简历和一个目标岗位开始</div>'
      + '<div class="note" style="margin-top:4px">先在「我的简历」完善内容，再来这里粘贴 JD 做第一次评估</div></div>'
      + '<div class="row">'
      + '<button class="btn" type="button" data-wz-go="resumes">去写简历</button>'
      + '<button class="btn pur" type="button" data-wz-go="jobs">粘贴岗位 JD</button>'
      + '</div></div>'
      + wzPipeline(0)
      + '</div>';
  }

  // ── 最近评估 / 最近投递 ──
  const evalList = S.reports.slice(0, 3).map((r) => {
    const v = wzScoreOf(r.score);
    return '<div class="li"><div class="ico">' + esc((r.title || '?')[0]) + '</div>'
      + '<div class="body"><div class="t">' + esc(r.title) + '</div>'
      + '<div class="s">' + esc(r.date || '') + (r.archetype ? ' · ' + esc(r.archetype) : '') + '</div></div>'
      + '<div class="r"><span class="tag">' + (v != null ? v + ' 分' : '—') + '</span>'
      + '<button class="btn sm" type="button" data-wz-report="' + esc(r.file) + '">查看</button></div></div>';
  }).join('');
  const appList = rows.slice(0, 3).map((r) => {
    const done = /已发送|已查看|已回复|已读/.test(r.status || '');
    return '<div class="li"><div class="ico" style="background:#f1f3f5;color:var(--ink2)">'
      + esc((r.company || '?')[0]) + '</div>'
      + '<div class="body"><div class="t">' + esc((r.company || '') + (r.role ? ' · ' + r.role : '')) + '</div>'
      + '<div class="s">' + esc(r.status || '待发送') + ' · ' + esc(r.date || '') + '</div></div>'
      + '<div class="r"><span class="tag ' + wzStatusCls(r.status) + '">' + esc(r.status || '—') + '</span>'
      + (done ? '' : '<button class="btn sm" type="button" data-wz-go="autoapply">去投递</button>')
      + '</div></div>';
  }).join('') || '<div class="note" style="padding:14px 0">还没有投递记录。评估后从岗位卡「去投递」开始。</div>';

  view.innerHTML = '<div class="page">'
    + suggest
    + '<div class="g3 mb">'
    + '<div class="stat"><div class="n">' + (latestScore != null ? latestScore : '—') + '</div>'
    + '<div class="l">最新适配度</div><div class="d">' + (S.reports.length ? '共 ' + S.reports.length + ' 次评估' : '还没有评估') + '</div></div>'
    + '<div class="stat"><div class="n">' + activeApps + '</div>'
    + '<div class="l">在投岗位</div><div class="d">' + (rows.length ? '累计 ' + rows.length + ' 条' : '从岗位卡发起') + '</div></div>'
    + '<div class="stat"><div class="n">' + prepItems.length + '</div>'
    + '<div class="l">待补知识点</div><div class="d">来自最近一次报告</div></div>'
    + '</div>'
    + '<div class="split">'
    + '<div class="card"><div class="sec-t">最近评估</div><div class="sec-d">点开任意一条可回到当次结果</div>'
    + (evalList || '<div class="note" style="padding:14px 0">还没有评估报告。粘贴一段 JD 开始第一次评估。</div>') + '</div>'
    + '<div class="card"><div class="sec-t">最近投递</div><div class="sec-d">打招呼后的状态跟踪</div>' + appList + '</div>'
    + '</div></div>';

  $$('[data-wz-go]', view).forEach((b) => b.addEventListener('click', () => go(b.dataset.wzGo)));
  $$('[data-wz-report]', view).forEach((b) => b.addEventListener('click', () => openReport(b.dataset.wzReport)));
};

// ══ 我的简历（列表页）═══════════════════════════════════════════
// 主简历（cv.md + 表单）永远在列表第一位；下面是「简历多版本」的派生卡。
// 「+ 新建简历」跳 #cv —— 那一页（表单化编辑器）**保持原界面不动**。
VIEWS.resumes = async function (view) {
  const [cv, ver] = await Promise.all([
    api('/api/cv').catch(() => null),
    api('/api/cv/versions').catch(() => ({ versions: [] })),
  ]);
  const versions = (ver && Array.isArray(ver.versions)) ? ver.versions : [];
  // 同步进会话缓存：版本卡上的删除走 askDeleteVersion → versionById()，
  // 而 versionById 读的是 S.cvVersions。原来这里只用了局部变量、缓存是空的，
  // 于是「删除」点了静默什么也不发生（2026-10-12 修死按钮时挖出来的）。
  if (ver && Array.isArray(ver.versions)) S.cvVersions = ver;
  const c = (cv && cv.form && cv.form.candidate) || {};
  const comp = (cv && cv.completeness) || {};
  const name = c.name || '（未填写姓名）';

  // 时间统一格式化：versions 的 updatedAt 是毫秒时间戳，直接 toString 切片
  // 会显示「179154701017.41」这种没人看得懂的数（实测截图暴露的 bug）。
  const fmtWhen = (t) => {
    if (!t) return '';
    if (typeof t === 'number' || /^\d{10,}$/.test(String(t))) {
      const d = new Date(Number(t));
      if (!isNaN(d)) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
        + '-' + String(d.getDate()).padStart(2, '0')
        + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    return String(t).slice(0, 16);
  };

  // 「原版简历」不单独出卡（2026-10-10 用户要求）：它就是主简历本身，
  // 主简历卡（上面第一张）已经展示了。base 过滤掉，剩下的都是定向版本。
  // 每张版本卡都是**独立简历**：「编辑」把编辑器切到那份简历（保存写回
  // 版本文件，主简历不动 —— 见 VIEWS.cv 的 S.cvEditTarget 与 versions/save）。
  const verCards = versions
    .filter((v) => v.id !== 'base')
    .map((v) => {
      const vn = v.name || v.file || v.id || '未命名版本';
      const when = fmtWhen(v.updatedAt || v.mtime || v.date);
      return '<div class="card tight wz-res-card">'
        // 标题可点击就地改名（2026-10-12 用户要求）：role=button + Enter/Space 支持键盘
        + '<div class="row-between mb"><div class="wz-res-title wz-ver-title"'
        + ' data-ver-title="' + esc(v.id) + '" role="button" tabindex="0" title="点击改名字">'
        + esc(vn) + '<span class="wz-ver-pen" aria-hidden="true">✎</span></div></div>'
        + '<div class="note wz-res-meta">' + (when ? '更新于 ' + esc(when) + '<br>' : '')
        + '独立简历 · 保存不影响主简历</div>'
        + '<div class="row mt wz-res-actions">'
        + '<button class="btn sm pri" type="button" data-wz-editver="' + esc(v.id) + '">编辑</button>'
        + '<button class="btn sm" type="button" data-wz-go="jobs">去评估</button>'
        + '<button class="btn sm" type="button" data-wz-delver="' + esc(v.id)
        + '" aria-label="删除版本：' + esc(vn) + '">删除</button>'
        + '</div></div>';
    }).join('');

  // 「+ 新建简历」放页头右侧（原型同位）：route() 每次切页清空 #topActions，
  // 视图在清空之后执行，这里塞进去是安全的。
  const topActions = $('#topActions');
  if (topActions) {
    topActions.innerHTML = '<button class="btn pri" type="button" id="wzNewResume">+ 新建简历</button>';
  }

  view.innerHTML = '<div class="page">'
    + '<div class="gauto">'
    // 主简历卡：「编辑」清掉编辑对象，编辑的始终是 cv.md
    + '<div class="card tight wz-res-card">'
    + '<div class="row-between mb"><div class="wz-res-title">' + esc(name) + '</div>'
    + '<span class="tag">主简历</span></div>'
    + '<div class="note wz-res-meta">完整度 ' + (comp.percent != null ? comp.percent : 0) + '%'
    + ((cv && cv.form) ? '<br>教育 ' + ((cv.form.education || []).length) + ' 条 · 经历 '
      + ((cv.form.experience || []).length) + ' 条 · 项目 ' + ((cv.form.projects || []).length) + ' 条' : '')
    + '</div>'
    + '<div class="row mt wz-res-actions">'
    + '<button class="btn sm pri" type="button" data-wz-editbase="1">编辑</button>'
    + '<button class="btn sm" type="button" data-wz-go="jobs">去评估</button>'
    + '<button class="btn sm" type="button" data-wz-go="cvopt">AI 优化</button>'
    + '</div></div>'
    + verCards
    + '</div>'
    + '</div>';

  $$('[data-wz-go]', view).forEach((b) => b.addEventListener('click', () => go(b.dataset.wzGo)));
  // 「新建简历」（2026-10-10 二次改口径）：**独立简历，完全不影响原简历**。
  //   ① 弹出名称框，用户给新简历起名
  //   ② 创建一个**空白**版本（不复制任何内容，不碰主简历）
  //   ③ 编辑器的编辑对象切到这份新简历 → 直接开写
  // 保存走 /api/cv/versions/save 写回版本文件 —— cv.md 原封不动。
  const newBtn = $('#wzNewResume');
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.setAttribute('role', 'dialog');
      mask.setAttribute('aria-modal', 'true');
      mask.setAttribute('aria-label', '新建简历');
      mask.innerHTML = '<div class="modal">'
        + '<div class="modal-head"><h3>新建简历</h3><span class="spacer"></span>'
        + '<button class="btn ghost sm icon" type="button" id="wzNrX" aria-label="关闭">' + icon('x') + '</button></div>'
        + '<p class="hint">会给这份简历起一个名字。它是**独立的**一份简历 —— 保存和编辑都不影响主简历。</p>'
        + '<label class="field"><span>简历名称</span>'
        + '<input class="input" id="wzNrName" placeholder="如：张三_前端开发 / 岗位版本-1024" maxlength="60"></label>'
        + '<div class="row" style="justify-content:flex-end;margin-top:8px">'
        + '<button class="btn" type="button" id="wzNrCancel">取消</button>'
        + '<button class="btn pri" type="button" id="wzNrGo">创建并编辑</button></div>'
        + '</div>';
      document.body.appendChild(mask);
      const close = () => mask.remove();
      const inp = mask.querySelector('#wzNrName');
      setTimeout(() => inp.focus(), 60);
      mask.querySelector('#wzNrX').addEventListener('click', close);
      mask.querySelector('#wzNrCancel').addEventListener('click', close);
      mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
      mask.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      const create = async () => {
        const name = (inp.value || '').trim();
        if (!name) { toast('先给这份简历起个名字', 'warn'); inp.focus(); return; }
        const goBtn = mask.querySelector('#wzNrGo');
        goBtn.disabled = true;
        try {
          const r = await api('/api/cv/versions/create', {
            method: 'POST', body: { name, empty: true },
          });
          const id = (r.version || {}).id;
          if (!id) throw new Error('创建失败：服务端没返回版本 id');
          close();
          // 编辑对象切到新简历；草稿清掉（「草稿优先」不能把上一份内容顶进来）
          S.cvEditTarget = { kind: 'version', id, name };
          S.cvDraft = null;
          S.cvDirty = false;
          toast('已创建「' + name + '」，开始填写吧', 'ok');
          go('cv');
        } catch (err) {
          goBtn.disabled = false;
          toast(err.message || '创建失败', 'bad');
        }
      };
      mask.querySelector('#wzNrGo').addEventListener('click', create);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
    });
  }
  // 版本卡「编辑」：编辑对象切到那份独立简历（保存写回版本文件，不碰主简历）
  $$('[data-wz-editver]', view).forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.wzEditver;
    const vn = (versions.find((x) => x.id === id) || {}).name || id;
    S.cvEditTarget = { kind: 'version', id, name: vn };
    S.cvDraft = null;
    S.cvDirty = false;
    go('cv');
  }));
  // 版本卡标题：点击就地改名（2026-10-12 用户要求「标题变成可编辑的」）。
  $$('[data-ver-title]', view).forEach((el) => {
    const start = () => startVersionTitleEdit(el, versions);
    el.addEventListener('click', start);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); start(); }
    });
  });
  // 版本卡「删除」：原来是只渲染不接线的**死按钮**（2026-10-12 顺手修），
  // 与「简历工具」页的删除走同一个确认框。
  $$('[data-wz-delver]', view).forEach((b) => b.addEventListener('click', () => {
    askDeleteVersion(b.dataset.wzDelver);
  }));
  // 主简历卡「编辑」：清掉编辑对象，回到主简历（cv.md）
  $$('[data-wz-editbase]', view).forEach((b) => b.addEventListener('click', () => {
    S.cvEditTarget = null;
    S.cvDraft = null;
    S.cvDirty = false;
    go('cv');
  }));
};

// ══ 目标岗位（2026-10-10 内嵌评估）════════════════════════════════
// 用户要求：评估**就在本页做**，不再跳旧的评估页；结果用「雷达图 + 报告说明」
// 呈现（不用旧样式）。数据链路复用 /api/eval（phase:'triage'，本地模型、约半
// 分钟、不写盘）。会话挂 S.wzEval —— 跑一次要半分钟，切页回来结果还在。

/** 「目标岗位」页的评估会话（跨页保留）。 */
function wzEvalSession() {
  if (!S.wzEval) {
    S.wzEval = {
      running: false,
      runId: 0,
      result: null,     // { triage:{score,verdict,tier,why,dims,good,gap,tip}, ms, raw }
      error: '',
      fullRunning: false,
      fullNotice: '',   // 完整报告（A–H）的状态行
    };
  }
  return S.wzEval;
}

const WZ_DIMS = ['专业技能', '项目经验', '学历背景', '软技能', '行业经验', '成果量化'];

/** 新皮肤的六维雷达图（类名 wz-radar-*，样式见 style.css §30e）。
 *  几何沿用项目既有的六边形画法，只换配色与描边 —— 旧样式不参与这一页。 */
function wzRadarSvg(values, labels) {
  const N = labels.length;
  const cx = 170; const cy = 148; const R = 96;
  const pt = (i, frac) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    return [cx + Math.cos(a) * R * frac, cy + Math.sin(a) * R * frac];
  };
  const poly = (frac) => labels.map((_, i) => pt(i, frac).map((n) => n.toFixed(1)).join(',')).join(' ');
  const axes = labels.map((_, i) => {
    const p = pt(i, 1);
    return '<line class="wz-radar-axis" x1="' + cx + '" y1="' + cy + '" x2="'
      + p[0].toFixed(1) + '" y2="' + p[1].toFixed(1) + '"/>';
  }).join('');
  const vals = values.map((v) => Math.max(0, Math.min(100, Number(v) || 0)));
  const data = vals.map((v, i) => pt(i, v / 100));
  const dataPoly = data.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ');
  const dots = data.map((p) => '<circle class="wz-radar-dot" cx="' + p[0].toFixed(1)
    + '" cy="' + p[1].toFixed(1) + '" r="3.4"/>').join('');
  const texts = labels.map((lb, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    const lx = cx + Math.cos(a) * (R + 26);
    const ly = cy + Math.sin(a) * (R + 22);
    const anchor = Math.abs(Math.cos(a)) < 0.35 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
    const dy = Math.sin(a) < -0.35 ? -4 : (Math.sin(a) > 0.35 ? 12 : 4);
    return '<text class="wz-radar-lab" x="' + lx.toFixed(1) + '" y="' + (ly + dy).toFixed(1)
      + '" text-anchor="' + anchor + '">' + esc(lb)
      + '<tspan class="wz-radar-num">' + vals[i] + '</tspan></text>';
  }).join('');
  return '<svg class="wz-radar" viewBox="0 0 340 300" role="img"'
    + ' aria-label="六维匹配雷达图：' + labels.map((l, i) => l + ' ' + vals[i]).join('，') + '">'
    + [0.25, 0.5, 0.75, 1].map((f) => '<polygon class="wz-radar-ring" points="' + poly(f) + '"/>').join('')
    + axes
    + '<polygon class="wz-radar-data" points="' + dataPoly + '"/>'
    + dots
    + texts
    + '</svg>';
}

/** 结果区（雷达图 + 报告说明）。空 = 不渲染（还没跑）。 */
function wzEvalResultHtml(s) {
  if (s.error) {
    return '<div class="notice warn" style="margin-top:14px"><b>评估没跑成</b>'
      + '<p>' + esc(s.error) + '</p></div>';
  }
  if (s.running) {
    return '<div class="wz-eval-run">'
      + '<span class="wz-eval-spin" aria-hidden="true"></span>'
      + '<div><b>正在评估…</b></div>'
      + '</div>';
  }
  if (!s.result) return '';
  const t = s.result.triage || {};
  const score5 = t.score != null ? Number(t.score) : null;
  const score100 = score5 != null ? Math.max(0, Math.min(100, Math.round((score5 / 5) * 100))) : null;
  // 档位 → 颜色：≥80 绿、≥60 蓝（可投）、其余灰
  const tierCls = score100 == null ? 'gray' : (score100 >= 80 ? 'green' : score100 >= 60 ? '' : 'gray');
  const dims = Array.isArray(t.dims) && t.dims.length === 6 ? t.dims : null;
  const values = dims || WZ_DIMS.map(() => score100 == null ? 0 : score100);

  const ul = (items, emptyText) => (items && items.length
    ? '<ul>' + items.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
    : '<p class="note" style="margin:0">' + esc(emptyText) + '</p>');

  return '<div class="wz-eval-result">'
    + '<div class="wz-eval-head">'
    + '<div class="wz-radar-wrap">' + wzRadarSvg(values, WZ_DIMS)
    + (dims ? '' : '<p class="note wz-radar-note">维度分缺失，按总分折算显示，仅供示意</p>')
    + '</div>'
    + '<div class="wz-eval-sum">'
    + '<div class="kicker">综合匹配</div>'
    + '<div class="wz-eval-score">' + (score100 != null ? score100 : '—') + '<span>/100</span></div>'
    + '<div class="row" style="margin:8px 0 12px">'
    + (t.tier ? '<span class="tag ' + tierCls + '">' + esc(t.tier) + '</span>' : '')
    + (t.verdict ? '<span class="tag ' + (t.verdict === 'PASS' ? 'green' : 'gray') + '">'
      + (t.verdict === 'PASS' ? '过门槛' : '未过门槛') + '</span>' : '')
    + (score5 != null ? '<span class="tag gray">' + score5 + '/5</span>' : '')
    + '</div>'
    + '<p class="wz-eval-why">' + esc(t.why || 'AI 这次没给出结论摘要。') + '</p>'
    + '<div class="note">耗时 ' + Math.round((s.result.ms || 0) / 1000) + ' 秒 · '
    + (s.result.fellBack ? '本地模型没启动，这次用 CodeBuddy 完成' : '本地模型初筛')
    + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="wz-eval-cols">'
    + '<div class="wz-eval-col ok"><h4>优势匹配点</h4>' + ul(t.good, 'AI 这次没给出这一组') + '</div>'
    + '<div class="wz-eval-col warn"><h4>能力短板</h4>' + ul(t.gap, 'AI 这次没给出这一组') + '</div>'
    + '<div class="wz-eval-col acc"><h4>简历优化建议</h4>' + ul(t.tip, 'AI 这次没给出这一组') + '</div>'
    + '</div>'
    + '<div class="wz-eval-actions">'
    + '<div class="row">'
    + '<button class="btn" type="button" id="wzEvalFull"' + (s.fullRunning ? ' disabled' : '') + '>'
    + (s.fullRunning ? '生成中…' : '生成完整报告（A–H）') + '</button>'
    + '<button class="btn" type="button" id="wzEvalOpt">AI 优化简历</button>'
    + '<button class="btn" type="button" id="wzEvalAgain">换个岗位再评</button>'
    + '</div>'
    + '<div class="note">完整报告会写进「历史评估」，需要 CodeBuddy 登录态；不消耗时点这里就好。</div>'
    + '</div>'
    + (s.fullNotice ? '<div class="notice ' + (s.fullNotice.ok ? '' : 'warn')
      + '" style="margin-top:12px">' + s.fullNotice.html + '</div>' : '')
    + '</div>';
}

/** 把会话投影到结果区（DOM 只是投影 —— 切页/重画都靠它补齐）。 */
function paintWzEval() {
  const out = $('#wzEvalOut');
  if (!out) return;
  const s = wzEvalSession();
  out.innerHTML = wzEvalResultHtml(s);
  const btn = $('#wzEvalNow');
  if (btn) {
    btn.disabled = s.running;
    btn.textContent = s.running ? '评估中…' : '开始评估';
  }
  const hint = $('#wzEvalHint');
  // 说明句已按用户要求删除（2026-10-12）；元素保留只为运行中占位
  if (hint) hint.textContent = '';
  // 结果区里的动作（每次重画都要重挂）
  const again = $('#wzEvalAgain');
  if (again) again.addEventListener('click', () => {
    const ta = $('#wzJd');
    if (ta) { ta.value = ''; ta.focus(); }
    S.wzJdDraft = '';
    s.result = null; s.error = ''; s.fullNotice = '';
    paintWzEval();
  });
  const opt = $('#wzEvalOpt');
  if (opt) opt.addEventListener('click', () => go('cvopt'));
  const full = $('#wzEvalFull');
  if (full) full.addEventListener('click', () => runWzFull());
}

/** 跑一次初筛评估（就在本页）。 */
async function runWzEval() {
  const s = wzEvalSession();
  const jd = (S.wzJdDraft || '').trim();
  if (!jd) { toast('先粘贴一段岗位 JD', 'warn'); return; }
  if (s.running) return;
  s.running = true; s.error = ''; s.result = null; s.fullNotice = '';
  s.runId += 1;
  const my = s.runId;
  paintWzEval();
  try {
    const r = await api('/api/eval', {
      method: 'POST',
      // 服务端 triage 超时 300s，前端比它宽一点，避免前端先断
      timeout: 330000,
      // cvVersion：本页选的「用哪份简历」。默认 'base'（原简历 cv.md），
      // 与评估页同一个会话字段 —— 2026-10-14 之前这里没带，导致本页的评估
      // 永远用原简历，选什么版本都不生效。
      body: { jd, phase: 'triage', cvVersion: evalSession().cvVersion || 'base' },
    });
    if (my !== s.runId) return;
    const t = r.triage || {};
    if (t.score == null) {
      throw new Error(r.friendly
        || 'AI 返回的内容没能解析出分数。原始输出：' + String(r.output || '').slice(0, 200));
    }
    s.result = { triage: t, ms: r.ms || 0, raw: r.output || '', engine: r.engine || '', fellBack: !!r.engineFellBack };
    const p = Math.round((Number(t.score) / 5) * 100);
    if (r.engineFellBack) {
      toast('本地模型没启动，这次用 CodeBuddy 完成（' + p + '/100）', p < 60 ? 'warn' : 'ok');
    } else {
      toast('评估完成：' + p + '/100', p < 60 ? 'warn' : 'ok');
    }
  } catch (err) {
    if (my !== s.runId) return;
    // 空简历守卫（400 needCv）：直接把人引到简历编辑，别留一句干巴巴的报错
    if (err && err.data && err.data.needCv) {
      s.error = err.message;
      toast('简历还是空白的，先去「我的简历」填上再评估', 'warn');
    } else {
      s.error = (err && err.message) || '评估失败，请稍后重试';
    }
  } finally {
    if (my === s.runId) { s.running = false; paintWzEval(); }
  }
}

/** 生成完整 A–H 报告（同一个页面内跑，不跳页）。 */
async function runWzFull() {
  const s = wzEvalSession();
  const jd = (S.wzJdDraft || '').trim();
  if (!jd) { toast('先粘贴一段岗位 JD', 'warn'); return; }
  if (s.fullRunning) return;
  s.fullRunning = true;
  s.fullNotice = { ok: true, html: '<b>正在生成完整报告…</b><p>这一步要读完整套规则并写报告文件，可能要几分钟；切页不会中断。</p>' };
  paintWzEval();
  try {
    const r = await api('/api/eval', {
      method: 'POST', timeout: 1900000,
      // cvVersion 与初筛保持同一份：不补的话「初筛用选中的简历、完整报告
      // 却悄悄用回原简历」，同一份报告里两份简历，结论对不上。
      body: { jd, phase: 'full', cvVersion: evalSession().cvVersion || 'base' },
    });
    if (r.ok) {
      s.fullNotice = { ok: true, html: '<b>完整报告已生成</b><p>出现在了下面的「历史评估」里，点「看结果」读全文。</p>' };
      toast('完整报告已生成', 'ok');
      try {
        const list = await api('/api/reports');
        S.reports = Array.isArray(list) ? list : [];
        route({ keepScroll: true });   // 岗位卡列表刷新（结果区还在会话里）
        return;
      } catch { /* 列表刷新失败不影响报告本身 */ }
    } else {
      s.fullNotice = { ok: false, html: '<b>完整报告没生成成功</b><p>'
        + esc(r.friendly || 'AI 没有写出报告文件。') + '</p>' };
    }
  } catch (err) {
    const d = (err && err.data) || {};
    s.fullNotice = {
      ok: false,
      html: '<b>完整报告没生成成功</b><p>'
        + esc(d.needWriteEngine ? '这一步需要能写文件的引擎：请先双击项目根目录的「登录CodeBuddy.cmd」完成登录，再回来重试。'
          : (err.message || '请稍后重试')) + '</p>',
    };
  } finally {
    s.fullRunning = false;
    paintWzEval();
  }
}

VIEWS.jobs = async function (view) {
  const reports = await api('/api/reports').catch(() => []);
  S.reports = Array.isArray(reports) ? reports : [];

  // 「用哪份简历评估」下拉的选项（2026-10-14 用户要求）。拉不到就只留
  // 「原简历」那一项 —— 那正是默认行为，不该因为读不到版本列表把整页拖垮。
  let cvVers = [];
  try { cvVers = (await api('/api/cv/versions')).versions || []; } catch { /* 留空即可 */ }

  const cards = S.reports.map((r) => {
    const v = wzScoreOf(r.score);
    const cls = v == null ? '' : (v >= 4 ? '' : v >= 3 ? 'amber' : 'gray');
    // wz-res-card = 通用「等高对齐」卡（标题两行截断 / 说明定高 / 按钮沉底）
    return '<div class="card tight wz-res-card">'
      + '<div class="row-between mb"><div class="wz-res-title">' + esc(r.title) + '</div>'
      + '<span class="tag ' + cls + '">' + (v != null ? v + ' 分' : '—') + '</span></div>'
      + '<div class="note wz-res-meta">' + esc(r.date || '') + (r.legitimacy ? '<br>真实性 ' + esc(r.legitimacy) : '') + '</div>'
      + '<div class="row mt wz-res-actions">'
      + '<button class="btn sm pri" type="button" data-wz-report="' + esc(r.file) + '">看结果</button>'
      + '<button class="btn sm" type="button" data-wz-go="autoapply">打招呼</button>'
      + '<button class="btn sm" type="button" data-wz-delrep="' + esc(r.file) + '"'
      + ' aria-label="删除岗位：' + esc(r.title) + '">删除</button>'
      + '</div></div>';
  }).join('');

  view.innerHTML = '<div class="page">'
    + '<div class="card mb" id="wzEvalCard">'
    + '<div class="sec-t">粘贴一段 JD，立刻评估匹配度</div>'
    + '<textarea class="inp" id="wzJd" rows="6" placeholder="岗位职责：…&#10;任职要求：…"></textarea>'
    + '<div class="row mt">'
    // 选哪份简历做评估（2026-10-14 用户要求，放在开始评估左边）。
    // 与评估页 #evCvVer 共用同一份会话状态，两边选哪个都同步。
    + '<select class="select" id="wzCvVer" title="用哪份简历做评估">'
    + '<option value="base">原简历</option>'
    + '</select>'
    + '<button class="btn pri" type="button" id="wzEvalNow">开始评估</button>'
    // 说明句已按用户要求删除（2026-10-12）；元素保留（运行中由 paintWzEval 写进度）
    + '<span class="note" id="wzEvalHint"></span>'
    + '</div>'
    + '<p class="hint" id="wzCvVerNote" style="margin:6px 0 0"></p>'
    + '<div id="wzEvalOut"></div>'
    + '</div>'
    + '<div class="sec-t" style="margin:4px 0 12px">历史评估</div>'
    // 虚线占位卡（「跑完整报告（A–H）的岗位会出现在这里 / 初筛结果只在上面那张卡里」）
    // 已按用户要求删除（2026-10-13）：它**常驻**显示 —— 列表满了也挂在末尾，
    // 纯噪音。空列表时这个网格就是空的，与「提升计划」页同一口径
    // （那边 2026-10-11 也删掉了「还没生成」说明）。
    + '<div class="gauto">'
    + cards
    + '</div></div>';

  const ta = $('#wzJd');
  // 上次没发出去的草稿带回来（切页不丢输入 —— 会话原则）
  if (ta && S.wzJdDraft) ta.value = S.wzJdDraft;
  if (ta) ta.addEventListener('input', () => { S.wzJdDraft = ta.value; });
  $('#wzEvalNow').addEventListener('click', () => runWzEval());
  // 简历选择器：灌选项 + 恢复上次选择（会话与评估页共用）
  fillWzCvVerSelect(evalSession(), cvVers);
  $$('[data-wz-go]', view).forEach((b) => b.addEventListener('click', () => go(b.dataset.wzGo)));
  $$('[data-wz-report]', view).forEach((b) => b.addEventListener('click', () => openReport(b.dataset.wzReport)));
  // 删除岗位 = 删除对应评估报告（askDeleteReport 自带确认框，并会点名
  // 「投递记录里引用它的行会一并删除」—— 服务端同一次操作处理）。
  $$('[data-wz-delrep]', view).forEach((b) => b.addEventListener('click', () => askDeleteReport(b.dataset.wzDelrep)));
  // 会话里已有结果/正在跑 → 进入页面立刻补齐（切页回来不丢）
  paintWzEval();
};

// ══ 提升计划 ════════════════════════════════════════════════════
// 2026-10-11 用户要求重做：原来的「每个岗位一张卡 + 点了跳 prep」改成
// prep 工作台同款（下拉选报告 + 选生成方式 + 生成），**计划直接生成本页、
// 结果放在下方** —— 与 prep 页共用同一套会话（S.prep）与渲染（paintPrep），
// 两个页面来回切不丢状态。页头保留岗位总览条（paintPrep 里按 hash 注入）。
VIEWS.growth = async function (view) {
  await VIEWS.prep(view);
};

// ══ 投递记录 ════════════════════════════════════════════════════
// 数据 = /api/tracker（投递台账）。批量投递的执行器仍在 autoapply 页。
VIEWS.applications = async function (view) {
  const t = await api('/api/tracker').catch(() => ({ rows: [] }));
  const rows = (t && Array.isArray(t.rows)) ? t.rows : [];
  const replied = rows.filter((x) => /已回复|已沟通|responded/i.test(x.status || '')).length;
  const viewed = rows.filter((x) => /已查看|已读/i.test(x.status || '')).length;
  const scores = rows.map((x) => wzScoreOf(x.score)).filter((x) => x != null);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : '—';

  const trs = rows.map((r) => '<tr>'
    + '<td><div class="t">' + esc(r.company || '—') + '</div>'
    + '<div class="s">' + esc(r.role || '') + '</div></td>'
    + '<td><div class="s">' + esc(r.date || '—') + '</div></td>'
    + '<td><span class="tag">' + esc(r.score || '—') + '</span></td>'
    + '<td><span class="tag ' + wzStatusCls(r.status) + '">' + esc(r.status || '—') + '</span></td>'
    + '<td><div class="s">' + esc(r.notes || '') + '</div></td>'
    + '<td>' + (r.num ? '<button class="btn sm" type="button" data-wz-delrow="'
      + esc(String(r.num).trim()) + '" aria-label="删除第 ' + esc(String(r.num).trim())
      + ' 行投递记录">删除</button>' : '') + '</td>'
    + '</tr>').join('');

  view.innerHTML = '<div class="page">'
    + '<div class="g4 mb">'
    + '<div class="stat"><div class="n">' + rows.length + '</div><div class="l">累计投递</div></div>'
    + '<div class="stat"><div class="n">' + replied + '</div><div class="l">已回复</div>'
    + '<div class="d">' + (rows.length ? '回复率 ' + Math.round(replied / rows.length * 100) + '%' : '—') + '</div></div>'
    + '<div class="stat"><div class="n">' + viewed + '</div><div class="l">已查看</div></div>'
    + '<div class="stat"><div class="n">' + avg + '</div><div class="l">平均适配度</div></div>'
    + '</div>'
    + (rows.length
      ? '<div class="card"><table><thead><tr><th style="width:26%">岗位</th><th style="width:13%">日期</th>'
        + '<th style="width:11%">适配度</th><th style="width:13%">状态</th><th style="width:29%">备注</th>'
        + '<th style="width:8%"></th>'
        + '</tr></thead><tbody>' + trs + '</tbody></table></div>'
      : '<div class="card"><div class="empty"><div class="ic">→</div><h3>还没有投递记录</h3>'
        + '<p>「自动投递」按关键词与城市读岗位列表、生成投递计划；确认后才真的发送。</p>'
        + '<button class="btn pri" type="button" data-wz-go="autoapply">去自动投递</button></div></div>')
    + '</div>';

  $$('[data-wz-go]', view).forEach((b) => b.addEventListener('click', () => go(b.dataset.wzGo)));
  // 行删除：/api/tracker/delete 吃台账的 # 列（num，纯数字）。移到 data/trash/ 可恢复。
  $$('[data-wz-delrow]', view).forEach((b) => b.addEventListener('click', async () => {
    const num = b.dataset.wzDelrow;
    const row = rows.find((x) => String(x.num).trim() === num) || {};
    const sure = await confirmDialog({
      title: '删除这行投递记录？',
      desc: '「' + (row.company || '（无公司名）') + (row.role ? ' · ' + row.role : '')
        + '」会从台账移到 data/trash/（可恢复）。',
      confirmLabel: '删除记录', danger: true,
    });
    if (!sure) return;
    try {
      await api('/api/tracker/delete', { method: 'POST', body: { num } });
      toast('已删除投递记录第 ' + num + ' 行', 'ok');
      route({ keepScroll: true });
    } catch (err) {
      toast(err.message || '删除失败', 'bad');
    }
  }));
};
