---
name: code-investigation
description: "Find, understand, navigate, or explore any code — by name, behavior, pattern, or relationship. Covers symbol lookup, semantic search, call graphs, type hierarchies, definitions, and pattern matching. Use when asked to find/search/locate code, understand how something works, trace calls, show implementations, or navigate a codebase. Triggers: 'find', 'search', 'look up', 'where is', 'how does X work', 'what calls X', 'what does X do', 'trace', 'show me', 'navigate'."
---

# Code Investigation

Two tools for navigating and understanding code. Use **both** — they complement each other.

## Quick reference

| Tool | Best for | CLI |
|------|----------|-----|
| **CodeGraph** | Structural: symbol definitions, callers/callees, type hierarchies, call graphs, impact analysis | `codegraph query/callers/callees/context` |
| **CodeSearch** | Semantic: find code by what it *does* (natural language), literal/regex patterns, full-text search | `codesearch search` |

## When to use which

```
You know the symbol name?           → CodeGraph (query, callers, callees)
You know what the code DOES?        → CodeSearch (semantic search)
You need a regex/pattern search?    → CodeSearch (literal mode)
You need callers/callees of a fn?   → CodeGraph (callers, callees)
You need to trace a call path?      → CodeGraph (context, impact)
You need type/interface info?       → CodeGraph (query/node)
You don't know where to start?      → CodeSearch first, then CodeGraph
```

## CodeGraph — structural

Uses a local `.codegraph/` index in the project root. **Per-repo only** — no cross-repo search. If the symbol might be in a dependency, `cd` to that repo first.

```bash
# Find a symbol by name
codegraph query "authService"

# Find callers of a function
codegraph callers "authenticateUser"

# Find what a function calls
codegraph callees "handleRequest"

# Build task context (entry points, related symbols, key code)
codegraph context "how does the auth flow work?"

# Impact analysis (what breaks if I change X?)
codegraph impact "verifyToken"

# List project file structure
codegraph files
```

## CodeSearch — semantic & literal

Uses a local `.codesearch.db` in the project root. No daemon needed.

```bash
# Single repo — works immediately
codesearch search "natural language query about what the code does"
codesearch search --mode literal "handleWebhook"
codesearch search --mode literal --regex "auth.*middleware"
codesearch search --compact "query"    # metadata only (saves tokens)
```

### Cross-repo search

When the answer may live in a dependency outside project folder, use groups.

**One-time setup** (index + register repos, create group):

```bash
codesearch index add -a <alias> /path/to/repo
codesearch groups add <group-name> --aliases <alias> <other-alias>
```

This writes to `~/.codesearch/repos.json`. Alias defaults to directory name if `-a` is omitted — groups reference repos by alias.

**When you need cross-repo search** — use the helper script to manage the daemon:

```bash
# Ensure daemon is running (starts if needed, no-op if already up)
~/.pi/agent/skills/code-investigation/scripts/codesearch-server.sh start

# Search across the group
codesearch search --group <name> "rate limiting"

# Restart after config changes (e.g., new repo or group added)
~/.pi/agent/skills/code-investigation/scripts/codesearch-server.sh restart
```

The daemon auto-discovers all repos from `~/.codesearch/repos.json`. No `--register` flags. Once started, it keeps running — only restart when you change the config. Never stop the daemon; other agents may be using it.

## Reference

- CodeGraph: `codegraph --help`, `codegraph status`
- CodeSearch: `codesearch search --help`, `codesearch stats`, `codesearch groups list`
