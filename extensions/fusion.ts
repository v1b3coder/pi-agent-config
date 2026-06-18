/**
 * pi-fusion: local multi-model deliberation.
 *
 * Originally forked from pi-fusion-plugin by Sami R. (speculees).
 * Original: https://github.com/speculees/pi-fusion-plugin
 *
 * This version was simplified from the original plugin:
 *   - Removed external runtime dependency — everything is self-contained
 *     in a single extension file with no npm install/build step.
 *   - Replaced the crafted UI overlay with a direct pi-footer status widget.
 *   - Inlined the panel/judge model resolution instead of relying on a
 *     separate runtime config loader.
 *   - Dropped conversation-history injection into the panel prompt
 *     (panel models see only the current query, not prior turns).
 *   - Kept the core pipeline intact: parallel panel → judge synthesis
 *     → structured JSON output with consensus/contradictions/blind spots.
 *
 * Runs a prompt against a panel of authed models in parallel, then asks a
 * judge model to compare the responses and return structured analysis
 * (consensus, contradictions, partial coverage, unique insights, blind spots).
 *
 * Configuration via .pi/fusion.json or ~/.pi/agent/fusion.json:
 *   { "panel": ["provider/model", ...], "judge": "provider/model" }
 *
 * pi-footer integration via ctx.ui.setStatus("fusion", "Fusion: on" | "Fusion: off").
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { complete } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI as _ExtensionAPI,
	type ExtensionContext,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, AssistantMessage } from "@earendil-works/pi-ai";

// ─── Types ────────────────────────────────────────────────────────────────

interface FusionConfig {
	panel?: string[];
	judge?: string;
	maxPanelModels?: number;
	maxPanelOutputTokens?: number;
	maxCompletionTokens?: number;
	temperature?: number;
}

interface PanelResult {
	model: string;
	content: string;
	error?: string;
}

interface FusionAnalysis {
	consensus: string[];
	contradictions: Array<{ topic: string; stances: Array<{ model: string; stance: string }> }>;
	partial_coverage: Array<{ models: string[]; point: string }>;
	unique_insights: Array<{ model: string; insight: string }>;
	blind_spots: string[];
}

// ─── State ────────────────────────────────────────────────────────────────

let pi: _ExtensionAPI | undefined;
let enabled = false;

function setEnabled(ctx: ExtensionContext, value: boolean) {
	enabled = value;
	const text = value ? "Fusion: on" : "Fusion: off";
	ctx.ui.setStatus("fusion", text);
	pi?.events.emit("pi-footer:update-widget", { widgetId: "fusion", value: text });
}

// ─── Config ───────────────────────────────────────────────────────────────

const DEFAULTS = {
	maxPanelModels: 3,
	maxPanelOutputTokens: 2048,
	maxCompletionTokens: 4096,
	temperature: 0.3,
	MAX_PANEL_MODELS_HARD_LIMIT: 8,
	PANEL_CONCURRENCY: 4,
};

function loadConfig(cwd: string, projectTrusted: boolean): FusionConfig {
	const paths: string[] = [];
	if (projectTrusted) paths.push(join(cwd, ".pi", "fusion.json"));
	paths.push(join(getAgentDir(), "fusion.json"));

	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			return JSON.parse(readFileSync(path, "utf8")) as FusionConfig;
		} catch (err) {
			console.error(`[fusion] failed to parse ${path}:`, err);
		}
	}
	return {};
}

// ─── Model resolution ─────────────────────────────────────────────────────

function modelDisplay(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function resolveModel(registry: ModelRegistry, identifier: string): Model<Api> | undefined {
	const slash = identifier.indexOf("/");
	if (slash > 0) {
		return registry.find(identifier.slice(0, slash), identifier.slice(slash + 1));
	}
	return registry.getAll().find((m) => m.id === identifier);
}

function selectDiversePanel(available: Model<Api>[], max: number): Model<Api>[] {
	const textModels = available.filter((m) => m.input.includes("text"));
	if (textModels.length === 0) return [];

	const byProvider = new Map<string, Model<Api>[]>();
	for (const m of textModels) {
		(byProvider.get(m.provider) ?? byProvider.set(m.provider, []).get(m.provider))!.push(m);
	}

	const providers = Array.from(byProvider.keys());
	const chosen: Model<Api>[] = [];
	for (let round = 0; chosen.length < max; round++) {
		let added = false;
		for (const provider of providers) {
			const candidate = byProvider.get(provider)![round];
			if (!candidate) continue;
			if (!chosen.some((c) => c.provider === candidate.provider && c.id === candidate.id)) {
				chosen.push(candidate);
				added = true;
				if (chosen.length >= max) break;
			}
		}
		if (!added) break;
	}
	return chosen;
}

async function resolvePanelAndJudge(
	registry: ModelRegistry,
	config: FusionConfig,
	currentModel?: Model<Api>,
): Promise<{ panel: Model<Api>[]; judge: Model<Api> }> {
	const maxPanel = Math.min(config.maxPanelModels ?? DEFAULTS.maxPanelModels, DEFAULTS.MAX_PANEL_MODELS_HARD_LIMIT);

	// Config → auto-diverse → current model fallback.
	let panel: Model<Api>[] = [];
	if (config.panel?.length) {
		for (const id of config.panel) {
			const m = resolveModel(registry, id);
			if (m && registry.hasConfiguredAuth(m) && !panel.some((p) => p.provider === m.provider && p.id === m.id)) {
				panel.push(m);
			}
		}
	}
	if (panel.length === 0) {
		panel = selectDiversePanel(registry.getAvailable(), maxPanel);
	}
	if (panel.length === 0 && currentModel && registry.hasConfiguredAuth(currentModel)) {
		panel = [currentModel];
	}
	if (panel.length === 0) {
		throw new Error("No authed models available for fusion. Configure ~/.pi/agent/fusion.json or authenticate more providers.");
	}
	if (panel.length > maxPanel) panel = panel.slice(0, maxPanel);

	// Judge: config → current model → first panel model.
	let judge: Model<Api> | undefined;
	if (config.judge) {
		judge = resolveModel(registry, config.judge);
	}
	if (!judge && currentModel && registry.hasConfiguredAuth(currentModel)) {
		judge = currentModel;
	}
	if (!judge) judge = panel[0];

	return { panel, judge };
}

// ─── LLM calls ────────────────────────────────────────────────────────────

async function callModel(
	registry: ModelRegistry,
	model: Model<Api>,
	systemPrompt: string,
	userText: string,
	maxTokens: number,
	temperature: number,
	signal?: AbortSignal,
): Promise<AssistantMessage> {
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) throw new Error(`No API key for ${modelDisplay(model)}`);

	return complete(model, { systemPrompt, messages: [{ role: "user", content: userText, timestamp: Date.now() }] }, {
		apiKey: auth.apiKey,
		headers: auth.headers,
		signal,
		maxTokens,
		temperature,
	});
}

function getText(msg: AssistantMessage): string {
	return msg.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

async function mapWithConcurrencyLimit<TIn, TOut>(items: TIn[], concurrency: number, fn: (item: TIn) => Promise<TOut>): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: limit }, async () => {
		while (true) {
			const idx = next++;
			if (idx >= items.length) return;
			results[idx] = await fn(items[idx]);
		}
	}));
	return results;
}

function truncateForJudge(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
	let end = buf.length;
	let start = end - 1;
	while (start >= 0 && (buf[start] & 0xc0) === 0x80) start--;
	if (start >= 0) {
		const lead = buf[start];
		const expected = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
		if (start + expected > end) end = start;
	}
	return buf.subarray(0, end).toString("utf8") + "\n\n[truncated for judge context window]";
}

function extractJson<T>(text: string): T | undefined {
	try { return JSON.parse(text) as T; } catch { /* ignore */ }
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
	if (fenced?.[1]) try { return JSON.parse(fenced[1]) as T; } catch { /* ignore */ }
	const brace = text.match(/\{[\s\S]*\}/);
	if (brace) try { return JSON.parse(brace[0]) as T; } catch { /* ignore */ }
	return undefined;
}

// ─── System prompts ───────────────────────────────────────────────────────

const PANEL_PROMPT = `You are an independent panelist in a multi-model deliberation.

Answer the user's question thoroughly and to the best of your ability. You do not have access to tools; rely on your training knowledge. Be concise but complete. Do not mention that you are part of a panel or refer to other models.`;

const JUDGE_PROMPT = `You are a critical judge comparing responses from a panel of AI models.

Given a task and the panel responses, return ONLY a JSON object with exactly this shape and no markdown code fences:

{
  "consensus": ["Points all or most panel models agree on. Treat these as higher-confidence."],
  "contradictions": [
    {
      "topic": "What they disagree about",
      "stances": [
        {"model": "provider/id", "stance": "What this model said"}
      ]
    }
  ],
  "partial_coverage": [
    {"models": ["provider/id"], "point": "Point only some models covered"}
  ],
  "unique_insights": [
    {"model": "provider/id", "insight": "Something only one model raised"}
  ],
  "blind_spots": ["Topics none of the panel models addressed"]
}

Guidelines:
- Compare rather than merge. Do not average opinions.
- Treat agreement across models as higher-confidence consensus.
- Surface real contradictions; do not invent them.
- Preserve unique insights from individual models.
- Flag blind spots the panel missed entirely.
- Output valid JSON only.`;

// ─── Core pipeline ────────────────────────────────────────────────────────

function classifyFailure(failed: PanelResult[]): string {
	const msgs = failed.map((f) => (f.error ?? "").toLowerCase());
	if (msgs.some((m) => m.includes("credit") || m.includes("quota") || m.includes("billing"))) return "insufficient_credits";
	if (msgs.some((m) => m.includes("rate limit") || m.includes("429"))) return "rate_limited";
	return "all_panels_failed";
}

async function runFusion(
	registry: ModelRegistry,
	prompt: string,
	config: FusionConfig,
	currentModel: Model<Api> | undefined,
	signal: AbortSignal | undefined,
): Promise<{ content: string; details: unknown }> {
	const { panel, judge } = await resolvePanelAndJudge(registry, config, currentModel);
	const maxPanelTokens = config.maxPanelOutputTokens ?? DEFAULTS.maxPanelOutputTokens;
	const maxCompletionTokens = config.maxCompletionTokens ?? DEFAULTS.maxCompletionTokens;
	const temperature = config.temperature ?? DEFAULTS.temperature;

	// Run panel
	const rawResults = await mapWithConcurrencyLimit(panel, DEFAULTS.PANEL_CONCURRENCY, async (model) => {
		const base = { model: modelDisplay(model) };
		try {
			const resp = await callModel(registry, model, PANEL_PROMPT, prompt, maxPanelTokens, temperature, signal);
			const content = getText(resp);
			return { ...base, content, error: content.trim() ? undefined : "empty response" };
		} catch (err) {
			return { ...base, content: "", error: err instanceof Error ? err.message : String(err) };
		}
	});

	const successful = rawResults.filter((r): r is PanelResult & { error: undefined } => !r.error);
	const failed = rawResults.filter((r): r is PanelResult & { error: string } => !!r.error);

	if (successful.length === 0) {
		return {
			content: JSON.stringify({
				status: "error",
				responses: [],
				failed_models: failed.map((f) => ({ model: f.model, error: f.error })),
				panel_models: panel.map(modelDisplay),
				judge_model: modelDisplay(judge),
				error: "all panel models failed",
				failure_reason: classifyFailure(failed),
			}, null, 2),
			details: { status: "error" },
		};
	}

	// Judge synthesis (2+ successful responses)
	let analysis: FusionAnalysis | undefined;
	if (successful.length >= 2) {
		const budget = Math.max(1024, Math.floor(judge.contextWindow / Math.max(successful.length * 2, 8)));
		const judgeText = `Task:\n${prompt}\n\n` +
			successful.map((r) => `--- Response from ${r.model} ---\n${truncateForJudge(r.content, budget)}`).join("\n\n");

		try {
			const resp = await callModel(registry, judge, JUDGE_PROMPT, judgeText, maxCompletionTokens, temperature, signal);
			analysis = extractJson<FusionAnalysis>(getText(resp));
		} catch (err) {
			console.error("[fusion] judge failed:", err);
		}
	}

	const details = {
		status: "ok" as const,
		analysis,
		responses: successful.map((r) => ({ model: r.model, content: r.content })),
		...(failed.length > 0 ? { failed_models: failed.map((f) => ({ model: f.model, error: f.error })) } : {}),
		panel_models: panel.map(modelDisplay),
		judge_model: modelDisplay(judge),
	};

	return {
		content: JSON.stringify(details, null, 2),
		details,
	};
}

// ─── Extension entry point ───────────────────────────────────────────────

export default function (api: _ExtensionAPI) {
	pi = api;
	// Restore fusion state on session start (from stored flag).
	// We store the enabled flag as a simple custom entry.
	api.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e.type === "custom" && e.customType === "fusion-state" && "data" in e && e.data) {
				enabled = !!(e.data as { enabled?: boolean }).enabled;
				ctx.ui.setStatus("fusion", enabled ? "Fusion: on" : "Fusion: off");
				break;
			}
		}
	});

	function ensureConfigFile(cwd: string, projectTrusted: boolean) {
		// Check in priority order: project then global
		const projectPath = projectTrusted ? join(cwd, ".pi", "fusion.json") : undefined;
		const globalPath = join(getAgentDir(), "fusion.json");

		if (projectPath && existsSync(projectPath)) return { path: projectPath, label: "project", existed: true };
		if (existsSync(globalPath)) return { path: globalPath, label: "global", existed: true };

		// No config exists — write sample to the global (user-level) path which works across projects
		const target = { path: globalPath, label: "global" };
		const sample = JSON.stringify(
			{
				$comment: "Fusion multi-model deliberation config. Edit panel and judge models below.",
				panel: [
					"provider/model-id",
				],
				judge: "provider/model-id",
				maxPanelModels: 3,
				maxPanelOutputTokens: 2048,
				maxCompletionTokens: 4096,
				temperature: 0.3,
			},
			null,
			2,
		);
		mkdirSync(dirname(target.path), { recursive: true });
		writeFileSync(target.path, sample, "utf8");
		return { path: target.path, label: target.label, existed: false };
	}

	api.registerCommand("fusion", {
		description: "Toggle fusion: /fusion on, /fusion off, /fusion status",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "enable") {
				const configResult = ensureConfigFile(ctx.cwd, ctx.isProjectTrusted());
				if (!configResult.existed) {
					ctx.ui.notify(
						`Created sample ${configResult.label} config at ${configResult.path}. Edit it to set your panel/judge models.`,
						"info",
					);
				}
				if (!enabled) setEnabled(ctx, true);
				ctx.ui.notify(enabled ? "Fusion is on" : "Fusion is off", "info");
				// Persist
				api.appendEntry("fusion-state", { enabled, timestamp: Date.now() });
			} else if (arg === "off" || arg === "disable") {
				if (enabled) setEnabled(ctx, false);
				ctx.ui.notify("Fusion is off", "info");
				api.appendEntry("fusion-state", { enabled, timestamp: Date.now() });
			} else {
				ctx.ui.notify(`Fusion is ${enabled ? "on" : "off"}. Usage: /fusion on|off`, "info");
			}
		},
	});

	api.registerTool({
		name: "fusion",
		label: "Fusion",
		description: [
			"Multi-model deliberation. Runs a prompt against a panel of models in parallel,",
			"then a judge compares responses and returns structured analysis (consensus,",
			"contradictions, partial coverage, unique insights, blind spots).",
			"Configure panel and judge in .pi/fusion.json or ~/.pi/agent/fusion.json.",
		].join(" "),
		promptSnippet: "Run multi-model deliberation on complex research, critique, or comparison prompts.",
		promptGuidelines: [
			"Use fusion when a task benefits from multiple perspectives: research, expert critique,",
			"multi-domain analysis, compare/contrast decisions, architecture trade-offs, or anything",
			"where being wrong is expensive.",
			"Do not use for simple tactical prompts, straightforward edits, or routine file operations.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description: "The question, task, or topic to analyze.",
			}),
		}, { description: "Multi-model deliberation parameters" }),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!enabled) {
				return {
					content: [{ type: "text", text: JSON.stringify({ status: "error", error: "fusion is off. Run /fusion on to enable." }, null, 2) }],
					details: { status: "error", error: "fusion disabled" },
				};
			}
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			const result = await runFusion(ctx.modelRegistry, params.prompt, config, ctx.model, signal);
			return {
				content: [{ type: "text", text: result.content }],
				details: result.details,
			};
		},
	});
}
