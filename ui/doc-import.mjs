// ui/doc-import.mjs — 把用户本地的文档变成批量初筛能吃的文本（零依赖）
//
//   .docx / .xlsx / .csv / .tsv / .txt / .md  ──►  带 `---` 分隔线的多岗位文本
//
// 为什么在浏览器侧解析（而不是上传给服务端）：
//   1. 文件本来就在用户磁盘上，File API 读进来直接解析 —— 不用上传、不用落盘。
//      简历和岗位这类内容不出本机，和整个项目「本地跑」的定位一致；
//   2. 服务端因此一行都不用改（只是静态白名单多一行）；
//   3. 解析全是纯函数（Uint8Array 进、字符串出），Node 侧可以直接断言，
//      不用起浏览器就能跑自检 —— 和 batch-jd.mjs 一个套路。
//
// 为什么不用 mammoth / xlsx / exceljs 这些现成库：
//   项目 dependencies 只有 playwright / js-yaml / dotenv 三个。为了读纯文本
//   引入两个几百 KB、几十个传递依赖的解析库不划算 —— .docx 和 .xlsx 本质上
//   都是 zip + XML，要拿的又只是文字。内置的 DecompressionStream('deflate-raw')
//   （Chrome 103+ / Node 18+）加一段手写 zip 目录解析就够了。
//
// 能力边界（刻意的，宁可明确说不行也不要猜错）：
//   ✅ .docx   段落 + 标题样式（标题自动当岗位分界）+ 文档内表格（每行一个岗位）
//   ✅ .xlsx   工作表内容 → 按表头语义（公司/岗位/城市/链接/JD）组装岗位块
//   ✅ .csv / .tsv / .txt / .md  自动判编码（UTF-8 / GB18030 / UTF-16LE）
//   ❌ .doc / .xls   旧二进制格式，解析器等于重写 Office —— 指引用户另存为新格式
//   ❌ .pdf   中文 PDF 的文字按字形索引存放，本机解析出来的常是乱码，不假装支持
//
// ⚠️ 本模块被 app.js import（浏览器侧），**必须保持零依赖**：
//    只能 import 同样是零依赖的 batch-jd.mjs，绝不能 import 根目录任何
//    用到 node:fs / js-yaml 的文件，否则浏览器加载整条模块图失败、页面全白。

import { splitBatchJds } from './batch-jd.mjs';

/** <input accept="..."> 用的扩展名串。 */
export const IMPORT_ACCEPT = '.docx,.xlsx,.csv,.tsv,.txt,.md,.text';

/** 单次导入允许的文件大小（单个）。超过多半是拖错了文件（比如整个 zip 包）。 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 解压后单个条目的上限 —— 防「解压炸弹」：一个几十 KB 的 zip 能膨胀到几个 G。 */
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;

/** 解压后所有条目的合计上限。 */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** zip 里最多认多少个条目（正常 docx/xlsx 几百个以内）。 */
const MAX_ZIP_ENTRIES = 4000;

/** 识别出来的岗位块最多多少条 —— 与批量初筛的上限同口径。 */
export const IMPORT_MAX_BLOCKS = 20;

// ── 格式识别 ─────────────────────────────────────────────────────────────

/** 扩展名 → 内部类型。认不出来返回 null。 */
const KINDS = {
  docx: 'docx',
  xlsx: 'xlsx',
  csv: 'csv',
  tsv: 'csv',
  txt: 'text',
  text: 'text',
  md: 'text',
  markdown: 'text',
};

const KIND_LABEL = {
  docx: 'Word 文档',
  xlsx: 'Excel 表格',
  csv: '表格文本',
  text: '纯文本',
};

/** 明确不支持、但要给出「下一步怎么办」的格式。 */
const REJECT = {
  doc: '.doc 是 Word 97 的二进制格式，读不了。用 Word 打开，另存为 .docx 再导入。',
  xls: '.xls 是 Excel 97 的二进制格式，读不了。用 Excel 打开，另存为 .xlsx 再导入。',
  pdf: 'PDF 里的中文是按字形索引存的，本机解析出来常是乱码，所以没有做。'
    + '把正文复制粘贴到上面的框里，或者用 Word 打开 PDF、另存为 .docx 再导入。',
  ppt: '.ppt / .pptx 不像是岗位列表。如果内容在幻灯片里，复制文字粘贴到上面的框里。',
  pptx: '.ppt / .pptx 不像是岗位列表。如果内容在幻灯片里，复制文字粘贴到上面的框里。',
  rtf: '.rtf 读不了。用 Word 打开，另存为 .docx 再导入。',
  odt: '.odt 读不了。用 Word 打开，另存为 .docx 再导入。',
  pages: 'Apple Pages 的文件读不了。导出成 .docx 或 PDF 转文本再导入。',
  zip: '压缩包要先解压，把里面的文档单独拖进来。',
  json: '这是数据文件，不是岗位列表。',
  html: '网页文件读不了。在浏览器里打开后，把岗位正文复制粘贴到上面的框里。',
  htm: '网页文件读不了。在浏览器里打开后，把岗位正文复制粘贴到上面的框里。',
};

/** 取扩展名（小写，不含点）。 */
function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)\s*$/);
  return m ? m[1] : '';
}

/** 文件类型 → 内部类型；不支持的返回 null。 */
export function detectKind(name) {
  return KINDS[extOf(name)] || null;
}

/** 不支持时给用户的一句话（可操作，不是「不支持」三个字）。 */
export function unsupportedHint(name) {
  const ext = extOf(name);
  if (REJECT[ext]) return REJECT[ext];
  if (!ext) return '这个文件没有扩展名，认不出格式。支持 .docx / .xlsx / .csv / .txt / .md。';
  return '.' + ext + ' 不在支持范围。支持 .docx / .xlsx / .csv / .tsv / .txt / .md。';
}

/** 界面上显示的类型名。 */
export function kindLabel(kind) {
  return KIND_LABEL[kind] || '文件';
}

// ── 字节小工具 ───────────────────────────────────────────────────────────

function toU8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new TypeError('需要 Uint8Array 或 ArrayBuffer');
}

const utf8Dec = new TextDecoder('utf-8');

/**
 * 严格解码：字节不是这个编码就抛（TypeError），编码不被运行时支持也抛（RangeError）。
 *
 * ⚠️ 这里**不能**用「catch 到 TypeError 就当成编码不支持、回落 UTF-8」——
 *    fatal 模式下「字节非法」抛的也是 TypeError，两者在类型上分不开。
 *    踩过：GBK 的 CSV 走进这个 catch，被硬当 UTF-8 解出来一整屏乱码，
 *    而调用方看到解码「成功」，于是既没报错也没提示 —— 用户只会觉得
 *    「这软件读我的表格全是问号」。要区分就得靠调用方：先试严格，抛了就换编码。
 */
function strictDecode(u8, enc) {
  return new TextDecoder(enc, { fatal: true }).decode(u8);
}

/** 宽松解码（非法字节变成 U+FFFD）；编码不被支持时回落 UTF-8。 */
function looseDecode(u8, enc) {
  try {
    return new TextDecoder(enc).decode(u8);
  } catch {
    return utf8Dec.decode(u8);
  }
}

/**
 * 文本字节 → 字符串，自动判编码。
 *
 * 顺序：BOM 最可信 → 严格 UTF-8（fatal:true，碰到非法序列就抛）→ GB18030。
 * 为什么不用「数 \uFFFD 的个数」那种启发式：GBK 的中文双字节里含 0x80–0xFF，
 * 硬按 UTF-8 解会产出大量替换符，但**偶尔**也会碰巧解出合法字符，
 * 于是「乱码比例」在临界样本上会判错。严格模式是确定性的：
 * 一个 GBK 文件恰好整个是合法 UTF-8 序列的概率可以忽略。
 * GB18030 而不是 GBK：前者是超集，能把 GBK 和 GB2312 一起覆盖掉。
 *
 * @returns {{text: string, encoding: string}}
 */
export function decodeText(bytes) {
  const u8 = toU8(bytes);
  if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
    return { text: utf8Dec.decode(u8.subarray(3)), encoding: 'UTF-8（带 BOM）' };
  }
  if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
    // Excel 的「另存为 → Unicode 文本」就是这个格式，带 BOM 的 UTF-16LE
    return { text: looseDecode(u8.subarray(2), 'utf-16le'), encoding: 'UTF-16LE' };
  }
  if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
    return { text: looseDecode(u8.subarray(2), 'utf-16be'), encoding: 'UTF-16BE' };
  }
  try {
    return { text: strictDecode(u8, 'utf-8'), encoding: 'UTF-8' };
  } catch { /* 不是合法 UTF-8，往 GB 系试 */ }
  try {
    return { text: strictDecode(u8, 'gb18030'), encoding: 'GB18030/GBK' };
  } catch { /* 也不是 GB 系 */ }
  // 兜底：按 UTF-8 宽松解（会有 U+FFFD，但至少不报错），交给上层提示
  return { text: utf8Dec.decode(u8), encoding: 'UTF-8（有无法识别的字节）' };
}

/** 看起来像二进制（混进了 .zip 改名 .txt 这种事）。 */
function looksBinary(text) {
  if (!text) return false;
  const sample = text.slice(0, 4000);
  let bad = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const c = sample.charCodeAt(i);
    if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad += 1;
  }
  return bad / sample.length > 0.02;
}

// ── zip 读取（够用就好） ─────────────────────────────────────────────────
//
// 只走「中央目录」这条路，不猜本地头：中央目录里有完整的名字、压缩方式、
// 压缩后/原始大小和本地头偏移，是最可靠的一份索引。zip64 直接拒绝 ——
// 我们的单文件上限是 8MB，永远碰不到 zip64（它在 4GB 以上才出现），
// 与其写一套用不上的字段解析，不如明确报错。

const SIG_EOCD = 0x06054b50;      // End of Central Directory
const SIG_CENTRAL = 0x02014b50;   // Central Directory File Header
const SIG_LOCAL = 0x04034b50;     // Local File Header

function findEocd(dv, len) {
  // EOCD 在文件末尾，注释最长 65535，所以往前最多找 22 + 65535 字节
  const stop = Math.max(0, len - 22 - 65535);
  for (let i = len - 22; i >= stop; i -= 1) {
    if (dv.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/** 解压一个 deflate-raw 流，边解边数大小，超限就掐断。 */
async function inflateRaw(data, limit) {
  const ds = new DecompressionStream('deflate-raw');
  const reader = new Blob([data]).stream().pipeThrough(ds).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      try { await reader.cancel(); } catch { /* 已经结束 */ }
      throw Object.assign(new Error('文档解压后过大，已中止'), { code: 'TOO_BIG' });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * 读 zip → Map<条目名, 懒解码函数>。
 *
 * 返回的是「取内容」的函数而不是内容本身：docx/xlsx 里真正要用的通常只有
 * 两三个条目（document.xml / sharedStrings.xml / sheet1.xml），把它们全解压
 * 出来纯属浪费 —— 一份带图片的 docx 里，图片体积占九成。
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {Promise<{names: string[], read: (name: string) => Promise<Uint8Array|null>, has: (name: string) => boolean}>}
 */
export async function unzip(bytes) {
  const u8 = toU8(bytes);
  if (u8.length < 22) throw Object.assign(new Error('文件太小，不是有效的文档'), { code: 'BAD_ZIP' });
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const len = u8.length;

  if (typeof DecompressionStream !== 'function') {
    throw Object.assign(new Error('这个浏览器不支持解压文档（需要较新的 Chrome / Edge）'
      + '，可以先用 Word 打开、把正文复制粘贴到上面的框里'), { code: 'NO_DECOMPRESS' });
  }

  const eocd = findEocd(dv, len);
  if (eocd < 0) throw Object.assign(new Error('不是有效的 .docx / .xlsx（没找到压缩包目录）'), { code: 'BAD_ZIP' });

  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff === 0xFFFFFFFF || count === 0xFFFF) {
    throw Object.assign(new Error('这个文档用了 zip64 格式（通常因为体积很大），读不了'), { code: 'ZIP64' });
  }
  if (cdOff + cdSize > len || cdOff < 0) {
    throw Object.assign(new Error('文档结构损坏（压缩包目录越界）'), { code: 'BAD_ZIP' });
  }

  const entries = new Map();
  let p = cdOff;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > len || dv.getUint32(p, true) !== SIG_CENTRAL) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    // 条目名基本是 ASCII（word/document.xml 这类）；中文名的 zip 不走这条路
    const name = utf8Dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, localOff });
    p += 46 + nameLen + extraLen + cmtLen;
    if (entries.size > MAX_ZIP_ENTRIES) {
      throw Object.assign(new Error('压缩包里条目太多，不像是一个正常文档'), { code: 'BAD_ZIP' });
    }
  }

  let spent = 0;
  const cache = new Map();

  async function read(name) {
    if (cache.has(name)) return cache.get(name);
    const e = entries.get(name);
    if (!e) { cache.set(name, null); return null; }
    const lo = e.localOff;
    if (lo + 30 > len || dv.getUint32(lo, true) !== SIG_LOCAL) {
      throw Object.assign(new Error('文档结构损坏（条目头不对）'), { code: 'BAD_ZIP' });
    }
    // 本地头的名字/扩展区长度可能和中央目录不一致，必须按本地头算数据起点
    const nameLen = dv.getUint16(lo + 26, true);
    const extraLen = dv.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    if (start + e.compSize > len) {
      throw Object.assign(new Error('文档结构损坏（条目越界）'), { code: 'BAD_ZIP' });
    }
    const raw = u8.subarray(start, start + e.compSize);
    let out;
    if (e.method === 0) {
      out = raw;                                  // stored，没压缩
    } else if (e.method === 8) {
      out = await inflateRaw(raw, MAX_ENTRY_BYTES);
    } else {
      throw Object.assign(new Error('文档用了不认识的压缩方式（' + e.method + '）'), { code: 'BAD_ZIP' });
    }
    spent += out.length;
    if (spent > MAX_TOTAL_BYTES) {
      throw Object.assign(new Error('文档解压后过大，已中止'), { code: 'TOO_BIG' });
    }
    cache.set(name, out);
    return out;
  }

  return { names: [...entries.keys()], read, has: (n) => entries.has(n) };
}

// ── XML 小工具 ───────────────────────────────────────────────────────────

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML 实体 → 字符（含数字实体，中文标点常被写成 &#xxxx;）。 */
export function decodeXml(s) {
  return String(s ?? '').replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(XML_ENT, e) ? XML_ENT[e] : m;
  });
}

/** 取标签属性值（双引号、单引号、无引号都认）。 */
function attrOf(tag, name) {
  if (!tag) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('\\s' + esc + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s/>]+))').exec(tag);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
}

/** 把所有 `<t>` 文本片段拼起来（docx 的 <w:t> / xlsx 的 <t> 都适用）。 */
function joinedText(inner, tagRe) {
  let out = '';
  const re = new RegExp('<' + tagRe + '(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</' + tagRe + '>)', 'g');
  let m;
  while ((m = re.exec(inner))) {
    if (m[1]) out += decodeXml(m[1]);
  }
  return out;
}

// ── .docx → 文本 ─────────────────────────────────────────────────────────

/** 段落属性 → 标题级别（0 = 正文）。Word / WPS / 中文版三套命名都要认。 */
function headingLevel(ppr) {
  if (!ppr) return 0;
  const st = /<w:pStyle[^>]*\bw:val=["']([^"']*)["']/.exec(ppr);
  if (st) {
    const v = st[1].trim();
    let m = /^heading\s*([1-9])$/i.exec(v) || /^标题\s*([1-9])$/.exec(v);
    if (m) return Number(m[1]);
    // WPS 和中文版 Word 会把内置标题样式的 styleId 直接写成数字
    if (/^[1-9]$/.test(v)) return Number(v);
    if (/^(title|标题)$/i.test(v)) return 1;
  }
  // 没绑样式但挂了大纲级别（用「大纲视图」排的文档会这样）
  const ol = /<w:outlineLvl[^>]*\bw:val=["'](\d)["']/.exec(ppr);
  if (ol) return Math.min(9, Number(ol[1]) + 1);
  return 0;
}

/** 一个 <w:p> 的内容 → {text, level}。 */
function paragraphOf(inner) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:(tab|br|cr)(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(inner))) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[2] === 'tab') out += '\t';
    else out += '\n';                 // <w:br/> 软换行、<w:cr/> 硬回车
  }
  // 段落属性只取第一个 pPr（正文里的 pPr 只在段首出现）
  const ppr = (/<w:pPr(?:\s[^>]*)?>([\s\S]*?)<\/w:pPr>/.exec(inner) || [])[1] || '';
  return { text: out.replace(/\s+$/, ''), level: headingLevel(ppr) };
}

/** 表格（<w:tbl>）→ 行列矩阵。单元格里的软换行折成空格，避免把一行撑散。 */
function tableOf(inner) {
  const rows = [];
  const trRe = /<w:tr(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:tr>)/g;
  let tr;
  while ((tr = trRe.exec(inner))) {
    const cells = [];
    const tcRe = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
    let tc;
    while ((tc = tcRe.exec(tr[1] || ''))) {
      const pRe = /<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
      let p;
      const lines = [];
      while ((p = pRe.exec(tc[1]))) lines.push(paragraphOf(p[1] || '').text);
      cells.push(lines.join(' ').replace(/\s+/g, ' ').trim());
    }
    rows.push(cells);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/**
 * .docx → 多岗位文本。
 *
 * 文档里两种「分界信号」都会被翻译成 `---`：
 *   · 标题样式的段落（Word 里把「标题 1」当岗位名是最自然的写法）
 *   · 表格（每行一个岗位；首行若是表头就按表头语义组装）
 * 都没有的话，整篇就是一块 —— 这时上层会提示用户怎么加分隔，
 * 而不是我们替他猜哪里是岗位边界。
 */
export async function docxToText(bytes) {
  const zip = await unzip(bytes);
  const main = await zip.read('word/document.xml');
  if (!main) {
    throw Object.assign(new Error('这个 .docx 里没有正文（可能是损坏的文件，或只是模板）'), { code: 'NO_BODY' });
  }
  const xml = utf8Dec.decode(main);
  const bodyStart = xml.indexOf('<w:body');
  const body = bodyStart >= 0 ? xml.slice(bodyStart) : xml;

  // 一次扫描把「表格」和「段落」按出现顺序切出来 —— 顺序不能丢，
  // 否则文档里「岗位标题在前、岗位表在后」这种结构会被拼错。
  const re = /<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:p>)/g;
  const pieces = [];
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      const rows = tableOf(m[1]);
      if (rows.length) pieces.push({ kind: 'table', rows });
    } else {
      const p = paragraphOf(m[2] || '');
      if (p.text.trim() !== '') pieces.push({ kind: 'para', ...p });
    }
  }

  const warnings = [];
  const out = [];          // 已拼好的块（不含分隔线）
  let buf = [];            // 当前块的行

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out.push(text);
    buf = [];
  };

  let headingCount = 0;
  let tableBlocks = 0;
  for (const pc of pieces) {
    if (pc.kind === 'para') {
      if (pc.level > 0) {
        // 标题 = 新岗位的开头。第一个标题前面不加分隔线。
        flush();
        headingCount += 1;
      }
      buf.push(pc.text);
      continue;
    }
    // 表格：两列以上、两行以上，按「每行一个岗位」展开
    const dataRows = hasHeaderRow(pc.rows) ? pc.rows.slice(1) : pc.rows;
    if (pc.rows.length >= 2 && Math.max(...pc.rows.map((r) => r.length)) >= 2) {
      if (dataRows.length && dataRows.some((r) => r.some((c) => c))) {
        flush();                       // 表格自己成块，不和前后段落混在一起
        const header = hasHeaderRow(pc.rows) ? pc.rows[0] : null;
        for (const line of rowsToBlocks(header, dataRows)) out.push(line);
        tableBlocks += dataRows.length;
        continue;
      }
    }
    for (const r of pc.rows) buf.push(r.join('\t'));
  }
  flush();

  const text = out.join('\n---\n').trim();
  if (!out.length) warnings.push('文档里没读到文字（可能内容都在图片里）。');
  if (out.length === 1 && text.length > 2000 && !headingCount) {
    warnings.push('这篇文档没找到标题样式，也没有分隔线，整个当成了一个岗位。'
      + '想按岗位拆开：在 Word 里用「标题 1」样式标出每个岗位名（或者手动加一行 ---）。');
  }
  if (tableBlocks) warnings.push('文档里的表格按「一行一个岗位」展开了，共 ' + tableBlocks + ' 行。');

  return { text, warnings, meta: { headings: headingCount, tableRows: tableBlocks } };
}

// ── .xlsx → 文本 ─────────────────────────────────────────────────────────

const siRe = /<si(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/si>)/g;
const cRe = /<c(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/c>)/g;
const rowRe = /<row(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g;

/** A1 / BC12 → 列索引（0 起）。 */
export function colIndex(ref) {
  let n = 0;
  for (const ch of String(ref || '').toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** sharedStrings.xml → 字符串数组（富文本的多个 run 要拼起来）。 */
function parseSharedStrings(xml) {
  const out = [];
  siRe.lastIndex = 0;
  let m;
  while ((m = siRe.exec(xml))) out.push(joinedText(m[1] || '', 't'));
  return out;
}

/** 一张 worksheet → 行列矩阵。空格子按坐标补齐，列不会错位。 */
function parseSheet(xml, shared) {
  const rows = [];
  rowRe.lastIndex = 0;
  let r;
  while ((r = rowRe.exec(xml))) {
    const cells = [];
    cRe.lastIndex = 0;
    let c;
    let auto = 0;
    while ((c = cRe.exec(r[1] || ''))) {
      const tag = c[0].slice(0, c[0].indexOf('>') + 1);
      const type = attrOf(tag, 't');
      const ref = attrOf(tag, 'r');
      const at = ref ? colIndex(ref) : auto;
      auto = at + 1;
      const inner = c[1] || '';
      let val = '';
      if (type === 's') {
        const v = (/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        const i = Number(decodeXml(v || '').trim());
        val = Number.isInteger(i) && i >= 0 && i < shared.length ? shared[i] : '';
      } else if (type === 'inlineStr') {
        val = joinedText(inner, 't');
      } else if (type === 'b') {
        const v = (/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        val = String(decodeXml(v || '')).trim() === '1' ? '是' : '否';
      } else {
        const v = (/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
        val = v === undefined ? '' : decodeXml(v);
      }
      cells[at >= 0 ? at : cells.length] = String(val).trim();
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows.filter((row) => row.some((v) => v !== ''));
}

/** rId → 工作表路径（workbook.xml 里给的是 rId，真实路径在 rels 里）。 */
function sheetTargets(workbookXml, relsXml) {
  const rels = new Map();
  const relRe = /<Relationship(?:\s[^>]*)?\/?>/g;
  let m;
  while ((m = relRe.exec(relsXml))) {
    const id = attrOf(m[0], 'Id');
    const target = attrOf(m[0], 'Target');
    if (id && target) rels.set(id, target);
  }
  const sheets = [];
  const shRe = /<sheet(?:\s[^>]*)?\/?>/g;
  while ((m = shRe.exec(workbookXml))) {
    const name = attrOf(m[0], 'name');
    if (!name) continue;
    const rid = attrOf(m[0], 'r:id') || attrOf(m[0], 'id');
    sheets.push({ name: decodeXml(name), target: rid ? rels.get(rid) : null });
  }
  return sheets;
}

/** 把 rels 里的相对路径规整成 zip 里的条目名（xl/worksheets/sheet1.xml）。 */
function normTarget(target) {
  if (!target) return null;
  let t = String(target).replace(/\\/g, '/').replace(/^\/+/, '');
  if (t.startsWith('xl/')) return t;
  if (t.startsWith('../')) return t.replace(/^\.\.\//, '');
  return 'xl/' + t;
}

/** .xlsx → {sheets:[{name, rows}]}（全部工作表，顺序与文件里一致）。 */
export async function xlsxToSheets(bytes) {
  const zip = await unzip(bytes);
  const sharedBytes = await zip.read('xl/sharedStrings.xml');
  const shared = sharedBytes ? parseSharedStrings(utf8Dec.decode(sharedBytes)) : [];
  const wbBytes = await zip.read('xl/workbook.xml');
  const relBytes = await zip.read('xl/_rels/workbook.xml.rels');
  const list = wbBytes ? sheetTargets(utf8Dec.decode(wbBytes), relBytes ? utf8Dec.decode(relBytes) : '') : [];

  const sheets = [];
  if (list.length) {
    for (const s of list) {
      const p = normTarget(s.target);
      const b = p ? await zip.read(p) : null;
      if (!b) continue;
      const rows = parseSheet(utf8Dec.decode(b), shared);
      if (rows.length) sheets.push({ name: s.name, rows });
    }
  }
  if (!sheets.length) {
    // workbook.xml 缺失或结构怪：退而求其次，直接扫 xl/worksheets/ 下的所有表
    const names = zip.names.filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort();
    for (const n of names) {
      const b = await zip.read(n);
      if (!b) continue;
      const rows = parseSheet(utf8Dec.decode(b), shared);
      if (rows.length) sheets.push({ name: n.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''), rows });
    }
  }
  if (!sheets.length) {
    throw Object.assign(new Error('这个 .xlsx 里没有读到内容（可能整张表是空的，或只有图表）'), { code: 'NO_BODY' });
  }
  return sheets;
}

// ── 表格 → 岗位块（docx 表格与 xlsx 共用） ───────────────────────────────

// 列名 → 语义。**顺序即优先级**，因为关键词会互相包含：
// 「岗位职责」既含「岗位」也含「职责」—— 如果 title 规则排在 body 前面，
// 就会把整整一段职责正文当成岗位名。所以 body 必须排在 title 前。
const COL_RULES = [
  { key: 'company', re: /(公司|单位|企业|机构|集团|company|employer|organi[sz]ation)/i,
    neg: /(介绍|简介|规模|性质|文化|福利|地址|电话|官网|邮箱)/ },
  { key: 'body', re: /(jd|岗位描述|职位描述|工作描述|职位详情|岗位详情|工作内容|岗位职责|职位职责|职责|任职要求|任职资格|岗位要求|职位要求|招聘要求|要求|描述|详情|介绍|说明|responsib|requirement|qualification|description|duty)/i,
    neg: /(名称|标题)/ },
  { key: 'city', re: /(城市|地点|工作地|所在地|地区|base|location|city|region)/i },
  { key: 'link', re: /(链接|网址|url|link|投递|申请|apply|jobs?\.|href)/i },
  { key: 'title', re: /(岗位|职位|职务|标题|工种|position|job\s*title|role|title)/i,
    neg: /(描述|职责|要求|详情|说明)/ },
];

// 「有其他列」里的噪声列：这些对初筛没用，还会把每块撑得很长。
const NOISE_COL = /^(序号|编号|no\.?|index|操作|是否|备注|备注说明|状态|进度|score|status|note|remark|id)$/i;

/** 表头行？—— 至少有一个非空单元格命中语义规则。 */
export function hasHeaderRow(rows) {
  if (!rows || !rows.length) return false;
  const cells = rows[0].map((c) => String(c || '').trim());
  if (!cells.some((c) => c)) return false;
  // 表头单元格都很长 → 更像是数据行（真正表头的列名是短词）
  if (cells.some((c) => c.length > 30)) return false;
  return cells.some((c) => COL_RULES.some((r) => r.re.test(c) && !(r.neg && r.neg.test(c))));
}

/** 表头 → 每个语义列对应的列号（找不到为 -1）。 */
export function mapColumns(header) {
  const map = {};
  for (const rule of COL_RULES) map[rule.key] = -1;
  const used = new Set();
  (header || []).forEach((cell, i) => {
    const name = String(cell || '').trim();
    if (!name) return;
    for (const rule of COL_RULES) {
      if (map[rule.key] !== -1) continue;
      if (used.has(i)) continue;
      if (rule.re.test(name) && !(rule.neg && rule.neg.test(name))) {
        map[rule.key] = i;
        used.add(i);
        return;
      }
    }
  });
  return map;
}

/** 单元格值里带换行时当多行文本用（Excel 里一个格塞一整段 JD 是常态）。 */
function cellLines(v) {
  return String(v ?? '').replace(/\r\n/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * 表格行 → 岗位块文本（每块用 `---` 分隔，喂给 splitBatchJds 正好）。
 *
 * 每块的第一行放「公司 · 岗位」，因为 splitBatchJds 拿首行当标签，
 * 而初筛/完整评估都要靠这一行认公司和岗位方向。
 */
export function rowsToBlocks(header, rows) {
  const cols = header ? mapColumns(header) : {};
  const known = new Set(Object.values(cols).filter((i) => i >= 0));
  const hasSemantic = known.size > 0;
  const out = [];

  for (const row of rows) {
    const val = (key) => (cols[key] >= 0 ? String(row[cols[key]] ?? '').trim() : '');
    const lines = [];

    let head = [val('company'), val('title')].filter(Boolean).join(' · ');
    if (!head) {
      // 没识别出公司/岗位列：拿该行第一个非空单元格当标题
      head = String(row.find((c) => String(c ?? '').trim()) ?? '').trim();
    }
    if (head) lines.push(head);

    if (val('city')) lines.push('城市：' + val('city'));
    if (val('link')) lines.push('链接：' + val('link'));

    if (hasSemantic) {
      // 语义之外但有用的列，作为「列名：值」补在后面
      (header || []).forEach((name, i) => {
        if (known.has(i)) return;
        const raw = String(row[i] ?? '').trim();
        if (!raw) return;
        const label = String(name || '').trim();
        if (!label || NOISE_COL.test(label)) return;
        if (label === head) return;
        lines.push(label + '：' + raw);
      });
    } else {
      // 一列都没认出来：把除标题外的单元格按顺序铺开
      row.forEach((c, i) => {
        const raw = String(c ?? '').trim();
        if (!raw || i === 0 || raw === head) return;
        lines.push(raw);
      });
    }

    if (val('body')) lines.push(...cellLines(val('body')));

    const block = lines.join('\n').trim();
    if (block) out.push(block);
    if (out.length >= IMPORT_MAX_BLOCKS) break;
  }
  return out;
}

// ── .csv / .tsv → 行列 ───────────────────────────────────────────────────

/**
 * 极简 CSV 解析（RFC4180 的核心部分）：双引号包裹、引号内换行与分隔符、
 * 连续两个引号表示一个字面引号。够覆盖 Excel / WPS「另存为 CSV」的所有输出。
 */
export function parseDelimited(text, delimiter) {
  const src = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else { quoted = false; }
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  const cleaned = rows
    .map((r) => r.map((c) => String(c).trim()))
    .filter((r) => r.some((c) => c !== ''));
  return cleaned;
}

/** 猜分隔符：制表符优先（.tsv 或 Excel 复制的都是 Tab）。 */
function guessDelimiter(text, name) {
  if (extOf(name) === 'tsv') return '\t';
  const head = String(text).slice(0, 4000);
  const tabs = (head.match(/\t/g) || []).length;
  const commas = (head.match(/,/g) || []).length;
  const semis = (head.match(/;/g) || []).length;
  if (tabs >= 1 && tabs >= commas) return '\t';
  if (semis > commas) return ';';
  return ',';
}

// ── 统一入口 ─────────────────────────────────────────────────────────────

/** 把解析出的块拼成最终文本，并统计「切出几块」。 */
function finish(text, warnings, meta) {
  // 统一换行再往下走。Windows 导出的 CSV/TXT 大量是 \r\n，虽然 splitBatchJds
  // 和 textarea 都能吃 \r\n，但混着两种换行时导出的 Markdown 会出现「一行变两行」，
  // 而且「识别出几个岗位」的提示会随换行风格漂移。一次归一，下游只剩一种情况。
  const norm = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  const parsed = splitBatchJds(norm);
  const blocks = parsed.total;
  if (parsed.truncated) {
    warnings.push('识别出 ' + blocks + ' 个岗位，超过一次最多 ' + IMPORT_MAX_BLOCKS + ' 个的上限，只保留了前 '
      + IMPORT_MAX_BLOCKS + ' 个。');
  }
  return {
    // 超限时截断再返回：否则文本框里留着 20 条之后的岗位，用户会以为它们也会跑
    text: parsed.items.length === blocks ? norm : parsed.items.map((i) => i.jd).join('\n---\n'),
    blocks: parsed.items.length,
    totalBlocks: blocks,
    warnings,
    meta,
  };
}

/**
 * 一个文件 → 批量初筛能吃的文本。
 *
 * 永远不抛「未知错误」：解析不了就返回 {ok:false, error, hint}，
 * 由界面直接显示给用户（这是用户自己拖进来的文件，必须告诉他为什么不行）。
 *
 * @param {string} name 文件名（含扩展名）
 * @param {Uint8Array|ArrayBuffer} bytes
 */
export async function parseDocument(name, bytes) {
  const kind = detectKind(name);
  const u8 = toU8(bytes);

  if (!kind) {
    return { ok: false, name, kind: null, error: unsupportedHint(name) };
  }
  if (u8.length === 0) {
    return { ok: false, name, kind, error: '这个文件是空的。' };
  }
  if (u8.length > MAX_FILE_BYTES) {
    return {
      ok: false, name, kind,
      error: '文件有 ' + (u8.length / 1048576).toFixed(1) + ' MB，超过 '
        + (MAX_FILE_BYTES / 1048576) + ' MB 的上限。岗位列表通常几百 KB 以内，检查一下是不是拖错了文件。',
    };
  }

  try {
    if (kind === 'docx') {
      const r = await docxToText(u8);
      const fin = finish(r.text, r.warnings, { ...r.meta, kind });
      if (!fin.text) return { ok: false, name, kind, error: '文档里没读到文字（内容可能都在图片里）。' };
      return { ok: true, name, kind, encoding: '', ...fin };
    }

    if (kind === 'xlsx') {
      const sheets = await xlsxToSheets(u8);
      const warnings = [];
      const parts = [];
      let rowsSeen = 0;
      sheets.forEach((sh, i) => {
        const header = hasHeaderRow(sh.rows) ? sh.rows[0] : null;
        const data = header ? sh.rows.slice(1) : sh.rows;
        const blocks = rowsToBlocks(header, data);
        if (!blocks.length) return;
        rowsSeen += blocks.length;
        // 多个工作表时把表名写进第一块，否则两张表的内容会被当成同一批岗位
        if (sheets.length > 1) warnings.push('第 ' + (i + 1) + ' 张表「' + sh.name + '」读到 ' + blocks.length + ' 行。');
        parts.push(blocks.join('\n---\n'));
      });
      if (!parts.length) return { ok: false, name, kind, error: '表格里没读到内容（可能是空表）。' };
      const fin = finish(parts.join('\n---\n'), warnings, { kind, sheets: sheets.length, rows: rowsSeen });
      return { ok: true, name, kind, encoding: '', ...fin };
    }

    // csv / tsv / txt / md
    const { text, encoding } = decodeText(u8);
    if (looksBinary(text)) {
      return { ok: false, name, kind, error: '这个文件不是文本（可能有二进制内容）。检查一下扩展名对不对。' };
    }
    const warnings = [];
    let outText = text.replace(/^\uFEFF/, '');
    let meta = { kind };

    if (kind === 'csv') {
      const rows = parseDelimited(outText, guessDelimiter(outText, name));
      const wide = rows.length && Math.max(...rows.map((r) => r.length)) >= 2;
      if (wide && rows.length >= 2) {
        const header = hasHeaderRow(rows) ? rows[0] : null;
        const data = header ? rows.slice(1) : rows;
        const blocks = rowsToBlocks(header, data);
        if (!header) {
          warnings.push('没认出行标题，按「每行一个岗位」处理（首列当作岗位名）。'
            + '把第一行写成 公司 / 岗位 / 城市 / JD 这样的列名会更准。');
        }
        outText = blocks.join('\n---\n');
        meta = { kind, rows: blocks.length, header: header ? header.join(' / ') : null };
      } else {
        // 单列或没有表格结构：当成已经用 --- 分好块的纯文本
        meta = { kind, rows: 1 };
      }
    }

    const fin = finish(outText, warnings, meta);
    if (!fin.text) return { ok: false, name, kind, error: '文件里没读到内容。' };
    return { ok: true, name, kind, encoding, ...fin };
  } catch (err) {
    const map = {
      BAD_ZIP: '文件结构损坏，或者扩展名和真实格式对不上（比如把 .zip 改名成 .docx）。用 Word / Excel 重新另存一次试试。',
      ZIP64: '这个文档体积很大，用了 zip64 打包，读不了。把内容拆小一点再导入。',
      TOO_BIG: '文档解压后太大，已中止。检查一下是不是拖错了文件。',
      NO_BODY: '文档里没找到正文。',
      NO_DECOMPRESS: err.message,
    };
    return { ok: false, name, kind, error: map[err.code] || ('读不了这个文件：' + (err.message || '未知错误')) };
  }
}

/**
 * 多个文件的结果 → 一份文本。
 *
 * 每个文件内部已经用 `---` 分好块了，这里直接把各文件的结果首尾相接：
 * splitBatchJds 会把「连续两条分隔线」产生的空块丢掉，所以不用去重拼接符。
 * 第二个文件起，块名前加上文件名前缀 —— 否则「岗位1.docx + 岗位2.docx」
 * 在结果表里长得一模一样，用户分不清哪行来自哪个文件。
 */
export function mergeImports(results) {
  const ok = results.filter((r) => r.ok && r.text);
  if (!ok.length) return { text: '', blocks: 0, warnings: [], files: 0 };
  const warnings = [];
  const parts = [];
  ok.forEach((r, i) => {
    let t = r.text;
    if (i > 0 && t) {
      const base = String(r.name).replace(/\.[^.]+$/, '');
      // 只给第一块加前缀：这是「这批来自哪个文件」的标记，不是给每个岗位改名
      const firstNl = t.indexOf('\n');
      t = (firstNl < 0 ? t : base + '（' + t.slice(0, firstNl) + '）' + t.slice(firstNl));
    }
    parts.push(t);
    if (r.warnings && r.warnings.length) warnings.push(...r.warnings.map((w) => r.name + '：' + w));
  });
  const joined = parts.join('\n---\n');
  const parsed = splitBatchJds(joined);
  if (parsed.truncated) {
    warnings.push('合计识别出 ' + parsed.total + ' 个岗位，超过一次最多 ' + IMPORT_MAX_BLOCKS
      + ' 个的上限，只保留了前 ' + IMPORT_MAX_BLOCKS + ' 个。');
  }
  return {
    text: parsed.items.map((i) => i.jd).join('\n---\n'),
    blocks: parsed.items.length,
    totalBlocks: parsed.total,
    warnings,
    files: ok.length,
  };
}
