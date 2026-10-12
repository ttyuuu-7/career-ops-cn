#!/usr/bin/env node
// ui/check-doc-import.mjs — 文档导入的自检
//
// 为什么必须有：文档解析出错的方式**全是「看起来正常」的**。
//   · 编码判错 → 满屏问号，但程序认为解码成功，界面不报错；
//   · 表格列认错 → 「岗位职责」被当成岗位名，正文整段消失；
//   · 标题没认出来 → 十几个岗位糊成一条，初筛只给一个分数；
//   · zip 结构读歪 → 报个看不懂的异常，用户以为是自己文件坏了。
// 这些都不能靠肉眼点一遍发现，所以逐条钉住。
//
// A 段：纯函数（自己现造 zip，零浏览器、零服务、零 token，秒级）
// B 段：真实文件跑真实界面（需要 127.0.0.1:7317 上有服务；没有就跳过并提示）
//
// 用法：node ui/check-doc-import.mjs
import fs from 'node:fs';
import path from 'node:path';

import {
  detectKind, unsupportedHint, kindLabel, decodeText, unzip,
  docxToText, xlsxToSheets, rowsToBlocks, mapColumns, hasHeaderRow,
  parseDelimited, parseDocument, mergeImports, colIndex, decodeXml,
  IMPORT_MAX_BLOCKS, MAX_FILE_BYTES,
} from './doc-import.mjs';

const fails = [];
const ok = (cond, msg) => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fails.push(msg);
};
const eq = (a, b, msg) => ok(a === b, msg + '（实际 ' + JSON.stringify(a) + '）');
const contains = (hay, needle, msg) => ok(String(hay).includes(needle),
  msg + (String(hay).includes(needle) ? '' : '（实际：' + String(hay).slice(0, 160) + '）'));

const ROOT = path.resolve(import.meta.dirname, '..');
const SAMPLE_DIR = path.join(ROOT, 'output', 'import-evidence', 'samples');
const enc = new TextEncoder();

// ── 自己造 zip（A 段的样本不能依赖外部文件） ─────────────────────────────
// 用内置 CompressionStream 压 deflate-raw，再手写 zip 的本地头/中央目录/EOCD。
// 顺带证明了「reader 读得懂标准 zip」而不是只认得某个固定形状。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i += 1) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function deflateRaw(u8) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(u8);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const comp = await deflateRaw(data);
    const crc = crc32(data);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, 0x21, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);
    locals.push(lh, comp);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    centrals.push(ch);

    offset += lh.length + comp.length;
  }
  const cdSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of locals) { out.set(c, p); p += c.length; }
  for (const c of centrals) { out.set(c, p); p += c.length; }
  out.set(eocd, p);
  return out;
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const wp = (text, style) => '<w:p>'
  + (style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : '')
  + '<w:r><w:t xml:space="preserve">' + text + '</w:t></w:r></w:p>';
const wdocx = (body) => makeZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: '<w:document xmlns:w="' + W_NS + '"><w:body>' + body + '</w:body></w:document>' },
]);

console.log('\n══ A 段：纯函数 ══');

console.log('\n── A1. 认格式，不认的要给「怎么办」 ──');
eq(detectKind('岗位列表.docx'), 'docx', '.docx 认');
eq(detectKind('岗位列表.XLSX'), 'xlsx', '大写扩展名也认');
eq(detectKind('a.csv'), 'csv', '.csv 认');
eq(detectKind('a.tsv'), 'csv', '.tsv 当表格');
eq(detectKind('a.md'), 'text', '.md 认');
eq(detectKind('a.pdf'), null, '.pdf 不认（不做假支持）');
{
  const h1 = unsupportedHint('简历.doc');
  contains(h1, '另存为', '.doc 的提示告诉用户另存为 .docx');
  const h2 = unsupportedHint('jd.pdf');
  contains(h2, '复制', '.pdf 的提示给出可行的替代动作');
  const h3 = unsupportedHint('真相.zip');
  contains(h3, '解压', '.zip 提示先解压');
  const h4 = unsupportedHint('表.abc');
  contains(h4, '.docx', '未知格式的提示里列出支持的类型');
  eq(kindLabel('docx'), 'Word 文档', '类型中文名');
}

console.log('\n── A2. 编码：UTF-8 / BOM / GBK / UTF-16 ──');
{
  const s = '岗位名称：后端开发工程师\n公司：华为';
  eq(decodeText(enc.encode(s)).text, s, 'UTF-8 原样解出');
  eq(decodeText(enc.encode(s)).encoding, 'UTF-8', '编码名标 UTF-8');

  // 记事本「另存为 UTF-8」会加 BOM，不去掉的话第一个岗位名会多一个隐形字符
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF, ...enc.encode(s)]);
  eq(decodeText(bom).text, s, 'UTF-8 BOM 被剥掉（否则首个岗位名前面挂隐形字符）');

  // 中文 Windows 的 Excel「另存为 CSV」默认就是 GBK —— 这一条最容易出事：
  // 硬按 UTF-8 解不会报错，只会得到满屏问号，而且程序认为成功
  const gbk = Uint8Array.from([
    0xB9, 0xAB, 0xCB, 0xBE, 0x2C, 0xB8, 0xDA, 0xCE, 0xBB, 0x0A, // 公司,岗位\n
    0xBB, 0xAA, 0xCE, 0xAA, 0x2C, 0xBA, 0xF3, 0xB6, 0xCB,       // 华为,后端
  ]);
  const g = decodeText(gbk);
  eq(g.text, '公司,岗位\n华为,后端', 'GBK 字节正确解出中文（不是问号）');
  eq(g.encoding, 'GB18030/GBK', '编码名标 GB18030/GBK');

  const u16 = Buffer.from('\uFEFF' + s, 'utf16le');
  const r16 = decodeText(new Uint8Array(u16));
  eq(r16.text, s, 'Excel「Unicode 文本」的 UTF-16LE + BOM 能读');
  eq(r16.encoding, 'UTF-16LE', '编码名标 UTF-16LE');
}

console.log('\n── A3. zip 与 .docx ──');
{
  const zip = await makeZip([{ name: 'a.txt', data: '内容甲' }, { name: 'b.txt', data: '内容乙' }]);
  const z = await unzip(zip);
  eq(z.names.length, 2, '读到 2 个条目');
  eq(new TextDecoder().decode(await z.read('a.txt')), '内容甲', '条目内容正确');
  eq(await z.read('不存在'), null, '读不存在的条目返回 null 而不是抛错');
  eq(await z.read('b.txt') !== null, true, '按需解压：没读过的条目也能拿到');

  const docx = await wdocx(
    wp('字节跳动 · 后端开发', 'Heading1')
    + wp('工作地点：西安')
    + wp('任职要求：熟悉 Java。')
    + wp('腾讯 · 后台开发', 'Heading1')
    + wp('任职要求：熟悉 C++。'),
  );
  const r = await docxToText(docx);
  contains(r.text, '字节跳动', '段落文字读出来了');
  contains(r.text, '工作地点：西安', '正文段落完整');
  eq(r.text.split('\n---\n').length, 2, '标题样式自动切成 2 块');
  eq(r.meta.headings, 2, '统计到 2 个标题');
  ok(r.text.indexOf('字节跳动') < r.text.indexOf('腾讯'), '块序与文档顺序一致');

  // WPS / 中文版 Word 把内置标题样式的 styleId 写成数字，不认的话整篇糊成一块
  const num = await docxToText(await wdocx(wp('岗位甲', '1') + wp('正文甲') + wp('岗位乙', '1') + wp('正文乙')));
  eq(num.text.split('\n---\n').length, 2, '「标题样式的 id 是数字」（WPS）也认');
  const ol = await docxToText(await wdocx(
    '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>岗位甲</w:t></w:r></w:p>'
    + wp('正文甲')
    + '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>岗位乙</w:t></w:r></w:p>'
    + wp('正文乙'),
  ));
  eq(ol.text.split('\n---\n').length, 2, '只挂了大纲级别的标题也认');

  // 实体与软换行
  const ent = await docxToText(await wdocx(wp('公司 &amp; 岗位 &lt;2027届&gt;')));
  eq(ent.text, '公司 & 岗位 <2027届>', 'XML 实体正确还原');

  // 表格：Word 里排岗位表是最常见的写法
  const tbl = await docxToText(await wdocx(
    '<w:tbl>'
    + '<w:tr><w:tc>' + wp('公司') + '</w:tc><w:tc>' + wp('岗位') + '</w:tc><w:tc>' + wp('任职要求') + '</w:tc></w:tr>'
    + '<w:tr><w:tc>' + wp('华为') + '</w:tc><w:tc>' + wp('软件开发') + '</w:tc><w:tc>' + wp('熟悉 Java') + '</w:tc></w:tr>'
    + '<w:tr><w:tc>' + wp('小米') + '</w:tc><w:tc>' + wp('后端开发') + '</w:tc><w:tc>' + wp('熟悉 Go') + '</w:tc></w:tr>'
    + '</w:tbl>',
  ));
  eq(tbl.text.split('\n---\n').length, 2, 'Word 表格按「一行一个岗位」展开（表头不算岗位）');
  contains(tbl.text.split('\n---\n')[0], '华为 · 软件开发', '表格行的首行是「公司 · 岗位」');
  ok(!tbl.text.includes('公司 · 岗位'), '表头行没有被当成一个岗位');

  // 坏文件
  const bad = await docxToText(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]))
    .then(() => null, (e) => e.code);
  eq(bad, 'BAD_ZIP', '不是 zip 的字节 → BAD_ZIP（可转成友好提示）');
  const noBody = await docxToText(await makeZip([{ name: 'a.txt', data: 'x' }]))
    .then(() => null, (e) => e.code);
  eq(noBody, 'NO_BODY', 'zip 里没有 word/document.xml → NO_BODY');

  // 解压炸弹：30MB 的内容压完只有几十 KB，不设防的话内存直接被吃光
  const bomb = await makeZip([{ name: 'word/document.xml', data: new Uint8Array(30 * 1024 * 1024).fill(65) }]);
  ok(bomb.length < 1024 * 1024, '炸弹样本本身很小（' + Math.round(bomb.length / 1024) + ' KB）');
  const bz = await unzip(bomb);
  const bombCode = await bz.read('word/document.xml').then(() => null, (e) => e.code);
  eq(bombCode, 'TOO_BIG', '解压超出上限被掐断（TOO_BIG）而不是撑爆内存');
}

console.log('\n── A4. 表头语义（错了会让正文整段消失） ──');
{
  const m = mapColumns(['公司名称', '岗位', '工作地点', '岗位描述', '投递链接', '状态']);
  eq(m.company, 0, '公司名称 → company');
  eq(m.title, 1, '岗位 → title');
  eq(m.city, 2, '工作地点 → city');
  // ★ 这条最容易错：「岗位职责」同时含「岗位」和「职责」。如果 title 规则排在
  //   body 前面，整整一段职责正文会被当成岗位名，评估拿不到任何要求信息。
  eq(m.body, 3, '「岗位描述」归 body 而不是 title');
  eq(mapColumns(['公司', '职位名称', '职位描述']).body, 2, '「职位描述」也归 body');
  eq(mapColumns(['公司', '岗位职责']).body, 1, '「岗位职责」归 body');
  eq(mapColumns(['公司', '岗位']).title, 1, '纯「岗位」仍归 title');
  eq(m.link, 4, '投递链接 → link');

  ok(hasHeaderRow([['公司', '岗位'], ['华为', '后端']]), '「公司/岗位」是表头');
  ok(!hasHeaderRow([['2027 届本科，熟悉 Java 或 Go，了解 MySQL 与 Redis', '西安']]), '长文本数据行不是表头');
  ok(!hasHeaderRow([['华为', '中兴']]), '纯值行不是表头');

  const blocks = rowsToBlocks(
    ['公司', '岗位', '城市', '岗位描述', '状态'],
    [['华为', '软件开发工程师', '西安', '2027 届本科；熟悉 Java。', '未投递']],
  );
  eq(blocks.length, 1, '一行 → 一块');
  const lines = blocks[0].split('\n');
  eq(lines[0], '华为 · 软件开发工程师', '首行是「公司 · 岗位」（初筛靠它判方向）');
  contains(blocks[0], '城市：西安', '城市列被带出来');
  contains(blocks[0], '2027 届本科；熟悉 Java。', 'JD 正文完整');
  ok(!blocks[0].includes('未投递'), '「状态」这类无关列不混进 JD（会把每块撑长）');

  // 没有语义列时：不能把内容丢掉，退化成「每行一块」
  const plain = rowsToBlocks(null, [['华为 · 后端开发', '熟悉 Java', '西安']]);
  contains(plain[0], '华为 · 后端开发', '认不出列名时首列当标题');
  contains(plain[0], '熟悉 Java', '其余列的内容也不丢');

  eq(colIndex('A1'), 0, 'A1 → 第 0 列');
  eq(colIndex('C7'), 2, 'C7 → 第 2 列');
  eq(colIndex('AA3'), 26, 'AA3 → 第 26 列（两位数列表）');
  eq(decodeXml('&amp;&#xA;&#10;'), '&\n\n', '数字与十六进制实体都能还原');
}

console.log('\n── A5. CSV / TSV ──');
{
  const rows = parseDelimited('甲,乙,丙\n1,"含,逗号",3\n', ',');
  eq(rows[1][1], '含,逗号', '引号里的逗号不切列');
  const nl = parseDelimited('a,b\n1,"第一行\n第二行"\n', ',');
  eq(nl.length, 2, '引号里的换行不切行');
  eq(nl[1][1], '第一行\n第二行', '引号里的换行保留');
  const q = parseDelimited('a\n"他说""你好"""\n', ',');
  eq(q[1][0], '他说"你好"', '两个连续引号 = 一个字面引号');
  const tab = parseDelimited('甲\t乙\t丙\n1\t2\t3\n', '\t');
  eq(tab[1].length, 3, 'TSV 按 Tab 切列');

  const csv = enc.encode('公司,岗位,任职要求\n华为,后端开发,熟悉 Java\n小米,测试开发,熟悉 Python\n');
  const r = await parseDocument('岗位.csv', csv);
  ok(r.ok, 'CSV 导入成功');
  eq(r.blocks, 2, 'CSV 两行数据 → 2 个岗位');
  contains(r.text, '华为 · 后端开发', 'CSV 表头被用来组装岗位块');

  // 单列、没有表头的 CSV：当成已经用 --- 分隔的纯文本，不要瞎拆
  const flat = enc.encode('甲 · 后端\n职责：写代码\n---\n乙 · 前端\n职责：写界面\n');
  const rf = await parseDocument('岗位.txt', flat);
  eq(rf.blocks, 2, '带 --- 的纯文本按分隔线切（不按行拆）');
}

console.log('\n── A6. 边界：别把用户文件读坏读崩 ──');
{
  eq((await parseDocument('空.txt', new Uint8Array(0))).ok, false, '空文件被挡下');
  contains((await parseDocument('空.txt', new Uint8Array(0))).error, '空', '空文件的提示说得明白');

  const big = new Uint8Array(MAX_FILE_BYTES + 1).fill(65);
  const rb = await parseDocument('大.txt', big);
  eq(rb.ok, false, '超过体积上限的文件被挡下');
  contains(rb.error, 'MB', '超限提示给出具体上限');

  // 二进制文件改名 .txt：不能让一堆控制字符流进文本框
  const bin = new Uint8Array(2000);
  for (let i = 0; i < bin.length; i += 1) bin[i] = i % 7;
  const rbin = await parseDocument('伪装.txt', bin);
  eq(rbin.ok, false, '二进制内容改名 .txt 会被识破');

  const rdoc = await parseDocument('简历.doc', enc.encode('x'));
  eq(rdoc.ok, false, '.doc 明确拒绝');
  contains(rdoc.error, '另存为', '拒绝时给出可执行的下一步');

  const rbad = await parseDocument('坏.docx', new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]));
  eq(rbad.ok, false, '头部像 zip 但结构损坏 → 挡下');
  ok(rbad.error && !rbad.error.includes('undefined'), '损坏文件的提示是可读中文（不是异常堆栈）');

  // 超过一次最多 20 个岗位：超出的要截掉，否则用户以为它们也跑了
  const many = Array.from({ length: IMPORT_MAX_BLOCKS + 3 }, (_, i) => '岗位' + (i + 1) + ' · 后端\n任职要求：熟悉 Java。').join('\n---\n');
  const rm = await parseDocument('多.txt', enc.encode(many));
  eq(rm.blocks, IMPORT_MAX_BLOCKS, '超过上限时只保留 ' + IMPORT_MAX_BLOCKS + ' 个');
  eq(rm.totalBlocks, IMPORT_MAX_BLOCKS + 3, '同时报出真实总数（提示里要说）');
  ok(rm.warnings.some((w) => w.includes('上限')), '超上限有明确警告');
}

console.log('\n── A7. 多文件合并 ──');
{
  const a = { ok: true, name: '岗位A.docx', text: '甲公司 · 后端\n要求：Java。', warnings: [] };
  const b = { ok: true, name: '岗位B.xlsx', text: '乙公司 · 前端\n要求：JS。', warnings: [] };
  const m = mergeImports([a, b]);
  eq(m.blocks, 2, '两个文件合成 2 个岗位');
  eq(m.files, 2, '统计到 2 个文件');
  contains(m.text, '甲公司', '第一个文件的内容在');
  contains(m.text, '乙公司', '第二个文件的内容在');
  // 不给第二份加来源标记的话，结果表里两行长得一模一样，分不清来自哪个文件
  contains(m.text, '岗位B', '第二份的第一块带上了文件名前缀');

  const m2 = mergeImports([{ ok: false, name: 'x.pdf', error: '不支持' }, a]);
  eq(m2.blocks, 1, '失败的文件不影响成功的那些');

  const many = Array.from({ length: 25 }, (_, i) => ({ ok: true, name: 'f.txt', text: '岗位' + i + '\n要求：x', warnings: [] }));
  const m3 = mergeImports(many);
  eq(m3.blocks, IMPORT_MAX_BLOCKS, '合并后超上限也被截断');
  ok(m3.warnings.some((w) => w.includes('上限')), '合并超限有警告');
}

// ── A8. 真实样本（Office 生成的文件，不是自己造的 zip） ───────────────────
console.log('\n── A8. 真实 Office 样本 ──');
const SAMPLE_EXPECT = {
  '岗位合集-标题式.docx': 3,
  '岗位表-表格式.docx': 3,
  '岗位清单.xlsx': 4,
  '岗位列表-utf8.csv': 2,
  '岗位列表-gbk.csv': 3,
  '岗位文本.txt': 2,
};
if (fs.existsSync(SAMPLE_DIR)) {
  for (const [name, want] of Object.entries(SAMPLE_EXPECT)) {
    const p = path.join(SAMPLE_DIR, name);
    if (!fs.existsSync(p)) { console.log('  · 跳过 ' + name + '（样本不存在）'); continue; }
    const r = await parseDocument(name, fs.readFileSync(p));
    ok(r.ok, name + ' 解析成功' + (r.ok ? '' : '：' + r.error));
    if (r.ok) eq(r.blocks, want, name + ' 读出 ' + want + ' 个岗位');
    if (r.ok) {
      const first = r.text.split('\n---\n')[0];
      ok(!/[\uFFFD]/.test(r.text), name + ' 没有乱码字符（编码判对）');
      ok(first.trim().length > 3, name + ' 首个块有内容');
    }
  }
  const gbk = await parseDocument('岗位列表-gbk.csv', fs.readFileSync(path.join(SAMPLE_DIR, '岗位列表-gbk.csv')));
  contains(gbk.text, '华为', 'GBK 的 CSV 中文正确（不是问号）');
  const x = await parseDocument('岗位清单.xlsx', fs.readFileSync(path.join(SAMPLE_DIR, '岗位清单.xlsx')));
  contains(x.text, '城市：杭州', 'xlsx 的表头语义组装出「城市：」');
  ok(!x.text.includes('未投递'), 'xlsx 的「状态」列被过滤掉了');
} else {
  console.log('  · 跳过（' + SAMPLE_DIR + ' 不存在）—— 样本由 tests 一次性生成，缺了不影响纯函数结论');
}

console.log('\nA 段失败 ' + fails.length + ' 项');

// ── B 段：真实文件的真实界面 ─────────────────────────────────────────────
let serverUp = false;
try {
  const r = await fetch('http://127.0.0.1:7317/api/status', { signal: AbortSignal.timeout(2500) });
  serverUp = r.ok;
} catch { /* 没起服务 */ }

if (!serverUp) {
  console.log('\n(跳过 B 段界面自检：127.0.0.1:7317 上没有服务。先 `node ui/server.mjs` 再跑本脚本。)');
} else {
  console.log('\n══ B 段：界面（真实文件 → 真实解析 → 真实渲染）══');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1360, height: 980 } });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('response', (r) => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url()); });

    // 只打桩 /api/eval —— 自检绝不能真跑 AI。
    //
    // ⚠️ 这里刻意**不**打桩 /api/ai-status：它的响应形状（engines 下每个档位的
    //    字段）是页面渲染引擎卡片时要用的，随手编一个 `{engines:{}}` 会让卡片
    //    渲染中途抛错，后面整块内容都不出现 —— 症状是「#evBatchPick 等不到」，
    //    看起来像导入功能坏了，其实是桩喂错了。真实服务在本机，直接问它。
    await page.route('**/api/eval', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, triage: { score: 4.0, verdict: 'PASS', tier: 'A', why: '打桩' }, ms: 1 }),
    }));

    await page.goto('http://127.0.0.1:7317/#tools', { waitUntil: 'domcontentloaded' });
    try {
      // 批量卡（#evBatchPick 所在）自 #108 起迁到「全部脚本」页。
      // 等可见的按钮，不是等 file input —— 那个是 hidden 的，
      // waitForSelector 默认要求 visible，等它必然超时。
      await page.waitForSelector('#evBatchPick', { timeout: 20000 });
    } catch (err) {
      // 渲染不出来通常是模块加载失败（404 / 语法错），把控制台报错带出来
      console.log('  ✗ 全部脚本页没渲染出批量卡片：' + err.message);
      console.log('    控制台报错：' + (errs.length ? errs.slice(0, 5).join(' | ') : '（无）'));
      fails.push('B 段页面没渲染');
      await browser.close();
      console.log('\n✗ ' + fails.length + ' 项未通过');
      process.exit(1);
    }

    const summaryText = async () => (await page.textContent('#evBatchImport') || '').replace(/\s+/g, ' ');

    ok(await page.$('#evBatchPick') !== null, 'B1 卡片里有「导入文档」按钮');
    ok(await page.$('#evBatchFile') !== null, 'B1 有文件选择器（hidden 的，靠按钮触发）');
    const accept = await page.getAttribute('#evBatchFile', 'accept');
    ok(accept.includes('.docx') && accept.includes('.xlsx'), 'B1 文件选择器接受 .docx / .xlsx');

    const docxPath = path.join(SAMPLE_DIR, '岗位合集-标题式.docx');
    const xlsxPath = path.join(SAMPLE_DIR, '岗位清单.xlsx');

    if (fs.existsSync(docxPath)) {
      await page.setInputFiles('#evBatchFile', docxPath);
      await page.waitForFunction(() => !!document.querySelector('#evBatchImport .notice.ok'), null, { timeout: 15000 });
      const sum = await summaryText();
      contains(sum, '岗位合集-标题式.docx', 'B2 摘要显示文件名');
      contains(sum, 'Word 文档', 'B2 摘要显示识别出的格式');
      ok(/识别出\s*3\s*个岗位/.test(sum), 'B2 摘要报出 3 个岗位（实际：' + sum.slice(0, 90) + '）');
      const val = await page.inputValue('#evBatchJd');
      contains(val, '字节跳动', 'B2 正文填进了输入框');
      eq((val.match(/^---$/gm) || []).length, 2, 'B2 输入框里是 3 块（2 条分隔线）');
      contains(await page.textContent('#evBatchCount'), '3', 'B2 计数提示同步');
      ok(!(await page.$('#evBatchUndo')), 'B2 首次导入（原本为空）不给「恢复」按钮');

      // 覆盖导入 → 可撤销
      await page.fill('#evBatchJd', '手动粘的岗位 JD：要求熟悉 Java。');
      await page.waitForTimeout(120);
      if (fs.existsSync(xlsxPath)) {
        await page.setInputFiles('#evBatchFile', xlsxPath);
        await page.waitForFunction(() => !!document.querySelector('#evBatchUndo'), null, { timeout: 15000 });
        contains(await summaryText(), 'Excel 表格', 'B3 换文件后摘要更新为 Excel');
        ok(!!(await page.$('#evBatchUndo')), 'B3 覆盖已有内容时给「恢复导入前的内容」');
        await page.click('#evBatchUndo');
        eq(await page.inputValue('#evBatchJd'), '手动粘的岗位 JD：要求熟悉 Java。', 'B3 撤销后文本回来了');
        eq(await page.$('#evBatchUndo'), null, 'B3 撤销后按钮消失（只给一次机会）');
      }

      // 不支持格式：要有可读的原因，不是一句「失败」。
      // 先成功导一次、再导坏文件 —— 因为失败时**不能**把上一次的成功摘要擦掉：
      // 擦了之后页面会同时出现「1 个文件没读成」和满框岗位内容，用户无从判断
      // 这些内容是哪来的（截图里看着就像 bug）。
      if (fs.existsSync(xlsxPath)) {
        await page.setInputFiles('#evBatchFile', xlsxPath);
        await page.waitForFunction(() => {
          const t = document.querySelector('#evBatchImport');
          return !!t && t.textContent.includes('Excel 表格');
        }, null, { timeout: 15000 });
      }
      const pdfPath = path.join(SAMPLE_DIR, '_临时测试.pdf');
      fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4 fake'));
      await page.setInputFiles('#evBatchFile', pdfPath);
      await page.waitForFunction(() => !!document.querySelector('#evBatchImport .notice.bad'), null, { timeout: 15000 });
      const bad = await summaryText();
      contains(bad, '没读成', 'B4 读不了的文件被列出来');
      contains(bad, '另存为', 'B4 给出可执行的下一步（另存为 .docx）');
      contains(bad, '岗位清单.xlsx', 'B4 失败不清掉上一次的成功摘要（否则页面自相矛盾）');
      fs.unlinkSync(pdfPath);

      // 拖拽导入 + 悬停描边
      const b64 = fs.readFileSync(docxPath).toString('base64');
      await page.evaluate(({ b64, name }) => {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([u8], name, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
        const card = document.querySelector('#evBatchCard');
        card.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
        window.__dropHi = card.classList.contains('is-dropping');
        card.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, { b64, name: '拖进来的岗位.docx' });
      await page.waitForFunction(() => {
        const t = document.querySelector('#evBatchImport');
        return t && t.textContent.includes('拖进来的岗位.docx');
      }, null, { timeout: 15000 });
      eq(await page.evaluate(() => window.__dropHi), true, 'B5 拖拽悬停时卡片有描边');
      contains(await summaryText(), '识别出 3 个岗位', 'B5 拖进来的文件同样被解析');

      // 清空
      await page.click('#evBatchClear');
      eq(await page.$('#evBatchImport .notice'), null, 'B6 清空后摘要消失');
      eq(await page.inputValue('#evBatchJd'), '', 'B6 清空后输入框为空');
      eq(await page.$('#evBatchUndo'), null, 'B6 清空后撤销按钮也没了');
    } else {
      console.log('  · 跳过 B2~B6（样本不存在：' + docxPath + '）');
    }

    ok(errs.length === 0, 'B 段没有控制台报错' + (errs.length ? '：' + errs[0] : ''));
  } finally {
    await browser.close();
  }
}

console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 项未通过' : '✓ 全部通过'));
process.exit(fails.length ? 1 : 0);
