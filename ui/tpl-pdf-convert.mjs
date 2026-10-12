// ui/tpl-pdf-convert.mjs — docx → PDF 保真预览转换器（2026-09-30）
//
// 为什么需要它：文艺/活泼系列模板的正文全部装在「文本框」（w:txbxContent）
// 里、配图全是锚定浮动图 —— docx-preview 0.4.1 渲染不出（文字全部堆到页外
// 同一个坐标、52 张锚定图只渲染出 2 张，实测诊断 _tpl-art-diagnose.mjs）。
// 本机 Word / WPS 的 COM 接口能把 docx 精确导出为 PDF（所见即所得），前端
// 再用 pdf.js 渲染 —— 这才是「导入什么样就渲染什么样」。文件全程不出本机。
//
// 硬规矩：
//   ① Word COM 并发开会互相卡死 —— 全局串行队列，任何时刻只有一个 powershell
//      转换进程在跑；队列吞错（一次失败不断链）。
//   ② 产物必须过 %PDF 魔数校验，坏产物当失败处理（绝不把坏文件缓存住）。
//   ③ 先写临时文件再原子改名 —— 并发/重试不会读到半截 PDF。
//   ④ 目标文件已存在直接跳过（幂等，重试零成本）。

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

let queue = Promise.resolve();

/** 以 UTF-16LE base64 编码执行 powershell（避开 GBK 控制台的中文路径坑）。 */
function runPsEncoded(script, timeoutMs) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || err.message || '').trim().slice(-300);
          reject(Object.assign(new Error('powershell 转换进程失败：' + tail), { code: err.code }));
        } else {
          resolve(String(stdout || ''));
        }
      }
    );
  });
}

/** 单批转换脚本：开一次 Word/WPS，循环 ExportAsFixedFormat；一行 OK/FAIL 一个文件。
 *  ⚠️ 两个 PowerShell 坑：
 *  ① 本函数体是 JS 模板字面量 —— 里面绝不能出现反引号（PS 的 `t 转义会被
 *     JS 当模板语法），制表符一律用 [char]9 拼。
 *  ② 清单用「src|dst」字符串而不是嵌套数组 —— @() 会把单元素数组拆包，
 *     只转一份时 $it 变字符串、$it[0] 取到首字符 'D'，Word Open 报
 *     「无法将 char 的 'D' 值转换为 Object」（实测单份转换必挂）。路径里
 *     不会出现 |（Windows 文件名非法字符），做分隔符安全。
 */
function buildBatchScript(pairs) {
  const lines = pairs.map(([s, d]) => `  '${s}|${d}'`).join(",\n");
  return `
$ErrorActionPreference = 'Continue'
# stdout 强制 UTF-8 —— 否则 PS 按系统 OEM 码页（GBK）输出，Node 侧按 utf8 解码，
# 中文路径全部变乱码，OK/FAIL 行匹配不上（实测 100 份全挂在这一步）。
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$tab = [char]9
$app = $null
foreach($p in @('Word.Application','KWPS.Application','Kwps.Application','wps.Application')){
  try { $app = New-Object -ComObject $p; $used = $p; break } catch {}
}
if(-not $app){ [Console]::Error.WriteLine('NO_COM_ENGINE'); exit 3 }
try { $app.Visible = $false; try { $app.DisplayAlerts = 0 } catch {} } catch {}
$items = @(
${lines}
)
Write-Output ('ENGINE ' + $used)
foreach($it in $items){
  $pair = $it.Split('|')
  $src = $pair[0]; $dst = $pair[1]
  if(Test-Path $dst){ Write-Output ('SKIP' + $tab + $dst); continue }
  try {
    $doc = $app.Documents.Open($src, $false, $true)
    try {
      $doc.ExportAsFixedFormat($dst, 17)
    } catch {
      try { $doc.SaveAs2($dst, 17) } catch { $doc.SaveAs($dst, 17) }
    }
    $doc.Close($false)
    Write-Output ('OK' + $tab + $dst)
  } catch {
    Write-Output ('FAIL' + $tab + $dst + $tab + $_.Exception.Message)
  }
}
try { $app.Quit() } catch {}
`;
}

/** 解析批量输出：{ okBasenames, failReasons }。
 *  ⚠️ 以最后一段文件名（纯 ASCII）为键——OK/FAIL 行是「状态\t完整路径」，
 *  basename 在行尾而非紧跟状态码（用完整路径匹配会因编码/分隔符翻车）；
 *  中文路径即便被码页弄乱也不影响 ASCII 文件名的匹配。 */
function parseBatchLines(stdout) {
  const okBasenames = new Set();
  const failReasons = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(OK|SKIP|FAIL)\t(.*)$/);
    if (!m) continue;
    const seg = m[2].split('\t');
    const base = seg[0].split(/[\\/]/).pop();
    if (m[1] === 'FAIL') failReasons.set(base, seg[1] || '未知错误');
    else okBasenames.add(base);
  }
  return { okBasenames, failReasons };
}

function parseBatchOutput(stdout, pairs) {
  const fails = [];
  const seen = new Set();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(OK|SKIP|FAIL)\t(.*)$/);
    if (!m) continue;
    if (m[1] === 'FAIL') fails.push(m[2]);
    else seen.add(m[2].replace(/\.tmp-\d+$/, ''));
  }
  // 没出现在输出里的也算失败（进程中断等）
  for (const [, d] of pairs) if (!seen.has(d) && !fails.includes(d)) fails.push(d);
  return fails;
}

async function assertPdf(dst) {
  const buf = await fsp.readFile(dst);
  if (!(buf.length > 1000 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46)) {
    throw new Error('PDF 产物校验失败（不是有效的 PDF）');
  }
  return buf.length;
}

/**
 * 批量转换：[[src,dst],...] → 全部完成（或收集失败清单）。
 * 内部分批（每批一个 powershell/Word 实例），整体走全局串行队列。
 * 返回 { done: string[], failed: {src, dst, reason}[] }。
 */
export function docxToPdfBatch(pairsIn, { timeoutMs = 180000, chunkSize = 40 } = {}) {
  const pairs = pairsIn.filter(Boolean);
  const run = queue.then(async () => {
    // 幂等：目标已存在的直接剔除
    const todo = [];
    const done = [];
    for (const [s, d] of pairs) {
      try { await fsp.access(d); done.push(d); } catch { todo.push([s, d]); }
    }
    const failed = [];
    // 目标目录必须先建好 —— Word 的 ExportAsFixedFormat 对不存在的目录报
    // 「目录名无效」（预热脚本自己 mkdir 过所以批量没事，惰性单份必挂）。
    const dirs = new Set(todo.map(([, d]) => path.dirname(d)));
    for (const dir of dirs) await fsp.mkdir(dir, { recursive: true });
    for (let i = 0; i < todo.length; i += chunkSize) {
      const chunk = todo.slice(i, i + chunkSize).map(([s, d]) => {
        // ⚠️ 临时文件名必须以 .pdf 结尾 —— Word 的 ExportAsFixedFormat 对
        //    非 .pdf 扩展名会失败（实测 100/100 全挂的原因）。
        const tmp = d.slice(0, -4) + '.tmp-' + Date.now() + '.pdf';
        return [s, tmp, d];
      });
      const script = buildBatchScript(chunk.map(([s, tmp]) => [s, tmp]));
      let stdout = '';
      try {
        stdout = await runPsEncoded(script, timeoutMs);
      } catch (e) {
        for (const [, tmp, d] of chunk) failed.push({ src: '', dst: d, reason: e.message });
        continue;
      }
      const { okBasenames, failReasons } = parseBatchLines(stdout);
      for (const [s, tmp, d] of chunk) {
        const tmpBase = path.basename(tmp);
        const failReason = failReasons.get(tmpBase);
        if (failReason) {
          failed.push({ src: s, dst: d, reason: failReason });
          continue;
        }
        if (!okBasenames.has(tmpBase)) {
          failed.push({ src: s, dst: d, reason: '转换进程未产出该文件' });
          continue;
        }
        try {
          await assertPdf(tmp);
          await fsp.mkdir(path.dirname(d), { recursive: true });
          await fsp.rename(tmp, d);
          done.push(d);
        } catch (e) {
          await fsp.unlink(tmp).catch(() => {});
          failed.push({ src: s, dst: d, reason: e.message });
        }
      }
    }
    return { done, failed };
  });
  queue = run.catch(() => {}); // 失败不断链
  return run;
}

/** 单份转换（server 惰性生成用）。dst 已存在直接返回。 */
export function docxToPdf(srcPath, dstPath, opts = {}) {
  return docxToPdfBatch([[srcPath, dstPath]], opts).then((r) => {
    if (!r.done.includes(dstPath)) {
      const f = r.failed.find((x) => x.dst === dstPath);
      throw new Error((f && f.reason) || '转换失败');
    }
    return dstPath;
  });
}

/**
 * 共享串行锁（2026-09-30）：Word COM 并发开会互卡 —— 「模板内容填充」的
 * 合成会话（tpl-fill-convert）与普通转换共用这一条队列，任何时刻本机只有
 * 一个 Word/WPS 实例在跑。失败不断链。
 */
export function enqueueExclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}
