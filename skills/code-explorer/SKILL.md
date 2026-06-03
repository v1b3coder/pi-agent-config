---
name: code-explorer
description: "Understand, trace, or explore unfamiliar code — multi-file flows, dependencies, architecture, compound queries. **Always use** before cross-file edits and when the user asks: where things live, what calls or imports something, trace chains (who calls X, what X calls), how features flow end-to-end, or what breaks if changed. Also triggers on CodeSearch/CodeGraph mentions (skill manages their setup). Use when the user sounds lost, asks about cross-file references, or needs confidence before editing. Not for simple reads, single lookups, debugging, or non-search tasks."
---

# Code Explorer

Three tools for navigating and understanding code. Use them in any order — outputs from one tool feed into the next.

> **First step every session:** Run `scripts/init.sh` to check index health.
> 
> **If it exits with code 1 or 2:** Tell the user to copy the `!…/setup.sh` command printed by init.sh and paste it into Pi's chat prompt (the `!` prefix runs it as a shell command). Do NOT run any CodeSearch/CodeGraph commands this round.
> 
> Once setup.sh completes, re-run init.sh to verify.

## The Three Tools

Three complementary tools. Each has a different entry condition — start with whichever
matches what you know. Outputs from one tool feed into the next; you'll loop through
them as understanding grows.

### CodeSearch — find by intent

Semantic search using embeddings. Use when you know what the code *does* but not
the symbol name or file path.

```bash
codesearch search --compact --json --rerank "what the code does"
```

Returns JSON with file paths, line numbers, and relevance scores. Read the relevant
sections yourself — be surgical, not exhaustive. Jump to lines around each match
rather than reading whole files.

### CodeGraph — trace relationships

Structural queries. Use when you have a symbol name and need its connections.

```bash
codegraph query "symbol"             # find definition
codegraph callers "symbol"           # who calls it
codegraph callees "symbol"           # what it calls
codegraph impact "symbol"            # what breaks if changed (transitive)
codegraph context "topic description" # task context without a specific symbol
codegraph files                      # list all indexed files in the project
```

**Per-repo only** — no cross-repo search. If the symbol might be in a dependency,
`cd` to that repo first.

**No symbol yet?** Use `codegraph context` with a topic description — it finds nodes
near the described concept. Or use codesearch or grep to discover symbols first.

### grep — verify exhaustively

Text search. Use when you have a string literal, config key, error message, or any
exact pattern.

```bash
grep -rn "symbol" --include="*.go" .
grep -rn "yaml_tag" --include="*.yml" .
grep -rn "string literal" --include="*.md" .
```

**Don't skip this step.** The first two surface intent and structure; grep fills in
the concrete details: test fixtures, config files, documentation references, string
constants, and anything the semantic tools might have fuzzy-matched around.

## The Exploration Cycle

Exploration loops through the three tools until the territory is clear. At any
point, your next action depends on what you currently know:

### State machine

| You have → | Do this | Produces → | Then |
|---|---|---|---|
| intent description (what it does, not where) | `CodeSearch` | file paths + line numbers | Read surgically → extract symbols → CodeGraph |
| symbol name | `CodeGraph` | files + relationships | Read → extract more symbols; or grep for related strings |
| string/pattern (error msg, config key, test fixture) | `grep` | file paths + matching lines | Read → extract symbols → CodeGraph |
| read a file, found a symbol | `CodeGraph` | that symbol's connections | Read new files; or grep for related patterns |
| read a file, found a pattern | `grep` | all occurrences across the project | Read → extract symbols → CodeGraph |
| CodeGraph returned no new nodes | `grep` the symbol in configs, docs, tests | cross-reference surface | Read; or stop if nothing new |
| CodeSearch returned nothing useful | refine query, or fall back to `grep` | narrower results | Try grep with key terms from the user's request |

### Reading files

When any tool points at a file: read **surgically** — jump to lines around the
match, read function bodies, not file headers. Don't read the whole file.


## Example Traversals

Each row shows a real path through the cycle — not a fixed sequence, but where the
agent started and how it looped between tools.

| Starting point | Path | Stop when |
|---|---|---|
| "Find token refresh logic" | CodeSearch("token refresh") → read hits → CodeGraph callers(found symbol) → grep("refresh\\|expir") in config/yaml → CodeGraph callees → grep test files | From trigger → call chain → config → storage is clear |
| "What calls authenticateUser?" | CodeGraph callers("authenticateUser") → read callers → grep("authenticate" *.test.go) → CodeGraph callees | All callers + test coverage mapped |
| "How does handleRequest work end-to-end?" | CodeGraph callees("handleRequest") → read each callee → CodeGraph callees of each → grep error messages | Full call tree + error paths documented |
| "What would break if I changed verifyToken?" | CodeGraph impact("verifyToken") → read impacted files → grep("verifyToken\\|VerifyToken" --include="*.yml" --include="*.md") | All references in code + config + docs cataloged |
| "Find something that sends emails" | CodeSearch("email sending") → read hits → CodeGraph callees(found mailer) → grep("smtp\\|mail" *.env *.yml) → CodeGraph callers(mailer) | Trigger → mailer call → SMTP config fully traced |

## When to stop exploring

Stop when all entry points yield no new information. Diminishing returns sets in quickly. Once the map is complete enough to answer the
original question, move on.

## Presenting findings

Present findings in a format that answers the original question directly.
Don't dump raw command output — synthesize.

| Question type | Present as |
|---|---|
| "What calls X?" / trace chain | **Call chain**: `main() → handleRequest() → authenticateUser() → verifyToken()` |
| "What would break if I changed X?" | **Impact list**: direct callers first, then transitive callers, then config/docs references — grouped by distance |
| "Where does X live?" | **File + line**: `src/auth/verifyToken.go:42` — include a one-line summary of the symbol's role |
| "How does feature X work end-to-end?" | **Narrative flow**: paragraph tracing the path with key files/symbols referenced inline |
| "Find things related to Y" | **Cross-reference table**: symbol → definition → usages → config/docs references |
| "Explore this codebase, give me an overview" | **Orientation summary**: 3–5 paragraphs covering entry points, key modules, data flow |

**Principles:**

- **Synthesize, don't dump.** Never show raw JSON, grep output, or command invocations.
  Explain what you found in your own words.
- **Anchor every symbol to a file:line.** If you mention a function, say where it lives.
- **Match the question's shape.** A list question gets a list; a "how does it work"
  question gets a narrative; an impact question gets a grouped analysis.
- **End with a one-paragraph summary** that directly answers the original question.

> **Don't show your work.** Never include `codesearch`, `codegraph`, or `grep` commands
> in your response. The user asked about code, not about how you searched for it.

## Tool Reference

### Cross-repo search

When the answer may live in a dependency outside the project folder, use groups.

**When you need cross-repo search** — start daemon first:

```bash
scripts/codesearch-server.sh start     # no-op if already running
codesearch groups list          # Shows registered groups, setup repo (see below) if not present
codesearch search --compact --json --rerank --group <name> "rate limiting"
```

The daemon auto-discovers all repos from `~/.codesearch/repos.json`. No `--register`
flags. Once started, it keeps running — only restart when you change the config.

**One-time setup for new external repo** (index + register repos, create group):

```bash
codesearch index add -a <alias> /path/to/repo
codesearch groups add <group-name> --aliases <alias> <other-alias>
```

This writes to `~/.codesearch/repos.json`. Alias defaults to directory name if
`-a` is omitted — groups reference repos by alias.


### Available scripts

These live inside the skill, not the working project — run them resolved relative
to this SKILL.md:

- **`scripts/init.sh`** — Quick health check (fast). Exit code 1 = missing tools,
  exit code 2 = indexes need setup. Run **every session** before using
  CodeSearch/CodeGraph.
- **`scripts/setup.sh`** — One-time index initialization. **Run only on user
  consent.** Can take an hour+ on large repos. Idempotent — safe to re-run.
- **`scripts/codesearch-server.sh`** — Start/stop/status for the cross-repo search
  daemon. `start` (or no arg) launches it; `status` checks; `restart` reloads
  configuration. 

