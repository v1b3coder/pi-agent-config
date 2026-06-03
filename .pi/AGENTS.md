# CodeGraph

This repo has **two** CodeGraph projects:

### 1. Extensions (default)

```
~/.pi/agent/.codegraph/
```

### 2. Pi package sources (separate project)

```
~/.pi-agent-codegraph/
```

Indexes all pi package sources (pi-subagents, pi-footer, pi-goal-x, pi-mcp-adapter, pi-amplike, pi-agentic-compaction, ...)

**Why separate?** CodeGraph uses git-aware scanning when `.git/` is present. The symlink targets for pi sources resolve through `npm/` (gitignored), so codegraph skips them. A separate project outside the git repo avoids this.

**Note:** If the pi packages are ever reinstalled (`npm install`), run `cd ~/.pi-agent-codegraph && codegraph sync` to refresh.

## Codesearch

Uses **codesearch** (CLI) for semantic code search. No MCP integration.

### Indexed repos

| Alias | Path |
|-------|------|
| `agent` | `/home/dev/.pi/agent` (custom extensions & config) |
| `pi-coding-agent` | (npm global package — pi agent core) |

### Group: `pi-agent`

Both repos are grouped under `pi-agent` for cross-repo search.

> **When adding new extensions**: run `codesearch index add /path/to/new/repo` and add the alias to the group via `codesearch groups add pi-agent --aliases agent pi-coding-agent <new-alias>`.

