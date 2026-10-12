#!/usr/bin/env node
// ui/server.mjs — career-ops 本地控制台服务端
//
// 设计约束（都是刻意的）：
//   1. 零外部依赖。只用 node: 内置模块 + 项目已有的 js-yaml。开箱即跑，不污染环境。
//   2. 只监听 127.0.0.1。这是操作你私人简历和投递记录的服务，绝不对外暴露。
//   3. 写操作全部限制在项目目录内，且路径经过越界校验。
//   4. 能执行的脚本走白名单。不做「把用户输入拼进命令行」这种事。
//   5. 编辑 YAML 用行级替换而不是 js-yaml 序列化——否则 profile.yml 里
//      那几百行注释会被全部抹掉。
//
// 启动： node ui/server.mjs [--port 7317]

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  EMPTY_CV, normalizeCv, cvToMarkdown, markdownToCv, cvToPayload, cvCompleteness, auditCvMarkdown,
  emptyExperience, emptyProject, emptyEducation, emptyCertification, emptyAward, emptySkill,
} from './cv-model.mjs';
import { parseTriage } from './eval-parse.mjs';
import { parseCvOptimize } from './cv-optimize-parse.mjs';
// 中文简历版式（标题中文化、章节重排、要点逐行）。放在 ui/ 而不是 templates/，
// 是因为 templates/ 属于系统层，`node update-system.mjs` 会把它还原成上游版本。
import { prepareZhCvPayload, applyZhCvLayout } from './cv-zh-layout.mjs';
// 简历模板库：内置三套版式 + 导入校验的口径单点。零依赖纯函数模块，
// 前端（app.js）import 同一份 —— 「服务端收下的模板」必须就是「前端渲染得出的模板」。
import { BUILTIN_CV_TEMPLATES, normalizeCvTemplateInput, TPL_ITEM_KINDS } from './cv-templates.mjs';
// 分区导航的口径单点（章节表、顺序/显隐归一化）。前端三处与这里读同一份 ——
// 「预览里有的」必须就是「导出的 Word 里有的」。
import { normalizeCvNav } from './cv-nav.mjs';
// 外观设置的口径单点（默认值、归一化）。导出的 CSS 在浏览器侧用（cv-word.mjs），
// 服务端只负责存取，所以这里不引 cvLookWordCss。
import { normalizeCvLook } from './cv-look.mjs';
// 基本信息字段行的顺序与显隐（2026-10-09，参照 magicv.art 的「基础字段」）。
// 与 cv-nav.mjs 同一套语义：隐藏只影响预览与导出，值始终留在 cv.md。
import { normalizeCvFields } from './cv-fields.mjs';
import { docxToPdf } from './tpl-pdf-convert.mjs';
import { fillTemplate, fillHash } from './tpl-fill-convert.mjs';
import { buildFillPairs, boxesFromDocumentXml } from './tpl-fill-rules.mjs';
import { unzip } from './doc-import.mjs';
// 「这一次用哪个 AI 引擎」的决策口径。同样是纯函数模块 —— 多了一条引擎通路之后，
// 「选错引擎」是静默失败（不报错，只是行为不对），必须有单元测试兜着。
import {
  ENGINE_CLI, ENGINE_OLLAMA, ENGINE_AUTO, ENGINE_CHOICES,
  normalizeEngine, isKnownEngine, canWriteFiles, pickEngine,
  engineUnavailableText, writeBlockedText,
  normalizeOllamaBase, normalizeOllamaModel,
  DEFAULT_OLLAMA_BASE, DEFAULT_OLLAMA_MODEL,
  ollamaTagsUrl, ollamaChatUrl,
} from './ai-engine.mjs';
// 本地模型的「完整评估」编排（纯函数部分）：prompt 拼装、输出解析、落盘产物。
// HTTP 与 fs 在本文件 —— 模块注释里写明了这条边界。
import {
  LOCAL_EVAL_NUM_CTX,
  buildLocalEvalPrompt, parseLocalEvalOutput, buildLocalReportArtifacts,
} from './local-eval.mjs';
// 报告编号预留/释放（与 ollama-eval.mjs 同一套），本地完整评估落盘时用
import { reserveReportNumbers, releaseReportNumbers } from '../reserve-report-num.mjs';
// 自动投递的安全口径（默认上限、平台上限、计划项状态中文）。零依赖模块，
// 浏览器与 Node 侧共用同一份 —— 界面上写的上限和真正执行的必须是同一个数。
import {
  PLATFORM, PLATFORM_DAILY_CAP, SAFE_DEFAULTS, ITEM_STATE, STATE_ZH, FILTER_REASON_ZH,
  LOGIN_COOKIES, hasLoginCookie,
} from './auto-apply.mjs';
// 「现在该跟进谁」的口径。国内招聘把中段拆细了（简历筛选/笔试/初试/复试/终面/谈薪），
// 而系统层 followup-cadence.mjs 的 ACTIONABLE_STATUSES 只认上游三个状态 ——
// 直接复用它，跟进页对国内岗位会几乎永远是空的。状态覆盖面写在 ui/followup-cn.mjs，
// 节奏数学仍然 import 自根目录那一份（不重写，避免两份口径各自漂移）。
import {
  analyzeFollowups, followupRowLine, appendFollowupRow, followupPinLine,
  appendFollowupLine, nextFollowupNum, normalizeChannel, CHANNELS,
  FOLLOWUPS_FILE_SKELETON,
} from './followup-cn.mjs';
// 跟进文件是跨进程共享的（CLI 的 followup-seed.mjs / set-status.mjs 也会写它），
// 所以必须用**同一个**目录锁，而不是本进程内自己排队 —— 进程内队列看不见别的进程。
// 注意：这把锁不可重入，持有它时不能再调也拿这把锁的 core 脚本。
import { withFollowupsLock } from '../followup-seed.mjs';
// 「今天是哪一天」按宿主本地时区算。toISOString() 给的是 UTC 日 ——
// 东八区的早上它会说「昨天」，跟进日期就会晚一天。
import { localToday } from '../lib/local-today.mjs';
// 「面试备考建议」的纯函数内核：报告解析、prompt 拼装、AI 回复解析、
// 本地规则兜底、导出 Markdown 组装。它**零依赖**，既给这里用也给浏览器用
// （app.js 会 import 同一份常量做展示），所以列在 STATIC 白名单里。
import {
  parseReportForPrep, diagnoseInputs, buildPrepPrompt, parsePrepOutput,
  prepOutputUsable, prepUnusableReason, buildLocalFallback, buildPrepMarkdown,
  MISSING_REASONS, parseReportSummary,
} from './prep-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 1. 定位项目根目录 ────────────────────────────────────────────────────
// 与 .agents/skills/career-ops/SKILL.md 的 PROJECT_ROOT 规则一致：
// 从当前目录向上找同时含 AGENTS.md 和 modes/ 的目录。
function findProjectRoot(start) {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'AGENTS.md')) && fs.existsSync(path.join(dir, 'modes'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const ROOT = findProjectRoot(__dirname);
if (!ROOT) {
  console.error('✖ 找不到 career-ops 项目根目录（需要同时存在 AGENTS.md 和 modes/）。');
  process.exit(1);
}

const PATHS = {
  cvMd: path.join(ROOT, 'cv.md'),
  cvForm: path.join(ROOT, 'data', 'cv-form.json'),
  profile: path.join(ROOT, 'config', 'profile.yml'),
  portals: path.join(ROOT, 'portals.yml'),
  tracker: path.join(ROOT, 'data', 'applications.md'),
  // 跟进记录（追加式，永不覆盖）：core 的 followup-cadence.mjs 与
  // followup-seed.mjs 读的是同一个文件，本文件只往里追加，不改写既有行。
  followups: path.join(ROOT, 'data', 'follow-ups.md'),
  pipeline: path.join(ROOT, 'data', 'pipeline.md'),
  reports: path.join(ROOT, 'reports'),
  output: path.join(ROOT, 'output'),
  templates: path.join(ROOT, 'templates'),
  // 「删除」一律是移到这个目录，不是真删。单独一处，用户后悔了知道去哪儿找；
  // reports/ 与台账都不再被扫描，所以界面上的效果和删除完全一样。
  trash: path.join(ROOT, 'data', 'trash'),

  // 简历多版本。**原版永远是 cv.md 本身，一个字节都不会被这里改写** ——
  // 定向优化出来的稿子一律另存成新版本，这样「按岗位定制」和「投得出去的那一份」
  // 不再互相覆盖。目录布局：
  //   data/cv-versions/index.json          元数据（版本名 / 适配岗位 / 创建时间 / 来源）
  //   data/cv-versions/<id>.md             版本正文本体
  //   data/cv-versions/_backups/<id>-<ts>.md   该版本被 AI 写回前的快照
  cvVersions: path.join(ROOT, 'data', 'cv-versions'),
  cvVersionBackups: path.join(ROOT, 'data', 'cv-versions', '_backups'),

  // 提升计划历史（2026-10-12）。每次生成 /api/prep/generate 自动落一份，
  // 一个岗位一份（同岗位重新生成 = 覆盖，计划永远跟最新一次走）：
  //   data/prep/<报告文件名>.json    完整计划（parsed + markdown + 元信息）
  // 删除走 moveToTrash（data/trash/，可恢复）。
  prep: path.join(ROOT, 'data', 'prep'),

  // AI 引擎选择。放 data/ 而不是 config/profile.yml：
  //   ① profile.yml 是「求职配置」，用户会天天打开看；引擎是跟本机环境绑定的设置，
  //      混进去只会让那份文件更难读，而且它得走行级替换改写，风险不值当。
  //   ② data/* 已被 .gitignore 排除，换机时不会把「我这台机器选了哪个引擎」带走。
  aiEngine: path.join(ROOT, 'data', 'ai-engine.json'),

  // 简历模板库（全局默认；注册用户走 userSpace() 里各自的那份）。
  // 结构：{ selected: '<模板id>|''', items: [ 自定义模板… ] } —— 内置三套
  // （'1'/'2'/'3'）在 cv-templates.mjs 里以代码定义，读取时合并，不落盘。
  cvTemplates: path.join(ROOT, 'data', 'cv-templates.json'),
  // 简历分区导航（2026-10-09）：{ order: [章节key…], hidden: [章节key…] }。
  // 只描述「章节怎么排、哪些不显示」，**不含简历内容** —— 内容永远在 cv.md。
  // 隐藏一项不会动 cv.md：预览与导出跳过它，素材原地保留（见 ui/cv-nav.mjs 注释）。
  cvNav: path.join(ROOT, 'data', 'cv-nav.json'),
  // 简历外观设置（2026-10-09）：{ accent, font, lineHeight, baseSize, … }。
  // 只描述「长什么样」，**不含简历内容** —— 内容永远在 cv.md。
  cvLook: path.join(ROOT, 'data', 'cv-look.json'),
  // 基本信息字段行的顺序与显隐（2026-10-09）：{ order: [字段key…], hidden: [字段key…] }。
  // 同样只描述「怎么排、哪些不显示」，**不含简历内容** —— 内容永远在 cv.md。
  cvFields: path.join(ROOT, 'data', 'cv-fields.json'),
  // 简历里插入的图片（头像 / 证书照片）。**存成文件而不是塞进 cv.md**：
  // base64 进 markdown 会让那份「给 AI 读、给人看」的文本彻底没法读，
  // 而且每次保存都要把整张图重写一遍。form 里只存应用内路径 /api/cv/asset/xx。
  cvAssets: path.join(ROOT, 'data', 'cv-assets'),
  // docx 保真模板的原文件（2026-09-30）：预置清单的 100 套放全局目录，
  // 自定义导入的放各用户空间 cv-tpl-files/。/api/tpl/file/:id 按这来取。
  tplCatalog: path.join(ROOT, 'data', 'tpl-catalog'),
  // docx 原文件转出的 PDF 缓存（保真预览用；转换走 ui/tpl-pdf-convert.mjs）
  tplCatalogPdf: path.join(ROOT, 'data', 'tpl-catalog-pdf'),
  // 同一批模板「按当前表单合成」的 docx 缓存（导出 Word 用；与预览同源）
  tplCatalogDocx: path.join(ROOT, 'data', 'tpl-catalog-docx'),
  // 全局空间（匿名/种子账号）自定义导入的 docx 原文件目录
  cvTplFiles: path.join(ROOT, 'data', 'cv-tpl-files'),
};

// 报告文件名白名单：只允许 reports/ 下的单层 .md 名，不含路径分隔符，`..` 也翻不出去。
// 除 ASCII 外**额外放行中文**——国内岗位的报告 slug 很可能被写成中文
// （`006-华为-2026-09-18.md`），而 \w 在非 u 模式下只认 [A-Za-z0-9_]，会把中文名
// 误判成「不合法」。读取与删除共用这一份，避免两处规则漂移。
const REPORT_NAME_RE = /^[\w.\-—\u4e00-\u9fa5]+\.md$/;

// YYYY-MM-DD 的**形状**校验。形状对不等于是真实日期（2026-02-31 也过这条正则），
// 所以调用处一律配合 toISOString() 回环比较 —— 一条不可能存在的日期进了
// follow-ups.md 会让节奏计算整份崩掉，这比拒绝一个手滑的输入代价大得多。
const REAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PORT = Number(argValue('--port') || process.env.PORT || 7317);
const HOST = '127.0.0.1';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// ── 2. 小工具 ────────────────────────────────────────────────────────────
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const existsDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

async function readText(p, fallback = '') {
  try { return await fsp.readFile(p, 'utf8'); } catch { return fallback; }
}

/** 把相对路径解析到项目内，越界直接抛错。所有文件读写都必须走这里。 */
function safeResolve(rel) {
  const abs = path.resolve(ROOT, rel);
  const relCheck = path.relative(ROOT, abs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw Object.assign(new Error('路径越界，已拒绝'), { status: 400 });
  }
  return abs;
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, text, type = 'text/plain; charset=utf-8', status = 200) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// ── Windows 自带 OCR（模板图片识别用）────────────────────────────────────
// 脚本本体**纯 ASCII**，经 -EncodedCommand（UTF-16LE base64）注入，图片路径
// 走环境变量 —— 避开「.ps1 + 中文路径 = GBK 乱码」的坑，也不用落脚本文件。
// Await 助手：WinRT 的 IAsyncOperation 在 PS 5.1 里要借
// WindowsRuntimeSystemExtensions.AsTask 转成可等待的 Task。
const TPL_OCR_PS = [
  "$ErrorActionPreference='Stop'",
  "$OutputEncoding=[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$null=[Windows.Storage.StorageFile,Windows.Foundation,ContentType=WindowsRuntime]",
  "$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Foundation,ContentType=WindowsRuntime]",
  "$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]",
  "$null=[Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]",
  "$m=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0]",
  "function Await($op,$t){ $task=$m.MakeGenericMethod($t).Invoke($null,@($op)); $task.Wait(-1)|Out-Null; $task.Result }",
  "$path=$env:TPL_OCR_PATH",
  "$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])",
  "$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])",
  "$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])",
  "$bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])",
  "$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()",
  "if(-not $engine){ $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN')) }",
  "if(-not $engine){ Write-Output '__NO_OCR_ENGINE__'; exit 2 }",
  "$result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])",
  "foreach($line in $result.Lines){ Write-Output $line.Text }",
].join('\n');

/** 图片路径 → OCR 文本（整段 stdout，行由调用方拆）。 */
function ocrImageWindows(imgPath, timeoutMs = 90000) {
  const encoded = Buffer.from(TPL_OCR_PS, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        windowsHide: true,
        env: { ...process.env, TPL_OCR_PATH: imgPath },
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout) => {
        const out = String(stdout || '');
        if (out.includes('__NO_OCR_ENGINE__')) {
          return reject(Object.assign(new Error('这台电脑没有可用的 OCR 语言包'
            + '（Windows 设置 → 时间和语言 → 语言和区域 → 添加「中文」并勾选文本识别），'
            + '或改用 PDF / Word 文件导入。'), { code: 'NO_ENGINE' }));
        }
        if (err) {
          if (err.killed || err.signal === 'SIGKILL') {
            return reject(Object.assign(new Error('OCR 识别超时（限时 90 秒）已中止。'
              + '试试内容少一些、分辨率低一些的图片。'), { code: 'OCR_TIMEOUT' }));
          }
          return reject(Object.assign(new Error('OCR 引擎启动失败：' + (err.message || '未知错误')), { code: 'OCR_FAIL' }));
        }
        resolve(out);
      });
  });
}

// ── 3. 执行子进程 ────────────────────────────────────────────────────────
function runNode(args, { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
    });

    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* 已经退出了 */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: killed ? -2 : code,
        stdout, stderr, ms: Date.now() - started,
        timeout: killed,
      });
    });
  });
}

// ── 3b. 定位 AI 命令行 ───────────────────────────────────────────────────
// 控制台要能在页面里直接做评估，就必须能自己把 AI 命令行拉起来。
// 这里按优先级探测，不要求用户配 PATH。
//
// 探测顺序：环境变量覆盖 → 常见安装位置 → WorkBuddy 托管 Node 的候选。
// 返回 { entry, label } 或 null。entry 是 CLI 的 JS 入口，用 process.execPath
// 直接跑它，绕开 .cmd 包装（那个包装内部调裸 node，反而更容易找不到）。
function findAiCli() {
  const HOME = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [];

  // 1) 用户显式指定（不校验存在性，出错时日志会说明）
  if (process.env.CAREER_OPS_AI_CLI) {
    candidates.push({ entry: process.env.CAREER_OPS_AI_CLI, label: '自定义 (CAREER_OPS_AI_CLI)' });
  }

  // 2) 项目本地安装
  candidates.push({
    entry: path.join(ROOT, 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    label: 'CodeBuddy Code (项目本地)',
  });

  // 3) 各 CLI 的常见全局安装位置
  const GLOBAL = [
    ['@tencent-ai/codebuddy-code/bin/codebuddy', 'CodeBuddy Code'],
    ['@anthropic-ai/claude-code/cli.js', 'Claude Code'],
    ['opencode-ai/bin/opencode', 'opencode'],
    ['@google/gemini-cli/dist/index.js', 'Gemini CLI'],
  ];
  const PREFIXES = [
    path.join(HOME, '.codebuddy-cli', 'node_modules'),
    path.join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules'),
    path.join(HOME, '.npm-global', 'lib', 'node_modules'),
    path.join(HOME, '.local', 'share', 'npm', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ];
  for (const prefix of PREFIXES) {
    for (const [rel, label] of GLOBAL) {
      candidates.push({ entry: path.join(prefix, ...rel.split('/')), label });
    }
  }

  for (const c of candidates) {
    try { if (c.entry && fs.existsSync(c.entry)) return c; } catch { /* 忽略 */ }
  }
  return null;
}

// ── AI 调用的两个坑，都会表现为「静默返回空」──────────────────────────
//
// 坑 1：端口冲突。
//   CLI 用 --port 起一个自己的本地服务。端口被占时它不一定报 EADDRINUSE，
//   而是退出码 0 + 输出为空，stderr 里留一句**误导性**的报错——
//   实测撞过一次，报的是 "Authentication required. Please use /login"，
//   害我先去查登录态。所以不写死端口，每次向系统现要一个空闲的。
//
// 坑 2：并发。
//   CLI 很重。页面上双击按钮、或开着两个标签页，两个进程会互相抢资源，
//   结果就是「随机某一次空返回」。这里串行化，排队比并行靠谱。
const AI_PORT_ENV = process.env.CAREER_OPS_AI_PORT || '';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(0)); // 拿不到就让 CLI 自己选，总比拿错强
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

let aiChain = Promise.resolve();
function withAiLock(fn) {
  const run = aiChain.then(fn, fn);
  aiChain = run.then(() => {}, () => {});
  return run;
}

// 在页面里跑一次 AI 对话（无头模式）。
// 刻意限制：只允许通过 /api/eval 调用，prompt 由服务端拼装，
// 前端只能提供「岗位链接 + JD 正文」这类内容，不能自由指定命令。
// ── 坑 3：无头模式的权限拦截（完整评估跑不出来的真正原因）──────────────
//
// `-p`（无头）模式下，CLI 默认把 Write / Bash / PowerShell 全部拦掉。
// 表现极具迷惑性：**退出码 0、输出正常、AI 还会礼貌地告诉你它写不了文件**——
//   「评估已完成，但当前会话为非交互模式，Write / Bash 全被权限拦截，
//     无法创建 reports/ 报告文件……请用 codebuddy -p -y 重跑」
// 所以完整评估必须加 `-y`（dangerously-skip-permissions），否则规则读了一万七千字、
// 报告一个字节也落不了盘，用户等十分钟拿到一段「我写不了」。
//
// 为什么只给 full 加、初筛不加：初筛明确不写文件，不加 `-y` 就能把影响面压到最小。
// 想再收一层可以设 CAREER_OPS_AI_NO_BYPASS=1。
const AI_BYPASS = process.env.CAREER_OPS_AI_NO_BYPASS !== '1';

// ── 3c. AI 引擎：CodeBuddy CLI ⇄ 本机 Ollama ─────────────────────────────
//
// 为什么值得有第二条引擎（不只为省钱）：
//   · CLI 是 agent —— 能自己读 modes/ 下的规则、能写 reports/ 与台账，
//     「完整评估」这个产物是文件，只有它做得出来。
//   · Ollama 是本机开源模型 —— 离线、零成本、数据不出本机，初筛完全够用。
// 两条路并存后，「这一次谁去跑」就有了三种答案。判断口径统一放在
// ui/ai-engine.mjs（纯函数、可单测），这里只负责按口径执行。
//
// 选择落在 data/ai-engine.json。**任何读取失败都退回 auto** ——
// 不能因为一个坏掉的配置文件把整个 AI 功能卡死，那是纯粹的净损失。
const OLLAMA_PROBE_MS = Number(process.env.OLLAMA_PROBE_MS || 1500);

// ── CodeBuddy 用哪个模型（2026-10-12：用户反馈生成太慢）─────────────────
// 实测病根不是启动、也不是工具往返，而是**单次模型流就要 150–600 秒**：
// CLI 默认模型（hy4-preview）写长中文很慢（一分钟几百字），而「完整报告 /
// 提升计划 / 简历优化」的产出动辄上万字 → 一次流跑十几分钟。
// 模型目录里同账号有 Flash 档（生成速度数量级更快），这里做成可配置：
//   data/ai-engine.json 的 cliModel 字段；没写就用这个默认值。
// 想换回质量更高的重模型：把该字段改成 'hy4-preview' / 'deepseek-v4-pro' 等。
const DEFAULT_CLI_MODEL = 'glm-5.3-flash';
const CLI_MODEL_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/i;

function normalizeCliModel(v) {
  const s = String(v == null ? '' : v).trim();
  return CLI_MODEL_RE.test(s) ? s : '';
}

function readAiEngineCfg() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(PATHS.aiEngine, 'utf8')) || {}; } catch { /* 首次运行或文件损坏：当空处理 */ }
  return {
    engine: normalizeEngine(raw.engine),
    // 空串 = 「用你自己模型的默认档」，只有显式配了才加 --model
    cliModel: normalizeCliModel(raw.cliModel || process.env.CAREER_OPS_CLI_MODEL || DEFAULT_CLI_MODEL),
    ollama: {
      base: normalizeOllamaBase(raw.ollama?.base || process.env.OLLAMA_BASE || DEFAULT_OLLAMA_BASE),
      model: normalizeOllamaModel(raw.ollama?.model || process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL),
    },
  };
}

function writeAiEngineCfg(cfg) {
  fs.mkdirSync(path.dirname(PATHS.aiEngine), { recursive: true });
  const out = {
    engine: normalizeEngine(cfg.engine),
    cliModel: normalizeCliModel(cfg.cliModel),
    ollama: {
      base: normalizeOllamaBase(cfg.ollama?.base),
      model: normalizeOllamaModel(cfg.ollama?.model),
    },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(PATHS.aiEngine, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

// 探测本机 Ollama。超时刻意压得很短：这只是一次状态查询，
// 服务没起时页面应该**立刻**看到「离线」，而不是转圈等成超时。
async function probeOllama(base) {
  const cfg = readAiEngineCfg();
  const url = ollamaTagsUrl(base || cfg.ollama.base);
  const shown = url.replace(/\/api\/tags$/, '');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_PROBE_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'Cache-Control': 'no-store' } });
    if (!res.ok) return { alive: false, base: shown, models: [], error: 'HTTP ' + res.status };
    const data = await res.json().catch(() => null);
    const models = Array.isArray(data?.models)
      ? data.models.map((m) => String(m?.name || '').trim()).filter(Boolean)
      : [];
    return { alive: true, base: shown, models };
  } catch (e) {
    return {
      alive: false, base: shown, models: [],
      error: e?.name === 'AbortError' ? '连接超时' : (e?.message || '连不上'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 「这一次到底该谁来跑」—— 三处共用一份判断（跑 AI、评估路由、简历优化路由）。
// 这行判断分散写三遍，最容易出的问题是「评估页说本地模型可用、简历页说不可用」，
// 而且两处都不报错，只是行为不一样。
// opts.force：把某一类功能**锁死**到指定引擎（2026-09-28 用户要求：岗位评估
// 一律走本地模型，不再读引擎卡的选择——CodeBuddy 登录态会过期，评估不能跟着遭殃）。
async function resolveEngine(opts = {}) {
  const cfg = readAiEngineCfg();
  const choice = opts.force || cfg.engine;
  const cli = findAiCli();
  // 只在「有可能真要用本地模型」时才探测它：服务没起时探测要等满超时，
  // 无条件探测等于给每一次 CLI 调用白加一次等待。
  let ollamaAlive = false;
  if (choice === ENGINE_OLLAMA || !cli) {
    ollamaAlive = (await probeOllama(cfg.ollama.base)).alive;
  }
  const picked = pickEngine({
    choice,
    cliAvailable: !!cli,
    ollamaAvailable: ollamaAlive,
  });
  return { cfg, cli, ollamaAlive, picked, choice };
}

/**
 * CodeBuddy 登录态「刚刚失效过」的短期记忆（2026-10-09）。
 *
 * 为什么要记：CLI 一次调用光启动 + 认证往返就要 15 秒左右，而登录态一旦失效，
 * 几分钟内不会自己好。每次都先跑一遍 CodeBuddy、白等 15 秒、再降级 —— 用户看到的
 * 是「点了 AI 优化，半分钟之后才开始干活」。记住之后直接走本地模型。
 *
 * 5 分钟自动过期：用户去「登录CodeBuddy.cmd」登录完回来，最迟 5 分钟恢复用 CodeBuddy，
 * 不需要重启服务。
 */
let cliAuthDownAt = 0;
const CLI_AUTH_DOWN_MS = 5 * 60 * 1000;

/**
 * 跑一次只读 AI 任务；首选引擎出不了稿就自动换另一个（2026-10-09）。
 *
 * 为什么需要：两个引擎的可用性**各自会变** —— CodeBuddy 的登录态约 10 天过期
 * （过期后每次都是「先等 15 秒，再回一句 Authentication required」），本地 Ollama
 * 则需要用户先把它跑起来。但「这个动作能不能用」不该跟着它们变：简历优化与
 * 一键润色都只有「给我一段改写文字」这一个用途，引擎不可用 = 功能不可用。
 *
 * 返回 { r, engine, from, reason }
 *   r      —— 真正出稿那次的 runAi 返回；一个都没成时是最后一次失败的返回
 *   engine —— 真正出稿的引擎；null = 一个都没跑成
 *   from   —— 被换掉的那个引擎（没换过 = ''）
 *   reason —— 换掉的原因：'auth' / 'empty' / 'unavailable' / 'cooling'
 *
 * ⚠️ 超时**不换引擎**：那说明引擎在干活、只是慢，换一个大概率一样慢，再等一遍
 *    纯属浪费用户时间。
 * ⚠️ 「换了引擎」必须由调用方在界面上说出来（用 degradeText）——用户有权知道
 *    自己的简历原文交给了谁。当初把优化页锁死在 CodeBuddy，就是不满这一点。
 */
async function runAiWithFallback(prompt, opts = {}) {
  const prefer = opts.prefer === ENGINE_OLLAMA ? ENGINE_OLLAMA : ENGINE_CLI;
  const timeoutMs = opts.timeoutMs || 600000;
  // CodeBuddy 刚失效过就先跳过：一次调用光启动 + 认证就是 15 秒。
  // 5 分钟自动过期（cliAuthDownAt），用户登录完回来不必重启服务。
  const cliCooling = Date.now() - cliAuthDownAt < CLI_AUTH_DOWN_MS;
  const order = prefer === ENGINE_OLLAMA ? [ENGINE_OLLAMA, ENGINE_CLI] : [ENGINE_CLI, ENGINE_OLLAMA];

  let from = '';
  let reason = '';
  let last = null;
  for (const id of order) {
    // 跳过也必须算作「降级」：用户这次用的仍是本地模型而不是 CodeBuddy，
    // 不记下来的话界面上什么都不说，等于把引擎换得悄无声息。
    if (id === ENGINE_CLI && cliCooling) {
      if (!from) { from = ENGINE_CLI; reason = 'cooling'; }
      continue;
    }
    const picked = (await resolveEngine({ force: id })).picked;
    if (!picked.ok) {
      if (!from) { from = id; reason = 'unavailable'; }
      last = { picked };
      continue;
    }
    const r = await runAi(prompt, { timeoutMs, bypass: !!opts.bypass, engine: id });
    if (r.timeout) return { r, engine: id, from, reason };                    // 超时留在原引擎
    if (!r.authFailed && String(r.stdout || '').trim()) {
      return { r, engine: id, from, reason };                                  // 出稿了
    }
    if (id === ENGINE_CLI) cliAuthDownAt = Date.now();
    if (!from) { from = id; reason = r.authFailed ? 'auth' : 'empty'; }
    last = { r, picked };
  }
  return { r: (last && last.r) || null, engine: null, from, reason, failed: last };
}

/** 「本次换过引擎」的说明文案。调用方**必须**把它显示出来 —— 不能静默换。 */
function degradeText(res) {
  if (!res || !res.from || !res.engine) return '';
  const why = res.reason === 'auth' ? '登录态过期'
    : res.reason === 'cooling' ? '登录态刚失效过'
      : res.reason === 'unavailable' ? '不可用' : '这次没返回内容';
  const fromLabel = (res.from === ENGINE_CLI ? 'CodeBuddy ' : '本地模型 ') + '（' + why + '）';
  const to = (res.r && res.r.cli) || (res.engine === ENGINE_OLLAMA ? '本地模型' : 'CodeBuddy');
  const tail = res.engine === ENGINE_OLLAMA
    ? '想要更好的效果：双击项目根目录的「登录CodeBuddy.cmd」重新登录，再回来重试。'
    : '';
  return '本次用的是 ' + to + ' —— ' + fromLabel + '没能出稿，已自动切换。' + tail;
}

// 本地模型的报错其实很直白，值得分开说 —— 「模型没拉过」是最常见的一种，
// 而它默认的报错既长又难认。
function friendlyOllamaError(status, body, model) {
  const s = String(body || '');
  if (status === 404 || /not found|no such model|unknown model/i.test(s)) {
    return '本地模型里没有 `' + model + '`。在终端跑一次：ollama pull ' + model;
  }
  if (status === 403) {
    return 'Ollama 拒绝了这次请求（HTTP 403）。若开了 OLLAMA_ORIGINS 白名单，请放行本机来源。';
  }
  return '本地模型返回 HTTP ' + status + '：' + s.slice(0, 300);
}

// 跑一次本地模型对话。
//
// 返回值**刻意和 runAiOnce 同形**（code/stdout/stderr/ms/cli）——
// 这样 /api/eval 那边一行都不用改。换个引擎不该让上游长出一堆 if。
//
// 两个**必须**（初筛 6.9 秒能跑通掩盖不了的坑，简历优化实测踩中）：
// ① stream:true。stream:false 时 Ollama 在生成完成前一个字节都不发，
//    Node 内置 fetch 的 undici 300 秒 headersTimeout 先到 —— 超过 5 分钟的
//    调用**必死**（ollama-eval.mjs 的注释记载过同一个坑）。流式让响应头
//    立刻到达，之后是身体在慢慢流。
// ② options.num_ctx 显式声明。Ollama 默认上下文只有 2048 token，
//    简历优化这种长 prompt 会被**静默截断**：模型只看到半份简历。
async function runOllamaOnce(prompt, { timeoutMs = 600000 } = {}) {
  const cfg = readAiEngineCfg();
  const model = cfg.ollama.model;
  const label = 'Ollama · ' + model;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(ollamaChatUrl(cfg.ollama.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        options: { temperature: 0.4, num_ctx: LOCAL_EVAL_NUM_CTX },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return { code: -1, stdout: '', ms: Date.now() - started, cli: label,
        stderr: friendlyOllamaError(res.status, text, model) };
    }
    const { text } = await readOllamaStream(res);
    return { code: 0, stdout: text.trim(), stderr: '', ms: Date.now() - started, cli: label };
  } catch (e) {
    const timedOut = e?.name === 'AbortError';
    return {
      code: timedOut ? -2 : -1, stdout: '', ms: Date.now() - started, cli: label,
      timeout: timedOut,
      stderr: timedOut
        ? '本地模型超时（' + Math.round(timeoutMs / 1000) + ' 秒）。'
          + '本地模型处理很长的提示会明显变慢，可以先「只做初筛」。'
        : '连不上本地模型服务（' + cfg.ollama.base + '）。'
          + '先双击项目里的「启动Ollama.cmd」，或到评估页点「测一下」确认端口。',
    };
  } finally {
    clearTimeout(timer);
  }
}

// 流式 /api/chat 的响应体是按行分隔的 JSON：每个 token 一个对象，
// 最后一个带 done:true 和 token 计数。收拢成完整文本，顺带把
// prompt / eval 的 token 计数带出来（成本展示用）。
// 尾行没有换行符也要算（Ollama 每个分块都带换行，但截断的尾巴不算数）。
async function readOllamaStream(res) {
  let acc = '', buf = '', promptTokens = 0, evalTokens = 0;
  const decoder = new TextDecoder();
  const drain = (line) => {
    line = line.trim();
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    if (obj.error) throw new Error('本地模型报错：' + obj.error);
    if (obj.message?.content) acc += obj.message.content;
    if (obj.done) {
      promptTokens = obj.prompt_eval_count ?? promptTokens;
      evalTokens = obj.eval_count ?? evalTokens;
    }
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      drain(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  drain(buf);
  return { text: acc, promptTokens, evalTokens };
}

// ── 本地模型的「完整评估」通路 ──────────────────────────────────────────────
// 完整评估的 prompt 有 1 万多 token（规则文件 + 简历 + JD）。runOllamaOnce 是给
// 「短问短答」用的（stream:false、不设 options）—— 而 Ollama 不显式给 num_ctx
// 时上下文默认只有 2048 token，prompt 会被**静默截断**：模型看到的规则只剩零头，
// 评估必然胡说。所以这里单独一个函数：流式（首 token 即回包，避开 undici 的
// 300s headersTimeout）+ temperature 0.4 + num_ctx 显式声明。
// 口径与根目录 ollama-eval.mjs 一致，那边是这条路的验证原型。
async function runOllamaEvalOnce({ system, user, timeoutMs = 1800000 } = {}) {
  const cfg = readAiEngineCfg();
  const model = cfg.ollama.model;
  const label = 'Ollama · ' + model;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(ollamaChatUrl(cfg.ollama.base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: true,
        options: { temperature: 0.4, num_ctx: LOCAL_EVAL_NUM_CTX },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      return { code: -1, stdout: '', ms: Date.now() - started, cli: label,
        stderr: friendlyOllamaError(res.status, body, model) };
    }
    // 流式读取 + token 计数收在 readOllamaStream() 一个地方
    const { text, promptTokens, evalTokens } = await readOllamaStream(res);
    return {
      code: 0, stdout: text.trim(), stderr: '', ms: Date.now() - started, cli: label,
      tokens: { prompt: promptTokens, eval: evalTokens },
    };
  } catch (e) {
    const timedOut = e?.name === 'AbortError';
    return {
      code: timedOut ? -2 : -1, stdout: '', ms: Date.now() - started, cli: label,
      timeout: timedOut,
      stderr: timedOut
        ? '本地模型超时（' + Math.round(timeoutMs / 1000) + ' 秒）。'
          + '完整评估要读全部规则再写整份报告，是最慢的一档；可以先「只做初筛」。'
        : (e?.message || '本地模型调用失败'),
    };
  } finally {
    clearTimeout(timer);
  }
}

// 完整评估的本地编排：读规则进 prompt → 调模型 → 解析 → 由**代码**写报告与
// 台账 addition。模型全程只出文本 —— 「本地模型写不了盘」限制的是模型，
// 不是服务端。编号预留/释放与 ollama-eval.mjs 同一套（reserve-report-num.mjs）。
async function runLocalFullEval({ jd, url, timeoutMs = 1800000, cvContent } = {}) {
  const cfg = readAiEngineCfg();
  const model = cfg.ollama.model;

  // 规则文件读进来。缺了不拦 —— prompt 里会带占位说明，模型按剩余规则评估，
  // 总好过整单报错（ollama-eval.mjs 同口径）。
  const readCtx = async (p, label) => {
    try {
      const t = (await readText(p)).trim();
      return t || `[${label} 为空]`;
    } catch {
      console.warn('[local-eval] ' + label + ' 读取失败，评估上下文不完整');
      return `[${label} 缺失]`;
    }
  };
  const shared = await readCtx(path.join(ROOT, 'modes', '_shared.md'), 'modes/_shared.md');
  const oferta = await readCtx(path.join(ROOT, 'modes', 'oferta.md'), 'modes/oferta.md');
  // 简历：调用方指定了版本就用调用方读好的正文（/api/eval 已过白名单），
  // 没指定才回落到根目录 cv.md —— 两条路的内容口径在这里收拢成一个出口。
  const cv = (cvContent != null && String(cvContent).trim())
    ? String(cvContent)
    : await readCtx(SP().cvMd, 'cv.md');
  const profileYml = await readCtx(PATHS.profile, 'config/profile.yml');
  const profile = await readCtx(path.join(ROOT, 'modes', '_profile.md'), 'modes/_profile.md');

  const { systemPrompt, userPrompt, budgetReport } = buildLocalEvalPrompt({
    shared, oferta, cv, profileYml, profile, jd, postingUrl: url,
  });

  const r = await runOllamaEvalOnce({ system: systemPrompt, user: userPrompt, timeoutMs });
  if (r.code !== 0 || !r.stdout) {
    return { ...r, localEval: { ok: false, reason: r.stderr || '本地模型没有返回内容' } };
  }

  const parsed = parseLocalEvalOutput(r.stdout);
  if (!parsed.body || !parsed.score) {
    return {
      ...r,
      localEval: {
        ok: false,
        reason: !parsed.body
          ? '输出为空'
          : '没解析出分数（SCORE_SUMMARY / Machine Summary / 正文头部三种格式都没认出来）',
      },
    };
  }

  // ── 落盘 ──────────────────────────────────────────────────────────────
  let reserved = [];
  try {
    reserved = await reserveReportNumbers(1, { rootDir: ROOT, reportsDir: SP().reports });
    const today = new Date().toISOString().split('T')[0];
    const art = buildLocalReportArtifacts({
      num: reserved[0],
      company: parsed.company, role: parsed.role, score: parsed.score,
      archetype: parsed.archetype, legitimacy: parsed.legitimacy,
      body: parsed.body, today, postingUrl: url, model,
    });
    await fsp.mkdir(SP().reports, { recursive: true });
    await fsp.writeFile(path.join(SP().reports, art.filename), art.reportContent, 'utf8');
    const additionsDir = path.join(ROOT, 'batch', 'tracker-additions');
    await fsp.mkdir(additionsDir, { recursive: true });
    await fsp.writeFile(
      path.join(additionsDir, art.additionName),
      art.additionHeader + '\n' + art.additionRow + '\n',
      'utf8',
    );
    return {
      ...r,
      localEval: {
        ok: true, filename: art.filename, addition: art.additionName,
        score: parsed.score, source: parsed.source,
        company: parsed.company, role: parsed.role,
        tokens: r.tokens, budget: budgetReport,
      },
    };
  } catch (e) {
    return { ...r, localEval: { ok: false, reason: '落盘失败：' + (e?.message || e) } };
  } finally {
    // 预留号写完就放回（已写的文件自己占着这个编号）；写失败则编号可复用
    if (reserved.length > 0) {
      try {
        await releaseReportNumbers(reserved, { reportsDir: SP().reports });
      } catch { /* 释放失败不影响主流程，GC 会兜 */ }
    }
  }
}

function runAiOnce(prompt, { timeoutMs = 600000, bypass = false, engine = null } = {}) {
  return new Promise(async (resolve) => {
    // ── 这次谁去跑 ────────────────────────────────────────────────────────
    // 口径统一在 resolveEngine()（内部调 ui/ai-engine.mjs 的 pickEngine）：
    // 显式选择优先，auto 优先 CLI —— 它多了写文件的能力。
    //
    // engine 必须能透传（2026-10-09）：调用方在**校验过**的引擎上执行，
    // 这里若再读一次全局配置，就会把选择悄悄改回去 ——
    // 踩过的坑：「简历全局优化」传 engine:'cli' 锁 CodeBuddy，
    // 校验通过却仍跑到了 Ollama（data/ai-engine.json 里正是 ollama）。
    const { cli, picked } = await resolveEngine(engine ? { force: engine } : {});

    if (picked.engine === ENGINE_OLLAMA) {
      resolve(await runOllamaOnce(prompt, { timeoutMs }));
      return;
    }
    if (!picked.ok || !cli) {
      resolve({
        code: -1, stdout: '', ms: 0,
        stderr: engineUnavailableText(picked.ok ? 'none' : picked.reason),
        // 一个引擎都没有时重试毫无意义，只会让用户多等一遍同样的失败
        noCli: true,
      });
      return;
    }
    const port = AI_PORT_ENV || String(await freePort());
    const started = Date.now();
    const args = [
      cli.entry,
      '-p', prompt,
      '--add-dir', ROOT,
      '--port', port,
      '--output-format', 'text',
    ];
    // 模型档位（2026-10-12 提速）：默认档写长文本要十几分钟，换成 Flash 档后
    // 同样的稿子快一个数量级。没配就完全不加这个参数（保持 CLI 自身默认）。
    const cliModel = readAiEngineCfg().cliModel;
    if (cliModel) args.push('--model', cliModel);
    if (bypass && AI_BYPASS) args.push('-y');
    // ⚠️ 代理必须剥掉：本机 shell 里可能留着 `http_proxy=127.0.0.1:<端口>`，
    // 而那个代理进程多半早就退了 —— CLI 会先按它建一次代理连接（日志里
    // 「fetch config failed ... at setProxy」就是它），每个请求白等一轮。
    // CLI 自己直连就行，这里只清代理相关的几个变量，不动别的环境。
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) {
      delete env[k];
    }
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      windowsHide: true,
    });

    let stdout = '', stderr = '', killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* 已经退出了 */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, ms: Date.now() - started, cli: cli.label, port });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: killed ? -2 : code,
        stdout, stderr, ms: Date.now() - started,
        timeout: killed, cli: cli.label, port,
      });
    });
  });
}

// 「静默失败」的指纹：退出码 0、没超时、但一个字都没输出。
// 这不是真正的成功，也不值得把错误甩给用户——换个端口重试一次基本就好。
const isSilentFail = (r) => !r.noCli && !r.timeout && r.code === 0 && !String(r.stdout || '').trim();

// 登录态过期的指纹（2026-09-28 实测）：CLI 会把这句话吐在 stderr、退出码 0、
// stdout 为空 —— 看起来和「瞬时空返回」一模一样。但它是**确定性失败**：
// 换端口重试毫无意义（两次都会回同一句话），必须走交互式重新登录。
const AUTH_FAIL_RE = /authentication required|please.*login|not logged in/i;
const isAuthFail = (r) => !r.noCli
  && (AUTH_FAIL_RE.test(String(r.stderr || '')) || AUTH_FAIL_RE.test(String(r.stdout || '')));

async function runAi(prompt, opts = {}) {
  return withAiLock(async () => {
    let r = await runAiOnce(prompt, opts);
    // 登录过期：一击即中，别再重试 —— 白白多等一倍时间，结果一模一样
    if (isAuthFail(r)) return { ...r, authFailed: true };
    if (isSilentFail(r)) {
      const first = { ...r };
      r = await runAiOnce(prompt, opts);
      if (isAuthFail(r)) return { ...r, authFailed: true, retried: true };
      if (isSilentFail(r) || (!String(r.stdout || '').trim() && String(first.stderr || '').trim())) {
        // 两次都空，把第一次的 stderr 带出来，方便定位
        r = { ...r, stderr: [first.stderr, r.stderr].filter(Boolean).join('\n'), retried: true };
      } else {
        r.retried = true;
      }
    }
    return r;
  });
}

// 可执行脚本白名单。args 是固定值，不接受来自请求的参数——
// 避免任何形式的命令注入。
//
// params（可选）：声明该脚本允许从页面表单接收的额外参数。
//   每一项形如 { name, flag, type, required, pattern, label, hint, default }
//   - type: 'text' | 'url' | 'number' | 'select' | 'checkbox'
//   - pattern: 正则字符串，值必须完全匹配才放行（防注入的关键防线）
//   - flag: 传参时的前缀（如 '--url'）；留空则作为位置参数追加
// 只有这里显式声明的参数才会被接受，其余一律忽略。
const SCRIPTS = {
  // ── A. 诊断 ──────────────────────────────────────────────────────────
  doctor:      { args: ['doctor.mjs', '--json'],                label: '环境自检',       group: 'diagnose', desc: '检查依赖、配置、初始化状态' },
  verify:      { args: ['verify-pipeline.mjs'],                  label: '台账完整性检查', group: 'diagnose', desc: '状态合法性、重复项、报告链接' },
  sync:        { args: ['cv-sync-check.mjs'],                    label: '配置同步检查',   group: 'diagnose', desc: '比对简历与 profile 的一致性' },
  freshness:   { args: ['check-table-freshness.mjs'],            label: '数据时效检查',   group: 'diagnose', desc: '法条/政策表是否过期' },
  jdarchive:   { args: ['check-jd-archive.mjs'],                 label: 'JD 归档检查',    group: 'diagnose', desc: '每份报告是否留了 JD 原文' },
  audit:       { args: ['audit-portals.mjs', '--summary'],       label: '岗位源审计',     group: 'diagnose', desc: '逐个岗位源抓取体检（较慢）', slow: true },
  lint:        { args: ['scripts/check-syntax.mjs'],             label: '脚本语法检查',   group: 'diagnose', desc: '扫描所有 .mjs 的语法错误', slow: true },
  liveness:    { args: ['check-liveness.mjs'],                   label: '岗位链接存活检测', group: 'diagnose', desc: '检查 URL 是否还能打开', slow: true,
                 params: [{ name: 'urls', label: '岗位链接', type: 'text', required: true, multi: true,
                            hint: '多个链接用空格分隔',
                            pattern: '^[\\w\\-./:?=&%#@+~\\[\\]!$\'()*;,]+(\\s+[\\w\\-./:?=&%#@+~\\[\\]!$\'()*;,]+)*$' }] },

  // ── B. 数据维护 ──────────────────────────────────────────────────────
  normalize:   { args: ['normalize-statuses.mjs'],                label: '状态标准化',     group: 'maintain', desc: '把台账状态统一成合法值' },
  dedup:       { args: ['dedup-tracker.mjs'],                    label: '台账去重',       group: 'maintain', desc: '删除重复的投递记录' },
  merge:       { args: ['merge-tracker.mjs'],                    label: '台账合并',       group: 'maintain', desc: '合并多个来源的台账' },
  reconcile:   { args: ['reconcile-pipeline.mjs'],               label: '链接池对齐',     group: 'maintain', desc: '对齐岗位链接池与报告' },
  vportals:    { args: ['validate-portals.mjs'],                 label: '岗位源校验',     group: 'maintain', desc: '校验 portals.yml 格式' },
  vportals2:   { args: ['verify-portals.mjs'],                   label: '岗位源连通性',   group: 'maintain', desc: '逐个测试岗位源是否可达', slow: true },
  archive:     { args: ['archive-posting.mjs'],                  label: '归档岗位信息',   group: 'maintain', desc: '把 JD 原文存进本地归档' },
  updatetest:  { args: ['updater-migration-tests.mjs'],          label: '更新迁移自测',   group: 'maintain', desc: '验证系统更新不会丢用户数据' },
  updatecheck: { args: ['update-system.mjs', 'check'],           label: '检查系统更新',   group: 'maintain', desc: '对比上游版本' },

  // ── C. 分析与统计 ────────────────────────────────────────────────────
  stats:       { args: ['stats.mjs'],                            label: '求职漏斗统计',   group: 'analyze', desc: '各阶段转化率、平均分' },
  patterns:    { args: ['analyze-patterns.mjs'],                 label: '被拒规律分析',   group: 'analyze', desc: '按渠道统计推进率' },
  upskill:     { args: ['upskill.mjs'],                          label: '技能缺口分析',   group: 'analyze', desc: '从已评估报告中汇总缺口' },
  reposts:     { args: ['detect-reposts.mjs', '--summary'],      label: '重复挂岗检测',   group: 'analyze', desc: '识别反复重挂的岗位' },
  calibrate:   { args: ['calibrate.mjs'],                        label: '评分校准',       group: 'analyze', desc: '对比自评分与实测结果' },
  latency:     { args: ['rejection-latency.mjs'],                label: '拒绝响应时长',   group: 'analyze', desc: '从投递到拒绝的平均天数' },
  digest:      { args: ['weekly-digest.mjs'],                    label: '周报生成',       group: 'analyze', desc: '汇总本周求职进展' },
  goldeneval:  { args: ['eval-golden.mjs'],                      label: '黄金样本评估',   group: 'analyze', desc: '用固定样本检验评估质量' },

  // ── D. 查询 ──────────────────────────────────────────────────────────
  tracker:     { args: ['tracker.mjs'],                          label: '台账概览',       group: 'query',   desc: '纯文本形式的投递状态表' },
  find:        { args: ['find.mjs'],                             label: '查找记录',       group: 'query',   desc: '按编号或公司/岗位搜索',
                 params: [{ name: 'q', label: '搜索关键词', type: 'text', required: true,
                            hint: '报告编号 / 台账编号 / 公司名片段',
                            pattern: '^[\\w\\u4e00-\\u9fa5\\-. /#&+]{1,80}$' }] },

  // ── E. 动作 ──────────────────────────────────────────────────────────
  scan:        { args: ['scan.mjs'],                             label: '扫岗',           group: 'action',  desc: '抓取岗位源（零 token，不花钱）', slow: true },
  scanhn:      { args: ['scan-hn.mjs'],                          label: '扫 HN 招聘',     group: 'action',  desc: '抓取 Hacker News 招聘帖', slow: true },
  scanfull:    { args: ['scan-ats-full.mjs'],                    label: '全量扫岗',       group: 'action',  desc: '抓取全部 ATS 岗位源', slow: true },
  company:     { args: ['company-funded.mjs'],                   label: '融资公司查询',   group: 'action',  desc: '查最近融资的公司名单', slow: true },

  // ── F. 简历与投递材料 ────────────────────────────────────────────────
  cncv:        { args: ['tools/cn-cv-check.mjs'],                label: '中文简历自检',   group: 'cv',      desc: '国内简历惯例：一页、教育前置、量化、反虚构（零 token）' },
  cnkit:       { args: ['tools/cn-interview-kit.mjs'],           label: '生成面试准备包', group: 'cv',      desc: '国内面试：技术八股/项目深挖/HR面20问/反问清单（零 token）',
                 params: [
                   { name: 'company', label: '公司名', type: 'text', flag: '--company',
                     hint: '可留空。例：华为',
                     pattern: '^[\\u4e00-\\u9fff\\w\\s·.\\-]{1,40}$' },
                   { name: 'role', label: '岗位名', type: 'text', flag: '--role',
                     hint: '可留空。填了会按方向给八股清单。例：后端开发工程师',
                     pattern: '^[\\u4e00-\\u9fff\\w\\s·.\\-/]{1,40}$' },
                 ] },
  cvfacts:     { args: ['verify-cv-facts.mjs'],                  label: '简历事实核验',   group: 'cv',      desc: '检查简历有无无法证实的表述',
                 params: [{ name: 'doc', label: '文档路径', type: 'text', required: true,
                            hint: '相对项目根的路径，如 output/cv-2026-09-17.html',
                            pattern: '^[\\w\\-./\\\\]{1,200}$' }] },
  cvats:       { args: ['verify-ats.mjs'],                       label: 'ATS 兼容检查',   group: 'cv',      desc: '海外 ATS 机器筛选友好度（国内投递基本用不上）',
                 params: [{ name: 'doc', label: '简历 HTML', type: 'text', required: true,
                            hint: '相对项目根的路径，如 output/cv-2026-09-17.html',
                            pattern: '^[\\w\\-./\\\\]{1,200}$' }] },
  cvsim:       { args: ['jd-similarity.mjs'],                    label: 'JD 相似度比对',  group: 'cv',      desc: '新旧 JD 或 JD 与简历的重合度',
                 params: [
                   { name: 'a', label: '新 JD 路径', type: 'text', required: true, hint: '相对路径',
                     pattern: '^[\\w\\-./\\\\]{1,200}$' },
                   { name: 'b', label: '对比文件路径', type: 'text', required: true, hint: '旧 JD 或简历',
                     pattern: '^[\\w\\-./\\\\]{1,200}$' }] },
  imgpdf:      { args: ['img-to-pdf.mjs'],                       label: '图片转 PDF',     group: 'cv',      desc: '把图片简历转成 PDF',
                 params: [{ name: 'img', label: '图片路径', type: 'text', required: true,
                            hint: '相对项目根的路径，如 output/scan.png',
                            pattern: '^[\\w\\-./\\\\ ]{1,200}\\.(png|jpg|jpeg|webp|bmp)$' }] },
  cover:       { args: ['generate-cover-letter.mjs', '--payload'], label: '生成求职信',   group: 'cv',      desc: '按岗位生成求职信草稿',
                 params: [{ name: 'payload', label: '岗位 payload JSON', type: 'text', required: true,
                            hint: '相对项目根的 JSON 路径',
                            pattern: '^[\\w\\-./\\\\]{1,200}\\.json$' }] },
  prepare:     { args: ['prepare-application.mjs'],              label: '准备投递材料',   group: 'cv',      desc: '汇总投递所需的文件与清单',
                 params: [
                   { name: 'url', label: '投递链接', type: 'url', required: true, hint: 'https://…',
                     pattern: '^https?://[\\w\\-./:?=&%#@+~]{1,300}$' },
                   { name: 'pdf', label: '简历 PDF 路径', type: 'text', required: true, hint: '相对路径',
                     pattern: '^[\\w\\-./\\\\]{1,200}\\.pdf$' }] },
  appinit:     { args: ['application-artifacts.mjs', '--init'],  label: '初始化投递档案', group: 'cv',      desc: '为一份投递建立目录骨架' },
  star:        { args: ['match-star.mjs'],                       label: 'STAR 故事匹配',  group: 'cv',      desc: '为面试匹配 STAR 案例' },
  pasteReply:  { args: ['paste-reply.mjs'],                      label: '记录 HR 回复',   group: 'cv',      desc: '粘贴回复内容并归档' },
  inviteprep:  { args: ['invite-match.mjs'],                     label: '面试邀约匹配',   group: 'cv',      desc: '把邀约与已有台账对齐' },
};

// ── 4. YAML 行级编辑（保留注释） ─────────────────────────────────────────
function yamlQuote(v) {
  const s = String(v ?? '');
  if (s === '') return '""';
  // 只在必要时加引号，让文件保持可读
  if (/^[A-Za-z0-9_\-./@+ ]+$/.test(s) && !/^\s|\s$/.test(s)) return s;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

/** 找到某个顶层键所在的行号（允许该行被注释）。 */
function findKeyLine(lines, key, indent, from = 0, to = lines.length) {
  for (let i = from; i < to; i++) {
    const raw = lines[i];
    const m = raw.match(/^(\s*)(#\s*)?([A-Za-z_][\w-]*)\s*:/);
    if (!m) continue;
    if (m[1].length !== indent) continue;
    if (m[3] !== key) continue;
    return i;
  }
  return -1;
}

/** 某个键管辖的区间 [start, end)，按缩进判断。 */
function blockRange(lines, keyLineIdx, indent) {
  let end = lines.length;
  for (let i = keyLineIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (indentOf(l) <= indent) { end = i; break; }
  }
  return [keyLineIdx + 1, end];
}

/**
 * 设置 YAML 标量。pathKeys 形如 ['candidate','full_name']。
 * 已存在（含被注释掉的）则就地替换并取消注释；不存在则在父键后插入。
 */
function setYamlScalar(text, pathKeys, value) {
  const lines = text.split(/\r?\n/);
  const leaf = pathKeys[pathKeys.length - 1];
  const leafIndent = (pathKeys.length - 1) * 2;

  let from = 0, to = lines.length, anchor = -1;
  for (let d = 0; d < pathKeys.length - 1; d++) {
    const idx = findKeyLine(lines, pathKeys[d], d * 2, from, to);
    if (idx < 0) { anchor = -1; break; }
    anchor = idx;
    [from, to] = blockRange(lines, idx, d * 2);
  }

  const idx = findKeyLine(lines, leaf, leafIndent, from, to);
  if (idx >= 0) {
    const pad = ' '.repeat(leafIndent);
    lines[idx] = `${pad}${leaf}: ${yamlQuote(value)}`;
    return lines.join('\n');
  }

  // 不存在 → 插在父键块的开头
  const insertAt = anchor >= 0 ? anchor + 1 : lines.length;
  lines.splice(insertAt, 0, `${' '.repeat(leafIndent)}${leaf}: ${yamlQuote(value)}`);
  return lines.join('\n');
}

/** 设置 YAML 字符串列表（形如 `key:\n  - a\n  - b`）。 */
function setYamlStringList(text, pathKeys, items) {
  const lines = text.split(/\r?\n/);
  const leaf = pathKeys[pathKeys.length - 1];
  const leafIndent = (pathKeys.length - 1) * 2;

  let from = 0, to = lines.length, anchor = -1;
  for (let d = 0; d < pathKeys.length - 1; d++) {
    const idx = findKeyLine(lines, pathKeys[d], d * 2, from, to);
    if (idx < 0) { anchor = -1; break; }
    anchor = idx;
    [from, to] = blockRange(lines, idx, d * 2);
  }

  const idx = findKeyLine(lines, leaf, leafIndent, from, to);
  const rendered = items.length
    ? items.map((s) => `${' '.repeat(leafIndent + 2)}- ${yamlQuote(s)}`)
    : [`${' '.repeat(leafIndent + 2)}[]`];

  if (idx < 0) {
    const at = anchor >= 0 ? anchor + 1 : lines.length;
    lines.splice(at, 0, `${' '.repeat(leafIndent)}${leaf}:`, ...rendered);
    return lines.join('\n');
  }

  const [bStart, bEnd] = blockRange(lines, idx, leafIndent);
  // 只吃「列表项」行，遇到注释或其它键就停
  let eat = bStart;
  while (eat < bEnd) {
    const t = lines[eat].trim();
    if (t === '') { eat++; continue; }
    if (/^-\s|^\[\]$/.test(t)) { eat++; continue; }
    break;
  }
  lines[idx] = `${' '.repeat(leafIndent)}${leaf}:`;
  lines.splice(idx + 1, eat - bStart, ...rendered);
  return lines.join('\n');
}

let yamlLib = null;
async function loadYaml() {
  if (yamlLib !== null) return yamlLib;
  try {
    // 命名导入，不能用 `.default`：js-yaml 5.x 是原生 ESM 构建、没有 default 导出，
    // 取 `.default` 会得到 undefined，随后被误判成"未安装 js-yaml"。
    // 命名形式在 4.x 和 5.x 上都能解析（与 detect-reposts.mjs、plugins/_engine.mjs 一致）。
    const mod = await import('js-yaml');
    const lib = mod && typeof mod.load === 'function' ? mod
      : (mod && mod.default && typeof mod.default.load === 'function' ? mod.default : null);
    yamlLib = lib || false;
  } catch { yamlLib = false; }
  return yamlLib;
}

// ── 5. 数据读取 ──────────────────────────────────────────────────────────
function splitRow(line) {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (t[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (cells) => cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '');

/** 找出文件里第一张表头含 Status/状态 的表。 */
function parseTable(md) {
  const lines = md.split(/\r?\n/);
  const tables = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const header = splitRow(run[0]);
      const body = run.slice(1).filter((l) => !isSeparator(splitRow(l)));
      tables.push({ header, rows: body.map(splitRow) });
    }
    run = [];
  };
  for (const line of lines) {
    if (line.trim().startsWith('|')) run.push(line);
    else flush();
  }
  flush();
  if (!tables.length) return { header: [], rows: [] };
  const hit = tables.find((t) => t.header.some((h) => /status|状态/i.test(h)));
  return hit || tables[0];
}

// ── 回收目录：所有「删除」都是移动，不是真删 ─────────────────────────────
async function ensureTrash() {
  await fsp.mkdir(PATHS.trash, { recursive: true });
}

/**
 * 把文件移进回收目录，返回相对 ROOT 的路径。
 * 同一毫秒内删多个也不互相覆盖，所以带个自增序号兜底。
 */
async function moveToTrash(absPath, label) {
  await ensureTrash();
  const stamp = Date.now();
  const base = path.basename(absPath);
  let target = path.join(PATHS.trash, `${stamp}-${label}-${base}`);
  for (let n = 1; exists(target); n++) {
    target = path.join(PATHS.trash, `${stamp}-${label}-${n}-${base}`);
  }
  await fsp.rename(absPath, target);
  return path.relative(ROOT, target).split(path.sep).join('/');
}

/**
 * 台账是「一个文件 + 若干行」，没法只把一行移走，
 * 所以删行前先把整份台账快照进回收目录 —— 恢复那一份就是恢复那一行。
 */
async function snapshotTracker() {
  if (!exists(PATHS.tracker)) return '';
  await ensureTrash();
  const stamp = Date.now();
  let target = path.join(PATHS.trash, `${stamp}-applications.md`);
  for (let n = 1; exists(target); n++) {
    target = path.join(PATHS.trash, `${stamp}-applications-${n}.md`);
  }
  await fsp.copyFile(PATHS.tracker, target);
  return path.relative(ROOT, target).split(path.sep).join('/');
}

/**
 * 从台账 Report 列的单元格里取报告文件名。
 * 该列存的是 Markdown 链接原文（`[003](../reports/003-xxx.md)`），也可能被手改成
 * 裸路径或带引号的名字。取 basename 再校验 .md，取不到返回 ''。
 * 与前端 reportFileName() 是同一套规则（改一处就要改两处）。
 */
function reportNameFromCell(cell) {
  const s = String(cell || '').trim();
  if (!s) return '';
  const link = s.match(/\]\(([^)]+)\)/);          // [003](../reports/003-xxx.md)
  const raw = (link ? link[1] : s).split('#')[0].split('?')[0].trim();
  const base = raw.replace(/^["'`]+|["'`]+$/g, '').split(/[\\/]/).pop().trim();
  return /\.md$/i.test(base) ? base : '';
}

// ── 简历多版本 ───────────────────────────────────────────────────────────
// 为什么要版本：一份简历投所有岗位，是国内校招里最常见的失分点。
// 但「按岗位改一版」如果直接改 cv.md，就会把上一版覆盖掉 —— 投到第三家时
// 已经找不回投给第一家的那一份了。所以这里的规矩是：
//   · 原版 = cv.md 本身，**只读**，任何版本操作都不会碰它；
//   · 定向优化出来的稿子一律另存成新版本，按岗位命名。
const VERSION_ID_RE = /^[a-z0-9]{6,32}$/;
const VERSION_NAME_MAX = 60;

async function ensureCvVersions() {
  await fsp.mkdir(path.join(SP().cvVersions, '_backups'), { recursive: true });
}

/**
 * 版本 id → 正文文件绝对路径。
 * id 只由服务端生成（时间戳 36 进制 + 随机后缀），天然不含路径分隔符；
 * 这里仍然过一道白名单，因为 index.json 是磁盘上的普通文件，
 * 被手改成 `../../config/profile` 之后就成了一次任意读。
 */
function versionFile(id) {
  if (!VERSION_ID_RE.test(String(id || ''))) {
    throw Object.assign(new Error('版本 id 不合法'), { status: 400 });
  }
  return path.join(SP().cvVersions, id + '.md');
}

async function readVersionIndex() {
  const raw = await readText(path.join(SP().cvVersions, 'index.json'));
  if (!raw.trim()) return [];
  let parsed = [];
  try { parsed = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  // 只认结构完整、id 合法的条目。坏一条丢一条，不让整个版本列表打不开。
  return parsed.filter((v) => v && typeof v === 'object' && VERSION_ID_RE.test(String(v.id || '')));
}

/** 原子写：先写 .tmp 再 rename。写到一半断电也不会留下半截 JSON 把版本列表锁死。 */
async function writeVersionIndex(list) {
  await ensureCvVersions();
  const file = path.join(SP().cvVersions, 'index.json');
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

const newVersionId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** 清洗版本名：换行会破坏表格与文件名，去掉；长度封顶，避免撑爆界面。 */
function cleanVersionName(raw) {
  const name = String(raw || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, VERSION_NAME_MAX);
  if (!name) throw Object.assign(new Error('版本名称不能为空'), { status: 400 });
  return name;
}

/**
 * 全部版本，原版永远排第一。
 * 原版不写进 index.json —— 它的事实来源是 cv.md 本身，
 * 单独存一份元数据就会多出「两处不一致」的可能。
 */
async function listVersions() {
  const idx = await readVersionIndex();
  const out = [];
  let st = null;
  try { st = await fsp.stat(SP().cvMd); } catch { /* 还没建简历 */ }
  out.push({
    id: 'base', name: '原版简历', targetRole: '', source: '', note: '',
    createdAt: st ? (st.birthtimeMs || st.mtimeMs) : null,
    updatedAt: st ? st.mtimeMs : null,
    bytes: st ? st.size : 0,
    base: true, exists: !!st,
  });
  for (const v of idx) {
    let s = null;
    try { s = await fsp.stat(versionFile(v.id)); } catch { /* 文件被手工删了，如实标 missing */ }
    out.push({
      id: v.id,
      name: v.name || v.id,
      targetRole: v.targetRole || '',
      source: v.source || '',
      sourceName: v.sourceName || '',
      note: v.note || '',
      createdAt: v.createdAt || (s ? s.birthtimeMs : null),
      updatedAt: s ? s.mtimeMs : (v.updatedAt || null),
      bytes: s ? s.size : 0,
      base: false,
      exists: !!s,
    });
  }
  return out;
}

/** 读某版本的正文；'base' 就是 cv.md。 */
async function readVersionMd(id) {
  if (!id || id === 'base') return await readText(SP().cvMd);
  return await readText(versionFile(id));
}

async function findVersionMeta(id) {
  return (await listVersions()).find((v) => v.id === id) || null;
}

/**
 * 行级 diff。CV 只有几百行，LCS 的 O(n·m) 完全够用；
 * 仍然留一个规模上限，免得有人把几兆的文本塞进来把服务卡住。
 */
function diffLines(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
  if (n * m > 4_000_000) {
    return [{ t: '!', text: `两份内容都太长（${n} / ${m} 行），已跳过逐行对比`, a: null, b: null }];
  }
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { out.push({ t: ' ', text: aLines[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: '-', text: aLines[i], a: i + 1, b: null }); i++; }
    else { out.push({ t: '+', text: bLines[j], a: null, b: j + 1 }); j++; }
  }
  while (i < n) { out.push({ t: '-', text: aLines[i], a: i + 1, b: null }); i++; }
  while (j < m) { out.push({ t: '+', text: bLines[j], a: null, b: j + 1 }); j++; }
  return out;
}

/** 用于 output/ 下的文件名：去掉路径分隔符与 Windows 保留字符，中文保留。 */
function safeSlug(s, max = 24) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '-').replace(/\s+/g, '-')
    .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max) || 'cv';
}

/**
 * 简历优化的 prompt。
 *
 * 抽成函数是因为它有**两个调用方**：原版 cv.md 的通用优化，和某个岗位版本的
 * 定向优化。两边必须用同一套反虚构规则 —— 复制一份出来改，迟早只有一边被修好，
 * 而另一边会安安静静地把用户真实写过的账号换成占位符。
 *
 * srcLabel 只用于提示 AI「这份内容来自哪里」，会写进 prompt 的标题行。
 */
/**
 * 「AI 优化本段」的三套提示词。
 *
 * 接入来源：github.com/ThanosKa/magic-resume 的 /api/polish（app/api/polish/route.ts）。
 * 它按 polishType 分 title / summary / description 三套 system prompt，不用一套
 * 通用提示词打天下 —— 因为三种字段的「好」标准根本不同：职位名要短、要行业术语；
 * 自我评价要两三句、要价值主张；经历描述要动词开头、要量化。用同一套规则硬套，
 * 模型会把一条经历改写成一段自述。
 *
 * 这边是**重新实现**：原文是英文、面向欧美简历；中文口径与「反虚构」这条硬规则
 * 一律沿用本项目既有的 buildCvOptimizePrompt 口径 —— 只改写法，不添事实。
 * magic-resume 那三套 prompt 里没有这条约束（它允许「quantify where possible」），
 * 照搬会让 AI 顺手给用户编一个看起来很合理的百分比。
 */
const POLISH_MODE_RULES = {
  title: [
    '【文体】这是在优化一个「职位名 / 求职意向」，不是一句话。',
    '1. 长度 2–6 个词（中文 4–12 字），用招聘网站上的通用叫法，不要生造职级或方向。',
    '2. **不得抬高或压低职级**：原文是「实习生」不能改成「专员」，原文没写「高级」不许加。',
    '3. 方向词（算法 / 全栈 / 后端 / 数据…）只能取自原文，不许凭联想补一个。',
    '4. 只输出这一行名字：不要标点收尾、不要换行、不要解释。',
  ],
  summary: [
    '【文体】这是在优化简历里的「自我评价 / 个人简介」。',
    '1. 写成 2–3 句：你是谁 + 目标方向 + 最硬的一条优势，语气笃定但不夸张。',
    '2. **不得新增原文没有的经历、数字、证书、公司名、技术栈**；只重写表达方式。',
    '3. 原文写了年限 / 届次就保留，没写就不要补一个看起来合理的。',
    '4. 删掉没有佐证的空话（「有责任心」「抗压能力强」这类），换成可验证的表述。',
    '5. 只输出正文：不要小标题、不要编号、不要解释。',
  ],
  description: [
    '【文体】这是在优化简历里的「经历描述 / 成果要点」。',
    '1. 每条写成「动词开头 + 做了什么 + 方法或工具 + 结果」的结构。',
    '2. 尽量量化，但**原文没有的数字一个都不许出现**；确实该量化而原文没写的地方，'
      + '写成【待补充：具体数字】让用户自己填，不许替他编。',
    '3. **保持原文的行结构**：原文几行就输出几行，不合并、不拆分、不新增条目。',
    '4. 专有名词、技术栈名称、公司 / 学校名原样保留，不翻译、不改写。',
    '5. 删掉口语化表达与空话，用书面、凝练的写法。',
    '6. 只输出正文，不要编号、不要小标题、不要代码块标记。',
  ],
};
const POLISH_MODES = Object.keys(POLISH_MODE_RULES);

/** 三套模式共用的收尾约束。 */
const POLISH_TAIL = [
  '',
  '【硬性规则】',
  'A. 只改写，不新增事实：原文没有的数字、成果、技术名词一律不得出现。',
  'B. 直接输出改写后的文字，不要任何解释、前后缀、小标题或代码块围栏。',
];

/**
 * 「AI一键优化本段」的提示词（简历编辑器，/api/ai/polish）。
 *
 * 与整份优化（buildCvOptimizePrompt）的区别：输入是一小段原文而不是整份 cv.md，
 * 输出也只有改写后的文字，没有问题清单 —— 快、便宜、结果可以直接对回单个输入框。
 *
 * mode 白名单外的值一律回落到 description（最常用的一档），不抛错 ——
 * 提示词档位不该成为让用户看到报错的原因。
 */
function buildPolishPrompt(text, hint = '', mode = 'description') {
  const m = POLISH_MODES.includes(mode) ? mode : 'description';
  const p = [
    '【任务】把下面这段简历原文改写得更专业、更有说服力。这是一次局部润色，不是重写。',
    '',
    ...POLISH_MODE_RULES[m],
  ];
  if (hint) p.push('', '【补充】这段文字出自简历里的「' + hint + '」字段，按该字段的文体改写。');
  p.push(...POLISH_TAIL, '', '【简历原文】', '', text);
  return p.join('\n');
}

/**
 * 简历优化的提示词。
 * opts（可选，来自评估页「AI优化简历」弹窗）：
 *   - scope: string[]  优化范围（'项目经历'/'工作经历'/'技能板块'/'个人简介' 白名单，
 *             服务端已过滤），不传或为空 = 全文优化，行为与从前一字不差
 *   - styleNote: string  文风指令（服务端按白名单映射好的完整句子）
 *   - extra: string  用户补充要求（服务端已截断到 500 字符）
 */
function buildCvOptimizePrompt(cvMd, jd, srcLabel = 'cv.md', opts = {}) {
  const p = [];
  p.push('【任务】优化下面这份中文求职简历。',
    '',
    '【阅读范围】只读这两份，不要读其他文件：',
    '1. config/profile.yml —— 目标岗位方向、核心优势、资格检查字段（优化的方向依据）',
    '2. modes/_profile.md —— 本项目的中文招聘覆盖规则，**简历规范在里面，优先级最高**',
    '',
    '**不要通读 modes/oferta.md 全文（8 万字符，会拖垮速度）。**',
    '需要模板段落时用 grep 定位小节后按需读取。',
    '');

  if (jd) {
    p.push('【优化目标】按下面这份岗位 JD 做**定向优化**：让简历的措辞、关键词、',
      '经历排序尽量贴合这个岗位的要求。',
      '注意：只能重组既有事实、换更贴合岗位的说法，**不许**为了贴合 JD 而编造经历或技能。',
      '如果 JD 要求的能力在简历里完全没有对应事实，就**不要硬凑**——',
      '照原样保留，并在问题清单里说明「这项要求目前没有对应经历，建议自行补充或放弃该岗位」。',
      '', '```', jd, '```', '');
  } else {
    p.push('【优化目标】按 profile.yml 里的目标岗位方向做**通用优化**：',
      '指出与目标方向不匹配的地方，并按国内简历规范调整结构、措辞、量化程度。',
      '（本次没有提供具体 JD，不要臆造某个岗位的要求。）',
      '');
  }

  if (Array.isArray(opts.scope) && opts.scope.length) {
    p.push('【本次优化范围】用户勾选了这些板块，改写稿与问题清单**优先覆盖**它们：'
      + opts.scope.join('、') + '。未勾选的板块保持原样，不要大改。', '');
  }
  if (opts.styleNote) {
    p.push('【简历文风】' + opts.styleNote, '');
  }
  if (opts.extra) {
    p.push('【用户补充要求】（若与前面的默认指令冲突，以这里为准）：', '```', opts.extra, '```', '');
  }

  p.push('【硬性规则】',
    '- **只读，绝对不要写文件**：不要调用 Write / Edit / Bash 修改任何文件，'
    + '不要写报告、不要更新台账。你的产出只有下面那三段文字。',
    // 2026-10-09「简历全局优化」页的规则：只改措辞，内容项一个不多一个不少，
    // 结构与顺序照旧。原prompt 只说了「反虚构」（不许新增），没说不许删 ——
    // AI 会在「精简」的名义下把用户的一条经历并进另一条，页面上看不出来，
    // 写回后才发现内容少了。两条必须一起写死。
    '- **只优化措辞，不增删内容项**：在原简历内容的基础上，仅优化措辞、表达方式与专业性。'
    + '**不得删除任何原有的内容项**——每一条经历、每一个项目、每一项技能、每一行描述，'
    + '都要能在改写稿里找到对应；合并同类项、把多行压成一行，都算删除。'
    + '**也不得新增原简历中不存在的内容**。宁可写得平淡，也不要为了好看而补内容。',
    '- **保留模块结构、字段顺序与层级**：模块数量与先后顺序、模块内字段的排列顺序、'
    + '条目的层级关系，一律与原文保持一致。不要把并列字段拆成新章节，'
    + '也不要把两个模块合并成一个。',
    '- **反虚构**：不许编造没有依据的经历、数字、证书、奖项、公司名。',
    '  原简历里没有量化数据的地方，改写时保留原意，并明确写成【待补充：具体数字】让用户自己填；'
    + '不要替他填一个看起来合理的数字。',
    '- **不许把已有的信息换成占位符**：原文里已经写了的账号、链接、奖项、课程、'
    + '职责描述，一律原样保留、只做润色或补量化。只有**原文确实没有**的信息才允许写'
    + '【待补充】。（踩过的坑：把原文的 GitHub 账号换成了「【待补充：GitHub 链接】」，'
    + '用户看到的就是「优化把我的信息删了」。）',
    '- **章节一个都不能少、名字一个都不要改**：原文有几个 `## 章节`，改写稿就保留几个，'
    + '顺序可以按国内惯例调整，但标题**沿用原文的写法**（原文是 `## Projects` 就写'
    + ' `## Projects`，不要自行改成「项目经验」之类）。控制台靠这些标题识别内容，'
    + '改名或删节会让简历在「我的简历」页里显示不全。',
    '- **条目的排版也沿用原文**：经历/教育用 `### 标题` + 紧随一行的 `**时间 · 城市**`；'
    + '项目用 `### 项目名` + `**技术栈：** …`；技能用 `- **分类：** a、b、c`。',
    '- 保留原有的真实信息（学校、专业、时间、公司、岗位名），不要改写这些事实。',
    '- 中文表达，符合国内招聘惯例（教育背景前置、一页纸、结论先行等，以 _profile.md 为准）。',
    '',
    '【简历原文 ' + srcLabel + '】',
    '```markdown',
    cvMd.trim(),
    '```',
    '',
    '【输出格式】严格按下面三段输出，**不要写别的内容**（不要开场白、不要结束语）：',
    '',
    'SUMMARY: <一到两句话总评：这份简历最大的问题是什么>',
    '',
    '### 问题清单',
    '1. [高] <问题标题> —— <具体说明 + 直接可用的改法>',
    '2. [中] <问题标题> —— <具体说明 + 直接可用的改法>',
    '3. [低] <问题标题> —— <具体说明 + 直接可用的改法>',
    '（最多 8 条，按严重度从高到低，只写真正影响投递的问题，不要凑数）',
    '',
    '### 改写稿',
    '```markdown',
    '<改写后的完整简历正文，Markdown 格式，可直接覆盖文件>',
    '```',
    '',
    '「改写稿」必须是**整份简历**（不是片段、不是修改说明），'
    + '否则用户没法直接写回文件。');

  return p.join('\n');
}

/**
 * 求职信的提示词（规则来源：modes/cover.md，系统层只读）。
 *
 * 为什么把规则**整份内联**，而不是像简历优化那样写「去读 modes/cover.md」：
 * 本地模型没有文件访问能力 —— 跟它说「读某个文件」它会当没看见，
 * 然后生成一封没有规则约束的通用信，而 cover.md 第 0 步恰恰明令禁止通用信。
 * CLI 能读文件，内联对它是冗余而不是冲突。宁可多花点 token，
 * 也不要两条引擎跑出两种质量的信。
 */
function buildCoverPrompt({ coverRules, cvMd, jd, company, role, cvLabel, question }) {
  const p = [];
  p.push('【任务】为下面这位候选人，针对指定的岗位写一封**可以直接发出去**的求职信。', '');
  if (company || role) p.push('【目标岗位】' + [company, role].filter(Boolean).join(' · '), '');

  p.push('【最高优先级规则】',
    '- **反虚构**：只能用简历里真实存在的事实；不许编造经历、数字、奖项、公司名。',
    '  简历里没有的量化数据写成【待补充：具体数字】，不要替候选人生一个看起来合理的数字。',
    '- **不要写通用信**：每一段都要贴着这个岗位的具体要求写；'
    + '某条要求简历里没有对应事实时，**如实说明缺什么**，不要用空话糊过去。',
    '- **只输出求职信正文**：不要开场白（「好的，我来写…」）、不要说明、不要复述规则。',
    '- **不要写文件、不要调用任何工具**：你的产出只有这封信本身。',
    '  规则文件里要求抓网页 / 查资料 / 写文件的步骤一律跳过。',
    '- 输出语言：简体中文；称呼、语气、篇幅按国内校招惯例（细节以规则文件为准）。', '');

  if (question) {
    p.push('【另外还有一个网申提问】国内网申常要求回答一个开放题。'
      + '除了求职信，再针对下面这个问题单独给一段中文回答（300 字以内）：',
      '', '```', question, '```', '');
  }

  p.push('【求职信规则文件（modes/cover.md —— 结构与语气以它为准）】', '', coverRules.trim(), '');
  p.push('【候选人简历' + (cvLabel ? '，' + cvLabel : '') + '】', '```markdown', cvMd.trim(), '```', '');
  p.push('【岗位 JD】', '```', jd.trim(), '```', '');
  p.push('【输出格式】',
    '第一行给邮件主题：`SUBJECT: <中文主题>`，空一行，然后给求职信正文'
    + '（Markdown：称呼、3–5 段正文、落款）'
    + (question
      ? '；最后用 `## 开放题回答` 起一段，给那个提问的回答。'
      : '。不要写别的内容。'));
  return p.join('\n');
}

/** 单行化外部输入：换行会破坏提示词结构，长度封顶防撑爆界面。 */
function cleanInline(raw, max = 60) {
  return String(raw ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

async function getTracker() {
  const md = await readText(PATHS.tracker);
  if (!md.trim()) return { header: [], rows: [], raw: '' };
  const { header, rows } = parseTable(md);
  const col = (name) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iNum = col('#'), iDate = col('Date'), iCompany = col('Company'),
    iRole = col('Role'), iScore = col('Score'), iStatus = col('Status'),
    iPdf = col('PDF'), iReport = col('Report'), iNotes = col('Notes');

  const items = rows.map((r) => ({
    num: iNum >= 0 ? r[iNum] : '',
    date: iDate >= 0 ? r[iDate] : '',
    company: iCompany >= 0 ? r[iCompany] : '',
    role: iRole >= 0 ? r[iRole] : '',
    score: iScore >= 0 ? r[iScore] : '',
    status: iStatus >= 0 ? r[iStatus] : '',
    pdf: iPdf >= 0 ? r[iPdf] : '',
    report: iReport >= 0 ? r[iReport] : '',
    notes: iNotes >= 0 ? r[iNotes] : '',
  })).filter((x) => x.company || x.role || x.num);

  return { header, rows: items, raw: md };
}

/**
 * 「现在该跟进谁」——读台账 + 跟进记录，交给 ui/followup-cn.mjs 算节奏。
 *
 * 读两个文件而不是一个：台账给状态和日期，跟进记录给「上次追是什么时候」。
 * 跟进文件不存在是正常状态（还没追过任何人），不是错误 —— analyzeFollowups
 * 对空内容是有定义的（每条 followupCount=0，于是按首次跟进节奏算）。
 */
async function getFollowups() {
  const [trackerMd, followupsMd] = await Promise.all([
    readText(PATHS.tracker),
    readText(PATHS.followups),
  ]);
  const analysis = analyzeFollowups(trackerMd, followupsMd);
  return {
    analysis,
    // 跟进记录文件是否存在 —— 前端据此区分「还没追过」和「文件丢了」
    hasLog: !!(followupsMd && followupsMd.trim()),
    // 可选通道交给前端渲染下拉，避免前端写死一份和这里漂移
    channels: CHANNELS,
  };
}

/**
 * 读 templates/states.yml 的 states 数组。
 * /api/states（台账页的状态下拉）用它 —— 若别处再各读一次，字段处理稍有出入
 * 就会出现「下拉里有的状态、别处没有」。
 */
async function readStates() {
  const yaml = await loadYaml();
  if (!yaml) return { states: [], yamlMissing: true };
  try {
    const raw = await readText(path.join(ROOT, 'templates', 'states.yml'));
    return { states: (yaml.load(raw) || {}).states || [], yamlMissing: false };
  } catch {
    return { states: [], yamlMissing: false };
  }
}

async function getPipeline() {
  const md = await readText(PATHS.pipeline);
  const lines = md.split(/\r?\n/);
  const pending = [], processed = [];
  let section = 'pending';

  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const t = h[1].toLowerCase();
      if (/pending|待/.test(t)) section = 'pending';
      else if (/processed|已处理|完成/.test(t)) section = 'processed';
      else section = 'other';
      continue;
    }
    const m = line.match(/^\s*-\s*\[([ x!])\]\s*(.+?)\s*$/);
    if (!m) continue;
    const flag = m[1];
    const rest = m[2];
    const urlMatch = rest.match(/https?:\/\/\S+/);
    const tail = urlMatch ? rest.slice(rest.indexOf(urlMatch[0]) + urlMatch[0].length) : rest;
    const parts = tail.split('|').map((s) => s.trim()).filter(Boolean);
    const item = {
      flag: flag === ' ' ? 'pending' : flag === 'x' ? 'done' : 'error',
      url: urlMatch ? urlMatch[0] : '',
      text: rest,
      company: parts[0] || '', role: parts[1] || '', extra: parts.slice(2).join(' | '),
    };
    if (section === 'pending') pending.push(item);
    else if (section === 'processed') processed.push(item);
  }

  return { pending, processed, raw: md, exists: md.trim().length > 0 };
}

/** 列出报告。目录默认取**当前请求的数据空间**（注册用户=自己的 reports/，
 *  其余=全局 reports/）；系统级统计（使用情况）显式传 SP().reports 保持全局口径。 */
async function listReports(dir = SP().reports) {
  if (!existsDir(dir)) return [];
  const names = await fsp.readdir(dir);
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('README')) continue;
    const full = path.join(dir, name);
    let stat; try { stat = await fsp.stat(full); } catch { continue; }
    const head = (await readText(full)).slice(0, 2500);
    const grab = (label) => {
      const m = head.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, 'i'));
      return m ? m[1].trim() : '';
    };
    // 报告标题：兼容中文标题 `# 评估报告：{公司} — {职位}` 与旧英文标题
    // `# Evaluation: {公司} — {职位}`，两种前缀都剥掉，卡片上只留「公司 — 职位」。
    const titleM = head.match(/^#\s+(?:(?:Evaluation|评估报告)\s*[:：]\s*)?(.+)$/m);
    out.push({
      file: name,
      title: titleM ? titleM[1].trim() : name,
      date: grab('Date'),
      score: grab('Score'),
      archetype: grab('Archetype'),
      url: grab('URL'),
      pdf: grab('PDF'),
      legitimacy: grab('Legitimacy'),
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function getCv() {
  const md = await readText(SP().cvMd);
  let form = null;
  const formRaw = await readText(SP().cvForm);
  if (formRaw.trim()) {
    try { form = normalizeCv(JSON.parse(formRaw)); } catch { form = null; }
  }
  if (!form) form = markdownToCv(md);
  return {
    markdown: md,
    form,
    completeness: cvCompleteness(form),
    hasMd: exists(SP().cvMd),
    hasForm: !!formRaw.trim(),
  };
}

async function getProfile() {
  const raw = await readText(PATHS.profile);
  const yaml = await loadYaml();
  let parsed = null, parseError = null;
  if (yaml) {
    try { parsed = yaml.load(raw); } catch (e) { parseError = e.message; }
  } else {
    parseError = '未找到 js-yaml（请先运行 npm install）';
  }
  return { raw, parsed, parseError, exists: exists(PATHS.profile) };
}

async function getStatus() {
  const res = await runNode(['doctor.mjs', '--json'], { timeoutMs: 60000 });
  let data = null;
  try {
    const m = res.stdout.match(/\{[\s\S]*\}/);
    if (m) data = JSON.parse(m[0]);
  } catch { /* 解析失败就走降级分支 */ }
  return {
    ok: !!data,
    doctor: data,
    raw: (res.stdout || '') + (res.stderr || ''),
    files: {
      // 系统体检：固定按全局环境算（种子数据在不在），不随请求者的数据空间走
      cvMd: exists(PATHS.cvMd),
      profile: exists(PATHS.profile),
      portals: exists(PATHS.portals),
      tracker: exists(PATHS.tracker),
      pipeline: exists(PATHS.pipeline),
      forms: exists(PATHS.cvForm),
    },
  };
}

// ── 6. 路由 ──────────────────────────────────────────────────────────────
// ── 登录 / 用户 / 反馈 / 使用情况（2026-09-26 多角色演示层）──────────────
// 三份 JSON 都是「没有就播种」的本地数据文件，全在 data/ 下（已被 .gitignore
// 排除）。密码只存 sha256(salt + ':' + password)，不存明文。会话表在内存里，
// 服务重启即失效 —— 前端启动时会用 /api/auth/me 校验并静默清掉旧 token。
const AUTH = {
  users: path.join(ROOT, 'data', 'users.json'),
  feedback: path.join(ROOT, 'data', 'feedback.json'),
  usage: path.join(ROOT, 'data', 'usage.json'),
};
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天
const sessions = new Map(); // token -> { username, role, exp }

function hashPassword(salt, password) {
  return crypto.createHash('sha256').update(salt + ':' + password).digest('hex');
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonFile(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function mkUser(id, username, displayName, role, password, createdAt) {
  const salt = crypto.randomBytes(8).toString('hex');
  return { id, username, displayName, role, salt, hash: hashPassword(salt, password), createdAt, lastLogin: '' };
}

function ensureSeedData() {
  const now = new Date().toISOString();
  if (!fs.existsSync(AUTH.users)) {
    writeJsonFile(AUTH.users, { users: [
      mkUser('u1', 'admin', '管理员', 'admin', 'admin123', now),
      mkUser('u2', 'demo', '演示用户', 'user', '123456', now),
      mkUser('u3', 'litong', '李同学', 'user', '123456', now),
      mkUser('u4', 'wang', '王女士', 'user', '123456', now),
    ] });
  }
  if (!fs.existsSync(AUTH.feedback)) {
    const d = (m) => new Date(Date.now() - m * 86400000).toISOString();
    writeJsonFile(AUTH.feedback, { items: [
      { id: 'f1', user: 'litong', text: '评估报告里的备考建议希望能一键导出成文档，方便打印着背。', status: 'pending', t: d(1) },
      { id: 'f2', user: 'demo', text: '简历预览在窄屏下偶尔要等两秒才刷新，其它都挺顺手。', status: 'pending', t: d(2) },
      { id: 'f3', user: 'wang', text: '岗位评估挺准的，希望以后能支持批量粘贴多个 JD 一起评。', status: 'done', t: d(5) },
    ] });
  }
  if (!fs.existsSync(AUTH.usage)) writeJsonFile(AUTH.usage, { events: [] });
}
ensureSeedData();

// ── 按用户隔离的数据空间（2026-09-30）────────────────────────────────────
// 注册 / 管理员建号产生的**新用户**拥有独立数据目录 data/users/<用户名>/：
//   cv.md（空白，自己填）、cv-form.json（派生缓存）、reports/（自己跑）、
//   cv-versions/（自己的岗位定制版）。与种子演示账号共享的全局数据互不可见 ——
//   新用户看到的是一份空白简历和空的报告列表，而不是演示账号的现成数据。
// 请求进入时用 AsyncLocalStorage 绑定所属空间，所有数据读写统一走 SP() 取
// 当前根；没有独立目录（种子账号 / 未登录）= 回落全局 PATHS，行为与从前一字不差。
const USER_SPACE = new AsyncLocalStorage();

/** 当前请求的数据空间：有独立目录的用户返回用户路径表，其余回落全局 PATHS。 */
function SP() {
  return USER_SPACE.getStore() || PATHS;
}

function userSpaceDir(username) {
  return path.join(ROOT, 'data', 'users', String(username || ''));
}

/** 有独立数据目录的用户 → 该用户的空间路径表；否则 null（走全局）。
 *  用户名在开户时已过 /^[a-z0-9_-]{2,20}$/ 校验，拼进路径是安全的。 */
function userSpace(username) {
  if (!username) return null;
  const dir = userSpaceDir(username);
  if (!existsDir(dir)) return null;
  return {
    cvMd: path.join(dir, 'cv.md'),
    cvForm: path.join(dir, 'cv-form.json'),
    reports: path.join(dir, 'reports'),
    cvVersions: path.join(dir, 'cv-versions'),
    cvVersionBackups: path.join(dir, 'cv-versions', '_backups'),
    prep: path.join(dir, 'prep'),
    cvTemplates: path.join(dir, 'cv-templates.json'),
    cvNav: path.join(dir, 'cv-nav.json'),
    cvLook: path.join(dir, 'cv-look.json'),
    cvFields: path.join(dir, 'cv-fields.json'),
    cvAssets: path.join(dir, 'cv-assets'),
    // docx 保真模板的原文件（导入时随模板一并落盘，/api/tpl/file/:id 读）
    cvTplFiles: path.join(dir, 'cv-tpl-files'),
    // 同一批模板转出的 PDF 缓存（/api/tpl/pdf/:id 读；首次请求时惰性生成）
    cvTplFilesPdf: path.join(dir, 'cv-tpl-files', 'pdf'),
    // 按当前表单合成的 docx 缓存（导出 Word 用；/api/tpl/fill-docx/:id 读）
    cvTplFilesDocx: path.join(dir, 'cv-tpl-files', 'docx'),
  };
}

/** 新开户播种：空白简历 + 空报告/版本目录。cv-form.json 不建 ——
 *  空的 cv.md 会让 /api/cv 给出一份空白表单（EMPTY_CV），用户从零开始填。 */
function scaffoldUserSpace(username) {
  const dir = userSpaceDir(username);
  fs.mkdirSync(path.join(dir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cv-versions'), { recursive: true });
  const cvFile = path.join(dir, 'cv.md');
  if (!fs.existsSync(cvFile)) fs.writeFileSync(cvFile, '', 'utf8');
  return dir;
}

function createSession(user) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username: user.username, role: user.role, exp: Date.now() + SESSION_TTL });
  return token;
}

function getSession(req, url) {
  const token = String(url.searchParams.get('token') || req.headers['x-lizhuo-token'] || '');
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) { sessions.delete(token); return null; }
  return { token, username: s.username, role: s.role };
}

function requireAdmin(req, url) {
  const s = getSession(req, url);
  return s && s.role === 'admin' ? s : null;
}

/** 近 14 天使用情况汇总：登录次数（usage.json 事件）+ 新增评估报告
 *  （reports/ 文件，日期取报告头部的 Date 字段，缺了退回文件名里的日期）。 */
async function buildUsageSummary() {
  const today = new Date();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    days.push({ key, label: (d.getMonth() + 1) + '/' + d.getDate(), logins: 0, reports: 0 });
  }
  const usage = readJsonFile(AUTH.usage, { events: [] });
  const perUser = {};
  for (const e of usage.events) {
    if (e.type !== 'login') continue;
    perUser[e.user] = (perUser[e.user] || 0) + 1;
    const day = days.find((x) => x.key === String(e.t || '').slice(0, 10));
    if (day) day.logins++;
  }
  // 使用情况是**系统级统计**（管理后台总览），报告数固定按全局目录算，
  // 不随管理员自己的数据空间走 —— 否则新开户的管理员会看到 0 报告的假象。
  const reports = await listReports(PATHS.reports);
  for (const r of reports) {
    const fromName = (r.file.match(/(\d{4}-\d{2}-\d{2})\.md$/) || [])[1] || '';
    const day = days.find((x) => x.key === (r.date || fromName));
    if (day) day.reports++;
  }
  const db = readJsonFile(AUTH.users, { users: [] });
  const userRows = db.users
    .map((u) => ({ username: u.username, displayName: u.displayName, role: u.role, lastLogin: u.lastLogin || '', logins: perUser[u.username] || 0 }))
    .sort((a, b) => b.logins - a.logins);
  const feedback = readJsonFile(AUTH.feedback, { items: [] });
  return {
    totals: {
      users: db.users.length,
      logins: usage.events.filter((e) => e.type === 'login').length,
      reports: reports.length,
      pending: feedback.items.filter((x) => x.status === 'pending').length,
    },
    days,
    userRows,
  };
}

// ══ 自动投递：只读配置 ═══════════════════════════════════════════════════
// 界面第一次进「自动投递」页要能立刻说清三件事：能不能跑（有没有 cookie）、
// 今天投了多少（还剩多少额度）、上次跑到哪（台账条数）。全是本地文件读取，
// 不碰网络、不碰浏览器，所以它是同步的、秒回的。
function getAutoApplyConfig() {
  const dir = path.join(ROOT, 'data', 'auto-apply');
  const logPath = path.join(dir, 'log.jsonl');
  const cookiePath = path.join(ROOT, 'data', 'cookies', PLATFORM + '.json');

  // 台账按行读，坏行跳过 —— 一行坏了不能让整页打不开
  const entries = [];
  try {
    if (exists(logPath)) {
      for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try { entries.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
      }
    }
  } catch { /* 读不到就当空台账 */ }

  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = entries.filter((e) => String(e.ts || '').slice(0, 10) === today);
  const count = (st) => todayEntries.filter((e) => e.state === st).length;

  // 有文件 ≠ 已登录：`save-cookies.mjs` 只要按了回车就写文件，没登录也照样写。
  // 所以这里要打开来看里面有没有 BOSS 的登录态 cookie（bst / wt2 / zp_at / geek_zp_token），
  // 否则界面会给一个假绿 —— 说「已就绪」，跑起来却什么都读不到。
  let cookieList = [];
  try {
    if (exists(cookiePath)) cookieList = JSON.parse(fs.readFileSync(cookiePath, 'utf8'));
  } catch { /* 坏了就当没登录 */ }
  if (!Array.isArray(cookieList)) cookieList = [];
  let savedAt = '';
  try { savedAt = new Date(fs.statSync(cookiePath).mtimeMs).toISOString().slice(0, 10); } catch { /* 没有文件 */ }

  return {
    platform: PLATFORM,
    platformDailyCap: PLATFORM_DAILY_CAP,
    safe: SAFE_DEFAULTS,
    hasCookie: exists(cookiePath),
    // 真正决定「能不能读到内容」的是这一个
    hasLogin: hasLoginCookie(cookieList),
    loginCookieNames: LOGIN_COOKIES,
    cookieCount: cookieList.length,
    cookieSavedAt: savedAt,
    cookiePath: 'data/cookies/' + PLATFORM + '.json',
    logPath: 'data/auto-apply/log.jsonl',
    logTotal: entries.length,
    today: {
      date: today,
      sent: count(ITEM_STATE.sent),
      failed: count(ITEM_STATE.failed),
      remaining: Math.max(0, PLATFORM_DAILY_CAP - count(ITEM_STATE.sent)),
    },
    // 最近 20 条，倒序（新的在上）—— 界面上「最近投过谁」直接用
    recent: entries.slice(-20).reverse(),
    stateZh: STATE_ZH,
    filterReasonZh: FILTER_REASON_ZH,
  };
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  // 前端模块（app.js 里 import 的）：批量初筛的切块/排序纯函数。
  // 白名单是**逐条列**的，不是目录映射 —— 加一个 import 就要加一行，
  // 否则浏览器拿 404，整个 app.js 模块加载失败、页面空白（踩过一次）。
  '/batch-jd.mjs': ['batch-jd.mjs', 'text/javascript; charset=utf-8'],
  // 文档导入（.docx / .xlsx / .csv / .txt → 多岗位文本）。同样零依赖：
  // 它只 import 上面那份 batch-jd.mjs，解压用的是浏览器内置的
  // DecompressionStream，不碰 node:fs。文件在用户本机解析，不上传、不落盘。
  '/doc-import.mjs': ['doc-import.mjs', 'text/javascript; charset=utf-8'],
  // 跟进提醒的展示常量（紧急度中文、通道中文与规范值）—— app.js 要用同一份，
  // 不能在页面里再写一遍中文映射，否则页面说法会和写盘格式分家。
  // ⚠️ 这里放的是 followup-format.mjs（零依赖），**不是** followup-cn.mjs：
  //    后者做节奏计算、import 了根目录的 followup-cadence.mjs，而那一份依赖
  //    js-yaml / node:fs，浏览器解析不了。真放进来并让 app.js 引用它，
  //    结果是整个模块图加载失败、页面全白（控制台只报几个 404，像静态资源没配好）。
  '/followup-format.mjs': ['followup-format.mjs', 'text/javascript; charset=utf-8'],
  // 「面试备考建议」的展示常量与文案组装（优先级中文、掌握程度三档、
  // 资源类型中文、导出 Markdown）。app.js 要用同一份，页面上的说法和
  // 服务端写进导出文档的说法才不会分家。
  // 同样是零依赖模块 —— 它一个 import 都没有，放进来是安全的。
  '/prep-model.mjs': ['prep-model.mjs', 'text/javascript; charset=utf-8'],
  // 简历的 Word 导入/导出（.docx 解析进表单、保存后下载 .doc）。
  // import 了下面两份零依赖模块：doc-import.mjs（unzip）与 cv-model.mjs。
  '/cv-word.mjs': ['cv-word.mjs', 'text/javascript; charset=utf-8'],
  // 结构化简历模型（表单 JSON ⇄ cv.md 双向转换）。此前只在 Node 侧用
  //（/api/cv、check 脚本），cv-word.mjs 引入后浏览器模块图也含它 ——
  // 它一个 import 都没有，零依赖，进白名单安全。
  '/cv-model.mjs': ['cv-model.mjs', 'text/javascript; charset=utf-8'],
  // 自动投递的安全口径与展示常量（默认上限、状态中文、过滤原因中文）。
  // app.js 要用同一份，界面上写的「单次最多 20 个」才和服务端真正执行的
  // 是同一个数。零依赖（一个 import 都没有），进白名单安全。
  '/auto-apply.mjs': ['auto-apply.mjs', 'text/javascript; charset=utf-8'],
  // 简历模板库的口径单点（内置清单、导入校验、id→渲染参数、样例简历）。
  // app.js 与 server.mjs import 同一份 ——「库里有的」必须就是「预览渲染得出的」。
  // 零依赖（一个 import 都没有），进白名单安全。
  '/cv-templates.mjs': ['cv-templates.mjs', 'text/javascript; charset=utf-8'],
  '/cv-tpl-catalog.mjs': ['cv-tpl-catalog.mjs', 'text/javascript; charset=utf-8'],
  // 双栏黄·图文模板（2026-10-09）。**漏了这一行 = 404 → app.js 模块图加载失败
  // → 整页空白**，且报错信息与根因隔着好几层，很难一眼看出是白名单缺项。
  '/cv-tpl-dual.mjs': ['cv-tpl-dual.mjs', 'text/javascript; charset=utf-8'],
  // 简历分区导航的章节表与顺序/显隐纯函数（2026-10-09，参照 magic-resume）。
  // 同样**漏一行就整页空白**：编辑区、预览、Word 导出三处都 import 它。
  '/cv-nav.mjs': ['cv-nav.mjs', 'text/javascript; charset=utf-8'],
  // 简历外观设置（2026-10-09，参照 magicv.art 魔方简历的设置卡）：
  // 主题色 / 字体 / 字号 / 行高 / 间距 / 模式的默认值与归一化、预览变量与导出 CSS。
  '/cv-look.mjs': ['cv-look.mjs', 'text/javascript; charset=utf-8'],
  // 基本信息字段行的顺序与显隐（2026-10-09，参照 magicv.art 的「基础字段」）。
  // 同样是**漏一行就整页空白**：编辑区字段行、预览页眉、Word 导出三处都 import 它。
  '/cv-fields.mjs': ['cv-fields.mjs', 'text/javascript; charset=utf-8'],
  // 「稳重」系列模板（2026-10-09 接入 10 套）。它们是**原始 HTML 资产**而不是
  // 转抄进 JS 的版式 —— ui/tpl-wz/*.html 由 DOMParser 运行时解析填充。
  // 下面这条通配路由只放行「一层文件名 + .html」，路径穿越一概不认。
  // cv-tpl-wz.mjs 本身仍走上面的精确白名单。
  '/cv-tpl-wz.mjs': ['cv-tpl-wz.mjs', 'text/javascript; charset=utf-8'],
  // docx 保真渲染（index.html <script> 顺序加载 + app.js import 链）
  '/jszip.min.js': ['jszip.min.js', 'text/javascript; charset=utf-8'],
  '/docx-preview.min.js': ['docx-preview.min.js', 'text/javascript; charset=utf-8'],
  // pdf.js（3.11.174 legacy UMD，Apache-2.0）：渲染 COM 转换出的保真 PDF。
  // worker 用「假 worker」方式工作（window.pdfjsWorker 已由 script 挂上全局）。
  '/pdf.min.js': ['pdf.min.js', 'text/javascript; charset=utf-8'],
  '/pdf.worker.min.js': ['pdf.worker.min.js', 'text/javascript; charset=utf-8'],
  '/tpl-docx-view.mjs': ['tpl-docx-view.mjs', 'text/javascript; charset=utf-8'],
  // 模板文件解析器（.pdf/.doc/.docx → 统一模板结构，浏览器侧本机解析）。
  // import 了零依赖的 doc-import.mjs（用它的 unzip/decodeXml），进白名单安全。
  '/tpl-file-parse.mjs': ['tpl-file-parse.mjs', 'text/javascript; charset=utf-8'],
  // 设计规范的可交互示例页（同时是组件状态的回归参照）
  '/design-system.html': ['design-system.html', 'text/html; charset=utf-8'],
  // 全站页面底图（2026-10-12）。由 style.css 的 body::before 引用，整站生效。
  // **漏了这条就是 404** —— 页面不会崩，只是悄悄退化成纯浅灰画布，
  // 肉眼很难发现是白名单缺项，故在此留一行说明。
  // 当前用的是用户提供的科技风位图 bg-tech.jpg（1920×1050，已去掉右下角水印）；
  // 早期自制的矢量线稿 bg-paper.svg 仍保留在白名单里，可随时切回或叠加。
  '/bg-tech.jpg': ['bg-tech.jpg', 'image/jpeg'],
  '/bg-paper.svg': ['bg-paper.svg', 'image/svg+xml'],
};

// ── 提升计划历史（data/prep/，2026-10-12）────────────────────────────
// 一个岗位一份 JSON：文件名 = 报告文件名（如 014-xxx.md.json），
// 这样「同一岗位重新生成 = 覆盖」天然成立，也不用再维护索引文件。
// 报告文件名已过 REPORT_NAME_RE（.md 结尾、无路径分隔符），拼路径安全。
function prepPlanPath(reportFile) {
  return path.join(SP().prep, String(reportFile) + '.json');
}

async function savePrepPlan(entry) {
  await fsp.mkdir(SP().prep, { recursive: true });
  const now = new Date();
  const at = localToday() + ' ' + now.toTimeString().slice(0, 5);
  const rec = {
    file: entry.file,
    title: entry.title,
    score: entry.score,
    archetype: entry.archetype,
    source: entry.source,
    requirementCount: entry.requirementCount,
    engineLabel: entry.engineLabel || '',
    fallbackNote: entry.fallbackNote || '',
    warn: entry.warn || '',
    at,
    parsed: entry.parsed,
    markdown: entry.markdown,
  };
  const full = prepPlanPath(entry.file);
  // 先写临时文件再 rename：半截 JSON 比没有 JSON 更难查（用户会以为计划存坏了）
  const tmp = full + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(rec, null, 2), 'utf8');
  await fsp.rename(tmp, full);
  const st = await fsp.stat(full);
  return { file: rec.file, title: rec.title, score: rec.score, at, source: rec.source, bytes: st.size };
}

/** 历史列表（新的在前）。读不了的单份跳过，不让一份坏文件废掉整页。 */
async function listPrepPlans() {
  const dir = SP().prep;
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const items = [];
  for (const name of names) {
    if (!/\.json$/.test(name)) continue;
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      if (!rec || !rec.file) continue;
      items.push({
        file: rec.file, title: rec.title || rec.file, score: rec.score || '',
        at: rec.at || '', source: rec.source || '', bytes: JSON.stringify(rec).length,
      });
    } catch { /* 跳过坏文件 */ }
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return items;
}

async function readPrepPlan(reportFile) {
  try {
    const rec = JSON.parse(await fsp.readFile(prepPlanPath(reportFile), 'utf8'));
    return rec && rec.file ? rec : null;
  } catch { return null; }
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method.toUpperCase();

  // —— 只读 ——
  if (route === '/api/status' && method === 'GET') return sendJson(res, await getStatus());

  if (route === '/api/scripts' && method === 'GET') {
    return sendJson(res, Object.entries(SCRIPTS).map(([key, s]) => ({
      key, label: s.label, group: s.group, desc: s.desc, slow: !!s.slow,
      // 只把表单需要的元数据给前端；pattern 一并下发，便于前端即时校验
      params: (s.params || []).map((p) => ({
        name: p.name, label: p.label, type: p.type || 'text',
        required: !!p.required, hint: p.hint || '', default: p.default ?? '',
        pattern: p.pattern || '',
      })),
    })));
  }

  if (route === '/api/states' && method === 'GET') {
    const { states } = await readStates();
    // cn 是本地化新增字段（详见 templates/states.yml 顶部注释）：
    // 界面按国内叫法显示（简历筛选 / 初试 / 复试 / 终面 / 谈薪 …），
    // 写回台账时仍用 id / label 这些规范值，项目其它脚本不受影响。
    return sendJson(res, states.map((s) => ({
      id: s.id, label: s.label, cn: s.cn || '', description: s.description, terminal: !!s.terminal,
    })));
  }

  if (route === '/api/stats' && method === 'GET') {
    const res1 = await runNode(['stats.mjs'], { timeoutMs: 90000 });
    let data = null;
    try { const m = res1.stdout.match(/\{[\s\S]*\}/); if (m) data = JSON.parse(m[0]); } catch { /* 降级 */ }
    return sendJson(res, { ok: !!data, data, raw: res1.stdout + res1.stderr });
  }

  if (route === '/api/tracker' && method === 'GET') return sendJson(res, await getTracker());
  if (route === '/api/followups' && method === 'GET') return sendJson(res, await getFollowups());
  if (route === '/api/pipeline' && method === 'GET') return sendJson(res, await getPipeline());
  if (route === '/api/reports' && method === 'GET') return sendJson(res, await listReports());

  // ── 自动投递（BOSS 直聘）──────────────────────────────────────────────
  // 这一块的**第一原则是别把用户的平台账号玩坏**，所以闸门全部放在服务端，
  // 前端传什么都绕不过去：
  //   · /config  纯只读：有没有 cookie、今天投了多少、台账多少条、安全默认值
  //   · /start   默认 dryRun（只出计划，一个字都不发给平台）；
  //              mode=send 还得 body.confirm === true 才会真的加 --confirm
  //   · cap / 间隔 / 打招呼语长度：服务端再夹一次，越界就夹回安全区间
  if (route === '/api/auto-apply/config' && method === 'GET') {
    return sendJson(res, getAutoApplyConfig());
  }

  if (route === '/api/auto-apply/start' && method === 'POST') {
    const body = await readBody(req);

    const keyword = String(body.keyword || '').trim().slice(0, 60);
    if (!keyword) {
      throw Object.assign(new Error('先填搜索关键词'), {
        status: 400,
        hint: '关键词决定了去 BOSS 搜哪一批岗位，例如「Java 后端」「测试开发」。',
      });
    }
    // 城市码只认数字：它要拼进 URL，放任意字符串进去等于给了一个注入口子
    const cityRaw = String(body.city || '').trim();
    const city = /^\d{1,12}$/.test(cityRaw) ? cityRaw : '100010000';

    const capRaw = Number(body.cap);
    const cap = Math.max(1, Math.min(PLATFORM_DAILY_CAP, Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : SAFE_DEFAULTS.dailyCap));
    const sayHi = String(body.sayHi || '').trim().slice(0, 150) || SAFE_DEFAULTS.sayHi;

    const clampSec = (v, def) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 1 ? Math.min(120, Math.floor(n)) : def;
    };
    const minSec = clampSec(body.minIntervalSec, SAFE_DEFAULTS.minIntervalSec);
    const maxSec = Math.max(minSec, clampSec(body.maxIntervalSec, SAFE_DEFAULTS.maxIntervalSec));

    // 只有「显式要发送」+「显式二次确认」两个条件同时成立才真发。
    // 少任何一个都落回 dry-run —— 宁可少投，不能误投。
    const wantSend = String(body.mode || 'plan').trim() === 'send';
    const really = wantSend && body.confirm === true;
    const dryRun = !really;

    const script = path.join(ROOT, 'auto-apply-run.mjs');
    if (!exists(script)) {
      throw Object.assign(new Error('执行脚本不见了'), {
        status: 500, hint: '缺 auto-apply-run.mjs（项目根目录）。',
      });
    }

    const args = [script, '--keyword', keyword, '--city', city, '--cap', String(cap),
      '--say-hi', sayHi, '--min', String(minSec), '--max', String(maxSec)];
    if (!dryRun) args.push('--confirm');

    // 一次跑完整轮（滚动 + 逐个点开）要几分钟；真实发送还要按随机间隔停顿，
    // 所以超时给到 15 分钟，和完整评估报告一个量级。
    const r = await runNode(args, { timeoutMs: 900000 });

    // 执行器往 stdout 写 JSONL（一行一条进度），这里整段解析后一起回给前端。
    // 解析不动也不算失败 —— 至少把原文带回去，用户能看到报了什么。
    const events = [];
    for (const line of String(r.stdout || '').split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try { events.push(JSON.parse(t)); } catch { /* 非 JSON 行忽略 */ }
    }
    const done = events.filter((e) => e.type === 'done').pop() || null;
    const err = events.filter((e) => e.type === 'error').pop() || null;

    return sendJson(res, {
      ok: !err && r.code === 0,
      dryRun,
      code: r.code,
      timeout: !!r.timeout,
      plan: (done && done.plan) || [],
      sent: (done && done.sent) || 0,
      events,
      error: err ? err.message : '',
      // 超时/非零退出时把尾巴带上，否则用户只看到一句「失败」
      raw: (err || r.code !== 0) ? String(r.stdout || '').slice(-2000) + String(r.stderr || '').slice(-2000) : '',
    });
  }

  // ── 登录 / 会话（用户端与管理端共用入口，按账号身份分流）────────────
  if (route === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'user';
    const db = readJsonFile(AUTH.users, { users: [] });
    const user = db.users.find((u) => u.username === username);
    if (!user || user.hash !== hashPassword(user.salt, password)) {
      return sendJson(res, { ok: false, error: '账号或密码不对' }, 401);
    }
    // 登录页上选了哪个入口，就得是哪种身份 —— 选错入口给一句能看懂的提示，
    // 而不是笼统的「密码错误」，否则演示时会被当成系统坏了。
    if (user.role !== role) {
      return sendJson(res, { ok: false, error: role === 'admin' ? '该账号不是管理员' : '该账号是管理员，请走「管理端」入口' }, 403);
    }
    user.lastLogin = new Date().toISOString();
    writeJsonFile(AUTH.users, db);
    const usage = readJsonFile(AUTH.usage, { events: [] });
    usage.events.push({ t: user.lastLogin, type: 'login', user: user.username, role: user.role });
    writeJsonFile(AUTH.usage, usage);
    const token = createSession(user);
    return sendJson(res, { ok: true, session: { token, role: user.role, username: user.username, name: user.displayName || user.username } });
  }

  // ── 注册：自助开户只出普通用户，管理员账号必须由管理员在后台建 ──────
  // 注册成功即建立会话（省一遍「注册完再手动登录」），前端直接进用户端；
  // 记一次 login 事件，让「使用情况」从注册当天就开始算数。
  if (route === '/api/auth/register' && method === 'POST') {
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim() || username;
    const password = String(body.password || '');
    if (!/^[a-z0-9_-]{2,20}$/.test(username)) {
      return sendJson(res, { ok: false, error: '用户名限 2-20 位小写字母、数字、下划线或中划线' }, 400);
    }
    if (password.length < 6) return sendJson(res, { ok: false, error: '密码至少 6 位' }, 400);
    const db = readJsonFile(AUTH.users, { users: [] });
    if (db.users.some((u) => u.username === username)) {
      return sendJson(res, { ok: false, error: '用户名已存在，换一个或直接登录' }, 409);
    }
    const user = mkUser('u' + Date.now().toString(36), username, displayName, 'user', password, new Date().toISOString());
    db.users.push(user);
    writeJsonFile(AUTH.users, db);
    // 新用户的数据空间：空白简历 + 空报告目录（2026-09-30）。
    // 简历要自己填、报告自己跑 —— 与演示账号共享的全局数据隔离。
    scaffoldUserSpace(username);
    user.lastLogin = user.createdAt;
    const usage = readJsonFile(AUTH.usage, { events: [] });
    usage.events.push({ t: user.lastLogin, type: 'login', user: user.username, role: 'user' });
    writeJsonFile(AUTH.usage, usage);
    const token = createSession(user);
    return sendJson(res, { ok: true, session: { token, role: 'user', username, name: displayName } });
  }

  if (route === '/api/auth/me' && method === 'GET') {
    const s = getSession(req, url);
    if (!s) return sendJson(res, { ok: false }, 401);
    // 带上注册时间 / 上次登录 —— 账号安全中心页直接用
    const db = readJsonFile(AUTH.users, { users: [] });
    const u = db.users.find((x) => x.username === s.username) || {};
    return sendJson(res, {
      ok: true, role: s.role, username: s.username,
      name: u.displayName || s.username,
      createdAt: u.createdAt || '', lastLogin: u.lastLogin || '',
    });
  }

  // ── 账号安全中心：自助改密（要登录会话；旧密码必须验对，新盐新哈希落盘）──
  if (route === '/api/auth/change-password' && method === 'POST') {
    const s = getSession(req, url);
    if (!s) return sendJson(res, { ok: false, error: '需要先登录' }, 401);
    const body = await readBody(req);
    const oldPassword = String(body.oldPassword || '');
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 6) return sendJson(res, { ok: false, error: '新密码至少 6 位' }, 400);
    const db = readJsonFile(AUTH.users, { users: [] });
    const user = db.users.find((u) => u.username === s.username);
    if (!user || user.hash !== hashPassword(user.salt, oldPassword)) {
      return sendJson(res, { ok: false, error: '当前密码不对' }, 401);
    }
    user.salt = crypto.randomBytes(8).toString('hex');
    user.hash = hashPassword(user.salt, newPassword);
    writeJsonFile(AUTH.users, db);
    return sendJson(res, { ok: true });
  }

  if (route === '/api/auth/logout' && method === 'POST') {
    const body = await readBody(req);
    if (body.token) sessions.delete(String(body.token));
    return sendJson(res, { ok: true });
  }

  // ── 管理后台：用户管理 / 用户反馈 / 使用情况（全部要求管理员会话）──
  if (route === '/api/admin/users' && method === 'GET') {
    if (!requireAdmin(req, url)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    const db = readJsonFile(AUTH.users, { users: [] });
    return sendJson(res, { ok: true, users: db.users.map((u) => ({
      id: u.id, username: u.username, displayName: u.displayName, role: u.role,
      createdAt: u.createdAt || '', lastLogin: u.lastLogin || '',
    })) });
  }

  if (route === '/api/admin/users' && method === 'POST') {
    if (!requireAdmin(req, url)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    const body = await readBody(req);
    const username = String(body.username || '').trim().toLowerCase();
    const displayName = String(body.displayName || '').trim() || username;
    const role = body.role === 'admin' ? 'admin' : 'user';
    const password = String(body.password || '');
    if (!/^[a-z0-9_-]{2,20}$/.test(username)) {
      return sendJson(res, { ok: false, error: '用户名限 2-20 位小写字母、数字、下划线或中划线' }, 400);
    }
    if (password.length < 6) return sendJson(res, { ok: false, error: '密码至少 6 位' }, 400);
    const db = readJsonFile(AUTH.users, { users: [] });
    if (db.users.some((u) => u.username === username)) {
      return sendJson(res, { ok: false, error: '用户名已存在' }, 409);
    }
    db.users.push(mkUser('u' + Date.now().toString(36), username, displayName, role, password, new Date().toISOString()));
    writeJsonFile(AUTH.users, db);
    // 管理员建的号同样开独立数据空间（与自助注册同一口径）
    scaffoldUserSpace(username);
    return sendJson(res, { ok: true });
  }

  if (route === '/api/admin/users/password' && method === 'POST') {
    if (!requireAdmin(req, url)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    const body = await readBody(req);
    const password = String(body.password || '');
    if (password.length < 6) return sendJson(res, { ok: false, error: '新密码至少 6 位' }, 400);
    const db = readJsonFile(AUTH.users, { users: [] });
    const user = db.users.find((u) => u.id === body.id);
    if (!user) return sendJson(res, { ok: false, error: '用户不存在' }, 404);
    user.salt = crypto.randomBytes(8).toString('hex');
    user.hash = hashPassword(user.salt, password);
    writeJsonFile(AUTH.users, db);
    return sendJson(res, { ok: true });
  }

  if (route === '/api/admin/feedback' && method === 'GET') {
    if (!requireAdmin(req, url)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    const db = readJsonFile(AUTH.feedback, { items: [] });
    return sendJson(res, { ok: true, items: db.items });
  }

  if (route === '/api/admin/feedback/status' && method === 'POST') {
    if (!requireAdmin(req, url)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    const body = await readBody(req);
    const db = readJsonFile(AUTH.feedback, { items: [] });
    const item = db.items.find((x) => x.id === body.id);
    if (!item) return sendJson(res, { ok: false, error: '反馈不存在' }, 404);
    item.status = body.status === 'done' ? 'done' : 'pending';
    writeJsonFile(AUTH.feedback, db);
    return sendJson(res, { ok: true });
  }

  if (route === '/api/admin/usage' && method === 'GET') {
    if (!requireAdmin(req, url)) return sendJson(res, { ok: false, error: '需要管理员登录' }, 403);
    return sendJson(res, { ok: true, ...(await buildUsageSummary()) });
  }

  // ── 用户反馈：登录用户从「使用帮助」页提交 ─────────────────────────
  if (route === '/api/feedback' && method === 'POST') {
    const s = getSession(req, url);
    if (!s) return sendJson(res, { ok: false, error: '请先登录再提交反馈' }, 401);
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text || text.length > 500) return sendJson(res, { ok: false, error: '反馈内容限 1-500 字' }, 400);
    const db = readJsonFile(AUTH.feedback, { items: [] });
    db.items.unshift({ id: 'f' + Date.now().toString(36), user: s.username, text, status: 'pending', t: new Date().toISOString() });
    writeJsonFile(AUTH.feedback, db);
    return sendJson(res, { ok: true });
  }

  // ── 面试备考建议：可选岗位清单 + 数据体检 ─────────────────────────────
  // 「这个功能与对应的评估的岗位对应」（需求第 4 条）。所以这里把 reports/ 里
  // **每份报告**都算一个可选岗位 —— 不是另建一张岗位表，否则就会出现
  // 「报告有、岗位表没有」的两份事实来源。
  //
  // 每一条都带上**能不能生成**的判断结果（diagnoseInputs），而不是等用户点了
  // 生成才报缺数据：下拉里直接标出哪几个岗位缺料，比事后弹一个错误友好得多。
  if (route === '/api/prep/list' && method === 'GET') {
    const list = await listReports();
    const cvText = await readText(SP().cvMd);
    const items = [];
    for (const r of list) {
      const head = await readText(path.join(SP().reports, r.file));
      // cvText 要传进去：报告没写差距清单时，解析器会拿 JD 要求跟简历对照现推，
      // 这样「这份岗位缺什么」不会因为报告写得糙而变成空清单。
      const parsed = parseReportForPrep(head, r, cvText);
      const diag = diagnoseInputs({ report: parsed, cvText });
      items.push({
        file: r.file,
        title: r.title,
        date: r.date,
        score: r.score,
        archetype: r.archetype,
        mtime: r.mtime,
        canGenerate: diag.ok,
        blockReason: diag.ok ? '' : diag.reason,
        blockHint: diag.hint,
        warn: diag.ok && diag.reason === MISSING_REASONS.NO_GAPS ? diag.hint : '',
        gapCount: parsed.gaps.length,
        requirementCount: parsed.requirements.length,
      });
    }
    return sendJson(res, {
      items,
      // 默认选谁：最近一份**能生成**的报告。全都不能生成时退回最近一份，
      // 这样页面至少能显示「为什么不能生成」，而不是一个空下拉。
      defaultFile: (items.find((x) => x.canGenerate) || items[0] || {}).file || '',
      cvChars: cvText.trim().length,
      // 简历缺失是全局性问题（不是某一份报告的问题），单独给一句结论，
      // 免得用户在十几个岗位之间来回点、每个都报同一个错。
      cvMissing: !cvText.trim(),
    });
  }

  if (route === '/api/report' && method === 'GET') {
    const name = url.searchParams.get('file') || '';
    // 只允许 reports/ 下的单层 .md 文件名：不含路径分隔符，因此 `..` 也翻不出去。
    // 除 ASCII 外**额外放行中文**——国内岗位的报告 slug 很可能被写成中文
    // （`006-华为-2026-09-18.md`），而 \w 在非 u 模式下只认 [A-Za-z0-9_]，
    // 会把中文文件名误判成「不合法」，报告页直接打不开。
    if (!REPORT_NAME_RE.test(name)) {
      throw Object.assign(new Error('文件名不合法'), {
        status: 400,
        hint: '报告文件名应以 .md 结尾且不含路径分隔符，实际收到：「' + name + '」',
      });
    }
    const full = path.join(SP().reports, name);
    if (!exists(full)) throw Object.assign(new Error('报告不存在'), { status: 404 });
    const markdown = await readText(full);
    // 顺带把报告解析成「匹配卡」字段（2026-10-12 用户要求：详情页内容按初筛
    // 结果卡那套版式写）。解析放在服务端：前端不该再实现一遍报告语法。
    const profile = await getProfile();
    const threshold = Number(profile.parsed?.pipeline?.triage_threshold ?? 3);
    return sendJson(res, {
      file: name,
      markdown,
      summary: parseReportSummary(markdown, { file: name, title: '', score: '' }, { threshold }),
    });
  }

  if (route === '/api/cv' && method === 'GET') return sendJson(res, await getCv());

  // 只算完整度，不落盘。前端增删排序后要立刻刷新那个百分比，
  // 但完整度规则只写在 cv-model.mjs 一处——不在前端重复实现一遍，
  // 否则两条规则迟早会分叉。
  if (route === '/api/cv/preview' && method === 'POST') {
    const body = await readBody(req);
    const form = normalizeCv(body.form || {});
    return sendJson(res, { completeness: cvCompleteness(form) });
  }

  if (route === '/api/profile' && method === 'GET') return sendJson(res, await getProfile());

  if (route === '/api/portals' && method === 'GET') {
    const raw = await readText(PATHS.portals);
    const yaml = await loadYaml();
    let parsed = null, parseError = null;
    if (yaml) { try { parsed = yaml.load(raw); } catch (e) { parseError = e.message; } }
    return sendJson(res, {
      raw, parsed, parseError, exists: exists(PATHS.portals),
      companies: parsed && Array.isArray(parsed.tracked_companies) ? parsed.tracked_companies.length : 0,
    });
  }

  if (route === '/api/outputs' && method === 'GET') {
    if (!existsDir(PATHS.output)) return sendJson(res, []);
    const names = await fsp.readdir(PATHS.output);
    const out = [];
    for (const n of names) {
      if (!/\.(pdf|html)$/i.test(n)) continue;
      const st = await fsp.stat(path.join(PATHS.output, n));
      out.push({ file: n, size: st.size, mtime: st.mtimeMs });
    }
    return sendJson(res, out.sort((a, b) => b.mtime - a.mtime));
  }

  if (route === '/api/output' && method === 'GET') {
    const name = url.searchParams.get('file') || '';
    const full = safeResolve(path.join('output', name));
    if (!exists(full)) throw Object.assign(new Error('文件不存在'), { status: 404 });
    const type = name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8';
    const buf = await fsp.readFile(full);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length });
    return res.end(buf);
  }

  // —— 写操作 ——

  /**
   * 对比「当前 cv.md」与「将要写入的 cv.md」，列出会整节消失的章节。
   *
   * 保存走的是 cvToMarkdown(form) —— **全量重建**：表单里没有的章节，写回去的
   * cv.md 里就没了。而表单之所以会是空的，多数时候不是用户主动清空，而是
   * 解析器没读懂文件里那种写法。2026-09-18 就是这样丢过一次实习经历 + 荣誉奖项。
   *
   * 只拦「整节从有到无」，不拦「条目变少」——后者多半是用户自己在改。
   * 拿两段 Markdown 比而不是「表单比文件」比，是为了绕开字段结构的差异，
   * 只看最终落盘的文本长什么样。
   */
  function droppedSections(beforeMd, afterMd) {
    const sum = (md) => {
      const m = new Map();
      for (const s of auditCvMarkdown(md).sections) {
        if (!s.key) continue;
        m.set(s.key, (m.get(s.key) || 0) + (s.count || 0));
      }
      return m;
    };
    const before = auditCvMarkdown(beforeMd).sections;
    const after = sum(afterMd);
    return before
      .filter((s) => {
        // 章节名没收录（用户手写的自定义小节）：表单里根本没有它的位置，
        // 保存一次就没了 —— 必须一并拦下。
        if (s.unknown) return true;
        if (!s.key) return false;
        return (s.count || 0) > 0 && !(after.get(s.key) > 0);
      })
      .map((s) => s.title);
  }

  if (route === '/api/cv' && method === 'POST') {
    const body = await readBody(req);
    const form = normalizeCv(body.form || body);
    const md = cvToMarkdown(form);

    // 守卫：这次保存会不会让某个章节整节消失？会的话先拦一次，
    // 由前端明确问过用户再写（body.force = true 表示「用户已确认」）。
    const prevMd = exists(SP().cvMd) ? await readText(SP().cvMd) : '';
    if (prevMd.trim() && !body.force) {
      const dropped = droppedSections(prevMd, md);
      if (dropped.length) {
        throw Object.assign(
          new Error('这次保存会让 cv.md 里这些章节整节消失：' + dropped.join('、')),
          {
            status: 409,
            hint: '如果是有意删掉的，在确认框里点「仍然保存」；'
              + '如果不是，先点「用 cv.md 覆盖表单」把内容读回来再改。',
            dropped,
          },
        );
      }
    }

    await fsp.mkdir(path.dirname(SP().cvForm), { recursive: true });

    // 写之前备份一次，避免误操作丢简历。
    // 独立空间的用户备份进自己的目录（data/users/<名>/backups/），
    // 全局用户维持原路径 data/ —— 两边都不混别人的东西。
    const spNow = SP();
    if (exists(spNow.cvMd)) {
      const bakDir = spNow === PATHS ? path.join(ROOT, 'data') : path.join(path.dirname(spNow.cvForm), 'backups');
      try { await fsp.mkdir(bakDir, { recursive: true }); } catch { /* 目录在就行 */ }
      const bak = path.join(bakDir, `cv.backup-${Date.now()}.md`);
      try { await fsp.copyFile(spNow.cvMd, bak); } catch { /* 备份失败不阻塞保存 */ }
    }

    await fsp.writeFile(SP().cvForm, JSON.stringify(form, null, 2), 'utf8');
    await fsp.writeFile(SP().cvMd, md, 'utf8');
    return sendJson(res, { ok: true, markdown: md, completeness: cvCompleteness(form) });
  }

  if (route === '/api/cv/import' && method === 'POST') {
    const md = await readText(SP().cvMd);
    const form = markdownToCv(md);
    if (!md.trim()) {
      await fsp.writeFile(SP().cvForm, JSON.stringify(EMPTY_CV(), null, 2), 'utf8');
      return sendJson(res, { ok: true, form: EMPTY_CV(), markdown: '', completeness: cvCompleteness(EMPTY_CV()), note: 'cv.md 为空，已重置表单' });
    }
    await fsp.mkdir(path.dirname(SP().cvForm), { recursive: true });
    await fsp.writeFile(SP().cvForm, JSON.stringify(form, null, 2), 'utf8');
    return sendJson(res, { ok: true, form, markdown: md, completeness: cvCompleteness(form) });
  }

  // ── 简历模板库（2026-09-30）──────────────────────────────────────────
  // 模板 = 版式描述（base 基底 + accent 主色），**不含简历内容** —— 内容永远
  // 来自用户当前表单，选模板只是换外观。存储：{ selected, items:[自定义模板] }，
  // 内置三套（'1'/'2'/'3'）以代码定义在 cv-templates.mjs，读取时合并、不落盘；
  // 文件按数据空间隔离（注册用户 data/users/<名>/cv-templates.json，其余全局）。
  function readTplStore() {
    const data = readJsonFile(SP().cvTemplates, { selected: '', items: [] });
    if (!Array.isArray(data.items)) data.items = [];
    if (typeof data.selected !== 'string') data.selected = '';
    return data;
  }
  const tplListPayload = (store) => ({
    selected: store.selected,
    items: [...BUILTIN_CV_TEMPLATES, ...store.items],
  });

  // 查询：全量列表（内置 + 自定义）+ 当前选中。选中 id 指向已不存在的模板时
  // 如实返回 —— 前端 resolveCvTplStyle 会回落模板1，页面不会崩。
  if (route === '/api/cv/templates' && method === 'GET') {
    return sendJson(res, { ok: true, ...tplListPayload(readTplStore()) });
  }

  // 导入：收「版式描述」，文件导入还带 from/file/fingerprint/structure（解析
  // 在浏览器侧完成 —— 内容不出本机，这里只收结构化结果并做同一套校验）。
  // 校验/归一化在 cv-templates.mjs 一处。导入 ≠ 生效 —— 要用去模板库选。
  // 重复导入：带 fingerprint 且库里已有同指纹模板 → 409 duplicate；
  // 前端确认后可 force:true 强制再入库一份（改名/微调后重导是合法诉求）。
  if (route === '/api/cv/templates/import' && method === 'POST') {
    // 请求体放宽到 32MB：docx 保真导入会随结构一并上送原文件 base64
    //（20MB 文件 → ~27MB base64）。只进本机 data/，不出本机网络。
    const body = await readBody(req, 32 * 1024 * 1024);
    const norm = normalizeCvTemplateInput(body);
    if (!norm.ok) {
      throw Object.assign(new Error(norm.error), { status: 400 });
    }
    const store = readTplStore();
    if (norm.tpl.fingerprint && !body.force) {
      const dup = store.items.find((t) => t && t.fingerprint === norm.tpl.fingerprint);
      if (dup) {
        throw Object.assign(new Error('库里已有相同内容的模板「' + dup.name + '」'
          + '（' + new Date(dup.createdAt).toLocaleString('zh-CN', { hour12: false }) + ' 导入）。'
          + '要再导入一份请确认后重试。'), {
          status: 409, code: 'duplicate',
          existing: { id: dup.id, name: dup.name, createdAt: dup.createdAt },
        });
      }
    }
    const tpl = {
      id: 'tpl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ...norm.tpl,
      source: 'custom',
      createdAt: new Date().toISOString(),
    };
    // docx 保真（2026-09-30）：前端把原文件字节一并上送 → 落盘到模板空间
    // cv-tpl-files/<id>.docx。PK\x03\x04 魔数校验；写盘失败不阻断导入
    //（模板照常入库，file.saved 不置 → 前端回落 3 套 CSS 版式渲染）。
    if (body.docxB64 && norm.tpl.file && norm.tpl.file.kind === 'docx') {
      // 坏文件（base64 解不出 / 不是 PK zip 头）= 无法按原样保存 → 直接 400 拒绝，
      // 不收一个渲染不出原版的「假 docx」入库（需求①「原样保存」口径）。
      const buf = Buffer.from(String(body.docxB64), 'base64');
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4B) {
        throw Object.assign(
          new Error('docx 文件已损坏或不是有效的 .docx 文件，无法按原样保存，请重新导出后再导入。'),
          { status: 400 }
        );
      }
      try {
        const dir = SP().cvTplFiles;
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, tpl.id + '.docx'), buf);
        tpl.file.saved = true;
      } catch (e) {
        // 只有磁盘 IO 失败才走优雅降级：模板照常入库（file.saved 不置 → 前端回落 CSS 版式）。
        console.error('[tpl-import] docx 原文件落盘失败（模板仍入库）:', e.message);
      }
    }
    store.items.push(tpl);
    writeJsonFile(SP().cvTemplates, store);
    return sendJson(res, { ok: true, template: tpl, ...tplListPayload(store) });
  }

  // 选择：持久化到当前数据空间。id 必须真实存在（内置或自定义），防止
  // 「选中了一个幽灵模板」后预览永远靠回落 —— 那种错用户根本看不出原因。
  if (route === '/api/cv/templates/select' && method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    const store = readTplStore();
    const hit = [...BUILTIN_CV_TEMPLATES, ...store.items].find((t) => t.id === id);
    if (!hit) {
      throw Object.assign(new Error('没有这个模板'), {
        status: 404, hint: '回模板库刷新一下列表再选。',
      });
    }
    store.selected = id;
    writeJsonFile(SP().cvTemplates, store);
    return sendJson(res, { ok: true, selected: id, ...tplListPayload(store) });
  }

  // ── 简历分区导航（2026-10-09）──────────────────────────────────────────
  // 只存「章节顺序 + 哪些隐藏」。**不存简历内容** —— 内容永远在 cv.md，
  // 隐藏只是让预览与导出跳过它（素材原地保留，见 ui/cv-nav.mjs 的语义说明）。
  // 归一化在 cv-nav.mjs 一处：脏 key 丢弃、缺失的章节按默认顺序补到末尾，
  // 所以前端永远拿到一份结构完整、可直接渲染的 nav。
  if (route === '/api/cv/nav' && method === 'GET') {
    const data = readJsonFile(SP().cvNav, null);
    return sendJson(res, { ok: true, nav: normalizeCvNav(data) });
  }

  if (route === '/api/cv/nav' && method === 'POST') {
    const body = await readBody(req);
    const nav = normalizeCvNav(body.nav);
    writeJsonFile(SP().cvNav, nav);
    return sendJson(res, { ok: true, nav });
  }

  // ── 简历外观设置（2026-10-09）──────────────────────────────────────────
  // 只存「长什么样」：主题色 / 字体 / 字号 / 行高 / 间距 / 模式。
  // 归一化在 cv-look.mjs 一处（脏值回落默认、不抛错），前端永远拿到一份完整的。
  if (route === '/api/cv/look' && method === 'GET') {
    return sendJson(res, { ok: true, look: normalizeCvLook(readJsonFile(SP().cvLook, null)) });
  }

  if (route === '/api/cv/look' && method === 'POST') {
    const body = await readBody(req);
    const look = normalizeCvLook(body.look);
    writeJsonFile(SP().cvLook, look);
    return sendJson(res, { ok: true, look });
  }

  // ── 基本信息字段行的顺序与显隐（2026-10-09）────────────────────────────
  // 只存「怎么排、哪些不显示」。与 /api/cv/nav 同一套口径：隐藏不改 cv.md，
  // 只是让预览与导出跳过该字段（值原地保留，见 ui/cv-fields.mjs 的语义说明）。
  if (route === '/api/cv/fields' && method === 'GET') {
    const data = readJsonFile(SP().cvFields, null);
    return sendJson(res, { ok: true, fields: normalizeCvFields(data) });
  }

  if (route === '/api/cv/fields' && method === 'POST') {
    const body = await readBody(req);
    const fields = normalizeCvFields(body.fields);
    writeJsonFile(SP().cvFields, fields);
    return sendJson(res, { ok: true, fields });
  }

  // ── 简历插图（头像 / 证书照片，2026-10-09）─────────────────────────────
  // 上传：base64 收进来落成文件，**只回一个应用内路径**给前端存进表单。
  //
  // 为什么不把图直接塞进表单 / cv.md：那份 markdown 是给人读、给 AI 读的，
  // 一张 200KB 的 base64 会把整份文件变成没法读的垃圾，而且每次保存都要把
  // 整张图重写一遍。图片是**版式资产**，和主色、字体同类，不该混进正文。
  //
  // 上限 2MB（与参考站「图片大小不能超过2MB」同一口径）；只收常见位图，
  // **不收 svg** —— svg 能内嵌脚本，当图片渲染等于开了一个 XSS 的口子。
  if (route === '/api/cv/asset' && method === 'POST') {
    const body = await readBody(req, 8 * 1024 * 1024);
    const m = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/
      .exec(String(body.dataUrl || ''));
    if (!m) {
      throw Object.assign(new Error('只支持 PNG / JPG / WebP / GIF 图片'), { status: 400 });
    }
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw Object.assign(new Error('图片是空的'), { status: 400 });
    if (buf.length > 2 * 1024 * 1024) {
      throw Object.assign(new Error('图片大小不能超过 2MB，请先压缩再上传'), { status: 400 });
    }
    await fsp.mkdir(SP().cvAssets, { recursive: true });
    // 文件名完全由时间戳 + 随机串组成，用户传的原名不进路径 ——
    // 免得 `../` 之类的花样把文件写到数据空间外面去。
    const name = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext;
    await fsp.writeFile(path.join(SP().cvAssets, name), buf);
    return sendJson(res, { ok: true, url: '/api/cv/asset/' + name, bytes: buf.length });
  }

  // 读取：/api/cv/asset/<name>。字符白名单 + 只认数据空间里那一个目录。
  if (route.startsWith('/api/cv/asset/') && method === 'GET') {
    const name = decodeURIComponent(route.slice('/api/cv/asset/'.length));
    if (!/^[a-z0-9]{1,40}\.(png|jpg|jpeg|webp|gif)$/i.test(name)) {
      throw Object.assign(new Error('图片名不合法'), { status: 400 });
    }
    const full = path.join(SP().cvAssets, name);
    if (!fs.existsSync(full)) {
      throw Object.assign(new Error('图片不存在或已被删除'), { status: 404 });
    }
    const buf = await fsp.readFile(full);
    const MIME = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.gif': 'image/gif',
    };
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      // 文件名含时间戳 + 随机串，内容永不变化 → 可以放心长缓存
      'Cache-Control': 'private, max-age=604800',
    });
    return res.end(buf);
  }

  // ── 模板图片 OCR（2026-09-30）：图片模板的本地识别 ──────────────────────
  // 用 Windows 自带 OCR 引擎（WinRT，powershell 子进程驱动）—— 零新依赖、
  // 图片不出本机（只写进系统临时目录、识别完即删）。只服务「上传文件导入模板」。
  // 请求体放宽到 32MB：前端把图压到最长边 2600px 后以 base64 上送本机服务。
  if (route === '/api/tpl/ocr' && method === 'POST') {
    const body = await readBody(req, 32 * 1024 * 1024);
    const dataUrl = String(body.dataBase64 || '');
    const b64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
    let img = null;
    try { img = Buffer.from(b64, 'base64'); } catch { img = null; }
    if (!img || !img.length) {
      throw Object.assign(new Error('图片数据为空或不是有效的 base64。'), { status: 400 });
    }
    if (img.length > 20 * 1024 * 1024) {
      throw Object.assign(new Error('图片超过 20MB 的上限。截图一般几百 KB，检查一下是不是选错了文件。'), { status: 413 });
    }
    // 魔数校验：扩展名可以骗人，文件头不会
    const sig = (bytes) => bytes.every((b, i) => img[i] === b);
    const isPng = sig([0x89, 0x50, 0x4E, 0x47]);
    const isJpg = sig([0xFF, 0xD8, 0xFF]);
    const isBmp = sig([0x42, 0x4D]);
    const isGif = sig([0x47, 0x49, 0x46, 0x38]);
    const isWebp = sig([0x52, 0x49, 0x46, 0x46]) && img.subarray(8, 12).toString('latin1') === 'WEBP';
    const ext = isPng ? '.png' : isJpg ? '.jpg' : isBmp ? '.bmp' : isGif ? '.gif' : isWebp ? '.webp' : '';
    if (!ext) {
      throw Object.assign(new Error('不是有效的图片文件（支持 PNG / JPG / BMP / GIF / WEBP）—— '
        + '扩展名和真实格式可能对不上，或文件已损坏。'), { status: 400 });
    }
    const tmp = path.join(os.tmpdir(), 'lizhuo-tpl-ocr-' + crypto.randomBytes(6).toString('hex') + ext);
    await fsp.writeFile(tmp, img);
    try {
      const out = await ocrImageWindows(tmp);
      const lines = String(out || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) {
        throw Object.assign(new Error('OCR 没有识别到文字 —— 图片可能太模糊、对比度太低，或不是简历模板截图。'
          + '试试更清晰的截图，或改用 PDF / Word 文件导入。'), { status: 422, code: 'OCR_EMPTY' });
      }
      return sendJson(res, { ok: true, count: lines.length, lines });
    } finally {
      fsp.unlink(tmp).catch(() => {});
    }
  }

  // ── docx 保真模板的原文件（2026-09-30）───────────────────────────────
  // 内置（含预置清单）→ 全局 data/tpl-catalog/<id>.docx，对所有人开放
  //（内置清单本就匿名可见）；自定义 → 本空间 cv-tpl-files/<id>.docx，仅本人。
  // id 白名单校验（与生成规则同款字符集），杜绝路径拼接逃逸。
  if (route.startsWith('/api/tpl/file/') && method === 'GET') {
    const id = decodeURIComponent(route.slice('/api/tpl/file/'.length));
    if (!/^[\w-]{1,40}$/.test(id)) {
      throw Object.assign(new Error('模板 id 不合法。'), { status: 400 });
    }
    const builtin = BUILTIN_CV_TEMPLATES.find((t) => t.id === id && t.file && t.file.saved);
    let full = null;
    if (builtin) {
      full = path.join(PATHS.tplCatalog, id + '.docx');
    } else {
      const mine = readTplStore().items.find((t) => t && t.id === id && t.file && t.file.saved);
      if (mine) full = path.join(SP().cvTplFiles, id + '.docx');
    }
    if (!full || !fs.existsSync(full)) {
      throw Object.assign(new Error('这个模板没有可渲染的原文件。'), { status: 404, code: 'NO_FILE' });
    }
    const buf = await fsp.readFile(full);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(buf);
  }

  // ── docx 保真模板的 PDF 预览（2026-09-30）────────────────────────────
  // docx-preview 渲染不了「文本框 + 锚定图片」类模板（文艺/活泼系列实测：
  // 文字全堆到页外同一坐标、52 张图只出 2 张）。改用本机 Word/WPS COM 把
  // 原文件转 PDF（所见即所得），缓存后直接吐字节，前端 pdf.js 渲染。
  // 权限与 /api/tpl/file/:id 完全一致：内置匿名可取，自定义仅本人。
  // 首次请求惰性转换（Word 冷启动 ~10s），之后走缓存零开销。
  if (route.startsWith('/api/tpl/pdf/') && method === 'GET') {
    const id = decodeURIComponent(route.slice('/api/tpl/pdf/'.length));
    if (!/^[\w-]{1,40}$/.test(id)) {
      throw Object.assign(new Error('模板 id 不合法。'), { status: 400 });
    }
    const builtin = BUILTIN_CV_TEMPLATES.find((t) => t.id === id && t.file && t.file.saved);
    let src = null;
    let dst = null;
    if (builtin) {
      src = path.join(PATHS.tplCatalog, id + '.docx');
      dst = path.join(PATHS.tplCatalogPdf, id + '.pdf');
    } else {
      const mine = readTplStore().items.find((t) => t && t.id === id && t.file && t.file.saved);
      if (mine) {
        src = path.join(SP().cvTplFiles, id + '.docx');
        dst = path.join(SP().cvTplFilesPdf, id + '.pdf');
      }
    }
    if (!src || !fs.existsSync(src)) {
      throw Object.assign(new Error('这个模板没有可渲染的原文件。'), { status: 404, code: 'NO_FILE' });
    }
    if (!fs.existsSync(dst)) {
      try {
        await docxToPdf(src, dst);
      } catch (e) {
        throw Object.assign(
          new Error('原版预览生成失败（需要本机 Word/WPS）：' + e.message),
          { status: 500, code: 'CONVERT_FAIL' }
        );
      }
    }
    const pdfBuf = await fsp.readFile(dst);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdfBuf.length,
      'Cache-Control': 'no-cache',
    });
    return res.end(pdfBuf);
  }

  // ── docx 模板的「内容填充合成」预览（2026-09-30）──────────────────────
  // 设计类模板的示例内容（姓名/电话/自我评价…）全在图形文本框里，此前结论
  // 是「无法合成」——但 COM 的 Find & Replace 是**内容级替换**，以模板示例值
  // 为锚点、在保字符样式的前提下换成用户真实值（原型 _com-fill-proto 实测
  // 9/9 替换成功、排版零崩坏）。产物 = 模板原样排版 + 用户简历内容。
  // 替换对由 ui/tpl-fill-rules.mjs 按框内容特征生成；缓存文件名带替换对
  // hash —— 表单一改 hash 就变，下次请求自动重新合成；没改则秒回缓存。
  // 权限与 /api/tpl/file/:id 一致：内置匿名可取，自定义仅本人。
  if (route.startsWith('/api/tpl/fill/') && method === 'GET') {
    const id = decodeURIComponent(route.slice('/api/tpl/fill/'.length));
    if (!/^[\w-]{1,40}$/.test(id)) {
      throw Object.assign(new Error('模板 id 不合法。'), { status: 400 });
    }
    const builtin = BUILTIN_CV_TEMPLATES.find((t) => t.id === id && t.file && t.file.saved);
    let src = null;
    let dir = null;
    if (builtin) {
      src = path.join(PATHS.tplCatalog, id + '.docx');
      dir = PATHS.tplCatalogPdf;
    } else {
      const mine = readTplStore().items.find((t) => t && t.id === id && t.file && t.file.saved);
      if (mine) {
        src = path.join(SP().cvTplFiles, id + '.docx');
        dir = SP().cvTplFilesPdf;
      }
    }
    if (!src || !fs.existsSync(src)) {
      throw Object.assign(new Error('这个模板没有可渲染的原文件。'), { status: 404, code: 'NO_FILE' });
    }
    // 用户表单 → 替换对。解包/解析失败不拦路：pairs 为空时 fill 退化为
    // 「模板原样转 PDF」—— 比 500 挂掉好，前端至少能显示模板原貌。
    let pairs = [];
    let kinds = [];
    let dropped = [];
    let unmapped = [];
    let slots = {};
    try {
      const docBytes = await fsp.readFile(src);
      const zip = await unzip(docBytes);
      const xml = await zip.read('word/document.xml');
      const form = markdownToCv(await readText(SP().cvMd));
      const built = buildFillPairs(boxesFromDocumentXml(Buffer.from(xml).toString('utf8')), form);
      pairs = built.pairs;
      kinds = built.kinds || [];
      dropped = built.dropped || [];
      unmapped = built.stats && built.stats.unmapped || [];
      slots = built.stats || {};
    } catch { pairs = []; }
    const hash = fillHash(src, pairs);
    const dst = path.join(dir, 'fill-' + id + '-' + hash + '.pdf');
    if (!fs.existsSync(dst)) {
      try {
        await fillTemplate(src, dst, pairs);
      } catch (e) {
        throw Object.assign(
          new Error('合成预览失败（需要本机 Word/WPS）：' + e.message),
          { status: 500, code: 'FILL_FAIL' }
        );
      }
    }
    const pdfBuf = await fsp.readFile(dst);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdfBuf.length,
      'Cache-Control': 'no-cache',
      'X-Fill-Hash': hash,
      // 2026-10-04：把「装不下被裁掉的条目」与「模板有但表单没有的字段」回传，
      // 前端据此给提示 —— 容量守护不能静默丢内容（用户看到的就少了却不知道）。
      // HTTP 头不能带非 ASCII，这里 encodeURIComponent，前端 decodeURIComponent 解。
      'X-Fill-Dropped': encodeURIComponent(dropped.slice(0, 12).join(' ｜ ')).slice(0, 900),
      'X-Fill-Unmapped': encodeURIComponent(unmapped.slice(0, 12).join('、')).slice(0, 300),
      // 头不能带非 ASCII（unmapped 里是中文）→ 编码后前端解
      'X-Fill-Slots': encodeURIComponent(JSON.stringify(slots)).slice(0, 400),
    });
    return res.end(pdfBuf);
  }

  // ── docx 模板的「按当前表单合成」Word 导出（2026-10-04）───────────────
  // 用户诉求：「保存并生成 Word」得到的文件要**就是预览那个样式**。
  // 做法：与预览走**同一条** COM 合成管线（同一份模板副本、同一批替换对），
  // 只是最后一步存成 .docx 而不是 PDF —— 所以两者同源，不会出现
  // 「预览好看、导出变形」。权限与 /api/tpl/fill/:id 一致：内置匿名可取。
  if (route.startsWith('/api/tpl/fill-docx/') && method === 'GET') {
    const id = decodeURIComponent(route.slice('/api/tpl/fill-docx/'.length));
    if (!/^[\w-]{1,40}$/.test(id)) {
      throw Object.assign(new Error('模板 id 不合法。'), { status: 400 });
    }
    const builtin = BUILTIN_CV_TEMPLATES.find((t) => t.id === id && t.file && t.file.saved);
    let src = null;
    let dir = null;
    if (builtin) {
      src = path.join(PATHS.tplCatalog, id + '.docx');
      dir = PATHS.tplCatalogDocx;
    } else {
      const mine = readTplStore().items.find((t) => t && t.id === id && t.file && t.file.saved);
      if (mine) {
        src = path.join(SP().cvTplFiles, id + '.docx');
        dir = SP().cvTplFilesDocx;
      }
    }
    if (!src || !fs.existsSync(src)) {
      throw Object.assign(new Error('这个模板没有可合成的原文件。'), { status: 404, code: 'NO_FILE' });
    }
    // 替换对与预览完全一致：同一份 buildFillPairs 结果，两个出口共用
    let pairs = [];
    let dropped = [];
    try {
      const docBytes = await fsp.readFile(src);
      const zip = await unzip(docBytes);
      const xml = await zip.read('word/document.xml');
      const form = markdownToCv(await readText(SP().cvMd));
      const built = buildFillPairs(boxesFromDocumentXml(Buffer.from(xml).toString('utf8')), form);
      pairs = built.pairs;
      dropped = built.dropped || [];
    } catch { pairs = []; }
    const hash = fillHash(src, pairs, { fmt: 'docx' });
    const dst = path.join(dir, 'fill-' + id + '-' + hash + '.docx');
    if (!fs.existsSync(dst)) {
      try {
        await fillTemplate(src, dst, pairs, { fmt: 'docx' });
      } catch (e) {
        throw Object.assign(
          new Error('按模板导出 Word 失败（需要本机 Word/WPS）：' + e.message),
          { status: 500, code: 'FILL_DOCX_FAIL' }
        );
      }
    }
    const buf = await fsp.readFile(dst);
    const nameUtf8 = encodeURIComponent('简历-' + id + '.docx');
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Length': buf.length,
      'Content-Disposition': "attachment; filename=\"resume-" + id + ".docx\"; filename*=UTF-8''" + nameUtf8,
      'Cache-Control': 'no-cache',
      'X-Fill-Dropped': encodeURIComponent(dropped.slice(0, 12).join(' ｜ ')).slice(0, 900),
    });
    return res.end(buf);
  }

  // ── 简历多版本 ────────────────────────────────────────────────────────
  // 只读：列出全部版本（原版第一）。
  if (route === '/api/cv/versions' && method === 'GET') {
    await ensureCvVersions();
    return sendJson(res, { versions: await listVersions(), dir: 'data/cv-versions' });
  }

  // 只读：取某版本正文 + 结构化表单 + 体检结果。
  // 体检结果一起返回，是因为前端要拿它当「这个版本能不能安全地再编辑」的依据。
  if (route === '/api/cv/versions/content' && method === 'GET') {
    const id = String(url.searchParams.get('id') || 'base').trim() || 'base';
    const meta = await findVersionMeta(id);
    if (!meta) throw Object.assign(new Error('没有这个版本'), { status: 404 });

    const md = await readVersionMd(id);
    const audit = auditCvMarkdown(md);
    const form = markdownToCv(md);
    return sendJson(res, {
      id, meta, markdown: md, form, audit,
      completeness: cvCompleteness(form),
    });
  }

  // 新建：从原版（或指定版本）复制一份，按岗位命名。
  // 「新建」和「复制」在数据层是同一件事，只是默认来源不同 ——
  // 界面上分成两个入口，是为了让「从哪儿抄的」这个选择显式化。
  //
  // empty:true（2026-10-10）= **空白新建**：「+ 新建简历」的语义是「从零写一份
  // 独立简历」，不是复制当前内容。不碰主简历、不碰其它版本，只落一个新的空 md。
  if (route === '/api/cv/versions/create' && method === 'POST') {
    const body = await readBody(req);
    const name = cleanVersionName(body.name);
    const targetRole = String(body.targetRole || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    const source = String(body.source || 'base').trim() || 'base';
    const empty = !!body.empty;

    let srcMeta = null;
    let srcMd = '';
    if (!empty) {
      srcMeta = await findVersionMeta(source);
      if (!srcMeta) throw Object.assign(new Error('要复制的来源版本不存在'), { status: 404 });
      srcMd = await readVersionMd(source);
      if (!srcMd.trim()) {
        throw Object.assign(
          new Error('来源版本是空的，没有内容可复制'),
          { status: 400, hint: '先去「我的简历」把原版内容填上，再来建版本。' },
        );
      }
    }

    await ensureCvVersions();
    const id = newVersionId();
    await fsp.writeFile(versionFile(id), empty ? '\n' : srcMd, 'utf8');

    const now = Date.now();
    const idx = await readVersionIndex();
    idx.push({
      id, name, targetRole,
      source: empty ? '' : (source === 'base' ? 'base' : source),
      sourceName: empty ? '空白新建' : (source === 'base' ? '原版简历' : (srcMeta.name || source)),
      note: String(body.note || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200),
      createdAt: now, updatedAt: now,
    });
    await writeVersionIndex(idx);

    return sendJson(res, { ok: true, version: (await findVersionMeta(id)), versions: await listVersions() });
  }

  // 保存一份**独立版本**的内容（2026-10-10）：编辑器的编辑对象是某个版本时
  // （「+ 新建简历」创建的空白简历、或从版本卡点进来的定向版本），保存写回
  // 版本文件本身 —— cv.md 与其它版本都不动。这就是「新建不影响原简历」的落点。
  // 版本没有自己的 form.json 缓存：GET content 用 markdownToCv 现算，两条路
  // 不会分叉。主简历的「整节消失」守卫在这里不适用 —— 它保护的是 cv.md。
  if (route === '/api/cv/versions/save' && method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (!id || id === 'base') {
      throw Object.assign(new Error('要保存的版本 id 不合法'), { status: 400 });
    }
    const meta = await findVersionMeta(id);
    if (!meta) throw Object.assign(new Error('没有这个版本'), { status: 404 });

    const form = normalizeCv(body.form || {});
    const md = cvToMarkdown(form);
    await ensureCvVersions();
    const out = md.endsWith('\n') ? md : md + '\n';
    await fsp.writeFile(versionFile(id), out, 'utf8');

    const idx = await readVersionIndex();
    const hit = idx.find((v) => v.id === id);
    if (hit) hit.updatedAt = Date.now();
    await writeVersionIndex(idx);

    return sendJson(res, { ok: true, id, bytes: out.length });
  }

  // 重命名 / 改适配岗位。原版不允许改名 —— 它的名字来自 cv.md 这个事实，
  // 不在这里另存一份，否则就会出现「界面叫 A、文件叫 B」。
  if (route === '/api/cv/versions/rename' && method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (id === 'base') {
      throw Object.assign(new Error('原版的名称不可修改'), {
        status: 400, hint: '原版就是项目根目录的 cv.md；要另取名字请先点「新建版本」复制一份。',
      });
    }
    const name = cleanVersionName(body.name);
    const targetRole = String(body.targetRole || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);

    const idx = await readVersionIndex();
    const hit = idx.find((v) => v.id === id);
    if (!hit) throw Object.assign(new Error('没有这个版本'), { status: 404 });
    hit.name = name;
    hit.targetRole = targetRole;
    hit.updatedAt = Date.now();
    await writeVersionIndex(idx);

    return sendJson(res, { ok: true, version: await findVersionMeta(id), versions: await listVersions() });
  }

  // 删除：与报告/台账同一套规矩 —— 移进 data/trash/，不真删。
  // 回收文件名里带上版本名，用户后悔时一眼能认出是哪一个。
  if (route === '/api/cv/versions/delete' && method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (id === 'base') {
      throw Object.assign(new Error('原版不能删除'), {
        status: 400, hint: '原版是 cv.md 本身，是整条链路的来源。它只能被编辑，不能被删。',
      });
    }
    const idx = await readVersionIndex();
    const hit = idx.find((v) => v.id === id);
    if (!hit) throw Object.assign(new Error('没有这个版本'), { status: 404 });

    const full = versionFile(id);
    let trash = '';
    if (exists(full)) trash = await moveToTrash(full, 'cv-version-' + safeSlug(hit.name, 30));

    await writeVersionIndex(idx.filter((v) => v.id !== id));

    return sendJson(res, {
      ok: true, trash, removed: { id, name: hit.name, targetRole: hit.targetRole || '' },
      versions: await listVersions(),
    });
  }

  // Diff：任意两版逐行对比。a/b 都可以是 'base'。
  if (route === '/api/cv/versions/diff' && method === 'POST') {
    const body = await readBody(req);
    const aId = String(body.a || 'base').trim() || 'base';
    const bId = String(body.b || 'base').trim() || 'base';
    const aMeta = await findVersionMeta(aId);
    const bMeta = await findVersionMeta(bId);
    if (!aMeta) throw Object.assign(new Error('左侧版本不存在'), { status: 404 });
    if (!bMeta) throw Object.assign(new Error('右侧版本不存在'), { status: 404 });

    const aText = (await readVersionMd(aId)).replace(/\r\n/g, '\n');
    const bText = (await readVersionMd(bId)).replace(/\r\n/g, '\n');
    const lines = diffLines(aText.split('\n'), bText.split('\n'));

    const stats = { added: 0, removed: 0, same: 0 };
    for (const l of lines) {
      if (l.t === '+') stats.added++;
      else if (l.t === '-') stats.removed++;
      else if (l.t === ' ') stats.same++;
    }
    return sendJson(res, {
      ok: true, lines, stats,
      a: { id: aId, name: aMeta.name, bytes: aText.length },
      b: { id: bId, name: bMeta.name, bytes: bText.length },
      identical: aText === bText,
    });
  }

  // ── 简历优化（AI，只读） ──────────────────────────────────────────────
  // 与「评估岗位」的区别：这条链路**不产出任何文件**，AI 只回一段结构化文本
  // （问题清单 + 改写稿），由用户在页面上确认后，再由 apply 接口写回 cv.md。
  //
  // 为什么不做成「AI 直接改 cv.md」：简历是全系统的事实来源，所有评估都读它。
  // 让模型在无人确认的情况下覆盖它，一次幻觉就可能把量化数据改成编造的经历。
  // 所以这里强制分开：AI 只出稿，写盘是另一个显式动作，且写前必留备份。
  if (route === '/api/cv/optimize' && method === 'POST') {
    const body = await readBody(req);
    const jd = String(body.jd || '').trim();
    if (jd.length > 30000) {
      throw Object.assign(new Error('JD 正文过长（上限 3 万字符）'), { status: 400 });
    }

    // ── 优化偏好（可选；评估页「AI优化简历」弹窗的三个控件） ────────────
    // scope/style/extra 全部是「给 AI 的软指令」：不改变接口契约与输出格式，
    // 不传时 prompt 与从前一字不差。scope/style 走白名单，用户传什么都注入不进别的指令。
    const OPT_SCOPES = ['项目经历', '工作经历', '技能板块', '个人简介'];
    const OPT_STYLES = {
      '专业精炼': '用专业精炼的书面语，删口语化表达，突出动词开头的动作句，适合大厂 ATS 机器筛阅（默认推荐）。',
      '成果量化': '尽量把每条经历补成「动作 + 量化结果」的结构；原文没有数字的地方写【待补充：具体数字】让用户自己填，不要编。',
      '简洁保守': '用语平实克制、少形容词、结构保守稳重，适合国企 / 传统行业。',
      '项目领导力': '突出项目里的主导角色、协调推动与决策过程，体现 ownership。',
    };
    let optScope = [];
    let optStyleNote = '';
    let optExtra = '';
    if (body.opts && typeof body.opts === 'object' && !Array.isArray(body.opts)) {
      if (Array.isArray(body.opts.scope)) {
        optScope = body.opts.scope.map((s) => String(s).trim()).filter((s) => OPT_SCOPES.includes(s));
      }
      const st = String(body.opts.style || '').trim();
      if (OPT_STYLES[st]) optStyleNote = OPT_STYLES[st];
      optExtra = String(body.opts.extra || '').trim().slice(0, 500);
    }

    // ── 优化对象：原版 cv.md，还是某个岗位版本？ ─────────────────────
    // 同一个接口服务两种场景，因为下游（解析、体检门禁、错误话术）完全一样，
    // 只有「读哪个文件」和「写回哪里」不同。拆成两个接口只会多出一份要同步维护的规则。
    const target = String(body.target || 'base').trim() || 'base';
    let cvMd = '';
    let srcLabel = 'cv.md';
    let targetMeta = null;
    if (target === 'base') {
      cvMd = await readText(SP().cvMd);
    } else {
      targetMeta = await findVersionMeta(target);
      if (!targetMeta) {
        throw Object.assign(new Error('这个简历版本不存在，可能已经被删掉了'), {
          status: 404, hint: '回「我的简历」刷新一下版本列表。',
        });
      }
      cvMd = await readVersionMd(target);
      srcLabel = '（版本「' + targetMeta.name + '」，适配岗位：'
        + (targetMeta.targetRole || '未填写') + '）';
    }

    const srcName = target === 'base' ? 'cv.md' : '版本「' + targetMeta.name + '」';
    if (!cvMd.trim()) {
      throw Object.assign(
        new Error(srcName + ' 还是空的，先去「我的简历」把内容填上再优化'),
        { status: 400 },
      );
    }
    if (cvMd.length > 60000) {
      throw Object.assign(new Error(srcName + ' 过长（超过 6 万字符），请先精简'), { status: 400 });
    }

    // ── 引擎：优先 CodeBuddy，它出不了稿就自动换本地模型（2026-10-09）──
    // 降级的理由、冷却机制、以及「为什么超时不换」全部在 runAiWithFallback 那里。
    // 这里只负责把结果翻译成对用户说得清的响应。
    const prompt = buildCvOptimizePrompt(cvMd, jd, srcLabel, {
      scope: optScope, styleNote: optStyleNote, extra: optExtra,
    });
    // 只读任务：不放开写权限，AI 就算想写也会被拦下。
    // engine 一起传下去：runAiOnce 内部还会再解析一次引擎，
    // 不传就会读回全局配置（data/ai-engine.json），把选定的引擎换掉。
    // ⚠️ 局部变量**不能叫 res** —— 那会遮蔽 HTTP 响应对象，
    //    后面的 sendJson(res, …) 会炸成「res.writeHead is not a function」，
    //    而且是在 AI 跑完之后才炸（2026-10-09 实测踩中）。
    const airun = await runAiWithFallback(prompt, {
      prefer: String(body.engine || '').trim() === ENGINE_OLLAMA ? ENGINE_OLLAMA : ENGINE_CLI,
      timeoutMs: 600000,
    });
    if (!airun.r) {
      const noOne = airun.reason === 'unavailable'
        ? 'no-' + (airun.from === ENGINE_CLI ? 'cli' : 'ollama') : 'none';
      throw Object.assign(new Error(engineUnavailableText(noOne)), { status: 503 });
    }
    const r = airun.r;
    const usedEngine = airun.engine;
    const degraded = degradeText(airun);

    const out = (r.stdout || '').trim();
    const err = (r.stderr || '').trim();
    let friendly = '';
    if (r.authFailed) {
      // 登录态过期（2026-09-28 实测：token ~10 天失效，两次重试都回同一句
      // Authentication required）——放最前面，别让「瞬时故障」误导用户空转重试
      friendly = 'CodeBuddy 的登录态过期了。双击项目根目录的「登录CodeBuddy.cmd」，'
        + '在弹出的浏览器里完成登录，然后回来重试。';
    } else if (r.code === 0 && !out) {
      if (r.retried) {
        friendly = 'AI 命令行连续两次都空返回（换端口重试过）。通常是瞬时故障：稍等十几秒再点一次。';
      } else if (/authentication required|please.*login|not logged in/i.test(err)) {
        friendly = 'AI 命令行报告未登录，但这类报错也可能是端口冲突的误报。'
          + '双击项目根目录的「登录CodeBuddy.cmd」重新登录，然后刷新本页重试。';
      } else {
        friendly = 'AI 命令行没有返回任何内容。请确认已登录（双击「登录CodeBuddy.cmd」完成登录）。';
      }
    } else if (r.timeout) {
      friendly = '优化超时（10 分钟）。简历越长越慢，可以先把简历精简一点再试，或改用终端跑。';
    }

    const parsed = out ? parseCvOptimize(out) : { summary: '', issues: [], draft: '', parseError: '' };
    if (!r.timeout && out && parsed.parseError && !friendly) friendly = parsed.parseError;

    return sendJson(res, {
      ok: r.code === 0 && !!out && !!parsed.draft,
      // 'jd' = 按贴进来的 JD 定向优化；'general' = 按 profile.yml 的目标方向通用优化
      mode: jd ? 'jd' : 'general',
      cli: r.cli, ms: r.ms, code: r.code, timeout: !!r.timeout, retried: !!r.retried,
      // 本次**实际**用的是哪个引擎，以及降级说明。
      // 必须回给前端：降级是自动的，但绝不能是静默的（见上面那段的说明）——
      // 用户有权知道自己的简历原文交给了谁。degraded 为空 = 没降级。
      engineUsed: usedEngine, degraded,
      output: out, stderr: err, friendly, parsed,
    });
  }

  // 「AI一键优化本段」（简历编辑器，/api/ai/polish）：只润色一小段文字。
  // 和 /api/cv/optimize 的分工：那边读磁盘上的整份简历、出问题清单 + 改写稿，
  // 1–3 分钟；这边只吃一个输入框里的几十上百字，十几秒返回 —— 用户在表单里
  // 写完一条经历立刻能润，不用先保存、也不用等整份简历跑完。
  // 同样是**只读任务**：结果回填到输入框由用户确认，服务端不碰任何文件。
  if (route === '/api/ai/polish' && method === 'POST') {
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    const hint = String(body.hint || '').trim().slice(0, 60);
    // 三套文体（职位名 / 自我评价 / 经历描述），见 POLISH_MODE_RULES。
    // 白名单外的值在 buildPolishPrompt 里回落到 description。
    const mode = String(body.mode || 'description').trim();
    if (!text) {
      throw Object.assign(new Error('要优化的文字是空的'), { status: 400 });
    }
    if (text.length > 4000) {
      throw Object.assign(
        new Error('这段太长（超过 4000 字符）。一键优化按「段」来的，请拆小一点再试'),
        { status: 400 },
      );
    }

    // 引擎：**优先本地模型**。润色是几十上百字的小任务，本地模型十几秒就能回，
    // 也不耗 CodeBuddy 的额度；它没起来就自动换 CodeBuddy —— 见 runAiWithFallback。
    // ⚠️ 同样不能把局部变量叫 res（会遮蔽 HTTP 响应对象）。
    const airun = await runAiWithFallback(buildPolishPrompt(text, hint, mode), {
      prefer: ENGINE_OLLAMA, timeoutMs: 300000,
    });
    if (!airun.r) {
      const noOne = airun.reason === 'unavailable'
        ? 'no-' + (airun.from === ENGINE_CLI ? 'cli' : 'ollama') : 'none';
      throw Object.assign(new Error(engineUnavailableText(noOne)), { status: 503 });
    }
    const r = airun.r;
    const degraded = degradeText(airun);

    const out = (r.stdout || '').trim()
      // 有的模型会给输出套一层代码围栏，剥掉 —— 正文里真的写 ``` 的场景
      // 在简历语句里不存在，首尾各剥一层是安全的
      .replace(/^```[a-zA-Z]*\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();

    let friendly = '';
    if (r.authFailed) {
      friendly = 'CodeBuddy 的登录态过期了。双击项目根目录的「登录CodeBuddy.cmd」，'
        + '在弹出的浏览器里完成登录，然后回来重试。';
    } else if (r.code === 0 && !out) {
      friendly = r.retried
        ? 'AI 命令行连续两次都空返回（换端口重试过）。通常是瞬时故障：稍等十几秒再点一次。'
        : 'AI 命令行没有返回任何内容。请确认已登录（双击「登录CodeBuddy.cmd」完成登录）。';
    } else if (r.timeout) {
      friendly = '优化超时（5 分钟）。请稍后再试一次，或改用「AI简历全局优化」。';
    }

    return sendJson(res, {
      ok: r.code === 0 && !!out,
      // 回报实际用的文体（白名单外的值已回落成 description）——
      // 前端据此把模式按钮的选中态对齐，不让界面显示的和真正跑的不一致。
      mode: POLISH_MODES.includes(mode) ? mode : 'description',
      text: out, ms: r.ms, code: r.code, timeout: !!r.timeout, retried: !!r.retried,
      // 与 /api/cv/optimize 同一个口径：换过引擎就说出来
      engineUsed: airun.engine, degraded,
      stderr: (r.stderr || '').trim(), friendly,
    });
  }

  // 写回 cv.md。**必须单独一步**：AI 出稿是一回事，动用户的简历文件是另一回事。
  if (route === '/api/cv/optimize/apply' && method === 'POST') {
    const body = await readBody(req);
    const draft = String(body.draft || '').replace(/\r\n/g, '\n').trim();
    if (draft.length < 100) {
      throw Object.assign(new Error('改写稿太短，疑似没解析成功，已拒绝写回'), { status: 400 });
    }
    if (draft.length > 80000) {
      throw Object.assign(new Error('改写稿过长（超过 8 万字符），已拒绝写回'), { status: 400 });
    }

    // 守卫：改写稿必须能被完整解析回结构化表单。
    //
    // 为什么这是硬门槛：apply 之后表单由 markdownToCv(draft) 重建，而表单里
    // 解析不出来的章节就是空的 —— 用户下一次点「保存」，那些章节会从 cv.md
    // 里被彻底删掉。2026-09-18 的「优化之后我填的信息全没了」正是这个链路：
    // AI 把 `## 实习经历` 写成了解析器当时不认识的标题。现在解析器已经能认了，
    // 但**将来还会有别的写法**，所以这里必须拦住，而不是赌解析器永远够用。
    const audit = auditCvMarkdown(draft);
    if (audit.broken.length) {
      throw Object.assign(
        new Error('改写稿里这些章节解析不出内容：' + audit.broken.join('、')),
        {
          status: 422,
          hint: '这是解析器兼容问题，不是你的操作失误——cv.md **一字未改**，'
            + '没有发生任何丢失。请把这条反馈给维护者；急用可以复制改写稿手工粘贴。',
        },
      );
    }

    // ── 写回到哪里？ ─────────────────────────────────────────────────
    //   'base'        → 覆盖 cv.md（原有行为：通用优化后写回原版）
    //   '<版本 id>'   → 覆盖那个版本的文件，cv.md 不动
    //   'new'         → 用改写稿**另存为新版本**，cv.md 与所有既有版本都不动
    //
    // 'new' 是「按岗位定制」的正确落点：用户是拿一份岗位 JD 去改简历的，
    // 改完覆盖原版就等于把「投得出去的那一份」弄丢了。这个分支的存在，
    // 让「初筛 ≥3 分 → 简历对应优化」这条链路可以完全不碰原版。
    const target = String(body.target || 'base').trim() || 'base';

    if (target === 'new') {
      const name = cleanVersionName(body.name);
      const targetRole = String(body.targetRole || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80);

      await ensureCvVersions();
      const id = newVersionId();
      const content = draft.endsWith('\n') ? draft : draft + '\n';
      await fsp.writeFile(versionFile(id), content, 'utf8');

      const now = Date.now();
      const idx = await readVersionIndex();
      idx.push({
        id, name, targetRole,
        source: 'base', sourceName: '原版简历',
        note: String(body.note || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200),
        createdAt: now, updatedAt: now,
      });
      await writeVersionIndex(idx);

      // 这条链路**不写 cv.md、不重建 cv-form.json**。前者是设计目标，
      // 后者是必须：cv-form.json 是 cv.md 的派生缓存，在这里重建会把它
      // 指向新版本的内容 —— 原版编辑器下次一保存就把新版本内容写进 cv.md。
      // 体检直接用上面那次的 audit（同一份正文），不重复算一遍。
      const warnings = [];
      if (audit.unknown.length) {
        warnings.push('这些章节名解析器不认识，表单里看不到它们：' + audit.unknown.join('、')
          + '——本版本已经存下来了，但若之后要按它改 cv.md，建议改成常用名称');
      }

      return sendJson(res, {
        ok: true, target: 'new', backup: '', bytes: content.length,
        version: await findVersionMeta(id), versions: await listVersions(),
        warnings, markdown: content,
        completeness: cvCompleteness(markdownToCv(content)),
      });
    }

    // base 与 <id> 共用同一套「先备份、再整份替换」的流程，
    // 只是落点文件不同 —— 这样两种写回的风险与副作用完全一致，不用记两套。
    let writePath = SP().cvMd;
    let backupDir = path.join(ROOT, 'data');
    let backupPrefix = 'cv.backup-';
    let targetMeta = null;
    if (target !== 'base') {
      targetMeta = await findVersionMeta(target);
      if (!targetMeta) {
        throw Object.assign(new Error('这个简历版本不存在，可能已经被删掉了'), {
          status: 404, hint: '回「我的简历」刷新一下版本列表，或改用「另存为新版本」。',
        });
      }
      writePath = versionFile(target);
      backupDir = SP().cvVersionBackups;
      backupPrefix = target + '.backup-';
    }

    const srcLabel = target === 'base' ? 'cv.md' : '版本「' + targetMeta.name + '」';
    const cur = (await readVersionMd(target)).trim();
    if (cur === draft) {
      throw Object.assign(new Error('改写稿与当前 ' + srcLabel + ' 完全相同，无需写回'), { status: 400 });
    }

    // 备份：原版沿用 data/cv.backup-*，版本快照进 data/cv-versions/_backups/。
    // 分开放是有意的——原版的备份要一眼能找到，版本快照数量多，混在一起会淹掉它。
    let backup = '';
    if (exists(writePath)) {
      const bak = path.join(backupDir, backupPrefix + Date.now() + '.md');
      try {
        await fsp.mkdir(path.dirname(bak), { recursive: true });
        await fsp.copyFile(writePath, bak);
        backup = path.relative(ROOT, bak);
      } catch { /* 备份失败不阻塞写回，但要如实告诉用户没有备份 */ }
    }

    const content = draft.endsWith('\n') ? draft : draft + '\n';
    await fsp.writeFile(writePath, content, 'utf8');

    // 关键一步（**只在写回原版时做**）：表单缓存必须跟着重建。
    // getCv() 的优先级是「cv-form.json 存在就用它」，只改 cv.md 的话
    // 简历编辑器会继续显示旧内容，用户下一次点保存又把旧内容写回 cv.md——
    // 改写稿当场作废，而且看起来像「优化没生效」。
    const form = markdownToCv(draft);
    if (target === 'base') {
      try {
        await fsp.mkdir(path.dirname(SP().cvForm), { recursive: true });
        await fsp.writeFile(SP().cvForm, JSON.stringify(form, null, 2), 'utf8');
      } catch { /* 表单重建失败不影响 cv.md 已写入的事实 */ }
    } else {
      // 版本的 updatedAt 要跟上，否则界面上「上次修改」还停在创建时间
      const idx = await readVersionIndex();
      const hit = idx.find((v) => v.id === target);
      if (hit) { hit.updatedAt = Date.now(); await writeVersionIndex(idx); }
    }

    // 写回后如实汇报「相对写回前少了什么」。不拦，因为用户可能就是想删；
    // 但必须说出来 —— 静默变少才是最坑的那种失败。备份在 data/ 下，能回退。
    const warnings = [];
    const gone = droppedSections(cur, draft);
    if (gone.length) warnings.push('改写稿里没有了这些章节：' + gone.join('、') + '（可从备份恢复）');
    if (audit.unknown.length) {
      warnings.push('这些章节名解析器不认识，表单里看不到它们：' + audit.unknown.join('、')
        + '——下次在表单里保存会丢掉，建议改成常用名称');
    }
    const before = cvCompleteness(markdownToCv(cur)).missing.length;
    const after = cvCompleteness(form).missing.length;
    if (after > before) warnings.push('完整度下降：缺项从 ' + before + ' 项变成 ' + after + ' 项');

    return sendJson(res, {
      ok: true, target, backup, bytes: content.length, form, warnings,
      version: targetMeta ? await findVersionMeta(target) : null,
      versions: target === 'base' ? undefined : await listVersions(),
      completeness: cvCompleteness(form),
    });
  }

  if (route === '/api/profile' && method === 'POST') {
    const body = await readBody(req);
    let text = await readText(PATHS.profile);
    if (!text.trim()) {
      const example = await readText(path.join(ROOT, 'config', 'profile.example.yml'));
      text = example || 'candidate:\n';
    }

    const scalars = body.scalars || {};
    for (const [dotted, value] of Object.entries(scalars)) {
      if (value === undefined || value === null) continue;
      text = setYamlScalar(text, dotted.split('.'), value);
    }
    const lists = body.lists || {};
    for (const [dotted, items] of Object.entries(lists)) {
      if (!Array.isArray(items)) continue;
      text = setYamlStringList(text, dotted.split('.'), items.map((s) => String(s)).filter(Boolean));
    }

    // 落盘前自检：config/profile.yml 是全系统的唯一事实来源，
    // 一旦写入坏 YAML，后续所有评估都会静默降级。宁可拒存也不留损坏文件。
    const yamlLib = await loadYaml();
    if (yamlLib) {
      try {
        yamlLib.load(text);
      } catch (e) {
        throw Object.assign(
          new Error('这次改动会让 profile.yml 变成非法 YAML，已放弃保存（原文件未改动）：' + e.message),
          { status: 400 },
        );
      }
    } else {
      throw Object.assign(
        new Error('无法加载 js-yaml，为保护 profile.yml 已放弃保存。请先运行 npm install。'),
        { status: 400 },
      );
    }

    await fsp.writeFile(PATHS.profile, text, 'utf8');
    return sendJson(res, await getProfile());
  }

  if (route === '/api/portals' && method === 'POST') {
    const body = await readBody(req);
    if (typeof body.raw !== 'string') throw Object.assign(new Error('缺少 raw 字段'), { status: 400 });
    const yaml = await loadYaml();
    if (yaml) {
      try { yaml.load(body.raw); }
      catch (e) { throw Object.assign(new Error('YAML 语法有误，未保存：' + e.message), { status: 400 }); }
    }
    await fsp.writeFile(PATHS.portals, body.raw, 'utf8');
    return sendJson(res, { ok: true });
  }

  if (route === '/api/pipeline/add' && method === 'POST') {
    const body = await readBody(req);
    const url0 = String(body.url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url0)) throw Object.assign(new Error('请填写以 http(s):// 开头的完整链接'), { status: 400 });

    const company = String(body.company || '').trim();
    const role = String(body.role || '').trim();
    const extra = String(body.extra || '').trim();
    const parts = [url0, company, role, extra].filter(Boolean);
    const line = `- [ ] ${parts.join(' | ')}`;

    let md = await readText(PATHS.pipeline);
    if (!/^##\s+\S/m.test(md)) {
      md = '# Job Pipeline\n\n## Pending\n\n## Processed\n';
    } else if (!/^##\s+(Pending|待)/m.test(md)) {
      md = md.replace(/^(#.*\n)/, '$1\n## Pending\n');
    }

    if (!/^##\s+(Pending|待)/m.test(md)) {
      md += `\n## Pending\n`;
    }

    const lines = md.split(/\r?\n/);
    let pendingIdx = lines.findIndex((l) => /^##\s+(Pending|待)/i.test(l));
    if (pendingIdx < 0) { lines.push('', '## Pending'); pendingIdx = lines.length - 1; }
    let insertAt = lines.length;
    for (let i = pendingIdx + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { insertAt = i; break; }
    }
    // 跳过 pending 段尾部空行，插在最后一条之后
    while (insertAt > pendingIdx + 1 && !lines[insertAt - 1].trim()) insertAt--;
    lines.splice(insertAt, 0, line);

    await fsp.writeFile(PATHS.pipeline, lines.join('\n'), 'utf8');
    return sendJson(res, await getPipeline());
  }

  if (route === '/api/tracker/status' && method === 'POST') {
    const body = await readBody(req);
    const target = String(body.target || '').trim();
    const state = String(body.state || '').trim();
    if (!target || !state) throw Object.assign(new Error('缺少 target 或 state'), { status: 400 });
    // target 既可能是台账行号，也可能是公司名（含中文），因此不能只允许 [\w\-.#]。
    // spawn 走的是参数数组、不经 shell，无需转义元字符；只需挡住会被当成
    // 命令行选项的「前导 -」以及换行（换行会让注入的第二个"参数"混进来）。
    if (/[\r\n]/.test(target)) throw Object.assign(new Error('目标含非法换行符'), { status: 400 });
    if (target.startsWith('-')) throw Object.assign(new Error('目标不能以 - 开头'), { status: 400 });
    if (target.length > 120) throw Object.assign(new Error('目标过长'), { status: 400 });
    if (!/^[A-Za-z_ ]+$/.test(state)) throw Object.assign(new Error('状态名含非法字符'), { status: 400 });

    // set-status.mjs 的第一个位置参数是「报告编号或公司名」，不是台账行号。
    // 台账 Report 列里存的是报告文件名（含年份，如 2026-09-16-xxx.md），
    // 直接传 "1" 会被脚本当成报告编号 2026，触发歧义报错。
    // 因此纯数字一律用 --row 明确指定台账行（实测：--row 1 与公司名选择器都可正常改写）。
    const args = ['set-status.mjs'];
    if (/^\d+$/.test(target)) args.push('--row', target);
    else args.push(target);
    args.push(state);
    const note = String(body.note || '').trim();
    if (note) args.push('--note', note);
    const role = String(body.role || '').trim();
    if (role) args.push('--role', role);
    if (body.force) args.push('--force');

    const r = await runNode(args, { timeoutMs: 60000 });
    return sendJson(res, { ok: r.code === 0, ...r, tracker: await getTracker() });
  }

  // ── 跟进：记录一次跟进 / 推迟下次跟进 ──────────────────────────────
  //
  // 两条都只往 data/follow-ups.md **追加**，绝不改写既有行。这个文件是
  // 「跟进历史」的事实来源：它被改坏不会当场报错，只会让节奏算错 ——
  // 那种错要过好几周才会以「这个岗位怎么一直不提醒」的形式浮现出来。
  //
  // 写入走 core 的 withFollowupsLock（同一把目录锁），因为 CLI 的
  // followup-seed.mjs / set-status.mjs 也会写这个文件。用进程内队列代替
  // 文件锁是错的：队列只在一个进程内串行，对别的进程完全瞎。
  if (route === '/api/followups/log' && method === 'POST') {
    const body = await readBody(req);
    const appNum = Number.parseInt(String(body.appNum ?? ''), 10);
    if (!Number.isInteger(appNum) || appNum < 0) {
      throw Object.assign(new Error('缺少合法的台账编号 appNum'), {
        status: 400, hint: 'appNum 是台账「#」列的数字',
      });
    }

    // 编号必须真的在台账里 —— 否则这条跟进永远进不了分析（节奏只读台账），
    // 用户会以为记上了、实际是个孤儿行。宁可当场报错。
    const row = (await getTracker()).rows.find((r) => String(r.num).trim() === String(appNum));
    if (!row) {
      throw Object.assign(new Error(`台账里没有编号 ${appNum} 的记录`), {
        status: 404, hint: '跟进节奏只统计台账里存在的岗位；请先在台账中确认这个编号',
      });
    }

    const date = String(body.date || localToday()).trim();
    if (!REAL_DATE_RE.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw Object.assign(new Error('日期必须是真实存在的日历日（YYYY-MM-DD）'), {
        status: 400, hint: '例如 2026-09-21。2026-02-31 这种形状对但不是真实日期的一律拒绝',
      });
    }

    const channel = normalizeChannel(body.channel);
    const contact = String(body.contact || '').trim();
    const notes = String(body.notes || '').trim();

    const created = await withFollowupsLock(PATHS.followups, async () => {
      const existing = exists(PATHS.followups) ? await fsp.readFile(PATHS.followups, 'utf8') : '';
      const base = existing.trim() ? existing : FOLLOWUPS_FILE_SKELETON;
      const num = nextFollowupNum(base);
      const line = followupRowLine({
        num, appNum, date,
        // 公司/岗位取台账的权威值，不信前端传的 —— 前端可能拿着旧数据
        company: row.company, role: row.role,
        channel, contact, notes,
      });
      // 用写回整份再原子替换，而不是 appendFileSync：这样「补表头 + 补末尾换行 +
      // 追加行」是一次不可分割的替换，中途崩了也不会留下半个表格。
      await fsp.writeFile(PATHS.followups, appendFollowupRow(base, line), 'utf8');
      return { num, line };
    });

    return sendJson(res, {
      ok: true, num: created.num, appNum, date, channel,
      company: row.company, role: row.role,
      followups: await getFollowups(),
    });
  }

  if (route === '/api/followups/defer' && method === 'POST') {
    const body = await readBody(req);
    const appNum = Number.parseInt(String(body.appNum ?? ''), 10);
    if (!Number.isInteger(appNum) || appNum < 0) {
      throw Object.assign(new Error('缺少合法的台账编号 appNum'), { status: 400 });
    }
    const row = (await getTracker()).rows.find((r) => String(r.num).trim() === String(appNum));
    if (!row) {
      throw Object.assign(new Error(`台账里没有编号 ${appNum} 的记录`), { status: 404 });
    }

    const date = String(body.date || '').trim();
    if (!REAL_DATE_RE.test(date) || new Date(date).toISOString().slice(0, 10) !== date) {
      throw Object.assign(new Error('推迟日期必须是真实存在的日历日（YYYY-MM-DD）'), { status: 400 });
    }
    // 钉到过去等于「立刻超期」—— 那是把提醒按下去又让它弹回来，
    // 用户真正想做的是「今天再追一次」或「这条算了」。两种都有别的入口，
    // 所以这里直接挡住，并要求一个不早于今天的日期。
    const today = localToday();
    if (date < today) {
      throw Object.assign(new Error('推迟日期不能早于今天'), {
        status: 400, hint: `最早可以填 ${today}；如果今天已经追过了，用「记一次跟进」`,
      });
    }

    await withFollowupsLock(PATHS.followups, async () => {
      const existing = exists(PATHS.followups) ? await fsp.readFile(PATHS.followups, 'utf8') : '';
      const base = existing.trim() ? existing : FOLLOWUPS_FILE_SKELETON;
      await fsp.writeFile(PATHS.followups, appendFollowupLine(base, followupPinLine(appNum, date, today)), 'utf8');
    });

    return sendJson(res, {
      ok: true, appNum, nextDate: date,
      company: row.company, role: row.role,
      followups: await getFollowups(),
    });
  }

  // ── 删除记录（可恢复） ──────────────────────────────────────────────
  // 两个「删」都先落到 data/trash/，界面上立刻消失，文件却还在。
  // 台账的行由官方 tracker.mjs delete 处理（它带跨进程锁 + 原子替换 + 重建索引），
  // 本文件不自己改 applications.md —— markdown 始终是唯一事实来源。
  if (route === '/api/tracker/delete' && method === 'POST') {
    const body = await readBody(req);
    const num = String(body.num ?? '').trim();
    if (!/^\d+$/.test(num)) {
      throw Object.assign(new Error('缺少合法的台账行号'), {
        status: 400, hint: '需要 num 字段，且必须是数字（台账的 # 列）',
      });
    }

    const row = (await getTracker()).rows.find((r) => String(r.num).trim() === num);
    if (!row) {
      throw Object.assign(new Error(`台账里没有编号 ${num} 的记录`), { status: 404 });
    }

    const trash = await snapshotTracker();
    const r = await runNode(['tracker.mjs', 'delete', '--num', num], { timeoutMs: 60000 });
    if (r.code !== 0) {
      throw Object.assign(
        new Error('删除失败：' + (r.stderr || r.stdout || '命令没有返回原因').trim().slice(-300)),
        { status: 500, hint: '台账没有被改动；回收目录里的快照 ' + trash + ' 可以留着或删掉' },
      );
    }

    return sendJson(res, {
      ok: true,
      trash,
      removed: { num: row.num, company: row.company, role: row.role },
      tracker: await getTracker(),
    });
  }

  if (route === '/api/report/delete' && method === 'POST') {
    const body = await readBody(req);
    const name = reportNameFromCell(body.file) || String(body.file || '').trim();
    if (!REPORT_NAME_RE.test(name)) {
      throw Object.assign(new Error('文件名不合法'), {
        status: 400,
        hint: '报告文件名应以 .md 结尾且不含路径分隔符，实际收到：「' + name + '」',
      });
    }

    const full = path.join(SP().reports, name);
    if (!exists(full)) {
      throw Object.assign(new Error('报告不存在'), {
        status: 404, hint: 'reports\\' + name + ' 找不到，可能已经被删过了',
      });
    }

    // 报告和台账是同一件事的两面：删报告就把引用它的台账行一并删掉，
    // 不给台账留下点不开的死链（用户明确要这个语义）。
    const hits = (await getTracker()).rows
      .filter((r) => reportNameFromCell(r.report) === name);

    const trash = [];
    if (hits.length) trash.push(await snapshotTracker());
    trash.push(await moveToTrash(full, 'report'));

    const removedRows = [], failedRows = [];
    for (const row of hits) {
      // 行号不是纯数字（手改过台账）时 tracker.mjs 定位不了，如实报出来，不猜。
      if (!/^\d+$/.test(String(row.num).trim())) {
        failedRows.push({ num: row.num, message: '行号不是数字，请手工处理这一行' });
        continue;
      }
      const r = await runNode(['tracker.mjs', 'delete', '--num', String(row.num)], { timeoutMs: 60000 });
      if (r.code === 0) removedRows.push({ num: row.num, company: row.company, role: row.role });
      else failedRows.push({ num: row.num, message: (r.stderr || r.stdout || '').trim().slice(-200) });
    }

    return sendJson(res, {
      ok: true,
      trash,
      removedReport: name,
      removedRows,
      failedRows,
      tracker: await getTracker(),
    });
  }

  // ── AI 引擎与状态（页面上「引擎切换」按钮的数据源）────────────────────
  //
  // 一个接口把两条路的状态全查清楚，前端只读一份。拆成两个接口各查一半，
  // 最容易出的问题是「按钮显示可用，点下去说没有」——两处判断漂移了。
  async function aiStatus() {
    const cli = findAiCli();
    const cfg = readAiEngineCfg();
    // 本页要显示本地模型在不在线，所以这里必须真探一次（几十毫秒，不是 getStatus 那种汇总）
    const ollama = await probeOllama(cfg.ollama.base);
    const picked = pickEngine({
      choice: cfg.engine,
      cliAvailable: !!cli,
      ollamaAvailable: ollama.alive,
    });
    // auto 档的可用性要**单独算一次**：它问的是「假如现在改成自动，有没有引擎能跑」，
    // 跟「当前这一档能不能跑」是两个问题。
    // 用 picked 代替的后果实测过：选了本地模型而它离线时，auto 会被一起标成
    // 「不可用」，于是三个按钮全灰 —— 明明 CLI 好好的，用户会以为整个 AI 都坏了。
    const autoPick = pickEngine({
      choice: ENGINE_AUTO,
      cliAvailable: !!cli,
      ollamaAvailable: ollama.alive,
    });
    const profile = await getProfile();

    return {
      // 语义比原来更准：原来是「有 CLI 就算可用」，
      // 现在选了本地模型而服务没起时，它必须是 false，否则按钮点下去必然失败。
      available: picked.ok,
      choice: cfg.engine,
      // 模型档位（2026-10-12 提速引入）：页面上能看见当前用的是哪一档
      cliModel: cfg.cliModel || '',
      // auto 会在这里被解析成真正会去跑的那个引擎
      active: picked.engine,
      activeLabel: picked.engine === ENGINE_OLLAMA
        ? '本地模型 · ' + cfg.ollama.model
        : (picked.engine === ENGINE_CLI
          ? (cli?.label || 'CodeBuddy Code') + (cfg.cliModel ? ' · ' + cfg.cliModel : '')
          : ''),
      unavailableText: picked.ok ? '' : engineUnavailableText(picked.reason),
      // 会写文件 = 能做「完整评估」。前端拿它决定那个按钮禁用与否。
      writeCapable: canWriteFiles(picked.engine),
      writeBlockedText: writeBlockedText(),
      engines: ENGINE_CHOICES.map((c) => ({
        id: c.id, label: c.label, desc: c.desc,
        // auto 用 autoPick（「改成自动能不能跑」），其余两档看自己。
        available: c.id === ENGINE_AUTO
          ? autoPick.ok
          : (c.id === ENGINE_CLI ? !!cli : ollama.alive),
        // auto 自己没有「能不能写文件」——它取决于这次解析到了谁。
        // 直接套一张写死表会把 auto 报成「不能写」，把用户吓离默认档。
        writeCapable: c.id === ENGINE_AUTO
          ? canWriteFiles(autoPick.engine)
          : canWriteFiles(c.id),
      })),
      cli: cli ? cli.label : '',
      entry: cli ? cli.entry : '',
      cliAvailable: !!cli,
      ollama: {
        alive: ollama.alive,
        base: ollama.base,
        model: cfg.ollama.model,
        models: ollama.models,
        error: ollama.error || '',
      },
      port: AI_PORT_ENV || '每次现取空闲端口',
      threshold: profile.parsed?.pipeline?.triage_threshold ?? null,
      autoPdf: profile.parsed?.cv?.template ? (profile.parsed?.pipeline?.auto_pdf_score_threshold ?? null) : null,
    };
  }

  if (route === '/api/ai-status' && method === 'GET') {
    return sendJson(res, await aiStatus());
  }

  if (route === '/api/ai-engine' && method === 'GET') {
    return sendJson(res, await aiStatus());
  }

  // 切换引擎 / 改本地模型地址与模型名。
  if (route === '/api/ai-engine' && method === 'POST') {
    const body = await readBody(req);

    // 给了 engine 就必须是已知值。**不做静默纠正** ——
    // 把 'ollma' 悄悄改成 auto，用户会以为自己切到了本地模型，
    // 之后每次评估都莫名其妙走了 CLI，这种失败比报错难查得多。
    if (body.engine != null && !isKnownEngine(body.engine)) {
      throw Object.assign(
        new Error('未知的引擎：「' + String(body.engine).slice(0, 40) + '」。'
          + '可选值是 auto / cli / ollama。'),
        { status: 400 },
      );
    }
    if (body.base != null && typeof body.base !== 'string') {
      throw Object.assign(new Error('base 必须是字符串'), { status: 400 });
    }
    if (body.model != null && typeof body.model !== 'string') {
      throw Object.assign(new Error('model 必须是字符串'), { status: 400 });
    }

    const cur = readAiEngineCfg();
    const saved = writeAiEngineCfg({
      engine: body.engine != null ? body.engine : cur.engine,
      // 模型档位：界面上暂时没有这个控件，但**不能因为一次切引擎就把它抹掉**
      // （writeAiEngineCfg 是整份写回，不给值就等于写空）—— 2026-10-12
      cliModel: body.cliModel != null ? body.cliModel : cur.cliModel,
      ollama: {
        base: body.base != null ? body.base : cur.ollama.base,
        model: body.model != null ? body.model : cur.ollama.model,
      },
    });

    return sendJson(res, { ok: true, saved, status: await aiStatus() });
  }

  // 「测一下」——只测本地模型，不测 CLI。
  // 理由是速度：本地模型 1–2 秒就有回话，CLI 要几十秒才启动完，
  // 一个「测试」按钮让用户干等半分钟，用户只会以为它坏了。
  if (route === '/api/ai-engine/test' && method === 'POST') {
    const body = await readBody(req);
    const cfg = readAiEngineCfg();
    const base = body.base != null ? body.base : cfg.ollama.base;
    const model = body.model != null ? body.model : cfg.ollama.model;

    const probe = await probeOllama(base);
    if (!probe.alive) {
      return sendJson(res, {
        ok: false,
        error: '连不上 ' + probe.base + '（' + (probe.error || '服务没在跑') + '）。'
          + '先双击项目里的「启动Ollama.cmd」，再回来重试。',
        models: [],
      });
    }

    const r = await runOllamaOnce('只回复两个字：可用', { timeoutMs: 60000 });
    return sendJson(res, {
      ok: r.code === 0 && !!String(r.stdout || '').trim(),
      ms: r.ms,
      model: normalizeOllamaModel(model),
      base: probe.base,
      sample: String(r.stdout || '').trim().slice(0, 200),
      error: r.code === 0 ? '' : String(r.stderr || '').trim(),
      models: probe.models,
    });
  }

  if (route === '/api/eval' && method === 'POST') {
    const body = await readBody(req);

    const url = String(body.url || '').trim();
    const jd = String(body.jd || '').trim();
    // phase: 'triage' 只做初筛（快）· 'full' 出完整 A–H 报告（慢）
    const phase = body.phase === 'triage' ? 'triage' : 'full';

    // 至少要有一个来源，否则 AI 无从下手
    if (!url && !jd) {
      throw Object.assign(new Error('请提供岗位链接或 JD 正文'), { status: 400 });
    }
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
      throw Object.assign(new Error('岗位链接要以 http:// 或 https:// 开头'), { status: 400 });
    }
    // JD 正文长度上限，防止把超大文本塞进 prompt
    if (jd.length > 30000) {
      throw Object.assign(new Error('JD 正文过长（上限 3 万字符）'), { status: 400 });
    }

    // 简历来源（可选，优先级从高到低）：
    //   1. cvText —— 页面上传 / 粘贴的简历正文（评估页「上传你的简历」卡片），优先采用
    //   2. cvVersion ≠ base —— 「我的简历」里的某个版本
    //   3. 都没有 —— base = 根目录 cv.md，行为与从前一字不差。
    // 选了版本就用那一版的正文做匹配 —— 正文由服务端读好直接附进 prompt，
    // 版本 id 先过白名单（findVersionMeta → index.json），
    // 用户传什么都不可能变成任意文件读。
    const cvTextRaw = String(body.cvText || '').trim();
    let cvMeta = null;
    let cvContent = '';
    if (cvTextRaw) {
      // 上传正文与 JD 同一上限：异常大的文本直接拒，不静默截断
      if (cvTextRaw.length > 30000) {
        throw Object.assign(new Error('上传的简历过长（' + cvTextRaw.length + ' 字符，上限 3 万）'), { status: 400 });
      }
      // 伪版本元信息：只为让下游「简历正文附进 prompt」的既有链路原样生效
      // （triage/full 两段 prompt 和 runLocalFullEval 的 cvContent 参数共用），
      // 不为上传路径另写一份注入逻辑。id 仅用于响应回显，不参与文件查找。
      cvMeta = { id: 'upload', name: '上传的简历' };
      cvContent = cvTextRaw;
    } else {
      const cvVersionId = String(body.cvVersion || 'base').trim() || 'base';
      if (cvVersionId !== 'base') {
        cvMeta = await findVersionMeta(cvVersionId);
        if (!cvMeta || !cvMeta.exists) {
          throw Object.assign(new Error('没有这个简历版本（可能已被删除），请刷新页面后重新选择'), { status: 400 });
        }
        // 简历正文和 JD 同一上限：异常大的版本直接拒，不静默截断
        const raw = await readVersionMd(cvVersionId);
        if (raw.length > 30000) {
          throw Object.assign(new Error('这份简历版本过长（' + raw.length + ' 字符，上限 3 万）'), { status: 400 });
        }
        cvContent = raw;
      }
    }

    // 空简历守卫（2026-09-30）：新注册用户的数据空间里简历是空白的，
    // 直接开评只会产出「对着空简历硬编」的废报告。提前拦下，把人引去简历编辑页。
    // 上传正文（cvText）与指定版本（cvMeta）两条路不受影响 —— 那两份内容用户是给足了的。
    if (!cvMeta) {
      const baseCv = await readText(SP().cvMd);
      if (!baseCv.trim()) {
        throw Object.assign(
          new Error('简历还是空白的，先去「简历编辑」填写你自己的简历，再回来评估这个岗位'),
          { status: 400, needCv: true },
        );
      }
    }

    // 先确认这一次真有引擎能跑，并且它做得了这件事。
    // 2026-10-12 用户要求：**完整报告改用 CodeBuddy 生成**（质量优先）。
    //   · 完整报告（full）：优先 CodeBuddy；CLI 不可用（没装 / 登录态失效 /
    //     「刚失效过」的 5 分钟冷却期内）→ 回落本地编排版（runLocalFullEval
    //     服务端代写落盘，两条路都写得动盘；engineFellBack 会在响应里注明）。
    //   · 初筛（triage）：仍本地优先（20–30 秒、零成本、数据不出本机），
    //     本地不可用回落 CLI（2026-10-10 的口径不变）。
    const cliCooling = Date.now() - cliAuthDownAt < CLI_AUTH_DOWN_MS;
    let { picked } = phase === 'full'
      ? await resolveEngine({ force: cliCooling ? ENGINE_OLLAMA : ENGINE_CLI })
      : await resolveEngine({ force: ENGINE_OLLAMA });
    let engineFellBack = false;
    if (!picked.ok) {
      const alt = await resolveEngine({ force: phase === 'full' ? ENGINE_OLLAMA : ENGINE_CLI });
      if (alt.picked.ok) {
        picked = alt.picked;
        engineFellBack = true;
      }
    } else if (phase === 'full' && picked.engine === ENGINE_OLLAMA) {
      engineFellBack = true;   // 冷却期主动走的本地，也要让用户知道这份报告不是 CodeBuddy 写的
    }
    if (!picked.ok) {
      throw Object.assign(new Error(engineUnavailableText(picked.reason)), { status: 503 });
    }

    // 完整评估的产物是「报告文件 + 台账更新」，那是 agent 才做得到的事 ——
    // 本地模型看不到项目文件、也写不了盘。让它跑这一单，用户会等十分钟拿到
    // 一段漂亮但一个字节都没落盘的输出（3b 那段注释里踩过的正是这类坑，
    // 只是原因不同）。所以提前挡住，并说清换哪个选项能跑。
    if (phase === 'full' && !canWriteFiles(picked.engine)) {
      throw Object.assign(new Error(writeBlockedText()), { status: 409, needWriteEngine: true });
    }

    // ── 拼装 prompt ──────────────────────────────────────────────────
    // 分两阶段，原因是**速度实测差异巨大**：
    //   · 初筛（只读 _brief.md + _profile.md）：约 20–30 秒
    //   · 完整 A–H 报告（还要写 reports/ 与台账）：10 分钟以上，甚至超时
    // 所以页面先跑初筛给用户即时反馈，用户想深入时再单独触发完整评估。
    //
    // 速度提示（实测教训）：整仓规则约 17.6 万字符，其中 modes/oferta.md
    // 单独就有 8.2 万。让 AI 全读一遍再评估必然超时，所以显式限定阅读范围，
    // 并要求模板按需 grep、不要整份读入。
    //
    // 安全：prompt 完全由服务端拼装，前端只能传 url / jd / phase 三个值。
    const head = [];
    const tail = [];

    if (url) head.push('岗位链接：', url, '');
    if (jd) head.push('岗位描述（JD 正文，以此为准）：', '```', jd, '```', '');

    const srcBlock = head.join('\n');

    if (phase === 'triage') {
      tail.push(
        '这是一次**初筛**，不要写任何文件，也不要新建报告。',
        '',
        '【阅读范围】只读这两份，不要读其他文件：',
        '1. modes/_brief.md —— 初筛规则与硬门槛',
        '2. modes/_profile.md —— 本项目的中文招聘覆盖规则，**优先级最高**',
        '',
        '【硬性规则】门槛分 3.0（`pipeline.triage_threshold`），薪资不参与评分。',
        '',
        '【输出格式】严格按下面几行输出，不要写别的：',
        'SCORE: <总分，形如 3.8/5>',
        'VERDICT: <PASS 或 FAIL>',
        'TIER: <强匹配 或 值得投递 或 补投位 或 不建议投递>',
        'WHY: <一到两句话，说清为什么，含关键硬门槛的判定>',
        'DIMS: <6 个 0-100 的整数，逗号分隔，依次为：专业技能,项目经验,学历背景,软技能,行业经验,成果量化>',
        'GOOD: <优势匹配点，2~3 条，用中文分号「；」隔开，每条一句话>',
        'GAP: <能力短板，1~3 条，用中文分号「；」隔开>',
        'TIP: <简历优化建议，1~3 条，用中文分号「；」隔开>',
        '',
        '如果硬门槛没过（届次/学历/专业/城市/经验），VERDICT 写 FAIL 并在 WHY 里指出是哪一条。'
        + 'DIMS 里与硬门槛相关的维度（如学历背景）给低分，GOOD/GAP 里点出具体条目。',
      );
      if (cvMeta) {
        tail.push(
          '',
          '【简历】本次评估使用用户指定的简历版本「' + cvMeta.name + '」，正文附在本 prompt 末尾。',
          '技能 / 专业 / 届次等与简历内容相关的判定，一律以这一份为准。',
        );
      }
    } else {
      tail.push(
        '这是一次**完整评估**，需要写出报告文件。',
        '',
        '【阅读范围】按顺序读这几份，不要读其他文件：',
        '1. modes/_brief.md —— 先做初筛（门槛 3.0）与硬门槛检查',
        '2. modes/_shared.md —— 评估框架与维度定义',
        '3. modes/_profile.md —— 本项目的中文招聘覆盖规则，**优先级最高**',
        '4. modes/_custom.md —— 持久化指令',
        (cvMeta
          ? '5. 候选人简历 —— **已附在本 prompt 末尾**（用户指定版本「' + cvMeta.name + '」），用它做匹配，不要读根目录 cv.md'
          : '5. cv.md —— 候选人简历（算匹配度用）'),
        '',
        '**不要通读 modes/oferta.md 全文（8 万字符，会拖垮速度）。**',
        '需要其中的模板段落时，用 grep 定位小节后按需读取——',
        '**中文报告骨架在 `modes/zh/oferta.md` 末尾的报告模板**，照那份抄。',
        '',
        '【硬性规则】严格遵守 _profile.md 的覆盖规则：门槛分 3.0，薪资不参与评分。',
        '',
        '【产出要求：写成中文文档】标题、小标题、正文都中文，细则见',
        '`modes/_profile.md`【覆盖规则 8】。以下东西**必须保持英文原样**，',
        '程序按字面解析，翻译了会被静默丢弃：',
        '- 报告头六个字段**标签**：`**Date:**` `**URL:**` `**Archetype:**` `**Score:** X.X/5`',
        '  `**Legitimacy:**` `**PDF:**`（**字段的值**可以中文，如「谨慎推进」「后端开发」）',
        '- `## Risk Summary`（位置：`## G)` 之后、`## H)` 之前）',
        '- `## H) Draft Application Answers`（**这一行的字照抄英文** ——',
        '  `application-answers.mjs --read-draft` 逐字匹配它，翻了这个功能就静默失效）',
        '- `## Job Description (archived verbatim)`，原文粘回 JD，**放在报告最后一段**',
        '- 小标题的**字母序号**，字母后写中文：`## A) 岗位概览`、`## B) 简历匹配分析`、',
        '  `## C) 级别判断与求职策略`、`## D) 薪酬竞争力与市场需求`、`## E) 针对性定制方案`、',
        '  `## F) 面试备考计划`、`## G) 职位真实性评估`',
        '  标题写 `# 评估报告：{公司} — {职位}`，**不要写 `# Evaluation:`**',
        '  （附属段落：`## Keywords extracted` → `## ATS 关键词提取`、',
        '  `## Cover Letter Draft` → `## 求职信草稿`）',
        '- `## 求职信草稿` **要么写满、要么整段不写**：不许留 {xxx} 花括号占位、',
        '  `(placeholder)` 标注或「To be completed」待办 —— 写不出内容就删掉这一节，别留空壳',
        '- 行文按中文习惯：结论先行、先给动作再给分析、每句判定挂证据（引自 JD 或简历），',
        '  没有证据就直说「简历里没写，建议补一条 XX 经历」；同一句套话整份报告最多出现一次',
        '- 报告写入 `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`，编号取现有最大编号 +1',
        '- **报告正文用一次 Write 调用写完**（别分多次追加、也别反复重读同一份文件）——',
        '  实测每次额外往返都要多等十几秒，这是这份报告能不能十分钟内跑完的关键',
        '- 同时更新 `data/applications.md` 台账（用 merge-tracker.mjs，不要手写表格）',
        '',
        '【报告开头必须先给一块「摘要」（2026-10-12 新增）】',
        '结论段之后、`## A)` 之前，按下面的顺序与标题名写四小节 ——',
        '网页端的「报告详情」直接读它们渲染匹配卡，标题名写错就整块读不到：',
        '',
        '### 六维评分',
        '| 维度 | 分 |',
        '|------|-----|',
        '| 专业技能 | 0-100 整数 |',
        '| 项目经验 | 0-100 整数 |',
        '| 学历背景 | 0-100 整数 |',
        '| 软技能 | 0-100 整数 |',
        '| 行业经验 | 0-100 整数 |',
        '| 成果量化 | 0-100 整数 |',
        '（六个维度名与顺序照抄，不要改名、不要增减；0-100 是**整数**，不是 5 分制）',
        '',
        '### 优势匹配点',
        '2–4 条，每条一句话，写「JD 要什么 + 简历里哪条事实顶上」',
        '### 能力短板',
        '2–4 条，每条一句话，写「缺什么 + 落在 JD 哪一条要求上」',
        '### 简历优化建议',
        '2–4 条，每条写成可直接落到简历某一行的动作',
        '',
        '硬门槛没过（按覆盖规则 3 不给分）时：六维评分一节**整节不写**，',
        '三组里「优势匹配点」可省略，但「能力短板 / 简历优化建议」必须写。',
        '',
        '【最后】**用不超过 10 行**总结：公司、岗位、总分、是否过门槛（3.0）、投还是不投。',
        '不要在总结里复述整份报告。',
      );
    }

    // 选了「我的简历」里的某一版：正文直接附进 prompt。CLI 引擎按上面的阅读
    // 范围说明用这一份、不再读 cv.md；本地引擎的简历内容也走这一份
    // （runLocalFullEval 的 cvContent 参数）。不选 = base，prompt 与从前一字不差。
    if (cvMeta) {
      tail.push(
        '',
        '────────────────────────',
        '【候选人简历（版本：' + cvMeta.name + '）】',
        '```',
        cvContent,
        '```',
      );
    }

    // 完整评估的产出是「报告文件落盘」，不是「AI 说了什么」。
    // 踩过的坑：无头模式写权限被拦，AI 一个字节没写却礼貌地回了完整结论，
    // 响应还是 ok:true——页面显示成功，reports/ 里空空如也。
    // 所以前后各快照一次目录，用「文件真的变了」来判定成败，别信 AI 的自述。
    const snapReports = async () => {
      // 快照**当前请求的数据空间**的 reports/ —— 新用户的评估看的是自己的目录
      const dir = SP().reports;
      const map = new Map();
      try {
        for (const f of await fsp.readdir(dir)) {
          if (!f.endsWith('.md')) continue;
          try { map.set(f, (await fsp.stat(path.join(dir, f))).mtimeMs); } catch { /* 单个文件读不到就跳 */ }
        }
      } catch { /* reports/ 不存在，按空处理 */ }
      return map;
    };

    const before = phase === 'full' ? await snapReports() : null;

    // 本地模型的完整评估走**服务端编排**（runLocalFullEval：读规则进 prompt、
    // 解析回复、代码落盘），在 runAi() 之前分叉；响应结构保持同形，
    // 前端不用知道这次报告是谁写的 —— 它只看「reports/ 里真的多了文件」。
    const useLocalFull = phase === 'full' && picked.engine === ENGINE_OLLAMA;
    const r = useLocalFull
      ? await runLocalFullEval({ jd, url, timeoutMs: 1800000, cvContent: cvMeta ? cvContent : undefined })
      : await runAi(srcBlock + tail.join('\n'), {
          // 完整评估要落盘（报告 + 台账），必须放开写权限；初筛不写文件，保持受限
          timeoutMs: phase === 'triage' ? 300000 : 1800000,
          // ⚠️ 校验过的引擎**必须透传**（2026-10-10 踩到）：不传的话 runAiOnce
          //    会再读一次全局配置 —— 上面锁本地、判回落全白做。实测现象：
          //    engine=ollama 判定通过、Ollama 也活着，实际却跑到了 CodeBuddy，
          //    登录态正好过期，5 秒就回一句「请重新登录」。这正是别处注释里
          //    写过的那条坑（「engine 必须能透传」），这里当时漏了。
          engine: picked.engine,
          bypass: phase === 'full',
        });

    // 新增的、或被重写的报告文件都算数（同一天重跑同名岗位会走「重写」分支）
    let newReports = [];
    if (phase === 'full') {
      const after = await snapReports();
      newReports = [...after]
        .filter(([f, m]) => !before.has(f) || m > before.get(f))
        .map(([f]) => f)
        .sort();
    }

    // CLI 静默返回空有好几种原因，得分开说，否则用户看到一片空白不知从哪下手
    const out = (r.stdout || '').trim();
    const err = (r.stderr || '').trim();
    const wroteReport = phase !== 'full' || newReports.length > 0;

    let friendly = '';
    if (r.authFailed) {
      // 登录态过期放最前（2026-09-28）：确定性的失败不进「瞬时故障」分支
      friendly = 'CodeBuddy 的登录态过期了。双击项目根目录的「登录CodeBuddy.cmd」，'
        + '在弹出的浏览器里完成登录，然后回来重试。';
    } else if (r.code === 0 && !out) {
      if (r.retried) {
        friendly = 'AI 命令行连续两次都空返回（换端口重试过）。'
          + '通常是瞬时故障：稍等十几秒再点一次。'
          + '若反复出现，双击「登录CodeBuddy.cmd」确认能正常对话。';
      } else if (/authentication required|please.*login|not logged in/i.test(err)) {
        friendly = 'AI 命令行报告未登录，但这类报错也可能是端口冲突的误报。'
          + '双击项目根目录的「登录CodeBuddy.cmd」重新登录，然后刷新本页重试。';
      } else if (err.includes('EADDRINUSE')) {
        friendly = 'AI 命令行绑不上端口。已改为每次现取空闲端口，重启控制台后再试。';
      } else {
        friendly = 'AI 命令行没有返回任何内容。请确认已登录（双击「登录CodeBuddy.cmd」完成登录）。';
      }
    } else if (r.timeout) {
      friendly = phase === 'triage'
        ? '初筛超时（5 分钟）。模型响应慢，稍后重试；也可以改用终端跑。'
        : '完整评估超时（30 分钟）。这是最耗时的模式——可以先用「只做初筛」拿到分数，'
          + '或改用终端跑（不受此限制）。';
    } else if (!wroteReport) {
      // 跑完了、也有输出，但报告没落盘——这才是最难发现的一种失败
      friendly = r.localEval && r.localEval.reason
        ? '本地模型跑完了，但这一单没落盘：' + r.localEval.reason
          + '。多半是模型没按格式给分（这是 7B 的老毛病），原始输出在下方，'
          + '正文里的评分通常还在，人工也能取。'
        : 'AI 跑完了但没写出报告文件。多半是写文件的权限被拦住了。'
          + '控制台已默认放开（-y）；若仍失败，检查 AI CLI 是否可用 Write / Bash，'
          + '或直接用终端跑这一单。';
    }

    // 初筛阶段解析出结构化字段，前端不用正则猜。
    // 解析逻辑单独放在 eval-parse.mjs——它是链路里最脆弱的一环，
    // 而且坏掉时是「静默降级」（分数有、理由没了），必须有回归测试兜着。
    const triage = phase === 'triage' && out ? parseTriage(out) : null;

    return sendJson(res, {
      ok: r.code === 0 && !!out && wroteReport,
      phase, cli: r.cli, ms: r.ms, code: r.code, timeout: !!r.timeout,
      retried: !!r.retried, newReports, wroteReport,
      // 这次实际用了哪个引擎（triage 本地不可用会回落 CLI，前端据此提示）
      engine: picked.engine, engineFellBack,
      // 这次评估用了哪份简历（null = 原版 cv.md）。前端拿它回显，不自己猜。
      cvVersion: cvMeta ? { id: cvMeta.id, name: cvMeta.name } : null,
      // 本地编排的元信息（分数从哪种格式解析出来 / 报告文件名 / token 用量）。
      // CLI 路径没有这个字段，前端按「有就显示」处理。
      localEval: r.localEval || null,
      output: out, stderr: err, friendly, triage,
    });
  }

  // ── 求职信（只出稿，不落盘）────────────────────────────────────────────
  // 与「简历优化」同一条规矩：AI 只出稿，写文件永远由用户显式决定。
  // 规则来源是系统层的 modes/cover.md，这里只读不改。
  if (route === '/api/cover' && method === 'POST') {
    const body = await readBody(req);

    const jd = String(body.jd || '').trim();
    if (!jd) {
      throw Object.assign(
        new Error('需要 JD 正文。求职信必须贴着岗位写——没有 JD 只能写出通用信，'
          + '而通用信在国内校招里基本等于减分项。请先把这个岗位的 JD 粘进来。'),
        { status: 400 },
      );
    }
    if (jd.length > 30000) {
      throw Object.assign(new Error('JD 正文过长（上限 3 万字符）'), { status: 400 });
    }

    // 简历版本：与 /api/eval、/api/cv/optimize 共用 target 语义（base = cv.md）
    const target = String(body.target || 'base').trim() || 'base';
    let cvMd = '';
    let cvLabel = '原版 cv.md';
    if (target === 'base') {
      cvMd = await readText(SP().cvMd);
    } else {
      const meta = await findVersionMeta(target);
      if (!meta) {
        throw Object.assign(new Error('这个简历版本不存在，可能已经被删掉了'), {
          status: 404, hint: '回「我的简历」刷新一下版本列表。',
        });
      }
      cvMd = await readVersionMd(target);
      cvLabel = '版本「' + meta.name + '」';
    }
    if (!cvMd.trim()) {
      throw Object.assign(new Error(cvLabel + ' 还是空的，先去「我的简历」把内容填上'), { status: 400 });
    }
    if (cvMd.length > 60000) {
      throw Object.assign(new Error(cvLabel + ' 过长（超过 6 万字符），请先精简'), { status: 400 });
    }

    // 求职信是**只读任务**（只出文本，没有写回这一步），本地模型完全做得了。
    const { picked } = await resolveEngine();
    if (!picked.ok) {
      throw Object.assign(new Error(engineUnavailableText(picked.reason)), { status: 503 });
    }

    // 规则文件读不到就别硬跑：没有规则约束的求职信正是要避免的东西
    let coverRules = '';
    try { coverRules = (await readText(path.join(ROOT, 'modes', 'cover.md'))).trim(); }
    catch { /* 下面统一报错 */ }
    if (!coverRules) {
      throw Object.assign(
        new Error('读不到 modes/cover.md（求职信规则文件），不能保证生成质量，已中止'),
        { status: 500 },
      );
    }

    const prompt = buildCoverPrompt({
      coverRules,
      cvMd,
      jd,
      company: cleanInline(body.company, 60),
      role: cleanInline(body.role, 60),
      cvLabel,
      question: String(body.question || '').replace(/\r\n/g, '\n').trim().slice(0, 1000),
    });

    // 只读任务：不放开写权限（AI 就算想写也会被拦下）
    const r = await runAi(prompt, { timeoutMs: 600000, bypass: false });

    const out = (r.stdout || '').trim();
    const err = (r.stderr || '').trim();
    let friendly = '';
    if (r.authFailed) {
      friendly = 'CodeBuddy 的登录态过期了。双击项目根目录的「登录CodeBuddy.cmd」，'
        + '在弹出的浏览器里完成登录，然后回来重试。';
    } else if (r.code === 0 && !out) {
      friendly = r.retried
        ? 'AI 命令行连续两次都空返回（换端口重试过）。通常是瞬时故障：等十几秒再点一次。'
        : 'AI 命令行没有返回任何内容。请确认已登录（双击「登录CodeBuddy.cmd」完成登录）。';
    } else if (r.timeout) {
      friendly = '生成超时（10 分钟）。本地模型写这种长文会明显变慢，'
        + '可以把 JD 删短一点（去掉福利、公司介绍），或者切到 CodeBuddy 再试。';
    } else if (/authentication required|please.*login|not logged in/i.test(err)) {
      friendly = 'AI 命令行报告未登录，但这类报错也可能是端口冲突的误报。'
        + '双击项目根目录的「登录CodeBuddy.cmd」重新登录，然后重试。';
    }

    return sendJson(res, {
      ok: r.code === 0 && !!out,
      code: r.code, ms: r.ms, cli: r.cli, timeout: !!r.timeout, retried: !!r.retried,
      output: out, stderr: err, friendly, cvLabel,
    });
  }

  // ── 面试备考建议：生成（AI 优先，本地规则兜底）────────────────────────
  //
  // 与评估链路的关键区别：**这个功能不写盘**。
  //   · 不必放开 AI 的写权限（bypass:false）—— 它只回文本，落盘交给浏览器下载
  //   · 本地模型（纯文本模型）同样做得了，所以不需要 409「引擎不能写文件」拦截
  //   · 引擎两条路都不通时**也不报错**，降级到本地规则版并如实标注（需求确认过）
  //
  // 这样「AI 不可用就完全用不了」不会发生 —— 而这一点很重要：
  // 备考建议是给「已经拿到评估报告、准备去面」的人用的，卡在引擎上最不划算。
  if (route === '/api/prep/generate' && method === 'POST') {
    const body = await readBody(req);

    const file = String(body.file || '').trim();
    if (!REPORT_NAME_RE.test(file)) {
      throw Object.assign(new Error('文件名不合法'), {
        status: 400,
        hint: '备考建议要绑定一份评估报告，报告名应以 .md 结尾且不含路径分隔符，实际收到：「' + file + '」',
      });
    }
    const full = path.join(SP().reports, file);
    if (!exists(full)) {
      throw Object.assign(new Error('这份报告不存在，可能已被删除'), {
        status: 404, hint: '回「评估报告」页刷新一下列表。',
      });
    }

    const md = await readText(full);
    const meta = (await listReports()).find((x) => x.file === file) || { file };
    const cvText = await readText(SP().cvMd);
    // 简历正文一并传进去：报告里没写 Gaps 时由解析器现推（见 prep-model.mjs 形状⑥）
    const report = parseReportForPrep(md, meta, cvText);

    // 数据缺失 → 明确提示，不硬跑。跑出来也是「因为没有简历所以全是短板」的废话。
    const diag = diagnoseInputs({ report, cvText });
    if (!diag.ok) {
      throw Object.assign(new Error(diag.hint), {
        status: 400,
        // 结构化带上缺哪几样，前端渲染成清单而不是塞在一句话里
        missing: diag.missing,
        reason: diag.reason,
        needCv: diag.reason === MISSING_REASONS.NO_CV || diag.reason === MISSING_REASONS.NO_CV_CONTENT,
      });
    }

    // 生成方式：用户没指定就 auto（能用 AI 就用 AI）。
    // 显式选 local = 强制走规则版（零 token，用于对比或离线）。
    // want === 'local' 时不去探测引擎 —— 探测要等超时，而这次根本不用它。
    const want = String(body.engine || 'auto').trim().toLowerCase();
    const picked = want === 'local' ? { ok: false, reason: 'explicit-local' } : (await resolveEngine()).picked;

    let source = 'local';
    let parsed = null;
    let raw = '';
    let engineLabel = '';
    let fallbackNote = '';

    if (picked.ok) {
      const prompt = buildPrepPrompt({
        report, cvText,
        profile: await readText(PATHS.profile),
      });
      // 备考建议是纯文本任务（不写盘），所以走 runAi 的默认受限模式。
      // 超时给 15 分钟：比求职信长，因为它要输出三大段、篇幅差不多翻倍。
      const r = picked.engine === ENGINE_OLLAMA
        ? await runOllamaOnce(prompt, { timeoutMs: 900000 })
        : await runAi(prompt, { timeoutMs: 900000, bypass: false });

      raw = String(r.stdout || '').trim();
      const err = String(r.stderr || '').trim();
      engineLabel = r.cli || '';

      parsed = raw ? parsePrepOutput(raw) : null;

      if (raw && prepOutputUsable(parsed)) {
        source = 'ai';
      } else {
        // AI 跑通了但没给出可用的三部分 → 降级，并**说清为什么降级**。
        // 不这么判的话，模型回一句「好的，我来分析」就会被当成成功。
        fallbackNote = raw
          ? prepUnusableReason(parsed) + ' 下面这版改用本地规则生成，结论直接来自报告里的差距项。'
          : (r.timeout
            ? 'AI 超时了（15 分钟）。下面这版改用本地规则生成。'
            : (err
              ? 'AI 没有返回内容：' + err.slice(0, 200) + '。下面这版改用本地规则生成。'
              : 'AI 没有返回内容。下面这版改用本地规则生成。'));
        parsed = null;
      }
    } else if (want === 'local') {
      fallbackNote = '你选了「本地规则版」——零 token、不联网，结论直接来自评估报告里的差距项，'
        + '再配上本机内置的资源词典。';
    } else {
      fallbackNote = engineUnavailableText(picked.reason)
        + ' 下面这版改用本地规则生成，等引擎可用后重新生成会更贴合你的简历。';
    }

    if (!parsed) {
      parsed = buildLocalFallback({ report, cvText });
      source = 'local';
    }

    const markdown = buildPrepMarkdown({
      report, parsed, source, generatedAt: localToday() + ' ' + new Date().toTimeString().slice(0, 5),
    });

    // ── 历史留存（2026-10-12 用户要求：生成过的提升计划要能留下来）──────
    // 一个岗位一份，同岗位重新生成直接覆盖。写盘失败**不拦着出稿** ——
    // 计划内容已经在响应里，用户这一趟没白跑；下次生成会再试一次。
    let planMeta = null;
    try {
      planMeta = await savePrepPlan({
        file: report.file,
        title: report.title,
        score: report.score,
        archetype: report.archetype,
        source,
        requirementCount: report.requirements.length,
        engineLabel,
        fallbackNote: fallbackNote || '',
        warn: diag.reason === MISSING_REASONS.NO_GAPS ? diag.hint : '',
        parsed,
        markdown,
      });
    } catch (err) {
      console.warn('[prep] 计划保存失败（不影响本次出稿）：', err && err.message);
    }

    return sendJson(res, {
      ok: true,
      source,
      file: report.file,
      title: report.title,
      score: report.score,
      archetype: report.archetype,
      // 解析出来的原料：前端要显示「依据了哪几条差距」，让结论可追溯
      gapsFromReport: report.gaps,
      requirementCount: report.requirements.length,
      parsed,
      markdown,
      // AI 原样输出只在降级时回传（那时用户可能想自己看看模型到底回了什么）。
      // 成功时不传：那份原文有几十 KB，塞进响应纯属浪费。
      raw: source === 'ai' ? '' : raw,
      engineLabel,
      fallbackNote: fallbackNote || '',
      warn: diag.reason === MISSING_REASONS.NO_GAPS ? diag.hint : '',
      plan: planMeta,          // 刚保存的这一份（null = 保存失败）；前端据此更新历史列表
    });
  }

  // ── 提升计划历史（2026-10-12）──────────────────────────────────────────
  // 列表 / 读一份 / 删一份。删除 = 移 data/trash/（moveToTrash 的既有口径），
  // 评估报告本身不动 —— 报告是「尺子」，计划是「按尺子算出来的作业」。
  if (route === '/api/prep/history' && method === 'GET') {
    const items = await listPrepPlans();
    return sendJson(res, { ok: true, items, dir: path.relative(ROOT, SP().prep).split(path.sep).join('/') });
  }

  if (route === '/api/prep/history/content' && method === 'GET') {
    const file = String(url.searchParams.get('file') || '').trim();
    if (!REPORT_NAME_RE.test(file)) {
      throw Object.assign(new Error('文件名不合法'), { status: 400 });
    }
    const plan = await readPrepPlan(file);
    if (!plan) {
      throw Object.assign(new Error('这份提升计划不存在，可能已经被删掉了'), {
        status: 404, hint: '回「提升计划」页刷新一下列表。',
      });
    }
    return sendJson(res, plan);
  }

  if (route === '/api/prep/history/delete' && method === 'POST') {
    const body = await readBody(req);
    const file = String(body.file || '').trim();
    if (!REPORT_NAME_RE.test(file)) {
      throw Object.assign(new Error('文件名不合法'), { status: 400 });
    }
    const full = prepPlanPath(file);
    if (!exists(full)) {
      throw Object.assign(new Error('这份提升计划不存在，可能已经被删掉了'), { status: 404 });
    }
    const trashPath = await moveToTrash(full, 'prep');
    return sendJson(res, { ok: true, trash: trashPath, removed: file });
  }

  if (route === '/api/run' && method === 'POST') {
    const body = await readBody(req);
    const key = String(body.key || '');
    const entry = SCRIPTS[key];
    if (!entry) throw Object.assign(new Error('不在白名单中的脚本'), { status: 400 });

    // ── 安全传参 ─────────────────────────────────────────────────────
    // 只有 entry.params 里显式声明的参数才会被接受；每个值都必须完全
    // 匹配该参数自己的 pattern 正则，否则直接拒绝。shell 永远不参与，
    // 参数以数组形式交给 spawn，因此不存在命令注入面。
    const args = [...entry.args];
    const given = (body.params && typeof body.params === 'object') ? body.params : {};

    for (const spec of entry.params || []) {
      const raw = given[spec.name];
      let val = raw === undefined || raw === null ? '' : String(raw).trim();

      if (!val) {
        if (spec.default !== undefined) { val = String(spec.default); }
        else if (spec.required) {
          throw Object.assign(new Error(`缺少必填参数：${spec.label || spec.name}`), { status: 400 });
        } else { continue; }
      }

      if (spec.pattern) {
        const re = new RegExp(spec.pattern);
        if (!re.test(val)) {
          throw Object.assign(
            new Error(`参数「${spec.label || spec.name}」格式不合法`),
            { status: 400 },
          );
        }
      }

      if (spec.flag) args.push(spec.flag);
      // 一个值可能代表多个以空格分隔的条目（如 liveness 的多个 URL）
      if (spec.multi) args.push(...val.split(/\s+/).filter(Boolean));
      else args.push(val);
    }

    // 记录实际执行的参数（便于前端展示与排查，不含任何请求头信息）
    const r = await runNode(args, { timeoutMs: entry.slow ? 600000 : 180000 });
    return sendJson(res, {
      ok: r.code === 0, label: entry.label, invoked: args.join(' '), ...r,
    });
  }

  if (route === '/api/pdf' && method === 'POST') {
    const body = await readBody(req);

    // 导出哪一份？默认原版 cv.md，也可以指定某个岗位版本。
    // 版本简历不进 cv-form.json（那是 cv.md 的派生缓存），所以这里直接
    // 由 Markdown 现解析成表单 —— 保证「导出的就是这一版的内容」。
    const versionId = String(body.version || 'base').trim() || 'base';
    let cvForm;
    let versionMeta = null;
    let fileTag = '';
    if (versionId === 'base') {
      cvForm = (await getCv()).form;
    } else {
      versionMeta = await findVersionMeta(versionId);
      if (!versionMeta) {
        throw Object.assign(new Error('这个简历版本不存在，可能已经被删掉了'), {
          status: 404, hint: '回「我的简历」刷新一下版本列表。',
        });
      }
      const md = await readVersionMd(versionId);
      if (!md.trim()) throw Object.assign(new Error('这个版本是空的，没有内容可导出'), { status: 400 });
      cvForm = markdownToCv(md);
      fileTag = '-' + safeSlug(versionMeta.name, 18);
    }

    const profile = await getProfile();

    const templateName = String(body.template || (profile.parsed?.cv?.template || '')).trim();
    const lang = String(body.lang || profile.parsed?.language?.output || 'zh-CN').trim();
    const pageFormat = String(body.page_format || 'a4').toLowerCase();
    const maxPages = Math.min(Math.max(Number(body.max_pages) || 2, 1), 4);
    const stamp = new Date().toISOString().slice(0, 10);

    await fsp.mkdir(PATHS.output, { recursive: true });

    // 1. 结构化简历 → payload
    //    中文输出（profile.language.output 以 zh 开头）时套一层中文版式：
    //    章节标题换成中文、项目要点按行分段。换成别的输出语言就原样保持
    //    上游模板的行为，不做任何中文改写。
    const zhLayout = /^zh/i.test(lang);
    let payload = cvToPayload(cvForm, { lang, page_format: pageFormat });
    if (zhLayout) payload = prepareZhCvPayload(payload);
    if (!payload.experience.length && !payload.projects.length) {
      throw Object.assign(new Error('简历里还没有经历或项目，先生成内容再导出 PDF'), { status: 400 });
    }

    // 文件名带上版本名：同一版不同岗位各导一份时不会互相覆盖，
    // output/ 里一眼能看出哪份是投哪个岗位的。
    const payloadPath = path.join(PATHS.output, `.cv-payload-${stamp}${fileTag}.json`);
    const htmlPath = path.join(PATHS.output, `cv${fileTag}-${stamp}.html`);
    const pdfPath = path.join(PATHS.output, `cv${fileTag}-${stamp}.pdf`);

    await fsp.writeFile(payloadPath, JSON.stringify(payload, null, 2), 'utf8');

    // 2. 解析模板路径（对齐 config/profile.yml → cv.template）
    let templatePath = path.join(PATHS.templates, 'cv-template.html');
    if (templateName) {
      const candidate = path.join(PATHS.templates, `cv-template.${templateName}.html`);
      if (exists(candidate)) templatePath = candidate;
      else return sendJson(res, {
        ok: false,
        error: `找不到模板 templates/cv-template.${templateName}.html`,
        hint: '可用模板：' + (await fsp.readdir(PATHS.templates))
          .filter((f) => /^cv-template\..+\.html$/.test(f))
          .map((f) => f.replace(/^cv-template\./, '').replace(/\.html$/, '')).join(', '),
      }, 400);
    }

    // 3. payload → HTML
    const b = await runNode(['build-cv-html.mjs', payloadPath, htmlPath, templatePath], { timeoutMs: 60000 });
    if (b.code !== 0 || !exists(htmlPath)) {
      return sendJson(res, { ok: false, stage: 'html', error: (b.stderr || b.stdout || '').trim().slice(-3000) }, 500);
    }

    // 3.5 中文版式：章节按国内应届惯例重排 + 注入排版覆盖样式。
    //     必须夹在「生成 HTML」和「转 PDF」之间 —— generate-pdf.mjs 只负责把
    //     HTML 打成 PDF，到那一步顺序和样式已经定死在 HTML 里了。
    //     放在这里而不是改 templates/：模板属于系统层，会被 update-system.mjs 还原。
    if (zhLayout) {
      const htmlRaw = await fsp.readFile(htmlPath, 'utf8');
      await fsp.writeFile(htmlPath, applyZhCvLayout(htmlRaw), 'utf8');
    }

    // 4. HTML → PDF
    //    --allow-reorder：这里的 HTML 由结构化表单生成，与 cv.md 的章节顺序
    //    可能不同（中文版式还会再重排一次，把教育背景提到项目前面）。
    //    把顺序守卫降级为警告，否则会直接抛错。
    const p = await runNode(
      ['generate-pdf.mjs', htmlPath, pdfPath, `--format=${pageFormat}`, `--max-pages=${maxPages}`, '--allow-reorder'],
      { timeoutMs: 180000 },
    );
    if (p.code !== 0 || !exists(pdfPath)) {
      return sendJson(res, { ok: false, stage: 'pdf', error: (p.stderr || p.stdout || '').trim().slice(-3000) }, 500);
    }

    const st = await fsp.stat(pdfPath);
    return sendJson(res, {
      ok: true,
      file: path.basename(pdfPath),
      html: path.basename(htmlPath),
      size: st.size,
      template: path.basename(templatePath),
      version: versionId,
      versionName: versionMeta ? versionMeta.name : '原版简历',
      stdout: (b.stdout || '') + (p.stdout || ''),
    });
  }

  // PDF 导出：**与实时预览完全一致**（2026-10-11，用户反馈「导出的简历不是预览的模板」）。
  //
  // 原来的 /api/pdf 读的是 cv.md + templates/cv-template.*.html —— 那是**另一套版式**，
  // 跟编辑器右侧的实时预览（色系 3 套 / 稳重 10 套 / 双栏 1 套，全是前端 HTML 渲染）
  // 没有任何关系，用户选了「稳重03」导出却得到另一份版式，就是这个原因。
  //
  // 这里改走「所见即所得」：前端把预览节点的 HTML + 整页样式一起发过来，服务端只负责
  // 用 Chromium 打成 PDF。不再二次排版，所以不存在「对不上」的可能。
  if (route === '/api/cv/pdf-live' && method === 'POST') {
    const body = await readBody(req);
    const html = String(body.html || '');
    if (html.length < 200) {
      throw Object.assign(new Error('没有收到预览内容，无法导出'), { status: 400 });
    }
    if (html.length > 8 * 1024 * 1024) {
      throw Object.assign(new Error('预览内容过大（超过 8MB），请先精简简历'), { status: 413 });
    }
    const pageFormat = String(body.page_format || 'a4').toLowerCase() === 'letter' ? 'letter' : 'a4';
    const name = safeSlug(String(body.name || '简历'), 24) || '简历';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await fsp.mkdir(PATHS.output, { recursive: true });
    // 打印用的 HTML 放**子目录**：/api/outputs 会把 output/ 下所有 .pdf/.html
    // 列给用户看（「最近输出」），中间产物混进去就是垃圾条目。
    const printDir = path.join(PATHS.output, 'cv-print');
    await fsp.mkdir(printDir, { recursive: true });
    const htmlPath = path.join(printDir, `cv-preview-${stamp}.html`);
    const pdfPath = path.join(PATHS.output, `cv-${name}-${stamp.slice(0, 10)}.pdf`);
    await fsp.writeFile(htmlPath, html, 'utf8');
    // --skip-fact-check：这份 HTML 是前端渲染结果，没有 cv.md 可比对；
    // --allow-reorder：章节顺序由用户拖拽决定，不该被守卫拦下。
    const p = await runNode(
      ['generate-pdf.mjs', htmlPath, pdfPath, `--format=${pageFormat}`,
        '--max-pages=4', '--allow-reorder', '--skip-fact-check'],
      { timeoutMs: 180000 },
    );
    if (p.code !== 0 || !exists(pdfPath)) {
      return sendJson(res, { ok: false, stage: 'pdf', error: (p.stderr || p.stdout || '').trim().slice(-2000) }, 500);
    }
    const st = await fsp.stat(pdfPath);
    return sendJson(res, {
      ok: true,
      file: path.basename(pdfPath),
      html: path.basename(htmlPath),
      size: st.size,
      mode: 'live',
      stdout: (p.stdout || '').trim(),
    });
  }

  throw Object.assign(new Error('未知的接口：' + route), { status: 404 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      // 每个请求绑定所属数据空间：注册用户（有独立目录）读写自己的
      // cv.md / reports/ / cv-versions/；种子演示账号与未登录请求回落全局。
      // AsyncLocalStorage 会把空间带到整个 await 链（评估落盘、版本读写都算）。
      const s = getSession(req, url);
      return await USER_SPACE.run(userSpace(s && s.username), () => handleApi(req, res, url));
    }

    const hit = STATIC[url.pathname];
    if (hit) {
      const full = path.join(__dirname, hit[0]);
      if (!exists(full)) return sendText(res, '缺少前端文件 ' + hit[0], 'text/plain; charset=utf-8', 500);
      const buf = await fsp.readFile(full);
      res.writeHead(200, { 'Content-Type': hit[1], 'Cache-Control': 'no-store' });
      return res.end(buf);
    }

    // 「稳重」系列模板的原始 HTML（2026-10-09）。走通配而不是 STATIC 精确表 ——
    // 文件名是中文、还带数字前缀，逐条登记既啰嗦又容易漏。
    // ⚠️ 路径穿越防护：只允许**一层**文件名 + .html，
    //    不含 / \ .. 与任何分隔符 —— 这个前缀下再拼 ../ 就直接 404。
    if (url.pathname.startsWith('/tpl-wz/')) {
      const raw = decodeURIComponent(url.pathname.slice('/tpl-wz/'.length));
      if (/^[^\/\\.]+\.html$/i.test(raw)) {
        const full = path.join(__dirname, 'tpl-wz', raw);
        if (!exists(full)) return sendText(res, '没有这套模板：' + raw, 'text/plain; charset=utf-8', 404);
        const buf = await fsp.readFile(full);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(buf);
      }
      return sendText(res, '模板名不合法', 'text/plain; charset=utf-8', 400);
    }

    sendText(res, '404 Not Found', 'text/plain; charset=utf-8', 404);
  } catch (err) {
    const status = err.status || 500;
    if (url.pathname.startsWith('/api/')) {
      // hint 是可选的补充说明，前端请求层会优先用它（见 app.js 的 api()）。
      // 历史上只在少数接口里写过 hint 却没往响应里带，等于白写。
      const body = { ok: false, error: err.message || String(err) };
      if (err.hint) body.hint = err.hint;
      // 结构化附加信息（例如「这次会删掉哪些章节」）要原样带给前端，
      // 否则前端只能拿到一句错误文案，没法把清单摆给用户看。
      // 这里刻意是**白名单**而不是把 err 全量序列化：错误对象里可能有
      // 路径、堆栈之类不该出网的东西。
      if (err.dropped) body.dropped = err.dropped;
      // 模板重复导入（409 duplicate）：code 让前端认出「这是重复」而不是
      // 普通失败，existing 是库里那份的名字/时间，摆进确认框给用户看。
      if (err.code) body.code = err.code;
      if (err.existing) body.existing = err.existing;
      // 数据缺失诊断（备考建议用）：missing 是缺哪几样的清单，reason 是
      // 机器可读的代号，needCv 决定要不要顺手给一条「去填简历」的路。
      if (err.missing) body.missing = err.missing;
      if (err.reason) body.reason = err.reason;
      if (err.needCv) body.needCv = true;
      sendJson(res, body, status);
    } else {
      sendText(res, err.message || 'Server Error', 'text/plain; charset=utf-8', status);
    }
  }
});

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log('  career-ops 本地控制台已启动');
  console.log(`${line}`);
  console.log(`  地址   http://${HOST}:${PORT}`);
  console.log(`  项目   ${ROOT}`);
  console.log(`  模式   只监听本机，不对外网暴露`);
  console.log(`${line}`);
  console.log('  按 Ctrl+C 停止\n');
});
