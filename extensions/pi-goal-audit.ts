// pi-goal-audit — a fork of Michaelliv/pi-goal that adds an independent auditor
// subagent before marking goals complete. Architecture follows pi-goal's lean
// single-file approach (≈460 lines), with the auditor inspired by tmonk/pi-goal-x's
// goal-auditor.ts but simplified: it uses createAgentSession with read-only tools
// (read, grep, find, ls, bash) and requires <approved/> in the auditor's output.
// Temp names were used during development to coexist with installed pi-goal-x.
// ────────────────────────────────────────────────────────────────────────────

import { defineTool, createAgentSession, createExtensionRuntime, SessionManager, SettingsManager, ModelRuntime, getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { Type, isContextOverflow } from "@earendil-works/pi-ai";
import { join } from "node:path";

// ── Constants ────────────────────────────────────────────────────────────

const CUSTOM_TYPE = "pi-goal";
const EVENT_TYPE = "pi-goal-event";
const GOAL_TOOL_NAMES = ["get_goal", "update_goal"];
const COMMAND_NAME = "goal";
// Control words users may type as `/goal <word>` while a loop is running. Without
// these, `/goal stop` replaced the goal with an objective named "stop" and the
// continuation loop became impossible to stop from the command line.
const PAUSE_WORDS = new Set(["pause", "stop", "halt"]);
const CLEAR_WORDS = new Set(["clear", "cancel", "abort", "end", "quit", "reset"]);
const RESUME_WORDS = new Set(["resume", "continue"]);
// An auditor run must not hang update_goal forever if its model loops on tool calls.
const AUDITOR_TIMEOUT_MS = 100 * 60 * 1000;
// Consecutive audit failures (rejection or error) after which the goal auto-pauses.
// Deliberately high: complex goals may legitimately need many audit rounds; this is
// only a last-resort catch for a runaway loop.
const MAX_CONSECUTIVE_AUDIT_FAILURES = 20;

import { parseTokenBudget, tokenDelta, fmtTokens, fmtTime, truncate, evtLabel, usageStr, statusLine as sl, contPrompt, budgetStop, contentFor as cf, buildAuditPrompt, type GoalEventKind, type GoalState } from "./pi-goal-audit-helpers.ts";

// ── State ────────────────────────────────────────────────────────────────

let goal: GoalState | null = null;
let statusBarEnabled = true;
let activeTurnStartedAt: number | null = null;
// True when the current run executed at least one real work tool (not a goal
// tool). Continuations are only queued for runs that made progress; this is what
// stops the "agent answers with text only and the loop continues anyway" failure.
let goalWorkToolCalled = false;
// Audit failures since the last approval. A run of failures auto-pauses the goal.
let consecutiveAuditFailures = 0;

// ── Message builder ──────────────────────────────────────────────────────

const msgFor = (kind: GoalEventKind, state: GoalState) => cf(kind, state, GOAL_TOOL_NAMES[1]);

function emit(pi: ExtensionAPI, kind: GoalEventKind, state: GoalState, opts?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }) {
	pi.sendMessage({
		customType: EVENT_TYPE,
		content: msgFor(kind, state),
		display: true,
		details: { kind, goal: state, timestamp: Date.now() },
	}, opts);
}

// ── Session state ────────────────────────────────────────────────────────

function restore(ctx: ExtensionContext): { goal: GoalState | null; statusBarEnabled: boolean } {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as any;
		if (e.type === "custom" && e.customType === CUSTOM_TYPE) {
			return { goal: e.data?.goal ?? null, statusBarEnabled: e.data?.statusBarEnabled ?? true };
		}
	}
	return { goal: null, statusBarEnabled: true };
}

function updateStatus(s: GoalState | null, ctx: ExtensionContext) {
	ctx.ui.setStatus(CUSTOM_TYPE, statusBarEnabled ? (sl(s, COMMAND_NAME) ?? "") : "");
}

function syncTools(pi: ExtensionAPI) {
	const want = goal?.status === "active";
	const active = new Set(pi.getActiveTools());
	for (const name of GOAL_TOOL_NAMES) (want ? active.add(name) : active.delete(name));
	pi.setActiveTools(Array.from(active));
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext, next: GoalState | null) {
	goal = next;
	pi.appendEntry(CUSTOM_TYPE, { goal: next, statusBarEnabled });
	updateStatus(next, ctx);
	syncTools(pi);
}

function saveSettings(pi: ExtensionAPI, ctx: ExtensionContext) {
	pi.appendEntry(CUSTOM_TYPE, { goal, statusBarEnabled });
	updateStatus(goal, ctx);
}

function pauseGoal(pi: ExtensionAPI, ctx: ExtensionContext, reason: string) {
	if (!goal || goal.status !== "active") return;
	const next: GoalState = { ...goal, status: "paused", updatedAt: Date.now() };
	persist(pi, ctx, next);
	emit(pi, "paused", next);
	ctx.ui.notify(
		`‖ Goal auto-paused: ${reason}\nObjective: ${truncate(next.objective)}\nUse /${COMMAND_NAME} resume to continue, or /${COMMAND_NAME} clear to stop.`,
		"warning",
	);
}

// ── Auditor ──────────────────────────────────────────────────────────────

function makeAuditorLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => [
			"You are a read-only completion auditor running in an isolated pi agent session.",
			"Inspect the workspace and decide whether the claimed goal completion is genuinely satisfied.",
			"Never modify files.",
			"Use read, grep, find, ls, and bash to inspect real artifacts.",
			"",
			"Be thorough but decisive: inspect as much as the task needs, do not repeat",
			"the same command or file, and stop once you have enough evidence.",
			"You MUST finish with a plain-text message (never end on a tool call).",
			"",
			'End your report with exactly one of:',
			"<approved/>",
			"<disapproved/>",
		].join("\n"),
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}



async function runAuditor(ctx: ExtensionContext, state: GoalState, claim: string, thinkingLevel: NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"], signal?: AbortSignal): Promise<{ approved: boolean; output: string; error?: string }> {
	const parts: string[] = [];
	// Set when the auditor's model reports a context-window overflow. Without
	// this the auditor silently returns an empty report and update_goal reports a
	// misleading "rejected" with no findings.
	let overflowError: string | undefined;
	// Set when the auditor does not finish in time. A model that loops on tool
	// calls would otherwise block update_goal forever.
	let timedOut = false;
	const AUDITOR_STATUS_KEY = "pi-goal-auditor-stream";
	let notifyTimer: ReturnType<typeof setTimeout> | null = null;
	const flushNotify = () => {
		notifyTimer = null;
		const text = parts.join("").trim().slice(-300); // last 300 chars
		if (text) ctx.ui.notify(`🔍 Auditor: ${text}`, "info");
	};

	try {
		// Minimal API migration (new SDK): createAgentSession no longer accepts
		// `modelRegistry` (silently ignored), so a default runtime would lack the
		// extension-registered providers (e.g. litellm) and auth would fail with
		// "No API key found". Build the canonical runtime from the agent dir and
		// re-register the parent session's extension providers on it — the same
		// thing the parent's ExtensionRunner does. Everything else is unchanged.
		const agentDir = getAgentDir();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
			const config = ctx.modelRegistry.getRegisteredProviderConfig(id);
			if (config) modelRuntime.registerProvider(id, config);
		}

		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			model: ctx.model,
			thinkingLevel,
			modelRuntime,
			resourceLoader: makeAuditorLoader(),
			sessionManager: SessionManager.inMemory(ctx.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			tools: ["read", "grep", "find", "ls", "bash"],
		});

		ctx.ui.setStatus(AUDITOR_STATUS_KEY, "🔍 Auditor: inspecting workspace...");

		const killSession = () => session.abort();
		signal?.addEventListener("abort", killSession, { once: true });

		const unsub = session.subscribe((event: any) => {
			if (event.type === "message_update") {
				const ame = event.assistantMessageEvent;
				if (
					(ame?.type === "text_delta" || ame?.type === "thinking_delta") &&
					typeof ame.delta === "string"
				) {
					parts.push(ame.delta);
					const acc = parts.join("");
					const lastLine = acc.trim().split("\n").pop() ?? "";
					ctx.ui.setStatus(AUDITOR_STATUS_KEY, `🔍 Auditor: ${truncate(lastLine, 80)}`);
					// Debounced notify so the user sees streaming output every ~400ms
					if (!notifyTimer) notifyTimer = setTimeout(flushNotify, 400);
				}
				return;
			}
			if (event.type === "message_end") {
				const msg = event.message;
				if (msg?.role !== "assistant") return;
				if (msg.stopReason !== "stop" &&
					isContextOverflow(msg, ctx.model?.contextWindow ?? 0)) {
					overflowError = msg.errorMessage
						?? `The response was cut off by the model's context window (${ctx.model?.contextWindow ?? "?"} tokens).`;
					session.abortCompaction();
					void session.abort();
				}
				for (const p of msg.content ?? []) {
					if (p.type === "text" && typeof p.text === "string") {
						// Avoid duplicating text already captured via deltas
						if (!parts.join("").trim().endsWith(p.text.trim())) {
							parts.push(p.text);
						}
					}
				}
			}
		});

		const timeout = setTimeout(() => {
			timedOut = true;
			void session.abort();
		}, AUDITOR_TIMEOUT_MS);
		try {
			await session.prompt(buildAuditPrompt(state, claim));
			// Reasoning models sometimes loop on tool calls and end with no
			// final text.  Ask once more, explicitly, for the verdict.
			if (!timedOut && !/<(?:approved|disapproved)\s*\/>/.test(parts.join(""))) {
				await session.prompt(
					"Stop inspecting now and report. End with exactly <approved/> or <disapproved/>.",
				);
			}
		} finally {
			clearTimeout(timeout);
			if (notifyTimer) clearTimeout(notifyTimer);
			unsub();
			signal?.removeEventListener("abort", killSession);
			ctx.ui.setStatus(AUDITOR_STATUS_KEY, "");
		}

		if (timedOut) {
			return { approved: false, output: parts.join("").trim(), error: `auditor timed out after ${Math.round(AUDITOR_TIMEOUT_MS / 60000)} minutes` };
		}
		if (overflowError) {
			return { approved: false, output: parts.join("").trim(), error: `context overflow: ${overflowError}` };
		}
		const output = parts.join("").trim();
		const approved = /<approved\s*\/>/.test(output);
		const disapproved = /<disapproved\s*\/>/.test(output);
		// A missing verdict is a failure of the audit, not a rejection of the goal.
		// Treating it as a rejection silently blocked completion forever.
		if (!approved && !disapproved) {
			return {
				approved: false,
				output,
				error: output
					? "auditor finished without a verdict (<approved/> or <disapproved/>)"
					: "auditor produced no output",
			};
		}
		return { approved: approved && !disapproved, output };
	} catch (err) {
		if (notifyTimer) clearTimeout(notifyTimer);
		ctx.ui.setStatus(AUDITOR_STATUS_KEY, "");
		if (timedOut) {
			return { approved: false, output: parts.join("").trim(), error: `auditor timed out after ${Math.round(AUDITOR_TIMEOUT_MS / 60000)} minutes` };
		}
		return { approved: false, output: parts.join("").trim(), error: err instanceof Error ? err.message : String(err) };
	}
}

// ── Extension entry ──────────────────────────────────────────────────────

export default function piGoalAudit(pi: ExtensionAPI) {
	// ── Message renderer ──────────────────────────────────────────────────
	pi.registerMessageRenderer(EVENT_TYPE, (message, { expanded }, theme) => {
		const d = message.details as { kind?: GoalEventKind; goal?: GoalState | null; timestamp?: number } | undefined;
		const kind = d?.kind ?? "continuation";
		const state = d?.goal ?? null;
		if (!expanded) {
			return new Text(`${theme.fg("customMessageLabel", theme.bold("Goal"))} ${theme.fg("customMessageText", evtLabel(kind))}`, 0, 0);
		}
		const lines = [`${theme.fg("dim", "Status: ")}${theme.fg("customMessageText", evtLabel(kind))}`];
		if (state) {
			lines.push(`${theme.fg("dim", "Goal: ")}${theme.fg("customMessageText", state.objective)}`);
			lines.push(`${theme.fg("dim", "Usage: ")}${theme.fg("customMessageText", usageStr(state))}`);
		}
		return new Text(lines.join("\n"), 0, 0);
	});

	// ── get_goal tool ───────────────────────────────────────────────────
	pi.registerTool(defineTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Read the current pi-goal state, if a goal is set.",
		promptSnippet: "Read the current goal objective and remaining budget.",
		promptGuidelines: [
			"Only call get_goal when you need the objective or budget; the continuation prompt already injects them.",
		],
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: JSON.stringify({ goal }, null, 2) }], details: { goal } };
		},
	}));

	// ── update_goal tool ────────────────────────────────────────────────
	pi.registerTool(defineTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Mark the current goal complete (audited) or blocked (pauses auto-continuation).",
		promptSnippet: "Mark the current goal complete after a strict completion audit, or blocked when it cannot be achieved.",
		promptGuidelines: [
			'Call update_goal with status "complete" only when the goal objective is fully achieved and verified against concrete evidence.',
			"An independent auditor subagent will inspect the workspace before the goal is marked complete.",
			'Call update_goal with status "blocked" and a completionSummary explaining the blocker when the goal cannot be achieved; this pauses the goal instead of looping.',
			"Do not call update_goal to pause, resume, or budget-limit a goal.",
		],
		parameters: Type.Object({
			status: Type.Optional(Type.String({ description: "Set to 'complete' when the objective is achieved, or 'blocked' when it cannot be achieved." })),
			completionSummary: Type.Optional(Type.String({ description: "Summary of what was completed and evidence supporting the claim; the blocker reason when status is 'blocked'." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const effectiveStatus = params.status ?? "complete";
			if (effectiveStatus !== "complete" && effectiveStatus !== "blocked") {
				return { content: [{ type: "text", text: 'update_goal only accepts status="complete" or status="blocked".' }], isError: true };
			}
			if (!goal) {
				return { content: [{ type: "text", text: "No goal is set." }], isError: true };
			}
			if (goal.status !== "active") {
				return { content: [{ type: "text", text: `Goal is ${goal.status}; update_goal does not apply.` }], isError: true };
			}

			const completionSummary = params.completionSummary?.trim() ?? "";

			// ── Blocked: the agent explicitly gives up instead of looping ─────
			if (effectiveStatus === "blocked") {
				if (!completionSummary) {
					return { content: [{ type: "text", text: 'status="blocked" requires a completionSummary explaining the blocker.' }], isError: true };
				}
				const next: GoalState = { ...goal, status: "paused", updatedAt: Date.now() };
				persist(pi, ctx, next);
				emit(pi, "paused", next);
				ctx.ui.notify(`‖ Goal paused (blocked): ${truncate(completionSummary)}`, "warning");
				return {
					content: [{ type: "text", text: `Goal paused: the agent reported it as blocked.\n\nReason: ${completionSummary}\n\nAuto-continuation stopped. Use /${COMMAND_NAME} resume to continue, or /${COMMAND_NAME} clear to remove the goal.` }],
					details: { goal: next },
				};
			}

			// ── Audit phase ────────────────────────────────────────────────
			ctx.ui.notify("Auditor: inspecting workspace for completion evidence...", "info");

			const abortController = new AbortController();
			let unsubTerminal: (() => void) | null = null;
			// onTerminalInput is TUI-only: RPC exposes it but it never fires, so
			// `hasUI` alone would silently swallow Esc. Guard by mode instead.
			if (ctx.mode === "tui" && ctx.ui.onTerminalInput) {
				unsubTerminal = ctx.ui.onTerminalInput((data) => {
					if (matchesKey(data, "escape")) {
						abortController.abort();
						return { consume: true };
					}
					return undefined;
				});
			}

			let auditorResult: { approved: boolean; output: string; error?: string };
			try {
				auditorResult = await runAuditor(ctx, goal, completionSummary, pi.getThinkingLevel(), abortController.signal);
			} finally {
				unsubTerminal?.();
			}

			// ── Handle abort (Esc pressed during audit) ────────────────────
			if (abortController.signal.aborted) {
				const bypass = ctx.hasUI
					? await ctx.ui.confirm("Audit interrupted", "Complete without audit?")
					: false;
				if (bypass) {
					const next: GoalState = { ...goal, status: "complete", updatedAt: Date.now() };
					persist(pi, ctx, next);
					emit(pi, "complete", next);
					return {
						content: [{ type: "text", text: `Goal marked complete (audit bypassed via Esc).\n\nObjective: ${goal.objective}\nUsage: ${usageStr(next)}` }],
						details: { goal: next },
					};
				}
				return {
					content: [{ type: "text", text: "Goal audit aborted. Goal remains active." }],
					details: { goal },
				};
			}

			// ── Handle auditor error ───────────────────────────────────────
			if (auditorResult.error) {
				consecutiveAuditFailures++;
				const tail = auditorResult.output
					? `\n\nAuditor output tail:\n${auditorResult.output.slice(-1500)}`
					: "";
				if (consecutiveAuditFailures >= MAX_CONSECUTIVE_AUDIT_FAILURES) {
					const next: GoalState = { ...goal, status: "paused", updatedAt: Date.now() };
					persist(pi, ctx, next);
					emit(pi, "paused", next);
				}
				const capped = consecutiveAuditFailures >= MAX_CONSECUTIVE_AUDIT_FAILURES
					? ` Auditor failed ${consecutiveAuditFailures} times in a row; auto-continuation paused. Use /${COMMAND_NAME} resume to keep trying, or /${COMMAND_NAME} clear to stop.`
					: " Goal remains active.";
				return {
					content: [{ type: "text", text: `Auditor error: ${auditorResult.error}.${capped}${tail}` }],
					details: { goal },
					isError: true,
				};
			}

			// ── Handle rejection ───────────────────────────────────────────
			if (!auditorResult.approved) {
				consecutiveAuditFailures++;
				if (consecutiveAuditFailures >= MAX_CONSECUTIVE_AUDIT_FAILURES) {
					const next: GoalState = { ...goal, status: "paused", updatedAt: Date.now() };
					persist(pi, ctx, next);
					emit(pi, "paused", next);
					return {
						content: [{ type: "text", text: `Goal audit rejected by independent auditor (${consecutiveAuditFailures} in a row). Auto-continuation paused to avoid an audit loop; use /${COMMAND_NAME} resume to keep trying, or /${COMMAND_NAME} clear to stop.\n\n${auditorResult.output}` }],
						details: { goal: next },
					};
				}
				return {
					content: [{ type: "text", text: `Goal audit rejected by independent auditor.\n\n${auditorResult.output}\n\nGoal remains active. Address the auditor's findings and retry.` }],
					details: { goal },
				};
			}

			// ── Approved ───────────────────────────────────────────────────
			consecutiveAuditFailures = 0;
			const now = Date.now();
			const next: GoalState = { ...goal, status: "complete", updatedAt: now };
			persist(pi, ctx, next);
			emit(pi, "complete", next);
			return {
				content: [{
					type: "text",
					text: [
						"Goal audit approved.",
						"",
						"Auditor report:",
						auditorResult.output,
						"",
						"Goal complete.",
						`\nObjective: ${goal.objective}`,
						`Usage: ${usageStr(next)}`,
						goal.tokenBudget ? `Remaining budget: ${Math.max(0, goal.tokenBudget - next.tokensUsed)} tokens` : "",
					].filter(Boolean).join("\n"),
				}],
				details: { goal: next },
			};
		},
	}));

	// ── /goal command ─────────────────────────────────────────────────────
	pi.registerCommand(COMMAND_NAME, {
		description: "Set, view, pause/stop, resume, or clear/cancel a long-running goal",
		getArgumentCompletions: (prefix) => {
			const values = ["pause", "stop", "resume", "clear", "cancel", "status", "statusbar", "statusbar on", "statusbar off"];
			const filtered = values.filter((v) => v.startsWith(prefix));
			return filtered.length ? filtered.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const control = raw.toLowerCase();
			const now = Date.now();

			if (!raw || control === "status") {
				if (!goal) ctx.ui.notify(`Usage: /${COMMAND_NAME} [--tokens 50k] <objective>\nControls: pause|stop, resume, clear|cancel, status, statusbar`, "info");
				else ctx.ui.notify(`${sl(goal, COMMAND_NAME)}\nObjective: ${goal.objective}\nStatus bar: ${statusBarEnabled ? "on" : "off"}\nControls: pause|stop, resume, clear|cancel`, "info");
				return;
			}

			if (control === "statusbar" || control === "statusbar toggle" || control === "statusbar on" || control === "statusbar off") {
				const [, value] = control.split(/\s+/, 2);
				statusBarEnabled = value === "on" ? true : value === "off" ? false : !statusBarEnabled;
				saveSettings(pi, ctx);
				ctx.ui.notify(`Goal status bar ${statusBarEnabled ? "enabled" : "disabled"}.`, "info");
				return;
			}

			if (CLEAR_WORDS.has(control)) {
				if (!goal) { ctx.ui.notify("No goal is set.", "info"); return; }
				const prev = goal;
				consecutiveAuditFailures = 0;
				goalWorkToolCalled = false;
				persist(pi, ctx, null);
				emit(pi, "cleared", prev);
				ctx.ui.notify("Goal cleared. Auto-continuation stopped.", "info");
				return;
			}

			if (PAUSE_WORDS.has(control) || RESUME_WORDS.has(control)) {
				if (!goal) { ctx.ui.notify("No goal is set.", "warning"); return; }
				const resuming = RESUME_WORDS.has(control);
				const next: GoalState = { ...goal, status: resuming ? "active" : "paused", updatedAt: now };
				if (resuming) {
					consecutiveAuditFailures = 0;
					goalWorkToolCalled = false;
				}
				persist(pi, ctx, next);
				emit(pi, resuming ? "resumed" : "paused", next, resuming && ctx.isIdle() ? { triggerTurn: true } : undefined);
				ctx.ui.notify(resuming ? "Goal resumed." : "Goal paused. Auto-continuation stopped.", "info");
				return;
			}

			const parsed = parseTokenBudget(raw);
			if (parsed.error) { ctx.ui.notify(parsed.error, "warning"); return; }
			if (!parsed.objective) { ctx.ui.notify(`Usage: /${COMMAND_NAME} [--tokens 50k] <objective>`, "warning"); return; }
			if (goal && goal.status !== "complete") {
				const ok = await ctx.ui.confirm("Replace goal?", `Current: ${goal.objective}\n\nNew: ${parsed.objective}`);
				if (!ok) return;
			}
			const next: GoalState = {
				version: 1,
				id: `${now}-${Math.random().toString(16).slice(2)}`,
				objective: parsed.objective,
				status: "active",
				tokenBudget: parsed.tokenBudget,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
			};
			consecutiveAuditFailures = 0;
			goalWorkToolCalled = false;
			persist(pi, ctx, next);
			emit(pi, "active", next, { triggerTurn: ctx.isIdle() });
		},
	});

	// ── Event handlers ───────────────────────────────────────────────────
	pi.on("session_start", (event, ctx) => {
		const restored = restore(ctx);
		goal = restored.goal;
		statusBarEnabled = restored.statusBarEnabled;
		goalWorkToolCalled = false;
		consecutiveAuditFailures = 0;
		activeTurnStartedAt = null;
		syncTools(pi);
		if (goal?.status === "active" && event.reason === "reload") {
			goal = { ...goal, status: "paused", updatedAt: Date.now() };
			persist(pi, ctx, goal);
			ctx.ui.notify(
				`‖ Goal paused after reload: ${truncate(goal.objective)}\nUse /${COMMAND_NAME} resume to continue, or /${COMMAND_NAME} clear to stop.`,
				"info",
			);
			return;
		}
		updateStatus(goal, ctx);
		if (goal?.status === "active") {
			ctx.ui.notify(
				`⚑ Goal restored: ${truncate(goal.objective)}\nUse /${COMMAND_NAME} pause to stop, or /${COMMAND_NAME} clear to remove.`,
				"info",
			);
		}
	});

	// A new low-level run starts. Reset the per-run progress flag.
	pi.on("agent_start", () => {
		goalWorkToolCalled = false;
	});

	// Any non-goal tool counts as real work for this run. Calling update_goal
	// repeatedly is not progress and must not keep the loop alive.
	pi.on("tool_execution_start", (event) => {
		if (!goal || goal.status !== "active") return;
		if (GOAL_TOOL_NAMES.includes(event.toolName)) return;
		goalWorkToolCalled = true;
	});

	pi.on("turn_start", () => {
		activeTurnStartedAt = Date.now();
	});

	pi.on("turn_end", (event, ctx) => {
		if (!goal || goal.status !== "active") return;
		const elapsed = activeTurnStartedAt ? Math.max(0, Math.round((Date.now() - activeTurnStartedAt) / 1000)) : 0;
		activeTurnStartedAt = null;
		const tDelta = tokenDelta((event.message as { usage?: any }) ?? {});
		let next: GoalState = {
			...goal,
			tokensUsed: goal.tokensUsed + tDelta,
			timeUsedSeconds: goal.timeUsedSeconds + elapsed,
			updatedAt: Date.now(),
		};
		if (next.tokenBudget != null && next.tokensUsed >= next.tokenBudget) {
			next = { ...next, status: "budget_limited" };
		}
		persist(pi, ctx, next);
		if (next.status === "budget_limited") {
			emit(pi, "budget_limited", next, { triggerTurn: true, deliverAs: "followUp" });
			return;
		}
		// A user interrupt (Esc) stops the loop instead of continuing it.
		if (event.outcome === "aborted") {
			pauseGoal(pi, ctx, "the turn was interrupted (Esc)");
		}
	});

	// Final actionable boundary: decide whether Pi runs one more model request.
	// A run only continues when it did real work; otherwise the goal would keep
	// re-triggering itself after text-only replies (the reported infinite loop).
	pi.on("agent_before_settle", (event, ctx) => {
		if (!goal || goal.status !== "active" || ctx.hasPendingMessages()) return;
		if (event.outcome === "aborted") return; // turn_end already paused the goal
		if (!goalWorkToolCalled) {
			ctx.ui.notify(
				`‖ Goal auto-continuation stopped: the last turn made no progress.\nObjective: ${truncate(goal.objective)}\nUse /${COMMAND_NAME} resume to continue, or /${COMMAND_NAME} clear to stop.`,
				"warning",
			);
			return;
		}
		return {
			entries: [{
				type: "custom_message",
				customType: EVENT_TYPE,
				content: msgFor("continuation", goal),
				display: true,
				details: { kind: "continuation", goal, timestamp: Date.now() },
			}],
			continue: true,
		};
	});
}
