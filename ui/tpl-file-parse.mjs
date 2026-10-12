// ui/tpl-file-parse.mjs — 「上传文件导入简历模板」的解析器（零依赖，浏览器侧）
//
//   .pdf / .doc / .docx  ──►  统一模板结构 { sections:[{ title, items:[{kind,text}] }] }
//   kind ∈ heading（标题）/ field（字段名）/ placeholder（占位符）/ paragraph（段落）
//
// 为什么在浏览器侧解析而不是上传给服务端（与 doc-import.mjs 同一套论证）：
//   文件本来就在用户磁盘上，File API 读进来直接解析 —— 内容不出本机、服务端
//   不用碰 multipart、解析纯函数可离线断言。确认导入时提交的是**解析后的结构
//   数据**而不是文件本体，服务端只负责校验 + 指纹查重 + 落盘。
//
// 与 doc-import.mjs 口径的关系：那边对 .pdf / .doc 写着「不支持」，是针对
// **岗位 JD 文本** —— 乱码会静默毒化初筛数据，宁可拒绝。模板导入不一样：
//   ① 有第 3 步「预览识别结果、人工校正后确认」兜底（产品需求明确要求），
//   ② 结构是给人看、供后续按模板生成骨架用的，错几行可以当场改。
// 所以这里对 PDF/.doc 做**尽力解析**：能提就提、提不出就明确说为什么不行，
// 绝不静默交一坨乱码给用户。
//
// ⚠️ 本模块被 app.js import（浏览器侧），**必须保持零依赖**：
//    只能 import 同为零依赖的 doc-import.mjs（用它的 unzip / decodeXml）。

import { unzip, decodeXml } from './doc-import.mjs';

/** <input accept="..."> 串与文案。图片模板（png/jpg/...）走本机 OCR 分支。 */
export const TPL_FILE_ACCEPT = '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.bmp,.gif';
export const TPL_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];

/** 单文件大小上限（需求口径 20MB）。前端读取前拦一道，服务端结构上限另算。 */
export const TPL_FILE_MAX_BYTES = 20 * 1024 * 1024;

/** 解析时间预算：超过就中止并给出明确提示（需求 5：大文件解析超时）。 */
export const TPL_PARSE_TIME_BUDGET = 12000;

/** 结构上限（前端截断、服务端同样校验 —— 两层防御）。 */
export const STRUCTURE_MAX_SECTIONS = 60;
export const STRUCTURE_MAX_ITEMS = 400;
export const STRUCTURE_MAX_ITEM_CHARS = 600;
export const STRUCTURE_MAX_CHARS = 48000;

/** item 类型 → 中文（界面徽标 + 服务端校验共用）。 */
export const TPL_ITEM_KINDS = ['heading', 'field', 'placeholder', 'paragraph'];
export const TPL_KIND_ZH = {
  heading: '标题', field: '字段', placeholder: '占位符', paragraph: '段落',
};

// ── 进度读取（FileReader，读的是本机文件，进度条反映读取+阶段） ──────────

/**
 * 读 File → { name, size, bytes }。onProgress(0-100) 反映读取进度。
 * 读取失败给明确中文提示（文件被占用/权限等）。
 */
export function readTplFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onprogress = (e) => {
      if (e.lengthComputable && typeof onProgress === 'function') {
        onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      }
    };
    fr.onload = () => {
      if (typeof onProgress === 'function') onProgress(100);
      resolve({ name: file.name, size: file.size, bytes: new Uint8Array(fr.result) });
    };
    fr.onerror = () => reject(Object.assign(new Error('文件读取失败：文件可能正被其他程序占用，或没有读取权限。'), { code: 'READ_FAIL' }));
    fr.readAsArrayBuffer(file);
  });
}

/** 解析前的客户端校验：类型 + 大小。返回 null 或 {code, error}。 */
export function tplFilePreflight(name, size) {
  const ext = (String(name || '').toLowerCase().match(/\.([a-z0-9]+)\s*$/) || [])[1] || '';
  const isImage = TPL_IMAGE_EXTS.includes(ext);
  if (!isImage && !['pdf', 'doc', 'docx'].includes(ext)) {
    return {
      code: 'UNSUPPORTED',
      error: '不支持的文件格式：只支持 PDF（.pdf）、Word（.doc / .docx）与图片'
        + '（.png / .jpg / .webp / .bmp / .gif），收到的是 .' + (ext || '（无扩展名）') + '。',
    };
  }
  if (size > TPL_FILE_MAX_BYTES) {
    return { code: 'TOO_LARGE', error: '文件有 ' + (size / 1048576).toFixed(1) + ' MB，超过 20 MB 的上限。简历模板一般不到 1 MB，检查一下是不是选错了文件。' };
  }
  return null;
}

/**
 * 图片字节 → 缩放后的 PNG Blob（最长边 ≤ maxSide）。
 * 超大图 OCR 又慢又差；缩不动的（老浏览器）返回 null → 上层送原图。
 * 底色铺白：JPEG/带透明的图转 PNG 后黑底会毁掉识别。
 */
export async function downscaleTplImage(bytes, maxSide = 2600) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  let bmp;
  try { bmp = await createImageBitmap(new Blob([bytes])); } catch { return null; }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  if (scale >= 1) { if (bmp.close) bmp.close(); return null; }
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

// ── 时间预算小工具 ───────────────────────────────────────────────────────

function budgetGuard(budgetMs) {
  const t0 = Date.now();
  return () => {
    if (Date.now() - t0 > budgetMs) {
      throw Object.assign(new Error('文件太大、解析超时已中止（限时 '
        + Math.round(budgetMs / 1000) + ' 秒）。试试内容少一些的文件。'), { code: 'TIMEOUT' });
    }
  };
}

// ── .docx：zip + document.xml → 带样式的段落序列 ─────────────────────────

/** pPr → 标题级别（与 doc-import.mjs 同一套识别：Heading N / 标题 N / 大纲级别）。 */
function docxHeadingLevel(ppr) {
  if (!ppr) return 0;
  const st = /<w:pStyle[^>]*\bw:val=["']([^"']*)["']/.exec(ppr);
  if (st) {
    const v = st[1].trim();
    const m = /^heading\s*([1-9])$/i.exec(v) || /^标题\s*([1-9])$/.exec(v);
    if (m) return Number(m[1]);
    if (/^[1-9]$/.test(v)) return Number(v);
    if (/^(title|标题)$/i.test(v)) return 1;
  }
  const ol = /<w:outlineLvl[^>]*\bw:val=["'](\d)["']/.exec(ppr);
  if (ol) return Math.min(9, Number(ol[1]) + 1);
  return 0;
}

/** 一个 <w:p> → {text, level}（w:t 拼接 + tab/br 处理）。 */
function docxParagraph(inner) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:(tab|br|cr)(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(inner))) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[2] === 'tab') out += '\t';
    else out += '\n';
  }
  const ppr = (/<w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>/.exec(inner) || [])[1] || '';
  return { text: out.replace(/\s+$/, ''), level: docxHeadingLevel(ppr) };
}

/** .docx → 有序段落（标题带级别；表格按行摊平成段落，行内以「 / 」连接）。 */
async function docxParagraphs(bytes, tick) {
  const zip = await unzip(bytes);
  const main = await zip.read('word/document.xml');
  if (!main) {
    throw Object.assign(new Error('这个 .docx 里没有正文（文件可能损坏，或只是一个空壳）。'), { code: 'NO_BODY' });
  }
  const utf8 = new TextDecoder('utf-8');
  const xml = utf8.decode(main);
  const bodyStart = xml.indexOf('<w:body');
  const body = bodyStart >= 0 ? xml.slice(bodyStart) : xml;

  const out = [];
  const re = /<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
  let m;
  while ((m = re.exec(body))) {
    tick();
    if (m[1] !== undefined) {
      // 表格：每行摊成一个段落（模板里表格常用来排「字段名：值」）
      const trRe = /<w:tr(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:tr>)/g;
      let tr;
      while ((tr = trRe.exec(m[1]))) {
        const tcRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
        let tc;
        const cells = [];
        while ((tc = tcRe.exec(tr[1] || ''))) {
          const pRe = /<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
          let p;
          const lines = [];
          while ((p = pRe.exec(tc[1]))) lines.push(docxParagraph(p[1] || '').text);
          cells.push(lines.join(' ').replace(/\s+/g, ' ').trim());
        }
        if (cells.some((c) => c)) out.push({ text: cells.join(' / '), level: 0 });
      }
    } else {
      const p = docxParagraph(m[2] || '');
      if (p.text.trim() !== '') out.push(p);
    }
  }
  return out;
}

// ── .pdf：尽力提取文字（Flate 解压 + ToUnicode CMap + 十六进制串） ────────

/** 字节 → latin1 字符串（分块拼接，避免 apply 栈溢出）。 */
function bytesToLatin1(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return s;
}

/** zlib(FlateDecode) 解压，带上限。 */
async function inflateZlib(data, limit) {
  const ds = new DecompressionStream('deflate');
  const reader = new Blob([data]).stream().pipeThrough(ds).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { try { await reader.cancel(); } catch { /* 已结束 */ } return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/** ToUnicode CMap → Map<hex码, 字符串>（bfchar + bfrange，模板 PDF 够用）。 */
function parseCmap(text) {
  const map = new Map();
  const bfChar = /beginbfchar([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfChar.exec(text))) {
    const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pair.exec(m[1]))) map.set(p[1].toUpperCase(), hexToText(p[2]));
  }
  const bfRange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfRange.exec(text))) {
    const row = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = row.exec(m[1]))) {
      const lo = parseInt(p[1], 16);
      const hi = Math.min(parseInt(p[2], 16), lo + 65535);
      const dst = hexToText(p[3]);
      const step = dst.length ? [...dst].length : 1;
      // dst 是单字符时逐码递增；多字符（数组形式才合法，这里少见）就整串复用
      for (let c = lo, i = 0; c <= hi && i < 65536; c += 1, i += 1) {
        map.set(c.toString(16).toUpperCase().padStart(p[1].length, '0'), step === 1 ? [...dst][i % [...dst].length] : dst);
      }
    }
  }
  return map;
}

/** 十六进制串 → 文本：优先按 UTF-16BE（中文 PDF 导出的常见目标编码），否则 latin1。 */
function hexToText(hex) {
  const h = (hex || '').replace(/\s+/g, '');
  if (!h) return '';
  const bytes = [];
  for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
  // 长度是 4 的倍数且高字节大多非零 → UTF-16BE
  if (h.length % 4 === 0 && bytes.length >= 1 && bytes.filter((b) => b !== 0).length) {
    const hasHigh = bytes.length % 2 === 0 && bytes.some((b, i) => i % 2 === 0 && b > 0 && b < 0xff);
    if (hasHigh || /[\u4e00-\u9fff\u3000-\u303f]/.test(new TextDecoder('utf-16be').decode(new Uint8Array(bytes)))) {
      try { return new TextDecoder('utf-16be').decode(new Uint8Array(bytes)); } catch { /* 落 latin1 */ }
    }
  }
  return bytes.map((b) => String.fromCharCode(b)).join('');
}

/** 字面串 (…) 的转义还原。 */
function unescapePdfLiteral(s) {
  return String(s || '')
    .replace(/\\([0-7]{1,3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b').replace(/\\f/g, '\f')
    .replace(/\\([()\\])/g, '$1');
}

/** 内容流 → 文本行（认 (...)Tj、[..(…)..]TJ、hex串Tj；Td/TD/T*、ET 换行）。 */
function textFromContent(content, cmap) {
  let out = '';
  const re = /\[((?:\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|[^\]])*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*Tj|<([0-9A-Fa-f\s]+)>\s*Tj|(T\*|Td|TD|ET|BT)/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) {
      // TJ 数组：把里面的字面串依次取出
      const inner = /<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^\\()])*)\)/g;
      let s;
      while ((s = inner.exec(m[1]))) {
        out += s[1] !== undefined ? cmapDecode(s[1], cmap) : unescapePdfLiteral(s[2]);
      }
    } else if (m[2] !== undefined) {
      out += unescapePdfLiteral(m[2]);
    } else if (m[3] !== undefined) {
      out += cmapDecode(m[3], cmap);
    } else {
      out += '\n';
    }
  }
  return out;
}

function cmapDecode(hexRaw, cmap) {
  const h = (hexRaw || '').replace(/\s+/g, '').toUpperCase();
  if (!h) return '';
  if (cmap && cmap.size) {
    // 先按整串查（ToUnicode 多字节码），再按 2/4 位逐段查
    if (cmap.has(h)) return cmap.get(h);
    const width = [...cmap.keys()].reduce((w, k) => Math.max(w, k.length), 2);
    let out = '';
    for (let i = 0; i + width <= h.length; i += width) {
      const piece = h.slice(i, i + width);
      out += cmap.has(piece) ? cmap.get(piece) : hexToText(piece);
    }
    const rest = h.length % width;
    if (rest) out += hexToText(h.slice(h.length - rest));
    return out;
  }
  return hexToText(h);
}

/** .pdf → 段落序列。加密/扫描件/提取不出 → 明确报错。 */
async function pdfParagraphs(bytes, tick) {
  const head = bytesToLatin1(bytes.subarray(0, 1024));
  if (!head.startsWith('%PDF')) {
    throw Object.assign(new Error('这个文件不是有效的 PDF（文件头不对，可能扩展名和真实格式对不上）。'), { code: 'BAD_PDF' });
  }
  const latin = bytesToLatin1(bytes);
  if (/\/Encrypt\b/.test(latin)) {
    throw Object.assign(new Error('这个 PDF 已加密，读不了内容。请先解除密码（用 PDF 阅读器「另存为」不带密码的版本）再上传。'), { code: 'ENCRYPTED' });
  }
  if (typeof DecompressionStream !== 'function') {
    throw Object.assign(new Error('这个浏览器不支持解压 PDF 流（需要较新的 Chrome / Edge）。'), { code: 'NO_DECOMPRESS' });
  }

  // 对象流：dict + stream…endstream
  const objRe = /(\d+)\s+\d+\s+obj\b/g;
  const contents = [];
  const cmaps = [];
  let m;
  const marks = [];
  while ((m = objRe.exec(latin))) marks.push(m.index);
  for (let i = 0; i < marks.length; i += 1) {
    tick();
    const start = marks[i];
    const end = i + 1 < marks.length ? latin.indexOf('endobj', start) : latin.indexOf('endobj', start);
    if (end < 0) break;
    const body = latin.slice(start, end);
    const sIdx = body.indexOf('stream');
    if (sIdx < 0) continue;
    const dict = body.slice(0, sIdx);
    let dataStart = sIdx + 'stream'.length;
    if (body[dataStart] === '\r') dataStart += 1;
    if (body[dataStart] === '\n') dataStart += 1;
    const eIdx = body.lastIndexOf('endstream');
    if (eIdx < dataStart) continue;
    const rawLatin = body.slice(dataStart, eIdx);
    // latin1 串 → 字节（charCode ≤ 0xff 恒成立）
    const raw = new Uint8Array(rawLatin.length);
    for (let j = 0; j < rawLatin.length; j += 1) raw[j] = rawLatin.charCodeAt(j) & 0xff;

    let text = null;
    if (/\/FlateDecode\b/.test(dict)) {
      const inf = await inflateZlib(raw, 32 * 1024 * 1024);
      if (!inf) continue;
      text = bytesToLatin1(inf);
    } else if (!/\/Filter\b/.test(dict)) {
      text = rawLatin; // 未压缩的内容流
    }
    if (text == null) continue;
    if (/beginbfchar|beginbfrange/.test(text) || /\/ToUnicode/.test(dict)) {
      if (/beginbfchar|beginbfrange/.test(text)) cmaps.push(parseCmap(text));
    }
    if (/\/Type\s*\/(Page|XObject)/.test(dict) || /\bTj\b|\bTJ\b|\bBT\b/.test(text)) {
      contents.push(text);
    }
  }

  // 多套 CMap 时合并（后面的覆盖前面 —— 同码冲突极少见）
  const cmap = new Map();
  for (const c of cmaps) for (const [k, v] of c) cmap.set(k, v);

  const lines = [];
  for (const c of contents) {
    tick();
    const t = textFromContent(c, cmap);
    for (const line of t.split('\n')) {
      const s = line.replace(/\s+/g, ' ').trim();
      if (s) lines.push(s);
    }
  }

  // 乱码体检：非 ASCII 里 CJK 占比过低 → 提醒（不拦截，人工校正兜底）
  const warnings = [];
  const all = lines.join('');
  const nonAscii = all.replace(/[\x00-\x7f]/g, '');
  const cjk = (nonAscii.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) || []).length;
  if (nonAscii.length >= 20 && cjk / nonAscii.length < 0.3) {
    warnings.push('这份 PDF 的字体映射比较少见，提取结果可能乱码；请在校对步骤里核对，失真严重建议改传 .docx。');
  }
  if (!all || all.replace(/\s/g, '').length < 10) {
    throw Object.assign(new Error('从这个 PDF 里提取不到文字 —— 它多半是扫描件 / 图片型 PDF。'
      + '请改用文字版 PDF，或把内容整理进 Word（.docx）后重新上传。'), { code: 'NO_TEXT' });
  }
  return { paragraphs: lines.map((t) => ({ text: t, level: 0 })), warnings };
}

// ── .doc：老二进制格式的尽力提取 ─────────────────────────────────────────

/**
 * .doc 的完整解析等于重写 Office，这里只做「文本捞取」：
 * 扫 UTF-16LE 连续可读片段（Word 的 WordDocument 流里正文常以 UTF-16LE 存），
 * 辅以单字节 ASCII 片段。能捞出正文就交给人工校正；捞不出就明确指路 .docx。
 */
function docParagraphs(bytes, tick) {
  const magic = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  const isOle = magic.every((b, i) => bytes[i] === b);
  if (!isOle) {
    throw Object.assign(new Error('这个文件不是有效的 .doc（文件头不对，可能扩展名和真实格式对不上）。'), { code: 'BAD_DOC' });
  }
  const printable = (c) => (c >= 0x20 && c <= 0x7e) || (c >= 0x4e00 && c <= 0x9fff)
    || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) || c === 0x2014 || c === 0x2018
    || c === 0x2019 || c === 0x201c || c === 0x201d || c === 0x2026 || c === 0x00b7;
  const runs = [];
  let buf = '';
  const n = Math.min(bytes.length, 24 * 1024 * 1024);
  for (let i = 0; i + 1 < n; i += 2) {
    tick();
    const c = bytes[i] | (bytes[i + 1] << 8);
    if (printable(c)) {
      buf += String.fromCharCode(c);
    } else if (c === 0x000d || c === 0x0007) {
      if (buf.trim()) runs.push(buf.trim());
      buf = '';
    } else if (buf) {
      if (buf.trim()) runs.push(buf.trim());
      buf = '';
    }
    if (runs.length > 4000) break;
  }
  if (buf.trim()) runs.push(buf.trim());

  const text = runs.join('\n');
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (text.replace(/\s/g, '').length < 30) {
    throw Object.assign(new Error('这个 .doc 里没能可靠地提取出文字（老版二进制格式的通病）。'
      + '请用 Word 打开它，另存为 .docx 后重新上传 —— .docx 的解析是完整可靠的。'), { code: 'DOC_WEAK' });
  }
  return {
    paragraphs: runs.map((t) => ({ text: t, level: 0 })),
    warnings: ['.doc 是老版二进制格式，这里是尽力提取（识别到 ' + cjk + ' 个汉字）；'
      + '请在校对步骤里核对识别结果，失真严重建议另存为 .docx 重新上传。'],
  };
}

// ── 条目分类 + 结构组装 ──────────────────────────────────────────────────

const PLACEHOLDER_RE = /(【[^】]{1,24}】|\{\{[^}]{1,40}\}\}|_{3,}|\[[^\[\]]{2,20}\])/;
const FIELD_RE = /^[^\s：:，。]{1,14}[：:](\s*\S{0,40})?$/;

/** 一段文字 → 条目类型。标题只认显式样式；正文里带占位符/字段样式的单独标出。 */
export function classifyTplItem(text, headingLevel) {
  const t = String(text || '').trim();
  if (headingLevel > 0 && t.length <= 60) return 'heading';
  if (PLACEHOLDER_RE.test(t)) return 'placeholder';
  if (FIELD_RE.test(t) && t.length <= 40) return 'field';
  return 'paragraph';
}

/** 编辑行的类型（预览编辑器用）：h1/h2 是分节标题，h3 是节内小标题。 */
export const TPL_ROW_KINDS = ['h1', 'h2', 'h3', 'field', 'placeholder', 'paragraph'];
const ROW_KIND_TO_ITEM = { h3: 'heading', field: 'field', placeholder: 'placeholder', paragraph: 'paragraph' };

/**
 * 编辑后的行 → 统一结构（与 buildTplStructure 同一套分节逻辑）：
 * h1/h2 开新 section，h3 作为 heading 条目留在节内。
 */
export function tplRowsToStructure(rows) {
  const sections = [];
  let cur = null;
  let totalChars = 0;
  let itemCount = 0;
  for (const r of rows || []) {
    if (!r || !TPL_ROW_KINDS.includes(r.kind)) continue;
    const text = String(r.text || '').replace(/\s+/g, ' ').trim().slice(0, STRUCTURE_MAX_ITEM_CHARS);
    if (!text) continue;
    if (r.kind === 'h1' || r.kind === 'h2') {
      cur = { title: text.slice(0, 80), items: [] };
      sections.push(cur);
      totalChars += text.length;
      continue;
    }
    if (!cur) { cur = { title: '', items: [] }; sections.push(cur); }
    if (itemCount >= STRUCTURE_MAX_ITEMS || sections.length > STRUCTURE_MAX_SECTIONS) break;
    cur.items.push({ kind: ROW_KIND_TO_ITEM[r.kind], text });
    itemCount += 1;
    totalChars += text.length;
    if (totalChars > STRUCTURE_MAX_CHARS) {
      throw Object.assign(new Error('模板内容太大（超过 48000 字），请精简后再导入。'), { code: 'TOO_BIG' });
    }
  }
  const cleaned = sections.filter((s) => s.items.length || s.title);
  if (!cleaned.length) {
    throw Object.assign(new Error('校正后的模板结构是空的（至少保留一行内容）。'), { code: 'EMPTY' });
  }
  return { sections: cleaned };
}

/**
 * 有序段落 → 统一结构：1/2 级标题开新 section，其余进当前 section；
 * 3 级以下标题作为 heading 条目留在 section 内。全部截断到上限。
 */
export function buildTplStructure(paragraphs) {
  const rows = [];
  for (const p of paragraphs) {
    const level = p.level || 0;
    const kind = classifyTplItem(p.text, level);
    if (kind === 'heading') {
      rows.push({ kind: level <= 2 ? (level === 1 ? 'h1' : 'h2') : 'h3', text: p.text });
    } else {
      rows.push({ kind, text: p.text });
    }
  }
  return tplRowsToStructure(rows);
}

// ── 统一入口 ─────────────────────────────────────────────────────────────

/**
 * 一个模板文件 → 解析结果。
 * 成功：{ ok:true, kind, structure, warnings }
 * 失败：{ ok:false, code, error, hint } —— error/hint 都是可直接展示的中文。
 */
export async function parseTplFile(name, bytes) {
  const ext = (String(name || '').toLowerCase().match(/\.([a-z0-9]+)\s*$/) || [])[1] || '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const tick = budgetGuard(TPL_PARSE_TIME_BUDGET);

  if (!u8.length) return { ok: false, code: 'EMPTY_FILE', error: '这个文件是空的。' };

  try {
    let paragraphs = [];
    let warnings = [];
    let kind = ext;

    if (ext === 'docx') {
      // 扩展名说 docx，但真实格式要对上（PK 魔数在 unzip 里验）
      paragraphs = await docxParagraphs(u8, tick);
    } else if (ext === 'pdf') {
      const r = await pdfParagraphs(u8, tick);
      paragraphs = r.paragraphs;
      warnings = r.warnings;
    } else if (ext === 'doc') {
      const r = docParagraphs(u8, tick);
      paragraphs = r.paragraphs;
      warnings = r.warnings;
    } else {
      return { ok: false, code: 'UNSUPPORTED', error: '不支持的文件格式：只支持 PDF（.pdf）与 Word（.doc / .docx）。' };
    }

    if (!paragraphs.length) {
      return { ok: false, code: 'NO_BODY', error: '文件里没读到文字（内容可能都在图片里）。' };
    }
    const structure = buildTplStructure(paragraphs);
    return { ok: true, kind, structure, warnings };
  } catch (err) {
    const map = {
      BAD_ZIP: '文件结构损坏，或扩展名和真实格式对不上（比如把别的文件改成了 .docx）。用 Word 重新另存一次试试。',
      ZIP64: '这个文档体积很大、用了 zip64 打包，读不了。请精简内容后重试。',
      TOO_BIG: err.message,
      TIMEOUT: err.message,
      NO_DECOMPRESS: err.message,
      ENCRYPTED: err.message,
      NO_TEXT: err.message,
      BAD_PDF: err.message,
      BAD_DOC: err.message,
      DOC_WEAK: err.message,
      NO_BODY: err.message,
      EMPTY: err.message,
    };
    return {
      ok: false,
      code: err.code || 'PARSE_FAIL',
      error: map[err.code] || ('解析失败：' + (err.message || '未知错误')),
      hint: err.code === 'PARSE_FAIL' ? '换个文件试试（PDF / Word 的解析成功率更高）。' : '',
    };
  }
}

/** 结构 → 指纹（canonical JSON 的 SHA-256 hex）。同内容模板查重用。 */
export async function tplStructureFingerprint(structure) {
  const canonical = JSON.stringify(
    (structure && structure.sections || []).map((s) => ({
      t: (s.title || '').trim(),
      i: (s.items || []).map((it) => [it.kind, it.text]),
    })),
  );
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
