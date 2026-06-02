---
name: code-investigation
description: "Find, understand, navigate, or explore any code with CodeSearch & CodeGraph — by name, behavior, pattern, or relationship. Covers symbol lookup, semantic search, call graphs, type hierarchies, definitions, and pattern matching. Use when asked to find/search/locate code, understand how something works, trace calls, show implementations, or navigate a codebase. Triggers: 'grep', 'find', 'search', 'look up', 'where is', 'how does X work', 'what calls X', 'what does X do', 'trace', 'show me', 'navigate'."
---

# Code Investigation

Two tools for navigating and understanding code. Use **both** — they complement each other.

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

## Verify

```bash
codegraph status .
codesearch stats .
codesearch groups list
```

## Available scripts
- **`scripts/codesearch-server.sh`** - Launch cross repo daemon
- **`scripts/init.sh`** - Always run first before calling any CodeGraph or CodeSearch command. **Every session. No exceptions.** Use a **long timeout (≥1800s)** — model download + indexing can take a while. 

