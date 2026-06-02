---
name: code-investigation
description: "Find, understand, navigate, or explore any code with CodeSearch & CodeGraph — by name, behavior, pattern, or relationship. Covers symbol lookup, semantic search, call graphs, type hierarchies, definitions, and pattern matching. Use this BEFORE resorting to ad-hoc grep/find/file-browsing whenever you need to understand code. Triggers: the user asks to 'grep', 'find', 'search', 'look up', 'trace', 'navigate', 'where is', 'how does X work', 'what calls X', 'what does X do', 'show me', or wants to explore an unfamiliar codebase."
---

# Code Investigation

Two tools for navigating and understanding code. Use **both** — they complement each other.

> **First step every session:** Run `scripts/init.sh` (from the skill directory) to ensure indexes are up to date. The script is idempotent and safe to re-run.

## Quick reference

| Tool | Best for | CLI |
|------|----------|-----|
| **CodeGraph** | Structural: symbol definitions, callers/callees, type hierarchies, call graphs, impact analysis | `codegraph query/callers/callees/context` |
| **CodeSearch** | Semantic: find code by what it *does* (natural language) | `codesearch search` |

## When to use which

```
You know the symbol name?           → CodeGraph (query, callers, callees)
You know what the code DOES?        → CodeSearch (semantic search)
You need callers/callees of a fn?   → CodeGraph (callers, callees)
You need to trace a call path?      → CodeGraph (context, impact)
You need type/interface info?       → CodeGraph (query/node)
You don't know what you're looking for? → CodeSearch first, then CodeGraph
```

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

Uses a local `.codesearch.db` in the project root. No daemon needed. Uses tree-sitter AST chunking and `jina-code` embeddings (code-specific model).

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

| Scenario | Tool | Command |
|----------|------|---------|
| "Where is the token refresh logic?" | CodeSearch → CodeGraph | `codesearch search --compact --json --rerank "token refresh"` then `codegraph callers <found-symbol>` |
| "What calls `authenticateUser`?" | CodeGraph callers | `codegraph callers "authenticateUser"` — returns every call site with file + line |
| "How does `handleRequest` work end-to-end?" | CodeGraph callees | `codegraph callees "handleRequest"` — shows all internal calls it makes |
| "What would break if I changed `verifyToken`?" | CodeGraph impact | `codegraph impact "verifyToken"` — traces transitive callers |
| "Find something that sends emails" | CodeSearch first | `codesearch search --compact --json --rerank "email sending"` then `codegraph callees` to explore |

## Verify

Check that indexes are healthy before relying on results:

```bash
codegraph status .             # Shows node count, file count, "✓ Index is up to date"
codesearch stats .             # Shows chunk count, Indexed: ✅
codesearch groups list         # Shows registered groups (for cross-repo search)
```

If `codegraph status .` shows errors or "no index found", re-run `scripts/init.sh`. If `codesearch stats .` shows no results or an empty chunk count, re-index with `codesearch index --force --model jina-code .`

## Available scripts

These live inside the skill, not the working project — run them resolved relative to this SKILL.md:

- **`scripts/init.sh`** — Always run first before calling any CodeGraph or CodeSearch command. **Every session. No exceptions.** Use a **long timeout (≥1800s)** — model download + indexing can take a while. Prints install instructions if tools are missing. Adds `.codegraph/` and `.codesearch.db/` to `.gitignore`.
- **`scripts/codesearch-server.sh`** — Start/stop/status for the cross-repo search daemon. `start` (or no arg) launches it; `status` checks; `stop` shuts it down. 

