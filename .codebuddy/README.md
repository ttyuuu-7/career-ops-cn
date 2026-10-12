# .codebuddy/ —— CodeBuddy Code 适配层

这个目录是本 fork（career-ops 国内本地化）自己的东西，上游不发布它。
已在 `config/local-paths.txt` 里声明，所以 `update-system.mjs apply` 不会写这里，
路径覆盖率守卫也不会把它报成孤儿。

## 为什么需要它

career-ops 的技能本体放在 `.agents/skills/career-ops/SKILL.md`，那是**跨 CLI 的共享目录**。
但 **CodeBuddy Code 只从这两个位置发现技能**：

| 作用域 | 扫描路径 |
|---|---|
| 用户级 | `~/.codebuddy/skills/`、`~/.codebuddy/commands/` |
| 项目级 | `.codebuddy/skills/`、`.codebuddy/commands/` |

`~/.workbuddy/skills/` 也在它的可见范围内（与 WorkBuddy 共用），但 `.agents/skills/`
**不在**。实测：把探测技能放进 `.codebuddy/skills/` 能被列出，放在 `.agents/skills/`
则不被识别 —— 所以直接跑 `codebuddy` 时 `/career-ops` 这条命令是不存在的。

把技能放进 `.codebuddy/skills/` 后，CodeBuddy 就能识别 `career-ops`
（`arguments: mode`），`/career-ops oferta`、`/career-ops pdf` 这些命令随之可用。

## 这里有什么

```
.codebuddy/
└── skills/
    └── career-ops/
        └── SKILL.md      ← .agents/skills/career-ops/SKILL.md 的拷贝
```

代码刻意保持**原样拷贝**，一个字节都不改：技能内部靠
「从 SKILL.md 所在目录向上找到同时含 `AGENTS.md` 和 `modes/` 的目录」来推导
`PROJECT_ROOT`。放在 `.codebuddy/skills/career-ops/` 时向上第三级就是项目根，
推导结果正确；一旦改写内容，就有偏离上游的风险。

## 上游更新了怎么办

`.agents/` 属**系统层**，`update-system.mjs` 会更新它 —— 更新后这里的拷贝就旧了。
`node tools/verify-cn-setup.mjs` 的「CodeBuddy 技能与上游 .agents 版本一致（防漂移）」
这条断言会红。重新同步：

```bash
cp .agents/skills/career-ops/SKILL.md .codebuddy/skills/career-ops/SKILL.md
```

## 顺带说明

CodeBuddy 读项目根的 `AGENTS.md` 作为指令入口，而 `AGENTS.md` 正是 career-ops 的
AI 规则书。所以**即使不装这个适配层**，用自然语言（「帮我评估这个岗位：<JD>」）
也能驱动本项目；适配层解决的是「能敲 `/career-ops` 命令」这一层体验。
