// pi-goal-audit — a fork of Michaelliv/pi-goal that adds an independent auditor
// subagent before marking goals complete. Architecture follows pi-goal's lean
// single-file approach (≈460 lines), with the auditor inspired by tmonk/pi-goal-x's
// goal-auditor.ts but simplified: it uses createAgentSession with read-only tools
// (read, grep, find, ls, bash) and requires <approved/> in the auditor's output.
// Temp names were used during development to coexist with installed pi-goal-x.
// ────────────────────────────────────────────────────────────────────────────

import { defineTool, createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type Theme, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";

// ── Constants ────────────────────────────────────────────────────────────

const CUSTOM_TYPE = "pi-goal";
const EVENT_TYPE = "pi-goal-event";
const GOAL_TOOL_NAMES = ["get_goal", "update_goal"];
const COMMAND_NAME = "goal";

import { parseTokenBudget, tokenDelta, fmtTokens, fmtTime, truncate, evtLabel, usageStr, statusLine as sl, contPrompt, budgetStop, contentFor as cf, buildAuditPrompt, type GoalStatus, type GoalEventKind, type GoalState } from "./pi-goal-audit-helpers.ts";

// ── State ────────────────────────────────────────────────────────────────

let goal: GoalState | null = null;
let statusBarEnabled = true;
let activeTurnStartedAt: number | null = null;
let continuationQueued = false;

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

function queueCont(pi: ExtensionAPI, state: GoalState) {
	if (continuationQueued || state.status !== "active") return;
	continuationQueued = true;
	queueMicrotask(() => {
		continuationQueued = false;
		if (!goal || goal.id !== state.id || goal.status !== "active") return;
		emit(pi, "continuation", goal, { triggerTurn: true, deliverAs: "followUp" });
	});
}

// ── Auditor ──────────────────────────────────────────────────────────────

const AUDITOR_PROMPT = [
	"You are a read-only completion auditor running in an isolated pi agent session.",
	"Inspect the workspace and decide whether the claimed goal completion is genuinely satisfied.",
	"Never modify files.",
	"Use read, grep, find, ls, and bash to inspect real artifacts.",
	"",
	'End your report with exactly one of:',
	"<approved/>",
	"<disapproved/>",
].join("\n");



async function runAuditor(ctx: ExtensionContext, state: GoalState, claim: string, signal?: AbortSignal): Promise<{ approved: boolean; output: string; error?: string }> {
	const parts: string[] = [];
	const AUDITOR_STATUS_KEY = "pi-goal-auditor-stream";
	let notifyTimer: ReturnType<typeof setTimeout> | null = null;
	const flushNotify = () => {
		notifyTimer = null;
		const text = parts.join("").trim().slice(-300); // last 300 chars
		if (text) ctx.ui.notify(`🔍 Auditor: ${text}`, "info");
	};

	try {
		// Load global extensions first so extension providers (e.g. litellm) queue
		// registrations, then pre-apply them to a canonical ModelRuntime. Must be
		// passed explicitly: the new SDK ignores unknown options like modelRegistry,
		// and its default runtime (built from agentDir/auth.json) has no extension
		// providers — ctx.model (litellm/*) would fail with "No API key found".
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
		const extLoader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir, settingsManager });
		await extLoader.reload();
		const extResult = extLoader.getExtensions();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		for (const { name, config } of extResult.runtime.pendingProviderRegistrations) {
			modelRuntime.registerProvider(name, config);
		}
		extResult.runtime.pendingProviderRegistrations = [];

		// Delegate extension bindings to the real load result; keep the auditor's
		// clean skills/prompts/system prompt.
		const auditorLoader: ResourceLoader = {
			getExtensions: () => extResult,
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => AUDITOR_PROMPT,
			getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [],
			getAppendSystemPromptSources: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			model: ctx.model,
			modelRuntime,
			resourceLoader: auditorLoader,
			sessionManager: SessionManager.inMemory(ctx.cwd),
			settingsManager,
			tools: ["read", "grep", "find", "ls", "bash"],
		});

		ctx.ui.setStatus(AUDITOR_STATUS_KEY, "🔍 Auditor: inspecting workspace...");

		const killSession = () => session.abort();
		signal?.addEventListener("abort", killSession, { once: true });

		const unsub = session.subscribe((event: any) => {
			if (event.type === "message_update") {
				const ame = event.assistantMessageEvent;
				if (ame?.type === "text_delta" && typeof ame.delta === "string") {
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

		try {
			await session.prompt(buildAuditPrompt(state, claim));
		} finally {
			if (notifyTimer) clearTimeout(notifyTimer);
			unsub();
			signal?.removeEventListener("abort", killSession);
			ctx.ui.setStatus(AUDITOR_STATUS_KEY, "");
		}

		const output = parts.join("").trim();
		const approved = /<approved\s*\/>/.test(output);
		const disapproved = /<disapproved\s*\/>/.test(output);
		return { approved: approved && !disapproved, output };
	} catch (err) {
		if (notifyTimer) clearTimeout(notifyTimer);
		ctx.ui.setStatus(AUDITOR_STATUS_KEY, "");
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

	// ── Completion flow (shared by update_goal tool and /goal complete) ─
	let auditorFailures = 0;

	async function runCompletionFlow(ctx: ExtensionContext, completionSummary: string): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }> {
		if (!goal) {
			return { content: [{ type: "text", text: "No goal is set." }], isError: true };
		}
		if (goal.status !== "active") {
			return { content: [{ type: "text", text: `Goal is ${goal.status}; completion does not apply.` }], isError: true };
		}

		// Snapshot: the goal must not change while the audit is running (e.g.
		// /goal clear mid-audit). All decisions below use the snapshot.
		const goalSnapshot = goal;

		// ── Audit phase ────────────────────────────────────────────────
		ctx.ui.notify("Auditor: inspecting workspace for completion evidence...", "info");

		const abortController = new AbortController();
		let unsubTerminal: (() => void) | null = null;
		if (ctx.hasUI && ctx.ui.onTerminalInput) {
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
			auditorResult = await runAuditor(ctx, goalSnapshot, completionSummary, abortController.signal);
		} finally {
			unsubTerminal?.();
		}

		// ── Goal state changed during the audit → never persist ───────
		if (goal !== goalSnapshot) {
			return {
				content: [{ type: "text", text: "Goal state changed while the audit was running (cleared, replaced, or budget-limited) — no completion applied." }],
				details: { goal },
			};
		}

		// ── Handle abort (Esc pressed during audit) ────────────────
		if (abortController.signal.aborted) {
			const bypass = ctx.hasUI
				? await ctx.ui.confirm("Audit interrupted", "Complete without audit?")
				: false;
			if (bypass) {
				const next: GoalState = { ...goalSnapshot, status: "complete", updatedAt: Date.now() };
				persist(pi, ctx, next);
				emit(pi, "complete", next);
				return {
					content: [{ type: "text", text: `Goal marked complete (audit bypassed via Esc).\n\nObjective: ${next.objective}\nUsage: ${usageStr(next)}` }],
					details: { goal: next },
				};
			}
			return {
				content: [{ type: "text", text: "Goal audit aborted. Goal remains active." }],
				details: { goal },
			};
		}

		// ── Handle auditor error (infra failure, not a verdict) ──────
		// Without this, every failure leaves the goal active and the goal runner
		// auto-continues → endless retry loop. Pause after 3 consecutive errors.
		if (auditorResult.error && !auditorResult.output) {
			auditorFailures++;
			if (auditorFailures >= 3) {
				const next: GoalState = { ...goalSnapshot, status: "paused", updatedAt: Date.now() };
				persist(pi, ctx, next);
				emit(pi, "paused", next);
				return {
					content: [{ type: "text", text: `Auditor failed ${auditorFailures} consecutive times (${auditorResult.error}).\n\nGoal paused to stop the retry loop. Fix the auditor (e.g. provider auth) and run /${COMMAND_NAME} resume to retry.` }],
					details: { goal: next },
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Auditor error (attempt ${auditorFailures}/3): ${auditorResult.error}. Goal remains active.` }],
				details: { goal },
				isError: true,
			};
		}

		// The auditor produced a real verdict — reset the failure counter.
		auditorFailures = 0;

		// ── Handle rejection ───────────────────────────────────────
		if (!auditorResult.approved) {
			return {
				content: [{ type: "text", text: `Goal audit rejected by independent auditor.\n\n${auditorResult.output}\n\nGoal remains active. Address the auditor's findings and retry.` }],
				details: { goal },
			};
		}

		// ── Approved ───────────────────────────────────────────────
		const now = Date.now();
		const next: GoalState = { ...goalSnapshot, status: "complete", updatedAt: now };
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
					`\nObjective: ${next.objective}`,
					`Usage: ${usageStr(next)}`,
					goalSnapshot.tokenBudget ? `Remaining budget: ${Math.max(0, goalSnapshot.tokenBudget - next.tokensUsed)} tokens` : "",
				].filter(Boolean).join("\n"),
			}],
			details: { goal: next },
		};
	}

	// ── update_goal tool ────────────────────────────────────────────────
	pi.registerTool(defineTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Mark the current goal complete. Launches an independent auditor subagent that inspects the workspace before the goal is marked complete.",
		promptSnippet: "Mark the current goal complete after a strict completion audit.",
		promptGuidelines: [
			"Call update_goal only when the goal objective is fully achieved and verified against concrete evidence.",
			"An independent auditor subagent will inspect the workspace before the goal is marked complete.",
			"Do not call update_goal to pause, resume, abandon, or budget-limit a goal.",
		],
		parameters: Type.Object({
			status: Type.Optional(Type.String({ description: "Set to 'complete' when the objective is achieved." })),
			completionSummary: Type.Optional(Type.String({ description: "Summary of what was completed and evidence supporting the claim." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const effectiveStatus = params.status ?? "complete";
			if (effectiveStatus !== "complete") {
				return { content: [{ type: "text", text: "update_goal only accepts status=complete." }], isError: true };
			}
			return runCompletionFlow(ctx, params.completionSummary?.trim() ?? "");
		},
	}));

	// ── /goal command ─────────────────────────────────────────────────────
	pi.registerCommand(COMMAND_NAME, {
		description: "Set, view, pause, resume, complete, or clear a long-running goal",
		getArgumentCompletions: (prefix) => {
			const values = ["pause", "resume", "complete", "clear", "status", "statusbar", "statusbar on", "statusbar off"];
			const filtered = values.filter((v) => v.startsWith(prefix));
			return filtered.length ? filtered.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const now = Date.now();

			if (!trimmed || trimmed === "status") {
				if (!goal) ctx.ui.notify(`Usage: /${COMMAND_NAME} [--tokens 50k] <objective>`, "info");
				else ctx.ui.notify(`${sl(goal, COMMAND_NAME)}\nObjective: ${goal.objective}\nStatus bar: ${statusBarEnabled ? "on" : "off"}`, "info");
				return;
			}

			if (trimmed === "statusbar" || trimmed === "statusbar toggle" || trimmed === "statusbar on" || trimmed === "statusbar off") {
				const [, value] = trimmed.split(/\s+/, 2);
				statusBarEnabled = value === "on" ? true : value === "off" ? false : !statusBarEnabled;
				saveSettings(pi, ctx);
				ctx.ui.notify(`Goal status bar ${statusBarEnabled ? "enabled" : "disabled"}.`, "info");
				return;
			}

			if (trimmed === "complete") {
				// Completes the CURRENT goal via the auditor flow - never treat
				// "complete" as a new objective (that created bogus goals).
				if (!goal || goal.status !== "active") {
					ctx.ui.notify("No active goal to complete.", "warning");
					return;
				}
				const result = await runCompletionFlow(ctx, "");
				const text = result.content?.[0]?.text ?? "";
				ctx.ui.notify(text.split("\n")[0] ?? "", result.isError ? "warning" : "info");
				return;
			}

			if (trimmed === "clear") {
				if (!goal) { ctx.ui.notify("No goal is set.", "info"); return; }
				const prev = goal;
				persist(pi, ctx, null);
				emit(pi, "cleared", prev);
				return;
			}

			if (trimmed === "pause" || trimmed === "resume") {
				if (!goal) { ctx.ui.notify("No goal is set.", "warning"); return; }
				const status: GoalStatus = trimmed === "pause" ? "paused" : "active";
				const next = { ...goal, status, updatedAt: now };
				persist(pi, ctx, next);
				emit(pi, status === "active" ? "resumed" : "paused", next);
				if (status === "active" && ctx.isIdle()) queueCont(pi, next);
				return;
			}

			const parsed = parseTokenBudget(trimmed);
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
			persist(pi, ctx, next);
			emit(pi, "active", next, { triggerTurn: ctx.isIdle() });
		},
	});

	// ── Event handlers ───────────────────────────────────────────────────
	pi.on("session_start", (event, ctx) => {
		const restored = restore(ctx);
		goal = restored.goal;
		statusBarEnabled = restored.statusBarEnabled;
		continuationQueued = false;
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
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!goal || goal.status !== "active" || ctx.hasPendingMessages()) return;
		queueCont(pi, goal);
	});
}
