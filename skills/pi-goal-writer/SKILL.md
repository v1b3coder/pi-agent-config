---
name: pi-goal-writer
description: "Drafts and reviews strong /goal objectives for Pi goal-mode agent. Use when the user asks to write, improve, audit, or meta-prompt a long-running agent goal with clear success criteria, verification, constraints, iteration policy, blocked stop conditions, and auditor-verifiable completion claims."
---

# Pi Goal Writer

## Purpose

Write `/goal` prompts that are fit for persistent autonomous work. A goal is not a bigger ordinary prompt; it is a completion contract. The agent will keep using it to decide what to do next and whether it can honestly stop, so the goal must define the desired end state, the evidence that proves it, the constraints that must remain true, and when to stop as blocked instead of drifting.

Use this skill for Pi `pi-goal-audit` first. The same goal-writing principles also apply to Codex Goal mode and compatible `/goal` workflows.

## Who reads the goal

Two consumers read the goal with very different context:

- **The executor** runs in the conversation that produced the goal, so it still sees the full discussion, plans, and clarifications.
- **The auditor** is an isolated, read-only session. It receives only the objective string verbatim, the executor's completion claim, and the workspace (`read`, `grep`, `find`, `ls`, `bash`). It never sees the conversation.

The objective is therefore the only durable channel from the discussion into the audit, and the completion claim is the only narrative input the auditor gets besides it. Anything the auditor must verify has to be written in the objective or reachable from it (a spec file, test, command, log path). "As we discussed" is invisible to the audit.

## Core rule

Never produce a vague goal such as "make this better," "finish the feature," or "improve the codebase." Turn the user's rough intent into a goal with auditable completion criteria.

A strong goal includes seven parts:

1. **Outcome** — what must be true when the work is done.
2. **Verification surface** — tests, commands, benchmark output, report, artifact, diff audit, PR state, screenshots, logs, or other concrete evidence.
3. **Constraints** — what must not regress or be changed.
4. **Boundaries** — files, directories, tools, systems, data sources, or permissions the agent may or may not use.
5. **Iteration policy** — how the agent should choose the next action after each attempt.
6. **Completion claim** — what the executor must cite in `update_goal` (commands run, observed results, artifact paths) so the auditor can check the claim against the workspace.
7. **Blocked stop condition** — when the agent should stop honestly, with evidence and the next needed input, instead of continuing blindly.

## Workflow

1. Default to Pi `pi-goal-audit`. Write a Pi-compatible `/goal` command unless the user explicitly asks for another harness. The goal body can usually be reused in Codex Goal mode; Pi also supports optional token budgets such as `/goal --tokens 50k ...`.
2. Gather context before drafting when the task depends on a repository, issue, test suite, benchmark, PR, design, or external documentation. Read the relevant files or sources instead of inventing the verification surface.
3. Ask at most three clarifying questions only when missing information changes the goal contract. Prefer making safe assumptions explicit when the user is trying to move quickly.
4. Draft the goal as a single pasteable command, then include a short rationale or checklist showing how the seven parts are covered.
5. For high-stakes or ambiguous work, provide two options: a narrower goal that is safer to execute and a broader goal that delegates more discovery to the agent. Recommend one.

## Goal template

Use this shape unless the user asks for a different format:

```text
/goal <outcome>, verified by <verification surface>. Preserve <constraints>. Use <boundaries>. Between iterations, <iteration policy>. In the completion claim, cite <evidence>. If blocked, stop with <blocked stop condition>.
```

For Pi token budgets:

```text
/goal --tokens 50k <outcome>, verified by <verification surface>.
```

## Writing standards

Make the goal self-contained. It should survive context compaction, continuation turns, and the context-blind auditor: if a requirement cannot be checked from the objective plus the workspace, name the artifact, test, or command that carries the proof. Include exact command names when known, but do not invent commands. Say "run the relevant project checks identified in AGENTS.md/package scripts" only when exact commands are unknown and the agent can inspect them.

Make completion evidence-based. The goal should require the agent to inspect real artifacts before declaring success: files changed, tests passed, benchmark numbers, rendered screenshots, logs, PR checks, or a written audit. Do not let "tests pass" be the only evidence unless the tests actually cover every requirement.

Make the completion claim evidence-bearing. The goal should tell the executor what to put in the `completionSummary` of `update_goal`: the commands run, their observed results, and the artifacts or files that changed, mapped per requirement. This claim is the auditor's only narrative input, so a bare "done" or "implemented" leaves it with nothing to check.

Bound the scope. Name excluded directories or behaviors when important, such as "do not rewrite CLI user-facing output," "do not change public API behavior," or "do not touch generated files except via the generator."

Preserve honesty under uncertainty. If evidence may be unavailable, require a final report that separates confirmed findings, approximate/proxy evidence, blocked claims, and remaining uncertainty. Prefer concrete stop language: "If blocked, stop with the exact blocker and what would unlock progress." Avoid weak endings like "do your best."

## Review checklist

Before returning a goal, verify it answers:

- Can the agent tell when it is done?
- Could a read-only auditor with only this objective, the completion claim, and the workspace decide whether it is done?
- Does the goal require the completion claim to cite commands, results, and artifacts?
- Can the user independently audit that completion claim?
- Are regressions and forbidden approaches named?
- Does the goal allow iteration without inviting unlimited drift?
- Does it define what to do when tests, credentials, network, data, or product decisions block progress?
- Is it pasteable as one `/goal` command?

## Examples

**Weak:**
```text
/goal improve logging
```

**Strong:**
```text
/goal Implement structured runtime logging, verified by targeted logger tests, the full project check/type/test suite, and final audits showing no production console.* calls outside approved CLI/UI/logger-sink exceptions. Preserve existing operator-visible console behavior, avoid logging secrets or credentials, and keep the logger generic rather than error-only. Between iterations, inspect the diff and audit remaining catch paths before deciding the next change. In the completion claim, cite the test commands run, their results, and the files changed. If blocked, stop with the unverified requirement, evidence gathered, and the next input needed.
```

**Weak:**
```text
/goal fix flaky checkout test
```

**Strong:**
```text
/goal Diagnose and either fix or conclusively characterize the flaky checkout test, verified by a reliable local reproduction or an evidence-backed failure analysis plus the relevant test command passing when a fix is made. Preserve public checkout behavior and avoid broad timing hacks unless the evidence shows timing is the root cause. Between iterations, record the hypothesis tested, command output, and next most likely cause. In the completion claim, cite the reproduction command, its output across runs, and the diff of any fix. If the flake cannot be reproduced or no safe fix remains, stop with attempted reproductions, logs, suspected causes, and the missing evidence needed.
```

**Weak:**
```text
/goal reproduce this paper
```

**Strong:**
```text
/goal Produce the strongest evidence-backed reproduction of the paper using available local resources, verified by a final claim-by-claim report and any generated artifacts or runnable checks. Attempt the headline results where feasible, label approximate reconstructions separately from exact reproductions, and do not overclaim missing seeds, checkpoints, datasets, or implementation details. Between iterations, map claims to available evidence and prioritize the highest-value verifiable claim. In the completion claim, cite each claim, the artifact or run supporting it, and whether it is exact or approximate. If exact reproduction is blocked, stop with confirmed claims, proxy evidence, blocked claims, and the specific missing materials.
```
