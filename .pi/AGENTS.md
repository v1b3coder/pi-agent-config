# CodeGraph

This repo has **two** CodeGraph projects:

### 1. Extensions (default)

```
~/.pi/agent/.codegraph/
```

Used automatically when no `projectPath` is specified.

### 2. Pi package sources (separate project)

```
~/.pi-agent-codegraph/
```

Indexes all pi package sources (pi-subagents, pi-footer, pi-goal-x, pi-mcp-adapter, pi-amplike, pi-agentic-compaction, ...)

Query with `projectPath`:

```
codegraph_codegraph_context(task: "...", projectPath: "/home/dev/.pi-agent-codegraph")
codegraph_codegraph_search(query: "...", projectPath: "/home/dev/.pi-agent-codegraph")
codegraph_codegraph_files(projectPath: "/home/dev/.pi-agent-codegraph")
// etc — every codegraph tool accepts projectPath
```

**Why separate?** CodeGraph uses git-aware scanning when `.git/` is present. The symlink targets for pi sources resolve through `npm/` (gitignored), so codegraph skips them. A separate project outside the git repo avoids this.

**Note:** If the pi packages are ever reinstalled (`npm install`), run `cd ~/.pi-agent-codegraph && codegraph sync` to refresh.
