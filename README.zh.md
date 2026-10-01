# dsh-claude-memory

一个默认只读的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，把
**Claude Code 已有的项目记忆**接进 DSH —— 让 Claude Code 额度耗尽后，任务能在 DSH 里接着做。

English: [README.md](README.md)

```
~/.claude/CLAUDE.md          ─┐
  @import 已内联              │
~/.claude/projects/<key>/     ├─► 收敛 ─► 脱敏 ─► 字节预算 ─► DSH system prompt
  memory/MEMORY.md  (索引)    │                              + claude_memory 工具
  memory/<topic>.md (正文)   ─┘
```

## 它做什么

- 把解析到的项目 `MEMORY.md` 索引注入 system prompt，同时注入用户级
  `~/.claude/CLAUDE.md`（其 `@path` import 会被内联展开）。
- 注册一个 `claude_memory` 工具，让模型按需打开某条记忆、列项目、或跨主题搜索 ——
  完整正文默认不进 prompt。
- 在内容到达模型服务商**之前**就把凭据形状的文本打码。
- 除非开启 `enableWrite`，绝不写入、移动或删除 Claude home 下的任何文件。

## 安装

```bash
dsh plugin --profile web add dsh-claude-memory
```

需要重启 profile —— `dsh.profile.bundles` 里的新 bundle 是启动时读取的，不热加载。

从本地目录安装：

```bash
dsh plugin --profile web add /path/to/dsh-claude-memory
```

验证配置树：

```bash
dsh --profile web --dump-config | grep -A 10 claude-memory
```

## 配置

默认值在包内的 `cordis.patch.yml`；可在 profile 的 patch 层或 `--patch` 覆盖层里改。

| 字段 | 默认 | 含义 |
|---|---|---|
| `claudeHome` | `~/.claude` | Claude Code home，所有读取都收敛在这个根下 |
| `cwd` | `process.cwd()` | **仅兜底**。会话的 `agent.session.header.cwd` 永远优先 |
| `includeDescendants` | `true` | 是否列出有记忆的兄弟/子项目 |
| `descendantLimit` | `12` | 最多列出几个其他项目 |
| `maxIndexBytes` | `24000` | 注入记忆块的字节预算 |
| `maxGlobalBytes` | `6000` | `CLAUDE.md` 加内联 import 的字节预算 |
| `enableMemory` | `true` | 是否注入记忆块 |
| `enableGlobalInstructions` | `true` | 是否注入用户级指令 |
| `enableTool` | `true` | 是否注册 `claude_memory` 工具 |
| `enableWrite` | `false` | 允许模型在当前项目保存、删除记忆（需要 `enableTool`） |
| `redactMode` | `on` | `on` 打码、`report` 只统计、`off` 关闭 |
| `refreshMs` | `20000` | prompt 组装时若缓存超过此值就重读 |

## 实际进入模型的内容

两个 system prompt 段落（order 10 / 11，紧随部署 persona 之后）：

1. **`claude-memory:global`** —— `~/.claude/CLAUDE.md`，`@path` 已内联。DSH 自带的指令
   加载器**不解析 import**，且读的是 `$DSH_HOME/AGENTS.md` 而非 `~/.claude/CLAUDE.md`，
   所以这里是用户级 Claude Code 记忆唯一的通路。
2. **`claude-memory:memory`** —— 解析到的项目 `MEMORY.md` 索引，外加按新鲜度排序的其他
   项目列表。

完整正文只通过工具按需返回，一次一个文件，单次 20 KB 上限。

## 项目解析

决定"该读哪份记忆"的是**会话的工作目录**，不是 `dsh` 服务启动的目录 —— 服务从某个
checkout 启动、会话在另一个目录跑的时候，两者必然不同。

解析顺序：

1. **exact** —— `<home>/projects/<cwd 编码>/memory/` 存在；
2. **git-root** —— 外层 git 仓库根对应的键有记忆；
3. **freshest** —— 都没有时，在祖先与子项目里选索引更新时间最新的（并明确告知模型这是猜测）。

规则 2 的存在是因为 **Claude Code 把记忆归档在 git 仓库根下，而不是原始工作目录** ——
见下方案例研究。规则 2、3 下其他项目按新鲜度倒序列出，最新那个一次工具调用就能取。

`agent.session.header.cwd` 与第一方 `dsh-agent-instructions` 读的是同一个来源。段落先以
全局注册作兜底，再在 `agent/created` 时**按 agent 作用域 shadow**；工具则按调用方
`exec.agent` 逐次解析，因此子 agent 或在别处启动的会话看到的是自己的项目。

## `claude_memory` 工具

| action | 参数 | 返回 |
|---|---|---|
| `projects` | `limit?` | 所有有记忆的项目、条数、当前标记 |
| `index` | `project?` | 某个项目的 `MEMORY.md` |
| `read` | `project?`、`file?` | 某个主题文件；不给 `file` 则列出主题 |
| `search` | `query`、`project?`、`limit?` | 匹配行，格式 `file:line: text` |

`project` 可传完整键、键后缀或唯一子串。所有返回都过同一个脱敏器并受 20 KB 上限约束。

## 写入支持

默认关闭。在 profile 的 patch 里设 `enableWrite: true`，记忆即可双向共享：在 DSH 里记下的
内容，下一次 Claude 会话能看到，反之亦然。

```yaml
- id: claude-memory
  config:
    enableWrite: true
```

开启后工具多两个 action，并新增第三个 prompt 段落（`claude-memory:instructions`），告诉模型
什么值得记、何时保存，让它不经提醒也会维护记忆。

| action | 参数 | 效果 |
|---|---|---|
| `save` | `file`、`name`、`description`、`type`、`body` | 写入带 `name`/`description`/`metadata.type` frontmatter 的 `<file>`，并更新或追加它在 `MEMORY.md` 里的指针行 |
| `delete` | `file` | 删除 `<file>` 及其指针行 |

- **只写当前项目**：目标是 git 仓库根（linked worktree 取主 worktree），否则是工作目录，
  与另一端写入的目录一致。绝不写入 `freshest` 猜测的项目，也没有 `project` 参数。
- **索引按行更新，不重建**：只改链接到 `<file>` 的那一行，标题、顺序和其他行逐字节保留。
- **收敛**：`file` 必须是 `MEMORY.md` 以外的普通 `.md` 文件名，记忆目录必须解析在
  `claudeHome` 之内。主题文件和索引都先写临时文件再 `rename`，并发读者不会读到半个文件。
- **写入不脱敏**：笔记按模型写的原样落盘；读回发给服务商的内容仍然全部脱敏。

## 安全模型

威胁模型很具体：为 A 厂商模型写的笔记，即将发给 B 厂商。

- **默认只读**：`enableWrite` 关闭（默认）时，没有任何代码路径写入、移动或删除 `claudeHome` 下的文件。开启后见[写入支持](#写入支持)。
- **收敛**：每个路径都经 `realpath` 解析且必须落在 `claudeHome` 内；指向外部的符号链接
  会被拒绝；含路径分隔符的主题名会被拒绝。
- **注入前脱敏**：13 条规则覆盖厂商 key 形状、Bearer token、PEM 块、JWT、带熵阈值的
  `password`/`token`/`secret` 赋值、内联凭据的连接串、长 hex 串。误报代价是一行被打码，
  漏报代价是把凭据发出去 —— 所以策略偏保守。
- **不可信框定**：注入块明确告诉模型这些是背景笔记而非指令，记忆文本不能操纵 agent。
- **零依赖**：只 import `node:*`，信任链里没有第三方代码，且在 `node_modules` 为空
  （不含 harness 包）的 profile 里也能解析。
- **prompt 文本是字符串**：provider 读同步刷新的缓存，永不返回 Promise。

脱敏是基于模式的，不是分类器，抓不住"不像凭据的凭据"。用 `redactMode: report` 审计
"哪些会被打码"，用 `enableMemory: false` 作为总开关。

## 测试

```bash
npm test              # smoke + plugin + schema + live
npm run test:unit     # 仅 fixture，不需要真实 ~/.claude
```

| 文件 | 覆盖范围 |
|---|---|
| `test/smoke.mjs` | 路径、脱敏、存储、预算、工具 —— 全部跑在系统临时目录里的合成 fixture 上 |
| `test/plugin.mjs` | 假 Cordis ctx 下的 loader 契约，含 agent 作用域 shadow |
| `test/schema.mjs` | 手写工具 schema 过真实 `@deepseek-ai/dsh-tools` 校验器；无 DSH 时跳过 |
| `test/live.mjs` | 可选：对真实 `~/.claude` 检查"没有凭据形状文本进入 prompt"；无 store 时跳过 |

共 76 项断言，无网络、无模型调用。

## 案例研究：两件容易做错的事

两个发现都来自阅读生态里已有的插件与一份真实记忆库。对任何"桥接另一个 agent 文件"的
DSH 插件都适用。

### 1. prompt provider 是同步的 —— `async` provider 会渲染成 `Promise`

`dsh-system-prompt` 解析段落与上下文文本时**不做 await**（`lib/index.js:330,337`），随后
插值器调用 `text.indexOf`（`lib/index.js:152`）。所以声明成 `async () => string` 的 provider
返回的是 `Promise` 而不是字符串。

生态里最知名的 Claude Code 桥接插件
（[`YYTbit/dsh-plugin-claude-bridge`](https://github.com/YYTbit/dsh-plugin-claude-bridge)，
`src/index.ts:75,92,107`）注册的正是 async provider。**能加载不等于能渲染** —— 插件挂载
正常，组装时才失败。本插件用同步刷新的缓存，返回普通字符串。

### 2. Claude Code 把记忆归档在 git 仓库根下

记忆位于 `~/.claude/projects/<项目路径编码>/memory/`，路径编码是项目目录把 ASCII 字母和数字以外的每个字符换成 `-`（`/home/me/.config` 编码为
`-home-me--config`）。同一仓库的所有 linked worktree 共用主 worktree 的键。
问题在于**哪个目录算项目**。在作者机器上，对一个位于更大仓库内、自身没有 `.git` 的文档
hub 实测：

| 观察项 | 值 |
|---|---|
| 该 hub 会话记录的 `cwd` | hub 目录 |
| 它写入 `memory/` 的 `Write`/`Edit` 调用 | 12 次，**全部**落在外层仓库的键下 |
| 该会话引用外层仓库 `memory/MEMORY.md` 的次数 | 235 |
| 引用它自己目录 `memory/` 路径的次数 | **0** |
| hub / 父目录 / 祖父目录是否有 `.git` | 无 / 无 / **有** |

**会话记录**按 cwd 编码存放，**记忆按 git 仓库根存放**。按 `process.cwd()` 解析、或只认
精确 cwd 的桥接插件，在任何 hub 目录下都会静默读错项目的笔记。另外记忆目录是**按需创建**
的：那台机器 50 个项目目录里只有 20 个有非空索引，21 个是空 `memory/` —— 所以"没有记忆
目录"很正常，不代表那个目录没被用过。

## 已知边界

- **不读会话流水**。它读记忆文件，不读 transcript。"我一小时前在做什么"需要 `*.jsonl`，
  不在本插件范围内。
- **不强制 Claude Code 自己的索引上限**。Claude Code 只加载 `MEMORY.md` 的前 200 行或
  25 KB，超限的条目在那边会被静默丢弃；本插件按 `maxIndexBytes` 注入，不对该上限告警。
- **项目键有损**。`-` 既是分隔符也是目录名的合法字符，所以展示路径靠遍历文件系统反查，
  失败时退回键尾。
- **没有文件监听**。新鲜度靠 prompt 组装时检查 `refreshMs`，所以一轮对话中途的改动会在
  下一次组装生效。
- **只注入解析到的那一个项目的索引**。其他项目需要工具调用。

## 许可证

MIT
