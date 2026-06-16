# Important rules

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step work, encode the plan via `/plan` tools:
- `plan_write` — persist phases, verification steps, and `⏸️` checkpoints
- `plan_question` — batch 2-4 questions when ambiguous (instead of inline back-and-forth)
- `plan_list` / `plan_read` — review paused plans before resuming

Format:
```
Phase 1: [name]
- Step → verify: [check]

⏸️ Checkpoint

Phase 2: [name]
...
```

Strong criteria ("test for invalid inputs passes") let you loop independently. Weak criteria ("make it work") means stop and clarify. Don't plan what wasn't asked. If user gave numbered steps, preserve order.

## Best practices
- When creating new project or tool in `~/projekty`, create public git repository with upstream at 'ssh://git@gitea.slush.cz:220/marekp/$FOLDER.git'.
- You MUST mainstain automatic git commits for changes you do. Commit and push frequently with comprehensive messages.
- If cwd is in a git repo: work there. Do not jump to sibling checkout unless asked.
- No `git worktree` from CLI sessions unless user asks. If dirty/wrong branch/awkward: ask.
- Branch switch/checkout ok when task needs it and repo rules allow.
- `~/projekty` has many intentional same-repo checkouts. Treat as user-managed, not scratch.
- Safe by default: `git status/diff/log`.
- Push only when user asks.
- Branch changes require user consent.
- Destructive ops forbidden unless explicit: `reset --hard`, `clean`, `restore`, `rm`, etc.
- Commits: Conventional Commits (`feat|fix|refactor|build|ci|chore|docs|style|perf|test`).
- If user types a command ("pull and push"), that's consent for that command.
- No amend unless asked.
- Unrecognized changes: assume other agent; keep going; focus your changes. If it causes issues, stop + ask user.
- When developing python, always create/use .venv

