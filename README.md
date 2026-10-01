# dsh-claude-memory

A read-only [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
surfaces **Claude Code's existing project memory** inside DSH — so a task can continue in
DSH after a Claude Code quota runs out.

中文文档：[README.zh.md](README.zh.md)

```
~/.claude/CLAUDE.md          ─┐
  @imports inlined            │
~/.claude/projects/<key>/     ├─► confine ─► redact ─► byte-budget ─► DSH system prompt
  memory/MEMORY.md  (index)   │                                        + claude_memory tool
  memory/<topic>.md (bodies) ─┘
```

## What it does

- Injects the resolved project's `MEMORY.md` index into the system prompt, plus the
  user-global `~/.claude/CLAUDE.md` with its `@path` imports inlined.
- Registers one `claude_memory` tool so the model can open any memory, list projects, or
  search across a project's notes — full bodies never enter the prompt by default.
- Masks credential-shaped text **before** anything reaches the model provider.
- Never writes, moves, or deletes anything under the Claude home.

## Install

```bash
dsh plugin --profile web add dsh-claude-memory
```

Restart the profile — a new bundle in `dsh.profile.bundles` is read at boot, not live.

From a checkout instead of npm:

```bash
dsh plugin --profile web add /path/to/dsh-claude-memory
```

Verify the row composed:

```bash
dsh --profile web --dump-config | grep -A 10 claude-memory
```

## Configuration

Defaults live in this package's `cordis.patch.yml`; override them in your profile's patch
layer or a `--patch` overlay.

| Field | Default | Meaning |
|---|---|---|
| `claudeHome` | `~/.claude` | Claude Code home. Every read is confined to this root. |
| `cwd` | `process.cwd()` | **Fallback only.** A live session's `agent.session.header.cwd` always wins. |
| `includeDescendants` | `true` | List sibling/child projects that have memory. |
| `descendantLimit` | `12` | How many other projects to list. |
| `maxIndexBytes` | `24000` | Byte budget for the injected memory block. |
| `maxGlobalBytes` | `6000` | Byte budget for `CLAUDE.md` plus inlined imports. |
| `enableMemory` | `true` | Inject the memory block. |
| `enableGlobalInstructions` | `true` | Inject the user-global instructions. |
| `enableTool` | `true` | Register the `claude_memory` tool. |
| `redactMode` | `on` | `on` masks secrets, `report` counts only, `off` disables. |
| `refreshMs` | `20000` | Re-read the store when a prompt is assembled and the cache is older. |

## What reaches the model

Two system-prompt sections (orders 10 and 11, just after the deployment persona):

1. **`claude-memory:global`** — `~/.claude/CLAUDE.md` with `@path` lines inlined. DSH's own
   instruction loader deliberately does not expand imports, and it reads
   `$DSH_HOME/AGENTS.md` rather than `~/.claude/CLAUDE.md`, so this is the only path that
   carries the user-global Claude Code memory.
2. **`claude-memory:memory`** — the resolved project's `MEMORY.md` index, plus a
   newest-first list of the other projects that have memory.

Full memory bodies arrive only through the tool, one file at a time, under a 20 KB cap.

## Project resolution

The directory that decides which memory is relevant is the **session's** working directory,
not the directory the `dsh` server was launched from. Those differ whenever the server is
started from one checkout while sessions run in another.

Resolution order:

1. **exact** — `<home>/projects/<encoded-cwd>/memory/` exists;
2. **git-root** — the encoded key for the enclosing git repository root has memory;
3. **freshest** — otherwise, the most recently updated memory set among the ancestors and
   children of the working directory (reported to the model as a guess).

Rule 2 exists because **Claude Code files memory under the git repository root, not the raw
working directory** — see the case study below. In rules 2 and 3 the other projects are
listed newest-first, so the freshest child is one tool call away.

`agent.session.header.cwd` is the same source the first-party `dsh-agent-instructions`
loader reads. Sections are registered globally as a fallback and then **shadowed per agent**
from `agent/created`, and the tool resolves per call from `exec.agent`, so a subagent or a
session started elsewhere sees its own project.

## The `claude_memory` tool

| Action | Arguments | Returns |
|---|---|---|
| `projects` | `limit?` | Every project with memory, entry counts, current marker |
| `index` | `project?` | One project's `MEMORY.md` |
| `read` | `project?`, `file?` | One topic file; without `file`, the topic listing |
| `search` | `query`, `project?`, `limit?` | Matching lines as `file:line: text` |

`project` accepts a full key, a key suffix, or a unique substring. Every response passes the
same redactor and a 20 KB cap.

## Security model

The threat model is concrete: notes written for one vendor's model provider are about to be
sent to a different one.

- **Read-only.** No code path writes, moves, or deletes anything under `claudeHome`.
- **Confined.** Every path is `realpath`-resolved and must stay inside `claudeHome`; a
  symlinked file pointing outside is rejected. Topic names containing a path separator are
  rejected.
- **Redacted before injection.** 13 rules cover provider key shapes, bearer tokens, PEM
  blocks, JWTs, `password`/`token`/`secret` assignments with an entropy floor, connection
  strings with inline credentials, and long hex blobs. A false positive costs one masked
  line; a false negative ships a credential, so the policy leans conservative.
- **Untrusted framing.** The injected block tells the model the notes are background, never
  instructions — memory text must not be able to steer the agent.
- **No dependencies.** The plugin imports only `node:*`, so there is no third-party code in
  the trust path and it resolves in a profile whose `node_modules` lacks the harness
  packages.
- **Prompt text is a string.** Providers read a synchronously refreshed cache; they never
  return a promise.

Redaction is pattern-based, not a classifier. It cannot catch a secret that does not look
like one. Use `redactMode: report` to audit what *would* be masked, and
`enableMemory: false` as the kill switch.

## Tests

```bash
npm test              # smoke + plugin + schema + live
npm run test:unit     # fixture-only, no real ~/.claude needed
```

| File | What it covers |
|---|---|
| `test/smoke.mjs` | Paths, redaction, store, budgeting, tool — against a synthetic fixture in the OS temp dir |
| `test/plugin.mjs` | Loader contract against a fake Cordis context, including agent-scoped shadowing |
| `test/schema.mjs` | The hand-written tool schema against the real `@deepseek-ai/dsh-tools` validators; skips when DSH is absent |
| `test/live.mjs` | Optional check against a real `~/.claude`; asserts no credential-shaped text reaches the prompt, skips when absent |

76 assertions, no network, no model calls.

## Case study: two things that are easy to get wrong

Both findings come from reading the ecosystem's existing plugins and a real memory store.
They apply to any DSH plugin that bridges another agent's files.

### 1. Prompt providers are synchronous — an `async` provider renders as a `Promise`

`dsh-system-prompt` resolves section and context text **without awaiting it**
(`lib/index.js:330,337`), and the interpolator then calls `text.indexOf`
(`lib/index.js:152`). A provider declared as `async () => string` therefore yields a
`Promise`, not a string.

The most prominent Claude Code bridge in the ecosystem
([`YYTbit/dsh-plugin-claude-bridge`](https://github.com/YYTbit/dsh-plugin-claude-bridge),
`src/index.ts:75,92,107`) registers async providers. Loading is not the same as rendering:
the plugin mounts cleanly and then fails at assembly. This plugin keeps a synchronously
refreshed cache and returns plain strings.

### 2. Claude Code files memory under the git repository root

Memory lives at `~/.claude/projects/<encoded-project-path>/memory/`, where the path is the
project directory with every character other than an ASCII letter or digit replaced by `-`
(`/home/me/.config` becomes `-home-me--config`). All linked worktrees of a repository share
the main worktree's key. The question is *which* directory counts as the
project. Measured on the author's machine, on a docs hub that sits inside a larger repo and
has no `.git` of its own:

| Observation | Value |
|---|---|
| The hub session's recorded `cwd` | the hub directory |
| Its `Write`/`Edit` calls into a `memory/` path | 12, **all** under the enclosing repo's key |
| References to the enclosing repo's `memory/MEMORY.md` in that session | 235 |
| References to its own directory's `memory/` path | **0** |
| `.git` at hub / parent / grandparent | no / no / **yes** |

Session *transcripts* are stored under the cwd slug; **memory is stored under the git
repository root**. A bridge that resolves by `process.cwd()` — or that stops at the exact
cwd — silently reads the wrong project's notes for any hub directory. Memory directories are
also created on demand: across 50 project directories on that machine, only 20 had a
non-empty index and 21 had an empty `memory/`, so "no memory directory" is normal and does
not mean the directory was unused.

## Known limits

- **Not a session-history reader.** It reads memory files, not transcripts. "What was I doing
  an hour ago" needs the `*.jsonl` transcripts — out of scope here.
- **Claude Code's own index cap is not enforced.** Claude Code loads the first 200 lines or
  25 KB of `MEMORY.md`; an over-cap index silently drops entries there. This plugin injects
  up to `maxIndexBytes` and does not warn about the cap.
- **Lossy project keys.** `-` is both the separator and a legal character in a directory
  name, so display paths are recovered by walking the filesystem and fall back to the raw
  key tail.
- **No watcher.** Freshness comes from `refreshMs` checked at prompt assembly, so an edit
  made mid-turn lands on the next assembly.
- **Index only for the resolved project.** Other projects need a tool call.

## License

MIT
