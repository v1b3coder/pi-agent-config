# Pi Agent Configuration — marekp

Personal [Pi](https://github.com/EarendilWorks/pi) agent configuration with:

- **LiteLLM provider** — connects to a private LiteLLM proxy exposing multiple local/cloud models (set `LITELLM_BASE_URL` in `.env.local`)
- **Three thinking modes** — `rush` (no thinking, uses `beast/big`), `smart` (medium thinking, DeepSeek V4 Flash), `deep` (high thinking, DeepSeek V4 Flash)
- **Web search** — Tavily API for real-time web research
- **Pi packages**: agentic compaction, amplike (modes, handoff, session query), footer, goals, interactive shell, MCP adapter, OpenPlan, subagents
- **Custom extensions**: ntfy phone notifications, tool-call revert, context dump, perf speed, web search, visit webpage
- **Environment injection** — `.env` / `.env.local` loaded via `dotenv` by the `_env-injector` extension
- **Custom skills**: code-explorer, skill-creator
- **Git agent rules** — conventional commits, automatic commits, Gitea upstream for `~/projekty`

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

> **Extensions** in `extensions/` are **auto-discovered** — both single `.ts` files and subdirectories with `index.ts` (like `_env-injector/`) are loaded automatically. No need to register them anywhere in `settings.json`.

The `_env-injector` extension has its own `package.json` and is **not** managed by `pi update` — update its deps manually from `extensions/_env-injector/`.

## Environment variable resolution

Pi starts with the current shell environment as a base. The `_env-injector` extension (`extensions/_env-injector/`) layers additional sources on top before any other extension runs, in this priority order (later overrides earlier):

| Priority | Source | Description |
|---|---|---|
| 1 (base) | Shell / OS environment | Actual shell env vars, `.profile`, systemd, etc. |
| 2 | `~/.pi/agent/settings.json` → `"env"` block | Global Pi settings, supports `$VAR` / `${VAR}` expansion |
| 3 | `~/.pi/agent/.env` | Global dotenv (checked into version control) |
| 4 | `~/.pi/agent/.env.local` | Global dotenv secrets (gitignored) |
| 5 | `.pi/settings.json` → `"env"` block | Per-project Pi settings, supports `$VAR` / `${VAR}` expansion |
| 6 | `$cwd/.env` | Project-level defaults |
| 7 (highest) | `$cwd/.env.local` | Project-level local overrides |

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
├── extensions/           # Custom TS/JS extensions
│   ├── notify.ts         # ntfy push notification extension
│   ├── web-search.ts     # Web search with Tavily
│   ├── tool-call-revert.ts
│   ├── context-dump.ts
│   ├── perf-speed.ts
│   └── _env-injector/    # Local dotenv extension
├── skills/               # Custom skills
│   ├── code-explorer/
│   └── skill-creator/
├── agents/               # Custom subagent definitions (future)
├── sessions/             # Session logs
└── bin/                  # Helper binaries (rg, fd)
```
