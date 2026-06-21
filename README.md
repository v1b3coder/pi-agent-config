# Pi Agent Configuration — marekp

Personal [Pi](https://github.com/EarendilWorks/pi) agent configuration with extensively customized extensions, packages, skills, and TUI theme.

## Quick start on a fresh machine

### Prerequisites

- **Node.js** 20+ (use [nvm](https://github.com/nvm-sh/nvm) or your package manager)
- **npm** bundled with Node.js

### 1. Clone the repository

```bash
git clone <repo-url> ~/.pi/agent
cd ~/.pi/agent
```

### 2. Install Pi globally

```bash
npm install -g @earendil-works/pi-coding-agent
```

Verify:

```bash
pi --version
```

### 3. Set up environment secrets

Copy the template and fill in your own values:

```bash
cp .env .env.local
```

Edit `.env.local`:

| Variable | Description | Required |
|---|---|---|
| `LITELLM_BASE_URL` | Base URL of your LiteLLM proxy | Yes — no LLM access without it |
| `LITELLM_API_KEY` | API key for the LiteLLM proxy | Yes |
| `TAVILY_API_KEY` | API key for [Tavily](https://tavily.com) web search | Optional — needed for web search skills |
| `PI_EXT_NTFY_ENABLED` | Set to `1` to enable mobile push notifications via [ntfy](https://ntfy.sh) | Optional |
| `PI_EXT_NTFY_TOPIC` | ntfy topic name (any unique string) | Required if ntfy is enabled |

Treat `.env.local` as sensitive — it's already in `.gitignore`.

### 4. Install npm package dependencies

```bash
cd npm
npm install
cd ..
```

This installs all pi packages declared in `npm/package.json` (litellm provider, tavily, subagents, amplike, etc.).

### 5. Verify configuration

```bash
pi --list-modes
```

Expected output: `rush`, `smart`, `deep`.

Try a quick test:

```bash
pi "hello, world"
```

### 6. (Optional) Custom skills

The `skills/` directory contains custom skills:

- **code-explorer** — deep code understanding and tracing across multi-file flows
- **skill-creator** — create, edit, and benchmark agent skills

They are auto-discovered from `~/.pi/agent/skills/`.

The `agents/` directory can hold custom subagent definitions (currently empty).

## Updating

```bash
# Update pi itself + all npm packages in npm/
pi update

# Or just packages (skip pi self-update):
pi update --extensions

# Pull config changes from the repo:
cd ~/.pi/agent && git pull
```

`pi update --extensions` handles the npm packages declared in `npm/package.json` automatically. You only need to manually `npm install` in `npm/` on a **fresh clone** (step 4 in Quick start).

> **Extensions** in `extensions/` are **auto-discovered** — both single `.ts` files and directories with `index.ts` are loaded automatically. No need to register them anywhere in `settings.json`.

## Environment variable resolution

Pi starts with the current shell environment as a base. The `_env-injector` extension (`extensions/_env-injector.ts`) layers additional sources on top before any other extension runs, in this priority order (later overrides earlier):

| Priority | Source | Description |
|---|---|---|
| 1 (base) | Shell / OS environment | Actual shell env vars, `.profile`, systemd, etc. |
| 2 | `~/.pi/agent/settings.json` → `"env"` block | Global Pi settings, supports `$VAR` / `${VAR}` expansion |
| 3 | `~/.pi/agent/.env` | Global dotenv (checked into version control) |
| 4 | `~/.pi/agent/.env.local` | Global dotenv secrets (gitignored) |
| 5 | `.pi/settings.json` → `"env"` block | Per-project Pi settings, supports `$VAR` / `${VAR}` expansion |
| 6 | `$cwd/.env` | Project-level defaults |
| 7 (highest) | `$cwd/.env.local` | Project-level local overrides |

## Extensions & Customizations

### 📋 Core TUI / Editor Enhancements

| Extension | Description |
|---|---|
| **`left-strip-tools.ts`** | Replaces the default full-block colored backgrounds on tool call/result lines with a thin colored bar on the left edge. Preserves syntax highlighting, diffs, and truncation warnings. Each tool (read, bash, edit, write, grep, find, ls) gets a color-coded strip — pending (blue), success (green), error (red). Results are collapsed by default (showing line count) with `Ctrl+O` to expand. |
| **`keybindings.json`** | Overrides `tui.input.newLine` to use `Shift+Enter` / `Ctrl+N` instead of plain Enter (which submits). |
| **`themes/dark-strip.json`** — Custom `dark-strip` theme | Dark theme tuned for the left-strip tool rendering with distinct colors for tool states (`toolPendingBg`, `toolSuccessBg`, `toolErrorBg`), custom message backgrounds, and a cyan/blue accent palette. |

### 🔔 Notifications

| Extension | Description |
|---|---|
| **`notify.ts`** | Alerts you when pi waits for human input (`agent_end`). **Sound**: terminal bell + native audio player (paplay/pw-play/aplay) with bundled `notification.wav` fallback. **Desktop**: OSC 777 / Kitty OSC 99 / Windows toast. **Mobile push** (optional): sends an [ntfy.sh](https://ntfy.sh) notification if no activity within a configurable timeout (default 30s). Set `PI_EXT_NTFY_ENABLED=1` and `PI_EXT_NTFY_TOPIC` in `.env.local`. Tags, priority, sound all configurable. Includes idle detection via `xprintidle` to avoid spamming when you're away. |

### 🧠 Model Reliability

| Extension | Description |
|---|---|
| **`tool-call-revert.ts`** | Detects when a model outputs malformed tool calls (e.g., DeepSeek V4 DSML text blocks instead of proper API blocks) and automatically reverts + retries the prompt as if the bad response never happened. The bad response is filtered out of context so the model never sees it — even on future turns. Gives up after 5 consecutive failures to prevent infinite loops. |
| **`models.json`** — Model compatibility overrides | Configures DeepSeek V4 Flash with `reasoning: true`, a custom thinking-level map (`off→null`, `medium→high`, `high→max`), and DeepSeek-compat thinking format. |

### 🧪 Multi-Model Deliberation (Fusion)

| Extension | Description |
|---|---|
| **`fusion.ts`** | Runs a prompt against a panel of models in parallel, then a judge model compares responses and returns structured JSON analysis: consensus, contradictions, partial coverage, unique insights, and blind spots. Configured via `~/.pi/agent/fusion.json` or `.pi/fusion.json`. Toggle with `/fusion on/off`. **Widget**: shows status in the footer. Self-contained (no external packages). |

### 🔍 Web & Research Tools

| Extension | Description |
|---|---|
| **`web-search.ts`** | Registers a `web_search` tool powered by the [Tavily API](https://tavily.com). Supports time-range filtering, search depth selection (ultra-fast through advanced), and rich result rendering with line-count summaries. Requires `TAVILY_API_KEY`. Also includes a **`web_research`** tool (disabled) for deep Tavily research (30–120s, async delivery). |
| **`visit-webpage.ts`** | Registers a `visit_webpage` tool that fetches URLs via [Jina Reader](https://r.jina.ai) (JavaScript-rendered HTML → markdown) or downloads images to temp files. Supports Jina auth via `JINA_API_KEY`. Handles retries on 5xx/451 errors, content-length limits (5MB for images, 100KB for pages), and 60s timeout. |

### 🔄 Subagent Delegation

| Extension | Description |
|---|---|
| **`subagent.ts`** | Registers a `subagent` tool that spawns isolated child sessions for parallel or single-task delegation. Provides 6 built-in agent roles: **reviewer** (code review), **scout** (codebase recon), **researcher** (web research), **context-builder** (analysis), **worker** (implementation), **delegate** (generic). Supports concurrent execution (up to panel concurrency). **Widget**: shows per-agent status in the footer. **Shortcut `Alt+O`**: opens a TUI overlay to peek subagent output, navigate between agents (`←`/`→`), and scroll (`↑`/`↓`). Automatically compatible with `tool-call-revert` inside child sessions. |

### 💾 Persistent PTY Sessions

| Extension | Description |
|---|---|
| **`pty/index.ts`** | Full-featured PTY manager with 6 tools: `pty_start` (spawn SSH/REPL/db shell), `pty_send` (send input with escape-sequence interpretation), `pty_drain` (read new output, cursor-advancing), `pty_tail` (peek without advancing), `pty_list` (list all sessions), `pty_kill` (terminate). Uses `zigpty` + `@xterm/headless` for accurate terminal emulation. **Widget**: shows active sessions in the footer. **Shortcut `Alt+T`**: opens a TUI overlay with tabbed per-session viewport and scrolling. Supports `\n`, `\t`, `\x1b`, `\uXXXX` escape sequences in input. |

### ⚙️ Goal Mode & Auditing

| Extension | Description |
|---|---|
| **`pi-goal-audit.ts`** & **`pi-goal-audit-helpers.ts`** | Custom fork of Michaelliv/pi-goal that adds an **independent auditor subagent** before marking goals complete. The auditor uses read-only tools (read, grep, find, ls, bash) and must output `<approved/>` for the goal to pass. Supports `--tokens` budget flag, continuation prompts, and token/time tracking. `/goal` command manages goal lifecycle (set, pause, resume, clear, complete). |

### 🎛️ Tool & Skill Presets

| Extension | Description |
|---|---|
| **`preset.ts`** | Switchable named presets that filter active tools and skills. Supports allowlist (`tools-enabled`) and denylist (`tools-disabled`) per category. Stored in `~/.pi/agent/presets.json` (global) and `.pi/presets.json` (project). **Menu**: `/preset` opens an interactive selector. **Fast path**: `/preset <name>` activates directly. **Shortcut `Ctrl+Shift+P`**: cycles through presets. **CLI flag**: `--preset <name>` at startup. Built-in `all` and `none` presets. Interactive editor via `/preset` → Edit/Customize with full category browsing, toggle (`Space`), mode toggle (`m`), select all/none (`a`/`n`), and description scrolling (`←`/`→`). **Widget**: shows active preset name + tool/skill counts in the footer. |

### ⚡ Performance & Metrics

| Extension | Description |
|---|---|
| **`perf-speed.ts`** | Per-turn prefill and decode speed widget for the footer. Measures **prefill speed** (new input token delta / time-to-first-token, tok/s) and **decode speed** (output tokens / generation time, tok/s). Uses `pi-footer` event widget (widget ID: `perf-speed`). Emits values only on change to avoid unnecessary updates. |

### 📝 Prompt History

| Extension | Description |
|---|---|
| **`prompt-history.ts`** | Persists all submitted prompts to `~/.pi/agent/prompt-history.json` (last 20). On startup, injects them into the editor's history so `↑` immediately recalls previous prompts — no first submit needed. Uses prototype patching on `Editor.prototype.handleInput` and `addToHistory`. |

### 🔧 Environment & Dependency Management

| Extension | Description |
|---|---|
| **`_env-injector.ts`** | Loads environment variables from settings.json env blocks and `.env`/`.env.local` files (both global and project-level) before any other extension runs. 7-tier priority: shell env → global settings → global .env → global .env.local → project settings → project .env → project .env.local. Supports `$VAR`, `${VAR}`, and `$$` shell-style expansion within values. |
| **`_install-deps.ts`** | Scans sibling extension directories for `package.json` files and auto-runs `npm install` if `node_modules` is missing or incomplete. Runs before other extensions, ensuring deps like `zigpty` and `@xterm/headless` (used by the PTY extension) are ready. |

### 🐛 Debugging & Diagnostics

| Extension | Description |
|---|---|
| **`context-dump.ts`** | Registers `/context-dump` command that dumps the full session context (all messages, model info, token usage, raw session entries, system prompt) to a timestamped JSON file. Useful for debugging context bleed, audit traces, or inspecting what the LLM actually sees. |

### 📦 Configured Pi Packages (in `settings.json`)

| Package | Description |
|---|---|
| **`pi-provider-litellm`** | LiteLLM API provider — connects to a private proxy exposing multiple local/cloud models (DeepSeek, Qwen, more). |
| **`pi-skill-tavily`** | Tavily web search skills (tavily-research, tavily-search, tavily-extract) for the agent. |
| **`pi-amplike`** | Amplike modes system: `/mode` command, `/handoff`, `/session query`, `btw` footnotes, mode definitions in `modes.json`. |
| **`pi-footer`** | Customizable footer bar with widgets: cwd, context bar, compaction status, model name, token cost, git branch/diff/remote, preset status, fusion status, perf-speed. Configured in `extensions/pi-footer.json`. |
| **`pi-mcp-adapter`** | MCP (Model Context Protocol) adapter — connects to external MCP servers defined in `mcp.json`. Ready for use. |
| **`pi-agentic-compaction`** | Intelligent context compaction that condenses old turns to save tokens while preserving key information. Runs on DeepSeek V4 Flash. |
| **`pi-openplan`** | Structured planning: `/plan` commands (write, read, list, edit, question), `plan_write`/`plan_read`/`plan_edit`/`plan_question`/`plan_list` tools, auto-formatted YAML frontmatter, plan storage in `.pi/plans/`. |
| **`pi-interactive-shell`** | Interactive CLI session overlay (`interactive_shell` tool) for delegating to TUI coding agents (pi, Claude Code, Gemini, Codex, Cursor) with modes: interactive, hands-free, dispatch, monitor. |
| **`@dreki-gg/pi-context7`** | Fetches current library documentation by name or Context7 ID before coding against third-party APIs — prevents relying on stale training data. |

### 🌐 Thinking Modes

Configured in `modes.json` — all use **DeepSeek V4 Flash** via LiteLLM with different thinking levels:

| Mode | Thinking | Use Case |
|---|---|---|
| `rush` | Off (no thinking) | Quick lookups, simple edits, low-latency tasks |
| `smart` | Medium (mapped to `high`) | Default balance — general coding |
| `deep` | High (mapped to `max`) | Complex architecture, debugging, planning |

### 🧰 Custom Skills

| Skill | Description |
|---|---|
| **code-explorer** | Deep code understanding and tracing across multi-file flows. Uses CodeGraph and CodeSearch for fast cross-file analysis. Automatically triggered before complex cross-file edits. |
| **skill-creator** | Tools to create, edit, and benchmark custom agent skills. |
| **pi-goal-writer** | Drafts and reviews strong `/goal` objectives with clear success criteria, verification steps, constraints, and iteration policy. |

## Architecture overview

```
~/.pi/agent/
├── AGENTS.md             # Agent rules (coding guidelines, git conventions)
├── settings.json         # Main pi config — models, packages, modes
├── modes.json            # Mode definitions (rush/smart/deep)
├── models.json           # Per-provider model overrides (thinking maps, compat)
├── litellm-models.json   # Cached LiteLLM model catalog
├── mcp.json              # MCP server config (empty, ready for use)
├── .env                  # Template — copy to .env.local
├── .env.local            # Local secrets (gitignored)
├── npm/                  # Pi packages (package.json + node_modules)
├── extensions/                    # Custom TS/JS extensions
│   ├── _env-injector.ts           # Dotenv/settings env injection (7 tiers)
│   ├── _install-deps.ts           # Auto npm install for sibling extensions
│   ├── context-dump.ts            # /context-dump command for debugging
│   ├── fusion.ts                  # Multi-model deliberation panel + judge
│   ├── left-strip-tools.ts        # Colored left-strip tool call rendering
│   ├── notify.ts                  # Sound/desktop/ntfy push notifications
│   ├── perf-speed.ts              # Prefill/decode speed widget
│   ├── pi-footer.json             # Footer widget layout config
│   ├── pi-goal-audit.ts           # Goal mode with independent auditor
│   ├── pi-goal-audit-helpers.ts   # Goal audit helper functions
│   ├── preset.ts                  # Switchable tool/skill presets
│   ├── prompt-history.ts          # Persisted prompt history across sessions
│   ├── subagent.ts                # Isolated child session delegation
│   ├── tool-call-revert.ts        # Auto-retry on malformed tool calls
│   ├── visit-webpage.ts           # Webpage/image fetch tool (Jina Reader)
│   ├── web-search.ts              # Tavily web search tool
│   ├── notification.wav           # Sound file for notification extension
│   └── pty/                       # Persistent PTY session manager
│       ├── index.ts               #   pty_start / send / drain / tail / list / kill
│       └── package.json           #   Deps: zigpty, @xterm/headless
├── skills/                 # Custom skills
│   ├── code-explorer/      # Multi-file code tracing & understanding
│   ├── pi-goal-writer/     # Goal objective drafting & review
│   └── skill-creator/      # Create, edit & benchmark agent skills
├── agents/                # Custom subagent definitions (empty)
├── themes/                # Custom TUI themes
│   └── dark-strip.json    # Dark theme for left-strip tools
├── sessions/              # Session logs
├── bin/                   # Helper binaries (rg, fd)
└── keybindings.json       # Custom keybindings (Shift+Enter newline)
```
