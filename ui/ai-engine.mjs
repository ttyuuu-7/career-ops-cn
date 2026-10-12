// ui/ai-engine.mjs — 「这一次到底用哪个 AI 引擎」的决策口径（纯函数）
//
// 为什么单独一个模块：控制台原来只有一条 AI 通路（CodeBuddy CLI）。
// 现在多了一条「本机 Ollama 跑开源模型」的通路，于是每次 AI 调用都得先回答
// 「这一次谁去跑」。这个判断要是散在 server.mjs 里，坏起来是**静默**的：
// 选错引擎不会报错，只会表现成「莫名其妙失败」，或者更糟 ——
// 用户以为自己在用本地模型，实际又烧了 CLI 的额度。
//
// 所以决策抽成纯函数，由 ui/check-ai-engine.mjs 直接测，不经过服务器。
//
// 一个必须记住的差别：**只有 CLI 是 agent。**
// CLI 能自己读 modes/ 下的规则、能写 reports/ 和台账；
// Ollama 只是「给一段文字，还一段文字」——它自己看不到项目文件，也写不了盘。
// 但这不等于本地模型做不了完整评估：**服务端可以代劳**（ui/local-eval.mjs）——
// 把规则读进 prompt、从回复里解析出报告、由代码落盘。ollama-eval.mjs 验证过
// 这条路走得通。所以 ollama 的写能力是 true，只是「写」发生在服务端代码里，
// 不是模型自己写。

export const ENGINE_AUTO = 'auto';
export const ENGINE_CLI = 'cli';
export const ENGINE_OLLAMA = 'ollama';

export const ENGINE_CHOICES = [
  {
    id: ENGINE_AUTO,
    label: '自动',
    desc: '优先 CodeBuddy（更快更准），它不可用时退回本地模型',
  },
  {
    id: ENGINE_CLI,
    label: 'CodeBuddy',
    desc: '能读规则、能写 reports/ 与台账，可出完整报告',
  },
  {
    id: ENGINE_OLLAMA,
    label: '本地模型',
    desc: '离线、零成本、数据不出本机；完整报告由服务端代写落盘（较慢）',
  },
];

// 「能不能把结果落到磁盘上」。本地模型自己是纯文本的，但完整评估走
// 服务端编排（读规则进 prompt → 解析回复 → 代码写盘），所以它算能写。
// 这张表是「完整评估能不能用本地模型」的唯一依据，
// 前端提示、服务端拒绝请求都读它。
export const ENGINE_WRITE_CAPABLE = {
  [ENGINE_CLI]: true,
  [ENGINE_OLLAMA]: true,
};

export const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b';

/** 选择值归一化：认不出来的（含空、null、脏数据）一律退回 auto，不抛错。 */
export function normalizeEngine(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return ENGINE_CHOICES.some((c) => c.id === s) ? s : ENGINE_AUTO;
}

export function isKnownEngine(v) {
  return ENGINE_CHOICES.some((c) => c.id === String(v ?? '').trim().toLowerCase());
}

export function engineLabel(id) {
  const c = ENGINE_CHOICES.find((x) => x.id === normalizeEngine(id));
  return c ? c.label : ENGINE_CHOICES[0].label;
}

/** 该引擎能不能把结果落到磁盘上。false = 只能出文本。 */
export function canWriteFiles(id) {
  return ENGINE_WRITE_CAPABLE[id] === true;
}

/**
 * 真正的决策：这次谁去跑。
 *
 * @param {{choice?: string, cliAvailable?: boolean, ollamaAvailable?: boolean}} o
 * @returns {{engine: 'cli'|'ollama'|null, ok: boolean, reason: string}}
 *   engine 为 null 时 ok=false，reason 说明为什么一个都不能用：
 *   'no-cli' 明确要 CLI 但没装 / 'no-ollama' 明确要本地但服务没起 /
 *   'none' 两条路都不通 / 'auto-*' 是自动模式选了谁（ok=true 时用）
 */
export function pickEngine({ choice, cliAvailable = false, ollamaAvailable = false } = {}) {
  const want = normalizeEngine(choice);

  if (want === ENGINE_CLI) {
    return cliAvailable
      ? { engine: ENGINE_CLI, ok: true, reason: 'explicit-cli' }
      : { engine: null, ok: false, reason: 'no-cli' };
  }
  if (want === ENGINE_OLLAMA) {
    return ollamaAvailable
      ? { engine: ENGINE_OLLAMA, ok: true, reason: 'explicit-ollama' }
      : { engine: null, ok: false, reason: 'no-ollama' };
  }

  // auto：**故意优先 CLI**。它多出来的能力是写文件，
  // 「默认能用完整评估」比「默认省钱」更重要；想省钱就在页面上切一次，
  // 切换是会持久化的，不会每次都要重选。
  if (cliAvailable) return { engine: ENGINE_CLI, ok: true, reason: 'auto-cli' };
  if (ollamaAvailable) return { engine: ENGINE_OLLAMA, ok: true, reason: 'auto-ollama' };
  return { engine: null, ok: false, reason: 'none' };
}

/** 决策失败时给用户看的中文说明。前端和服务端共用一份，避免两处说法不一致。 */
export function engineUnavailableText(reason) {
  switch (reason) {
    case 'no-cli':
      return '你选的是 CodeBuddy，但这台机器上没有找到它的命令行入口。'
        + '可以切到「本地模型」，或先安装 CodeBuddy Code。';
    case 'no-ollama':
      return '你选的是本地模型，但连不上 Ollama 服务（默认 127.0.0.1:11434）。'
        + '先双击项目里的「启动Ollama.cmd」，再回来点「测一下」。';
    case 'none':
      return 'CodeBuddy 与本地模型都不可用。至少装一个：'
        + '装 CodeBuddy Code，或启动 Ollama。';
    default:
      return '当前没有可用的 AI 引擎。';
  }
}

/** 完整评估撞上「不能写文件」的引擎时的说明。现在所有已知引擎都能写，
 *  这个分支只剩防御意义（未知引擎 / 未来新增纯文本引擎），但话术保留。 */
export function writeBlockedText() {
  return '当前引擎只能输出文字、**不能把结果落到磁盘**，'
    + '所以「生成完整报告」这一步做不了 —— 完整评估的产物是 reports/ 里的报告文件'
    + '和台账更新。把引擎切成 CodeBuddy 或本地模型（服务端会代为落盘）就能跑；'
    + '「只做初筛」在任何引擎下都可用。';
}

/** 归一化 Ollama 地址：补协议、去尾斜杠、去空白，只保留 origin。认不出的返回默认值。 */
export function normalizeOllamaBase(v) {
  const raw = String(v ?? '').trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_OLLAMA_BASE;
  const withProto = /^https?:\/\//i.test(raw) ? raw : 'http://' + raw;

  // 先自己看一眼主机名再交给 URL。
  // 坑：`new URL('http://不是地址')` **不抛错** —— 它按 IDN 编码成
  // `http://xn--ihqq6tnb086g`，于是随便一段中文都能变成一个「合法」地址，
  // 一路传到连接失败为止，报错也指不回用户填的那个值。
  // 所以主机名只允许 ASCII 主机字符，外加 IPv6 的方括号与冒号。
  const hostPart = withProto.match(/^https?:\/\/([^/?#]+)/i);
  const host = hostPart ? hostPart[1] : '';
  if (!/^[A-Za-z0-9.\-_[\]:]+$/.test(host)) return DEFAULT_OLLAMA_BASE;

  try {
    const u = new URL(withProto);
    if (!u.hostname) return DEFAULT_OLLAMA_BASE;
    // 只保留 origin，避免用户把 /api/chat 也一起粘进来
    return u.origin;
  } catch {
    return DEFAULT_OLLAMA_BASE;
  }
}

export function normalizeOllamaModel(v) {
  const s = String(v ?? '').trim();
  return s || DEFAULT_OLLAMA_MODEL;
}

export function ollamaTagsUrl(base) {
  return normalizeOllamaBase(base) + '/api/tags';
}

export function ollamaChatUrl(base) {
  return normalizeOllamaBase(base) + '/api/chat';
}
