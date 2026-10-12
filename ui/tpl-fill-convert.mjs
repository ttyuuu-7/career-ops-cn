// ui/tpl-fill-convert.mjs — 「模板内容填充」合成器（2026-09-30）
//
// 原型 _com-fill-proto.mjs 验证过的路线：拷贝模板副本 → Word/WPS COM 打开 →
// 在全部文本框 TextRange 上跑 Find & Replace（**保字符样式**，wdReplaceAll）→
// ExportAsFixedFormat 转 PDF。产物 = 模板原样排版 + 用户真实简历内容。
//
// 铁律（全部实测得来，同 tpl-pdf-convert）：
//   ① COM 串行 —— 经 enqueueExclusive 与普通转换共享同一条队列。
//   ② 传给 COM 的路径必须是反斜杠绝对路径（正斜杠+空格会被当 URL 解析成 %20）。
//   ③ Find.Execute 的参数序：FindText, MatchCase, MatchWholeWord, MatchWildcards,
//     MatchSoundsLike, MatchAllWordForms, Forward, Wrap, Format, ReplaceWith, Replace。
//     第 5 参 MatchSoundsLike 传 true 会在中文上抛「同音字搜索只能包含无重音字母」。
//   ④ 替换对用换行分隔的「find|replace|nth」行传（逗号/嵌套数组都有坑）。
//   ⑤ 产物过 %PDF 魔数校验，tmp 原子改名。
//   ⑥ **定向替换**（2026-10-04）：设计模板一个栏目常有多组示例块（art01 经历
//      ×4、教育 ×2），同一个 find 文本在多个框里出现。旧的 wdReplaceAll 会把
//      「第 1 条经历」灌进所有块 → 同一段内容重复 4 次。现在按 pairs[i][2] 的
//      nth（该 find 在文档中的出现序号）只替换第 n 个：先按 Start 排序所有文本框
//      → 在框内用 Wrap=wdFindStop 逐个定位第 n 次出现 → 只对它做 wdReplaceOne
//      （保字符样式）。nth 超出该框命中数 → 视为未命中，规则层已把多余块发空串。

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { enqueueExclusive } from './tpl-pdf-convert.mjs';

function runPsEncoded(script, timeoutMs, env) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || err.message || '').trim().slice(-300);
          reject(Object.assign(new Error('powershell 合成进程失败：' + tail), { code: err.code }));
        } else {
          resolve(String(stdout || ''));
        }
      }
    );
  });
}

function buildFillScript() {
  // ⚠️ JS 模板字面量里禁反引号（PS 的转义会被 JS 吃掉）
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$src = $env:FILL_SRC
$tmp = $env:FILL_TMP
$fmt = [int]$env:FILL_FMT
$pairs = @()
foreach ($line in ($env:FILL_PAIRS -split "\\r?\\n")) {
  $line = $line.Trim()
  if (-not $line) { continue }
  $first = $line.IndexOf([char]124)
  $last = $line.LastIndexOf([char]124)
  if ($first -gt 0) {
    $find = $line.Substring(0, $first)
    if ($last -gt $first) {
      $rep = $line.Substring($first + 1, $last - $first - 1)
      $nth = $line.Substring($last + 1)
    } else {
      $rep = $line.Substring($first + 1)
      $nth = '0'
    }
    $pairs += , @($find, $rep, $nth)
  }
}
Write-Output ('PAIRS' + [char]9 + $pairs.Count)

$app = $null
foreach ($e in @('Word.Application', 'KWPS.Application', 'wps.Application')) {
  try { $app = New-Object -ComObject $e; Write-Output ('ENGINE' + [char]9 + $e); break } catch {}
}
if (-not $app) { throw '本机没有可用的 Word/WPS（COM 引擎）' }
$app.Visible = $false
$doc = $app.Documents.Open($src, $false, $false)

# 递归收集文本框：设计类模板的姓名/意向/教育/经历框大量藏在**组合**（type=6,
# msoGroup）里 —— 顶层 Shapes 遍历不到组内, art01 实测姓名「白晓云」就在
# B4.2（组 B4 内）。type=17 是 msoTextBox。
function Get-TbxRanges($shapes) {
  $out = @()
  foreach ($s in $shapes) {
    try { if ($s.Type -eq 6) { $out += @(Get-TbxRanges $s.GroupItems); continue } } catch {}
    try { if ($s.TextFrame.HasText) { $out += $s.TextFrame.TextRange } } catch {}
  }
  return $out
}

$ranges = @()
$ranges += @(Get-TbxRanges $doc.Shapes)
foreach ($sec in $doc.Sections) {
  foreach ($hf in @($sec.Headers, $sec.Footers)) {
    foreach ($h in $hf) {
      if ($h.Exists) {
        $ranges += @(Get-TbxRanges $h.Shapes)
      }
    }
  }
}
Write-Output ('RANGES' + [char]9 + $ranges.Count)

# 按文档顺序排序 —— nth 语义依赖「文档顺序」而非 COM 遍历顺序
$sorted = @()
foreach ($r in $ranges) { $sorted += , $r }
$sorted = @($sorted | Sort-Object { $_.Start })

# ── 两阶段（2026-10-04 修复「nth 永远命中不了 / 命中错框」）──────────────
# 阶段 1：**在任何替换发生之前**，为每个 find 枚举「包含它的文本框」并记下
#   Range 对象。Range 是活对象：别的框被改内容后它仍指向本框。
#   阶段 2：按 pairs[i][2] 的 nth 取第 n 个框做 ReplaceAll。
# 为什么必须两阶段：边替换边数会自我污染 —— nth=0 把第 1 框改掉后，第 2 框
# 就不再是「第 1 个命中」，nth=1 会跳到第 3 框，nth=2/3 直接失效（实测
# 8 条清空规则全 miss，第 4 组经历块永远留着模板示例）。
$boxIndex = @{}
foreach ($pair in $pairs) {
  $key = [string]$pair[0]
  if ($boxIndex.ContainsKey($key)) { continue }
  $list = @()
  foreach ($rng in $sorted) {
    $probe = $rng.Duplicate
    $pf = $probe.Find
    $pf.ClearFormatting()
    # Wrap = wdFindStop(0)：只在框内找，不绕回故事开头
    if ($pf.Execute($key, $false, $false, $false, $false, $false, $true, 0, $false)) { $list += , $rng }
  }
  $boxIndex[$key] = $list
}
Write-Output ('BOXINDEXED' + [char]9 + $boxIndex.Count)

$done = 0; $miss = @()
foreach ($pair in $pairs) {
  $find = [string]$pair[0]; $rep = [string]$pair[1]; $nth = [int]$pair[2]
  $list = $boxIndex[$find]
  if ($list.Count -le $nth) { $miss += $find; continue }
  $target = $list[$nth]
  $f2 = $target.Find
  $f2.ClearFormatting()
  $f2.Replacement.ClearFormatting()
  # Replace = wdReplaceAll(2)：只在本框内全替换，保留原字符样式
  if ($f2.Execute($find, $false, $false, $false, $false, $false, $true, 0, $false, $rep, 2)) { $done++ } else { $miss += $find }
}
Write-Output ('REPLACED' + [char]9 + $done + '/' + $pairs.Count)
foreach ($m in $miss) {
  $short = $m
  if ($short.Length -gt 60) { $short = $short.Substring(0, 60) }
  Write-Output ('MISS' + [char]9 + $short)
}

# 清空的文本框：去掉残留的项目符号。
# Word 文本框**至少保留一个段落**，文本替换能把内容清空、却删不掉段落属性
# —— 结果就是页面上留一个孤零零的 ■（2026-10-04 目视验收发现，用户截图里
# 「实践经验」下方那个空方块就是被清空的第 2 组经历框）。对空文本框移除
# 列表格式即可，段落还在、版式不塌。
$cleaned = 0
foreach ($rng in $sorted) {
  try {
    $t = $rng.Text
    if ($t -ne $null -and $t.Trim().Length -eq 0) {
      $rng.ListFormat.RemoveNumbers()
      $cleaned++
    }
  } catch {}
}
Write-Output ('CLEANED' + [char]9 + $cleaned)

# 出口：17 = wdExportFormatPDF（预览用）；12 = wdFormatXMLDocument（.docx 导出用）
#   走同一份「已替换」的内存文档，所以导出的 Word 与预览**逐像素同源**。
if ($fmt -eq 12) {
  $doc.SaveAs2($tmp, 12)
  Write-Output ('DOCX' + [char]9 + $tmp)
} else {
  $doc.ExportAsFixedFormat($tmp, 17)
  Write-Output ('PDF' + [char]9 + $tmp)
}
$doc.Close($false)
$app.Quit()
Write-Output ('DONE' + [char]9 + $tmp)
`;
}

async function assertPdf(p) {
  const fh = await fsp.open(p, 'r');
  const buf = Buffer.alloc(4);
  await fh.read(buf, 0, 4, 0);
  await fh.close();
  if (buf.toString('latin1') !== '%PDF') throw new Error('合成产物不是有效 PDF（%PDF 魔数缺失）');
  const st = await fsp.stat(p);
  if (st.size < 1000) throw new Error('合成产物异常地小（' + st.size + 'B）');
}

/** docx 产物校验：ZIP 魔数 PK + 体积下限（SaveAs2 失败时会留下 0 字节或半截文件）。 */
async function assertDocx(p) {
  const fh = await fsp.open(p, 'r');
  const buf = Buffer.alloc(2);
  await fh.read(buf, 0, 2, 0);
  await fh.close();
  if (buf.toString('latin1') !== 'PK') throw new Error('合成产物不是有效 docx（ZIP 魔数缺失）');
  const st = await fsp.stat(p);
  if (st.size < 5000) throw new Error('合成 docx 异常地小（' + st.size + 'B）');
}

/**
 * 模板内容填充合成。
 * @param {string} srcDocx 模板原文件绝对路径
 * @param {string} dstOut  产物绝对路径（.pdf 或 .docx，由 fmt 决定）
 * @param {Array<[string,string,number]>} pairs 替换对（第三项 nth 可选）
 * @param {object} [opt] { fmt:'pdf'|'docx' }
 * @returns {Promise<{replaced: string, total: number, out: string, stdout: string}>}
 */
export function fillTemplate(srcDocx, dstOut, pairs, opt) {
  const fmt = (opt && opt.fmt) === 'docx' ? 12 : 17;
  const isDocx = fmt === 12;
  return enqueueExclusive(async () => {
    const hash = createHash('sha256')
      .update(srcDocx + '\n' + fmt + '\n' + JSON.stringify(pairs))
      .digest('hex').slice(0, 16);
    const workDir = path.dirname(dstOut);
    await fsp.mkdir(workDir, { recursive: true });
    // 副本：绝不改原始模板文件（Word 打开即写锁）
    const tmpDocx = path.join(workDir, 'fill-' + hash + '.docx');
    const tmpOut = path.join(workDir, 'fill-' + hash + (isDocx ? '.tmp.docx' : '.tmp.pdf'));
    await fsp.copyFile(srcDocx, tmpDocx);
    try {
      const script = buildFillScript();
      const stdout = await runPsEncoded(script, 180000, {
        FILL_SRC: tmpDocx,
        FILL_TMP: tmpOut,
        FILL_FMT: String(fmt),
        // 行协议是「find|replace|nth」按行分隔 —— 真实换行必须清掉（规则引擎的
        // 多段连接用 ^p、bullets 分行用 ^l，都不会到这里；防御用户表单脏数据）。
        // nth 缺省为 0（唯一命中）。分隔符用「首个 | 切 find、末个 | 切 nth」，
        // 替换值里含 | 也不会错位。
        FILL_PAIRS: pairs.map(([a, b, nth]) =>
          String(a).replace(/\r?\n/g, ' ') + '|' + String(b).replace(/\r?\n/g, ' ') + '|' + (Number(nth) || 0)
        ).join('\n'),
      });
      const grab = (tag) => {
        const m = stdout.match(new RegExp(tag + '\\t([^\\r\\n]*)'));
        return m ? m[1].trim() : '';
      };
      const replaced = grab('REPLACED');
      if (isDocx) await assertDocx(tmpOut); else await assertPdf(tmpOut);
      await fsp.rename(tmpOut, dstOut);
      await fsp.unlink(tmpDocx).catch(() => {});
      // stdout 带 PAIRS/RANGES/REPLACED 计数与未命中的 find —— 排查「为什么没
      // 替换上」时要看它，别再猜（2026-10-04 排查定向替换失效靠的就是它）。
      return { replaced, total: pairs.length, out: dstOut, stdout: String(stdout || '') };
    } catch (e) {
      await fsp.unlink(tmpDocx).catch(() => {});
      await fsp.unlink(tmpOut).catch(() => {});
      throw e;
    }
  });
}

/** 缓存键：模板 id/路径 + 出口格式 + 替换对（表单内容或格式变了 hash 就变）。 */
export function fillHash(srcDocx, pairs, opt) {
  const fmt = (opt && opt.fmt) === 'docx' ? 'docx' : 'pdf';
  return createHash('sha256')
    .update(srcDocx + '\n' + fmt + '\n' + JSON.stringify(pairs))
    .digest('hex').slice(0, 16);
}
