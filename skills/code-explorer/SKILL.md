---
name: code-explorer
description: "Three-step code exploration: CodeSearch (find by intent) → CodeGraph (trace relationships) → grep (verify everything). Covers semantic search, symbol lookup, call graphs, type hierarchies, impact analysis, and cross-language tracing. Always use all three — each catches what the others miss. Triggers when the user asks to 'grep', 'search', 'find', 'look up', 'trace', 'navigate', 'where is', 'how does X work', 'what calls X', 'show me', or wants to explore unfamiliar code."
---

# Code Explorer

Two tools for navigating and understanding code. Use **both** — they complement each other.

> **First step every session:** Run `scripts/init.sh` to ensure indexes are up to date. Idempotent — safe to re-run.

## The 1-2-3 Recipe

Always do all three steps, in this order. Each catches things the others miss.

### Step 1: CodeSearch — find by intent

Semantic search. Use when you know what the code *does* but not the symbol name.

```bash
codesearch search --compact --json --rerank "what the code does"
```

Returns JSON with file paths, line numbers, and relevance scores. Read the relevant sections yourself.

### Step 2: CodeGraph — trace relationships

Structural queries. Use when you know a symbol name and need its connections.

```bash
codegraph query "symbol"             # find definition
codegraph callers "symbol"           # who calls it
codegraph callees "symbol"           # what it calls
codegraph impact "symbol"            # what breaks if changed (transitive)
codegraph context "topic description" # task context
```

### Step 3: grep — verify exhaustively

Catch what the tools miss: validation messages, YAML/JSON tags, documentation references, string literals, test fixtures.

```bash
grep -rn "symbol" --include="*.go" .
grep -rn "yaml_tag" --include="*.yml" .
grep -rn "string literal" --include="*.md" .
```

Don't skip this step. The first two map the territory; this one fills in the details.

---

The rest of this document is reference. Use the 1-2-3 recipe above for every investigation.

## CodeGraph — structural

Uses a local `.codegraph/` index in the project root. **Per-repo only** — no cross-repo search. If the symbol might be in a dependency, `cd` to that repo first.

```bash
codegraph query "authService"          # find symbol
codegraph callers "authenticateUser"   # who calls it
codegraph callees "handleRequest"      # what it calls
codegraph context "auth flow"          # task context
codegraph impact "verifyToken"         # what breaks if changed
codegraph files                        # project structure
```

## CodeSearch — semantic

Uses a local `.codesearch.db` in the project root. No daemon needed. Uses tree-sitter AST chunking and `bge-small-q` embeddings (code-specific model).

```bash
codesearch search --compact --json --rerank "what the code does"
# Returns JSON with file paths and line positions — read relevant sections yourself
```

### Cross-repo search

When the answer may live in a dependency outside project folder, use groups.

**One-time setup** (index + register repos, create group):

```bash
codesearch index add -a <alias> /path/to/repo
codesearch groups add <group-name> --aliases <alias> <other-alias>
```

This writes to `~/.codesearch/repos.json`. Alias defaults to directory name if `-a` is omitted — groups reference repos by alias.

**When you need cross-repo search** — start daemon first:

```bash
scripts/codesearch-server.sh start     # no-op if already running
codesearch search --group <name> "rate limiting"
```

The daemon auto-discovers all repos from `~/.codesearch/repos.json`. No `--register` flags. Once started, it keeps running — only restart when you change the config. Never stop the daemon; other agents may be using it.

## Examples

Here's how the 1-2-3 recipe plays out for common scenarios:

| Scenario | Approach | Key commands |
|----------|----------|--------------|
| "Find token refresh logic in a monorepo" | CodeSearch → CodeGraph → grep | `codesearch search --compact --json --rerank "token refresh"` → `codegraph callers <symbol>` → grep for error messages |
| "What calls `authenticateUser`?" | CodeGraph → grep | `codegraph callers "authenticateUser"` → grep test files for the function name |
| "How does `handleRequest` work end-to-end?" | CodeGraph callees + grep | `codegraph callees "handleRequest"` → read key files → grep for error handling |
| "What would break if I changed `verifyToken`?" | CodeGraph impact + grep | `codegraph impact "verifyToken"` → grep for string literals, YAML, docs mentioning it |
| "Find something that sends emails" | CodeSearch → CodeGraph → grep | `codesearch search --compact --json --rerank "email sending"` → `codegraph callees` → grep for SMTP config |

## Verify indexes

Before relying on results, check health:
```bash
codegraph status .             # Shows node count, file count, "✓ Index is up to date"
codesearch stats .             # Shows chunk count, Indexed: ✅
codesearch groups list         # Shows registered groups (for cross-repo search)
```

If `codegraph status .` shows errors or "no index found", re-run `scripts/init.sh`. If `codesearch stats .` shows no results or an empty chunk count, re-index with `codesearch index --force --model bge-small-q .`

## Available scripts

These live inside the skill, not the working project — run them resolved relative to this SKILL.md:

- **`scripts/init.sh`** — Always run first before calling any CodeGraph or CodeSearch command. **Every session. No exceptions.** Use a **long timeout (≥1800s)** — model download + indexing can take a while. Prints install instructions if tools are missing. Adds `.codegraph/` and `.codesearch.db/` to `.gitignore`.
- **`scripts/codesearch-server.sh`** — Start/stop/status for the cross-repo search daemon. `start` (or no arg) launches it; `status` checks; `stop` shuts it down. 

