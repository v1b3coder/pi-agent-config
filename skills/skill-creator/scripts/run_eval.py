#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes Pi to trigger (read the skill)
for a set of queries. Outputs results as JSON.

Unlike the Claude Code version, this works by editing the skill's SKILL.md
in place at its standard location (where Pi auto-discovers it), then running
`pi -p --mode json` to test triggering. No temp command files needed.
"""

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from scripts.utils import parse_skill_md


def run_single_query(
    query: str,
    skill_md_path: Path,
    timeout: int,
    model: str | None = None,
) -> bool:
    """Run a single query and return whether the skill was triggered.

    The skill's SKILL.md must already be in place at its standard location.
    Pi auto-discovers it from the standard skill directories. We detect
    triggering by monitoring tool_execution_start events for a `read` call
    on the skill's SKILL.md path.
    """
    cmd = [
        "pi", "-p", "--mode", "json", query,
    ]
    if model:
        cmd.extend(["--model", model])

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )

    triggered = False
    start_time = time.time()
    skill_md_str = str(skill_md_path.resolve())

    try:
        while time.time() - start_time < timeout:
            if process.poll() is not None:
                # Drain remaining stdout
                for line in process.stdout:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") == "tool_execution_start":
                        if event.get("toolName") == "read":
                            path_arg = event.get("args", {}).get("path", "")
                            if skill_md_str in path_arg or skill_md_str in path_arg.rstrip("/"):
                                triggered = True
                break

            line = process.stdout.readline()
            if not line:
                continue

            try:
                event = json.loads(line.decode("utf-8", errors="replace").strip())
            except json.JSONDecodeError:
                continue

            if event.get("type") == "tool_execution_start":
                if event.get("toolName") == "read":
                    path_arg = event.get("args", {}).get("path", "")
                    if skill_md_str in path_arg or skill_md_str in path_arg.rstrip("/"):
                        triggered = True
                        break

    finally:
        if process.poll() is None:
            process.kill()
            process.wait()

    return triggered


def run_eval(
    eval_set: list[dict],
    skill_path: Path,
    num_workers: int,
    timeout: int,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
) -> dict:
    """Run the full eval set and return results.

    Reads the description directly from the SKILL.md file (must be edited
    in place before calling this function).
    """
    skill_md_path = skill_path / "SKILL.md"
    name, description, _ = parse_skill_md(skill_path)

    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_md_path,
                    timeout,
                    model,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(False)

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(
        description="Run trigger evaluation for a skill description"
    )
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Model to use (e.g. anthropic/claude-sonnet-4-20250514)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, _ = parse_skill_md(skill_path)

    if args.verbose:
        print(f"Evaluating skill: {name}", file=sys.stderr)
        print(f"Description: {original_description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_path=skill_path,
        num_workers=args.num_workers,
        timeout=args.timeout,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            expected = "should trigger" if r["should_trigger"] else "should NOT trigger"
            print(f"  [{status}] rate={rate_str} ({expected}): {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
