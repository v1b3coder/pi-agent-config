# web-research — eval iteration 1

Run: 2026-11-18, model DeepSeek V4 Flash via LiteLLM, Tavily advanced depth.
Eval prompt: `evals/evals.json#1` (PyInstaller vs Nuitka vs shiv/pex for a Python CLI on 3 platforms).

## What happened

| | With skill | Baseline (no skill) |
|---|---|---|
| Subagent runs | 8 across 3 rounds (angles: 3 → 3 gaps → 2) | 1 |
| Evidence on disk | 8 files, 144 KB | none |
| Findings | 9, each with URL + date + confidence | ~6 claims, 2 with primary URLs |
| Contradictions handled | 4 (benchmark modes, licence claim, Windows support) | 0 |
| Open questions listed | 5 | 3 (vague) |
| Artifacts | `report.md` + `findings.json` + `plan.md` | chat answer only (~700 words) |
| Main-thread context | digests only (~2.4K tokens over 3 rounds) | full answer (~1K tokens) |
| Wall clock | 3 rounds in <15 min (run was aborted during synthesis) | ~3 min |

Both runs reached the same headline recommendation (PyInstaller `onedir` + CI matrix). The skill
did not change the answer; it changed what the answer rests on:

- **Licence**: baseline said "a commercial tier exists, unverified". Skill run read
  `LICENSE-RUNTIME.txt` and established that the AGPLv3 relicense still permits proprietary output —
  a wrong assumption here would have rejected Nuitka for no reason.
- **Numbers**: baseline quoted blog figures (13 s vs 75 s). Skill run triangulated two independent
  benchmarks, found the widely repeated "18.5 s vs 0.24 s" is folder-vs-onefile, and reported a range.
- **Costs**: baseline had no signing economics. Skill run quantified ~$220/yr and 2-4 engineer-days,
  plus which platforms can dodge signing by channel choice.

## Verdict

The skill earns its cost when a wrong answer is expensive and sources disagree. It does not earn it
for "which is faster, X or Y" — the baseline covers that in a third of the time. That matches the
trigger heuristic in SKILL.md.

## Failure found and fixed during the eval

The first attempt returned "no web tools in this session" from every researcher subagent.
Root cause: `extensions/subagent.ts` spawns children with `noExtensions: true`, so
`web_search`/`visit_webpage` (extension tools) never existed in the child, even though the
`researcher` agent declares them. Fixed by passing the tool definitions through
`createAgentSession({ customTools })`. Re-verified: `HAD_TOOLS=ano` and a real URL from a fresh process.
