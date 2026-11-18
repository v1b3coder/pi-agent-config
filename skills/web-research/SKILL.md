---
name: web-research
description: "Orchestrated multi-round web research. Frames the question, sends isolated researcher subagents per angle, keeps raw evidence on disk and only digests in the main thread, then writes a cited report plus findings.json. Trigger on an explicit request for research in any language, even when one page might do. Also trigger whenever no single page settles the question: technology or vendor comparisons, landscape and state-of-the-art surveys, 'what changed since X', library selection, due diligence, architecture decisions with external constraints. Not for single facts, version numbers, or reading one doc page (use web_search or visit_webpage directly)."
---

# Web Research

Multi-source questions fail in two opposite ways: the main thread reads twenty pages and drowns in them, or it reads two and guesses. This skill splits the difference — subagents absorb the reading in their own context windows, the main thread receives compact digests, and everything heavy stays on disk where it can be reopened.

## Is this the right tool?

Run the skill when the answer requires **combining evidence from several independent sources** and a wrong answer would cost real work: comparisons, landscape surveys, selection decisions, regulatory or pricing questions, "is X still true in 2026".

Do not run it when one page can answer — version numbers, API signatures, a specific error message, "what does flag Y do". A single `web_search` or `visit_webpage` is right there, and spawning subagents for it wastes minutes and credits. When in doubt, ask: *would two more sources change the answer?* If no, skip the skill.

**An explicit request wins over the heuristic.** When the user says "udělej research", "prozkoumej to", "deep dive", "udělej report", or otherwise asks for research by name, run the workflow even if you suspect one page would answer. They are asking for the process and the sourced brief, not just the fact. Say in one line that the question looks narrow and that a reduced run (one round, one angle) is enough, then do it — do not silently downgrade to a plain search.

**Subagents do not run this skill.** It needs the `subagent` tool, which researcher subagents do not have. If you are a subagent, do the assigned angle and return the digest — do not attempt the orchestration.

## The budget

The point of the workflow is that main-thread context grows by **digests only**. Keep these caps; they are what makes four rounds cheaper than one unfocused reading spree:

| Thing | Cap |
|---|---|
| Digest per subagent | 1,200 chars (≈300 tokens) |
| Subagents per round | 3 |
| Rounds | 4 (stop earlier — see below) |
| Findings returned per subagent | 6 |

Total research overhead in the main thread should stay under ~12K chars (≈3K tokens): all digests plus the final chat summary. If you are already deep into a session and context is tight, run fewer rounds rather than smaller digests — a digest cut below ~800 chars loses the URLs.

## Phase 0 — Frame before searching

Cheap thinking here saves a wasted round later. Write down, in the main thread:

1. **The question in one sentence**, and the decision it feeds. "Compare X vs Y" is weaker than "choose between X and Y for Z, where Z forbids A".
2. **What a good answer looks like** — which claims must be there, and which are optional colour.
3. **Angles** — 2-3 independent slices of the question (not 2-3 phrasings of it). For a library comparison: capability/fit, operational cost, ecosystem health. For a market question: size and growth, players and positioning, regulation.
4. **Known context** — what you already believe or was stated by the user, so subagents do not re-derive it.

Then create the workspace and write `plan.md` **before** the first round. If compaction hits mid-research, this file is what lets the next turn continue instead of restarting:

```
.pi/research/<slug>/
├── plan.md                  # question, angles, known context, gap list (updated each round)
├── iter-1-<angle>.md        # raw evidence from subagent 1
├── iter-1-<angle>.md
├── iter-2-<gap>.md
├── report.md                # final cited report
└── findings.json            # structured claims
```

`<slug>` is a short kebab-case name derived from the question (`pyinstaller-vs-nuitka`). Reuse an existing directory if the slug already exists — appending a round to earlier research beats starting a parallel copy. Never commit `.pi/` artifacts unless the user asks.

## Phase 1 — First round: breadth

Spawn 2-3 `researcher` subagents **in one `subagent` call with `tasks`**, one per angle. Parallel only works for independent angles; if angle B depends on what A finds, that is a later round, not this one.

Give each subagent this brief, filled in — the structure is what keeps the digest small and the evidence complete:

```
You are researching ONE angle of a larger question. Do not research the other angles.

OVERALL QUESTION: <one sentence + the decision it feeds>
YOUR ANGLE: <the slice you own>
ALREADY KNOWN (do not re-find): <up to 5 short claims from the user or earlier rounds>
WHAT WOULD SETTLE THIS ANGLE: <the specific claims, numbers, or comparisons needed>

METHOD
- 3-5 web_search queries. search_depth "advanced" when relevance matters, "basic" to scan fast.
  Use include_domains to pin official docs/vendors, time_range for anything recency-sensitive.
- Read 2-4 of the best hits with visit_webpage (css_selector to skip navigation). Prefer primary
  sources: official docs, changelogs, specs, pricing pages, filings. Do not read more than 4 pages.
- Note publish dates. A 2022 blog post is not evidence about 2026.
- Stop when the angle is settled or the remaining sources repeat the same claim.

WRITE FULL NOTES to <workspace>/iter-<n>-<angle>.md — quotes, URLs, dates, numbers, anything a
reader would need to verify the claims. This file is the evidence base and nobody else will write it.

RETURN ONLY THIS DIGEST, no preamble, max 1200 characters:
FINDINGS (max 6): <claim> [high|medium|low] — <source title> <url> (<date>)
CONTRADICTIONS: <claims that conflict with each other or with ALREADY KNOWN, or "none">
GAPS: <what you could not establish and why, or "none">
```

A subagent that returns prose instead of the digest has ignored the brief; the fix is a sharper brief on the next round, not re-reading its answer in the main thread.

## Phase 2 — Gap analysis, not summarization

Between rounds, do this in the main thread and **do not** paste digests around:

1. Merge findings, dedupe by claim (not by URL — three sources saying the same thing is one finding with three citations).
2. Mark each finding `settled`, `contested`, or `open`.
3. Update `plan.md` with the gap list: what is contested, what is missing, what is still low confidence.
4. Decide whether another round is worth it (see stop conditions).

Contested claims are the most valuable thing this process produces. Resolve them by **going to the primary source**, not by majority vote among secondary ones.

## Phase 3 — Later rounds: depth where it matters

One round per gap cluster, 1-3 subagents. These briefs differ from round 1:

- Lead with what is already established and *do not re-find it*.
- Point at the specific artefact you want: the changelog entry, the pricing page table, the spec section, the filing — "find the primary source", not "search more about X".
- Ask explicitly for disconfirmation: "what would make claim C false, and did you find that".

Narrow, named targets are what "steering into depth in specific domains" means in practice: same tool, smaller box.

## Stop conditions

Stop and synthesize when **any** of these is true:

- The gap list is empty or all remaining gaps are marked "unknowable from public sources".
- A round produces fewer than 3 new claims, or no finding flips from `open` to `settled` — diminishing returns.
- You have used 4 rounds, or the main thread is visibly running low on context (check the context indicator; if it is past ~70 %, stop now — do not trade the report for one more digest).
- The next round would only re-search queries already run.

Stopping early with an honest "unresolved" section beats a fifth round. Say which gaps remain open and what evidence would close them.

## Phase 4 — Deliver

Three artifacts plus a short chat answer.

**`report.md`** — cited prose, written for someone who was not in the conversation:

```markdown
# <Question>
## Answer
<decision-ready, ≤10 lines: recommendation, the 2-3 facts that drive it, main caveat>
## Findings
### 1. <claim>
<evidence, 2-4 sentences> — confidence: high|medium|low
Sources: <title> <url> (<date>); <title> <url> (<date>)
## Contradictions
<what conflicted, which source won and why>
## What we could not establish
<open gaps and what would close them>
## Sources
<full list, deduped>
```

**`findings.json`** — the machine-readable twin; keep it flat and small:

```json
{
  "question": "…",
  "generated_at": "2026-11-18T20:00:00Z",
  "rounds": 2,
  "findings": [
    {
      "id": "F1",
      "claim": "…",
      "topic": "<angle or gap>",
      "confidence": "high|medium|low",
      "evidence": "<quote or paraphrase, one or two sentences>",
      "sources": [{ "title": "…", "url": "…", "published": "YYYY-MM-DD" }],
      "contested_by": ["F4"]
    }
  ],
  "open_questions": ["…"],
  "artifacts": [".pi/research/<slug>/iter-1-<angle>.md"]
}
```

**Chat answer** — at most ~12 lines: the recommendation, the 2-3 load-bearing facts with confidence, the single biggest caveat, and the path to `report.md` for the rest. Never paste the report into chat; that reintroduces exactly the context cost the process was avoiding.

## Failure modes to avoid

- **Fan-out theatre.** Three subagents asked the same question in different words produce three overlapping digests and no new information. Angles must be genuinely independent.
- **Digest inflation.** If a "digest" is 4 KB, the subagent summarized nothing. Restate the cap.
- **Secondary-source drift.** Marketing blogs restate each other; only the primary source settles a contested claim.
- **Synthesis before resolution.** Writing the report while claims are still `contested` produces confident prose built on nothing.
- **Silent recency gaps.** A comparison of "current" tooling built from 2023 pages is wrong even if every citation is real — always ask what year the evidence is from.
- **Losing the thread.** Every round must land in `plan.md`. If the session is compacted, unrecorded research is gone while the credits are already spent.

## When the tools are missing

If `subagent` is unavailable in the session, run a reduced single-threaded version: frame in `plan.md`, do 3-4 `web_search` calls plus 3-4 `visit_webpage` reads yourself, write `report.md` and `findings.json` in the same shape, and tell the user the workflow ran without isolation (higher context cost).
