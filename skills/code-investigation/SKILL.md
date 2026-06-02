---
name: code-investigation
description: "Navigate and understand code with CodeSearch & CodeGraph — symbol lookup, semantic search, call graphs, type hierarchies, definitions, impact analysis, and pattern matching across large codebases. Use this FIRST for multi-package monorepos, cross-language investigations, architecture discovery, and semantic search (finding code by intent, not keyword). Falls back to grep/find for exhaustive edge-case coverage in small codebases. Triggers: the user asks to 'grep', 'find', 'search', 'look up', 'trace', 'navigate', 'where is', 'how does X work', 'what calls X', 'what does X do', 'show me', wants to explore an unfamiliar codebase, or investigate a large monorepo."
---

# Code Investigation

Two tools for navigating and understanding code. Use **both** — they complement each other.

> **First step every session:** Run `scripts/init.sh` (from the skill directory) to ensure indexes are up to date. The script is idempotent and safe to re-run.

## When this skill adds value

These tools shine in **specific contexts**. In others, grep/find is equally effective — use the right approach:

| Scenario | Best approach | Why |
|----------|---------------|-----|
| **Small project** (<1K files, single language) | grep/find | Exhaustive grep coverage is easy and catches edge cases grep can miss |
| **Large monorepo** (>5K files) | **CodeSearch first**, then grep to verify | Semantic search finds cross-package connections grep would miss |
| **Cross-language investigation** | **CodeSearch** + CodeGraph | Semantic search bridges languages; CodeGraph traces structural relationships |
| **Impact analysis** ("what breaks if I change X?") | **CodeGraph impact**, then grep for docs/error messages | CodeGraph traces transitive dependencies; grep catches human-readable refs |
| **Architecture discovery** ("how does this system work?") | **CodeSearch + CodeGraph first** | Maps the territory fast; grep fills in implementation details |
| **Interface + implementations** ("find all types that implement X") | **CodeGraph query + callers** | Structural knowledge finds relationships grep can't |
| **Simple symbol lookup** ("where is this defined?") | grep (faster for exact match) | Grep is 0.003s vs CodeGraph 0.16s for exact text matches |

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

## Combined workflow (recommended)

The most effective investigations use **both** skill tools and grep, not one or the other:

```
1. CodeSearch (semantic) →  find files by intent, discover key symbols
2. CodeGraph (structural) →  trace relationships: callers, callees, impact
3. grep / read files       →  verify exhaustively, check edge cases, find docs/error messages
```

Don't stop at the CodeGraph result. Follow up with targeted grep on the files it found to catch everything — validation messages, YAML tags, documentation references, string literals. The skill tools map the territory; grep fills in the details.

## Examples

| Scenario | Approach | Key commands |
|----------|----------|--------------|
| "Find token refresh logic in a monorepo" | CodeSearch → CodeGraph → grep | `codesearch search --compact --json --rerank "token refresh"` → `codegraph callers <symbol>` → grep for error messages |
| "What calls `authenticateUser`?" | CodeGraph → grep | `codegraph callers "authenticateUser"` → grep test files for the function name |
| "How does `handleRequest` work end-to-end?" | CodeGraph callees + grep | `codegraph callees "handleRequest"` → read key files → grep for error handling |
| "What would break if I changed `verifyToken`?" | CodeGraph impact + grep | `codegraph impact "verifyToken"` → grep for string literals, YAML, docs mentioning it |
| "Find something that sends emails" | CodeSearch → CodeGraph → grep | `codesearch search --compact --json --rerank "email sending"` → `codegraph callees` → grep for SMTP config |

## Verify

Check that indexes are healthy before relying on results:

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

