// ui/tpl-docx-view.mjs — docx 模板的保真渲染（2026-09-30；当晚升级 PDF 主路线）
//
// 为什么有这个模块：模板库此前的「样式」只是 base+accent 两枚令牌，docx 里
// 真正的字体/字号/颜色/行距/缩进在解析阶段就被丢掉了 —— 导入什么样式、库里
// 就是另一副样子。现在模板可以携带**原文件**（/api/tpl/file/:id），渲染层把
// 原文件画出来 —— 导入什么样，库里和预览就是什么样。
//
// 两级渲染路线（主 → 回落）：
//   ① PDF 主路线：/api/tpl/pdf/:id（服务端用本机 Word/WPS COM 把原 docx 转
//      PDF，见 ui/tpl-pdf-convert.mjs），前端 pdf.js 把每页画成 canvas →
//      PNG dataURL，以 <img> 注入 Shadow DOM。文艺/活泼系列模板的正文全在
//      「文本框」里、配图全是锚定浮动图，docx-preview 渲染不出（实测文字
//      全堆到页外、52 张图只出 2 张），只有这条路线能真正保真。
//   ② docx-preview 回落：本机没有 Word/WPS、PDF 转换失败时，退回 docx-preview
//      直接解析 docx（简单模板可用，复杂模板可能显示不全 —— 有总比空白好）。
//
// 三条硬约束（对应「样式保真」需求）：
//   ① 强绑定：每次渲染先把 host 清空（replaceChildren），再决定注入什么 ——
//      上一份模板的 DOM/shadow/样式一丝一毫都不留；快速切换用 runId 丢弃过期结果。
//   ② 样式隔离：每份模板渲染进**自己的 Shadow DOM**，样式跟着进 shadow，
//      跨模板互不影响，更不会污染页面全局样式。
//   ③ 缓存按模板各存各的：key=路线:模板id。PDF 路线缓存「解析句柄 + 逐页
//      渲染产物」—— 同一模板的卡缩略（首页）与预览（全部页）共享同一份缓存。
//
// 零依赖浏览器模块：不 import 项目内任何 Node 侧模块、不用 node:*；
// 只用 window.* / fetch / DOM。会话 token 直接读 localStorage（与 app.js
// 启动逻辑同源，探针种 localStorage 也自然生效）。

const DOCX_PAGE_W = 794; // A4 @96dpi 的像素宽（docx-preview 默认页面宽）
const PDF_REF_W = 780;   // PDF 页渲染的基准逻辑宽（卡缩略/预览共用，CSS 再缩放）

// cacheKey → pdf { kind:'pdf', doc, total, sizes, imgs:Map } / docx { kind:'docx', css, bodyHtml }
const cache = new Map();

export function isDocxRendererReady() {
  if (pdfLib()) return true;
  return !!(window.JSZip && window.docx && typeof window.docx.renderAsync === 'function');
}

export function clearDocxCache() { cache.clear(); }

function pdfLib() {
  return window['pdfjs-dist/build/pdf'] || window.pdfjsLib || null;
}

function sessionToken() {
  try {
    const s = JSON.parse(localStorage.getItem('lizhuo.session') || 'null');
    return (s && s.token) || '';
  } catch { return ''; }
}

async function fetchBytes(url) {
  const r = await fetch(url, { headers: { 'x-lizhuo-token': sessionToken() } });
  if (!r.ok) {
    let msg = '模板原文件获取失败（HTTP ' + r.status + '）';
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch { /* 非 JSON */ }
    throw new Error(msg);
  }
  return r.arrayBuffer();
}

/* ── ① PDF 主路线（模板原样，库卡缩略/原貌弹窗用）──────────────────────── */

async function getPdfEntry(tplId) {
  const key = 'pdf:' + tplId;
  if (cache.has(key)) return cache.get(key);
  if (!pdfLib()) throw new Error('pdf.js 未加载');
  const bytes = await fetchBytes('/api/tpl/pdf/' + encodeURIComponent(String(tplId)));
  const doc = await pdfLib().getDocument({ data: bytes }).promise;
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: Math.ceil(vp.width), h: Math.ceil(vp.height) });
  }
  const entry = { kind: 'pdf', doc, total: doc.numPages, sizes, imgs: new Map() };
  cache.set(key, entry);
  return entry;
}

/* ── ⓪ fill 内容填充路线（模板原样排版 + 用户简历内容，2026-09-30）─────── */

// 服务端把模板示例值 Find & Replace 成用户真实值后转 PDF（ui/tpl-fill-convert.mjs，
// Word COM 保字符样式）。缓存 key 必须带 X-Fill-Hash：表单一改 hash 就变，
// 同 key 秒回、新 key 触发服务端重合成。
async function fetchFill(tplId) {
  const r = await fetch('/api/tpl/fill/' + encodeURIComponent(String(tplId)),
    { headers: { 'x-lizhuo-token': sessionToken() } });
  if (!r.ok) {
    let msg = '合成预览获取失败（HTTP ' + r.status + '）';
    try { const j = await r.json(); if (j && j.error) msg = j.error; } catch { /* 非 JSON */ }
    throw new Error(msg);
  }
  const hash = r.headers.get('x-fill-hash') || '';
  // 2026-10-04：把服务端的诊断信息带出来 —— 容量守护裁掉了哪些条目、模板里
  // 有哪些字段表单还没入口。预览页据此提示用户，不再"静默丢内容"。
  const dec = (v) => { try { return v ? decodeURIComponent(v) : ''; } catch { return v || ''; } };
  let slots = {};
  try { slots = JSON.parse(dec(r.headers.get('x-fill-slots') || '')) || {}; } catch { /* 头坏了不影响渲染 */ }
  const info = {
    dropped: dec(r.headers.get('x-fill-dropped') || ''),
    unmapped: dec(r.headers.get('x-fill-unmapped') || ''),
    skillEmpty: !!slots.skillEmpty,
  };
  const bytes = await r.arrayBuffer();
  return { bytes, hash, info };
}

async function getFillEntry(tplId) {
  if (!pdfLib()) throw new Error('pdf.js 未加载');
  const first = await fetchFill(tplId);
  const key = 'fill:' + tplId + ':' + first.hash;
  const hit = cache.get(key);
  if (hit) { hit.info = first.info; return { entry: hit, key, info: first.info }; }
  const doc = await pdfLib().getDocument({ data: first.bytes }).promise;
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: Math.ceil(vp.width), h: Math.ceil(vp.height) });
  }
  const entry = { kind: 'pdf', doc, total: doc.numPages, sizes, imgs: new Map(), info: first.info };
  cache.set(key, entry);
  return { entry, key, info: first.info };
}

/** 渲染第 n 页为 PNG dataURL（按模板缓存；canvas 用完即释放位图内存）。 */
async function renderPdfPageImg(entry, n) {
  if (entry.imgs.has(n)) return entry.imgs.get(n);
  const pg = await entry.doc.getPage(n);
  const vp1 = pg.getViewport({ scale: 1 });
  const dpr = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1) + 0.25);
  const vp = pg.getViewport({ scale: Math.max(0.2, (PDF_REF_W / vp1.width) * dpr) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  await pg.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
  const url = canvas.toDataURL('image/png');
  canvas.width = 0;
  canvas.height = 0;
  entry.imgs.set(n, url);
  return url;
}

const PDF_CSS = `
  .pdf-pages { display: block; }
  .pdf-page { display: block; width: 100%; margin: 0 0 8px; background: #fff; }
  .pdf-page:last-child { margin-bottom: 0; }
`;

/** PDF 类 entry（原样/fill 共用）的逐页渲染与注入。 */
async function paintPdfPages(host, entry, opts, myRun) {
  if (host.__docxRunId !== myRun) throw new Error('stale');
  const fit = opts.fit || 'all';
  const pages = [];
  const want = fit === 'firstPage' ? [1] : Array.from({ length: entry.total }, (_, i) => i + 1);
  for (const n of want) {
    pages.push(await renderPdfPageImg(entry, n));
    if (host.__docxRunId !== myRun) throw new Error('stale');
  }
  // 注入：全新 shadow，只装这一份模板的页图（img 宽 100% → 高度自适应，无需手动收高）
  host.replaceChildren();
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.replaceChildren();
  const style = document.createElement('style');
  style.textContent = PDF_CSS;
  const wrap = document.createElement('div');
  wrap.className = 'pdf-pages';
  wrap.innerHTML = pages
    .map((u, i) => `<img class="pdf-page" alt="模板第 ${i + 1} 页" src="${u}">`)
    .join('');
  shadow.append(style, wrap);
}

async function renderViaPdf(host, tplId, opts, myRun) {
  const entry = await getPdfEntry(tplId);
  await paintPdfPages(host, entry, opts, myRun);
}

async function renderViaFillPdf(host, tplId, opts, myRun) {
  const { entry, info } = await getFillEntry(tplId);
  await paintPdfPages(host, entry, opts, myRun);
  return { info };
}

/* ── ② docx-preview 回落 ─────────────────────────────────────────────── */

/** 一次解析：离屏渲染 → 抽出 <style> 文本与正文 HTML（不留在页面上）。 */
async function renderToEntry(bytes) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:860px;visibility:hidden;';
  document.body.appendChild(holder);
  try {
    const shadow = holder.attachShadow({ mode: 'open' });
    const body = document.createElement('div');
    shadow.appendChild(body);
    await window.docx.renderAsync(bytes, body, shadow, {
      inWrapper: true,
      breakPages: true,
      useBase64URL: true, // 图片转 data URL —— HTML 字符串缓存重注入不失效
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      experimental: true, // 文本框等非流式内容的尽力渲染
      trimXmlDeclaration: true,
    });
    let css = '';
    shadow.querySelectorAll('style').forEach((s) => { css += s.textContent + '\n'; });
    return { css, bodyHtml: body.innerHTML };
  } finally {
    holder.remove();
  }
}

/** 缩放适配：按 host 可用宽把 docx 页面等比缩小；fit='firstPage' 只露首页。 */
function fitScale(shadow, host, fit) {
  const wrap = shadow.querySelector('.docx-wrapper');
  if (!wrap) return;
  const pages = wrap.querySelectorAll('section.docx');
  const hostW = host.clientWidth || DOCX_PAGE_W;
  const naturalW = pages[0] ? pages[0].offsetWidth : DOCX_PAGE_W;
  const scale = Math.min(1, hostW / (naturalW || DOCX_PAGE_W));
  wrap.style.transformOrigin = 'top left';
  wrap.style.transform = 'scale(' + scale + ')';
  // transform 不改布局 —— host 高度要按缩放后手动收
  const naturalH = (fit === 'firstPage' && pages[0])
    ? pages[0].offsetHeight
    : wrap.scrollHeight;
  wrap.style.marginBottom = '0';
  host.style.height = Math.ceil(naturalH * scale) + 'px';
}

async function renderViaDocxPreview(host, tplId, opts, myRun) {
  const key = 'docx:' + tplId;
  let entry = cache.get(key);
  if (!entry) {
    const bytes = await fetchBytes('/api/tpl/file/' + encodeURIComponent(String(tplId)));
    if (host.__docxRunId !== myRun) throw new Error('stale');
    entry = await renderToEntry(bytes);
    if (host.__docxRunId !== myRun) throw new Error('stale');
    cache.set(key, entry);
  }
  // 注入：全新 shadow，只装这一份模板的样式与正文
  host.replaceChildren();
  const shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
  shadow.replaceChildren();
  const style = document.createElement('style');
  style.textContent = entry.css;
  const wrap = document.createElement('div');
  wrap.innerHTML = entry.bodyHtml;
  shadow.append(style, wrap);
  fitScale(shadow, host, opts.fit || 'all');
}

/* ── 对外入口 ─────────────────────────────────────────────────────────── */

/**
 * 把 docx 模板渲染进 host（宿主元素内部挂 Shadow DOM）。
 * 路线由 opts.route 决定：
 *   'original'（默认）PDF 原样（Word/WPS COM 转换 + pdf.js）→ docx-preview → 抛错。
 *     —— 库卡缩略、模板原貌弹窗用：展示模板本身的示例内容。
 *   'fill' 合成预览（服务端把示例值替换成用户真实值后转 PDF）→ 失败直接
 *     返回 { ok:false }，**不回落 docx-preview**（复杂模板必然显示不全，
 *     调用方应回落色系版式）—— 简历页实时预览用。
 *   opts.fit   'firstPage' | 'all'               卡片缩略只露首页；预览整份展示
 * 返回 { ok, fromCache, via } 或 { ok:false, error }。
 */
export async function renderDocxTemplate(host, tplId, opts = {}) {
  if (!host) return { ok: false, error: '渲染容器不存在' };
  if (!isDocxRendererReady()) {
    return { ok: false, error: 'docx 渲染引擎未加载（检查 /pdf.min.js 与 /docx-preview.min.js）' };
  }

  // ① 强绑定第一步：先清空。host 里的旧 DOM、旧 shadow 全部丢弃。
  host.replaceChildren();
  const runId = (host.__docxRunId = (host.__docxRunId || 0) + 1);
  const myRun = runId;
  host.style.height = '';

  const stale = { ok: false, error: 'stale' };
  try {
    if (opts.route === 'fill') {
      const r = await renderViaFillPdf(host, tplId, opts, myRun);
      return { ok: true, via: 'fill', info: r && r.info };
    }
    await renderViaPdf(host, tplId, opts, myRun);
    return { ok: true, via: 'pdf' };
  } catch (errPdf) {
    if (errPdf && errPdf.message === 'stale') return stale;
    if (opts.route === 'fill') {
      host.replaceChildren();
      return { ok: false, error: (errPdf && errPdf.message) || '合成预览失败' };
    }
    try {
      await renderViaDocxPreview(host, tplId, opts, myRun);
      return { ok: true, via: 'docx-preview' };
    } catch (errDocx) {
      if (errDocx && errDocx.message === 'stale') return stale;
      host.replaceChildren();
      return { ok: false, error: (errDocx && errDocx.message) || (errPdf && errPdf.message) || 'docx 渲染失败' };
    }
  }
}
