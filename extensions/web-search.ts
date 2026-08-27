/**
 * Web Search & Research Extension
 *
 * Registers two native tools:
 *   - `web_search`   — quick search (synchronous, ~1-3s)
 *   - `web_research` — deep research (fire-and-forget, ~30-120s, delivers asynchronously)
 *
 * No skill files to read, no scripts to resolve — just native tool calls.
 *
 * Install:
 *   Place this file in ~/.pi/agent/extensions/web-search.ts
 *   Then /reload or restart pi.
 *
 * Requires TAVILY_API_KEY environment variable.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

function truncateToWidth(text: string, width: number): string {
	if (text.length <= width) return text;
	return text.slice(0, Math.max(0, width - 1)) + "…";
}

export default function webSearchExtension(pi: ExtensionAPI) {
	// ─── Quick Search Tool (synchronous) ───────────────────────────────────

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using the Tavily API. Returns relevant results with titles, URLs, relevance scores, and content snippets. Use for finding current information, documentation, news, facts, prices, or any web content.",
		promptSnippet: "Search the web for current information",
		promptGuidelines: [
			"Use web_search when you need current information not available in training data — prices, recent events, docs updates, real-time data.",
			"Keep queries concise (under 200 chars). Use keywords, not full sentences.",
			"Set time_range for time-sensitive queries (e.g., 'week', 'day').",
			"Use search_depth 'ultra-fast' or 'fast' for quick lookups; 'advanced' for thorough research.",
		],

		renderCall(args, _theme, context) {
			const text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(
				`web_search: ${truncateToWidth(args.query ?? "", 120)}`,
			);
			return text;
		},

		renderResult(
			result: { content: { type: string; text?: string }[]; details: unknown },
			options: { expanded: boolean; isPartial: boolean },
			_theme: any,
			context: any,
		): Component {
			const text = context.lastComponent ?? new Text("", 0, 0);
			const details = result.details as
				| {
						query: string;
						response_time_sec: number;
						total_results: number;
						results?: Array<{ title: string; url: string; score: number }>;
				  }
				| undefined;

			if (!options.expanded) {
				// Collapsed mode: just the result count (renderCall already shows the query)
				const count = details?.total_results ?? 0;
				text.setText(`— ${count} result${count !== 1 ? "s" : ""}`);
			} else {
				// Expanded mode: show full results
				const fullText = result.content
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text ?? "")
					.join("\n");
				text.setText(fullText);
			}
			return text;
		},
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query. Keep concise — keywords work better than full sentences. Max 200 chars.",
			}),
			max_results: Type.Optional(
				Type.Number({
					default: 5,
					description: "Number of results to return (1-10). Default 5. Lower = fewer tokens.",
				}),
			),
			time_range: Type.Optional(
				Type.String({
					default: null,
					description: "Time filter: 'day', 'week', 'month', 'year'. Omit for no filter.",
				}),
			),
			search_depth: Type.Optional(
				Type.String({
					default: "basic",
					description:
						"Search depth: 'ultra-fast' (fastest, lowest quality), 'fast', 'basic' (default, good), 'advanced' (slowest, highest quality).",
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Search cancelled" }], details: {} };
			}

			const apiKey = process.env.TAVILY_API_KEY;
			if (!apiKey) {
				throw new Error(
					"TAVILY_API_KEY is not set. Set it in ~/.pi/settings.json under env or export it.",
				);
			}

			onUpdate?.({
				content: [{ type: "text", text: `🔍 Searching for "${params.query}"...` }],
			});

			const body: Record<string, unknown> = {
				query: params.query,
				max_results: Math.min(params.max_results ?? 5, 10),
				search_depth: params.search_depth ?? "basic",
			};
			if (params.time_range) body.time_range = params.time_range;

			const response = await fetch("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal,
			});

			if (!response.ok) {
				const errText = await response.text().catch(() => "");
				throw new Error(`Tavily API error ${response.status}: ${errText.slice(0, 300)}`);
			}

			const parsed = (await response.json()) as {
				query: string;
				response_time: number;
				results?: Array<{
					title: string;
					url: string;
					content: string;
					score: number;
				}>;
				error?: string;
			};

			if (parsed.error) {
				throw new Error(`Search API error: ${parsed.error}`);
			}

			const results = (parsed.results ?? []).slice(0, params.max_results ?? 5);

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No results found for "${params.query}". Try broadening the query or using different keywords.`,
						},
					],
					details: { query: params.query, total: 0 },
				};
			}

			const lines = results.map(
				(r, i) =>
					`**[${i + 1}] ${r.title}**\n    ${r.url}\n    ${(r.content ?? "").slice(0, 400)}`,
			);

			return {
				content: [
					{
						type: "text",
						text: `## Search Results: "${params.query}"\n\n${lines.join("\n\n")}`,
					},
				],
				details: {
					query: params.query,
					response_time_sec: parsed.response_time,
					total_results: parsed.results?.length ?? 0,
					results: results.map((r) => ({
						title: r.title,
						url: r.url,
						score: r.score,
						content: (r.content ?? "").slice(0, 800),
					})),
				},
			};
		},
	});

	// ─── Deep Research Tool (fire-and-forget, async delivery) ──────────────

	// DISABLED: web_research tool is hidden from Pi
	if (false) pi.registerTool({
		name: "web_research",
		label: "Web Research",
		description:
			"Conduct comprehensive deep research on any topic with automatic source gathering, analysis, and citation generation. Uses Tavily's research API. For simple lookups, use web_search instead.",
		promptSnippet: "Conduct deep research with citations",
		promptGuidelines: [
			"Use web_research for multi-source synthesis — comparisons, market analysis, detailed reports with citations.",
			"Research takes 30-120 seconds. The tool returns immediately and delivers results asynchronously via a follow-up message.",
			"Use model 'mini' for quick targeted research (~30s), 'pro' for comprehensive multi-angle analysis (~60-120s).",
			"Be specific in your input: 'Compare React vs Vue for enterprise SPAs in 2025' beats 'React vs Vue'.",
		],
		parameters: Type.Object({
			input: Type.String({
				description:
					"Research topic or question. Be specific for better results. Example: 'Compare React vs Vue for enterprise SPAs in 2025'",
			}),
			model: Type.Optional(
				Type.String({
					default: "mini",
					description:
						"Research model: 'mini' (fast, ~30s, single-topic), 'pro' (comprehensive, ~60-120s, multi-source), or 'auto' (API chooses). Default: mini.",
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Research cancelled" }], details: {} };
			}

			const apiKey = process.env.TAVILY_API_KEY;
			if (!apiKey) {
				throw new Error(
					"TAVILY_API_KEY is not set. Set it in ~/.pi/settings.json under env or export it.",
				);
			}

			const model = params.model ?? "mini";
			const researchId = crypto.randomUUID();

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `🔬 Starting deep research on "${params.input}" (model: ${model})...`,
					},
				],
			});

			// Fire off the research request — don't await, let it run in background.
			// We capture `pi` from the factory closure to deliver results later.
			researchTask(apiKey, params.input, model, researchId, pi);

			return {
				content: [
					{
						type: "text",
						text: `🔬 Deep research started on **"${params.input}"** (model: **${model}**).\n\nThis will take ~30-120 seconds. You'll be notified with the full report when it's ready.`,
					},
				],
				details: {
					research_id: researchId,
					input: params.input,
					model,
				},
			};
		},
	});
}

// ─── Background Research Task ──────────────────────────────────────────────

async function researchTask(
	apiKey: string,
	input: string,
	model: string,
	researchId: string,
	pi: ExtensionAPI,
): Promise<void> {
	try {
		// Step 1: POST to /research to kick it off
		const initResponse = await fetch("https://api.tavily.com/research", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ input, model }),
		});

		if (!initResponse.ok) {
			const errText = await initResponse.text().catch(() => "");
			pi.sendUserMessage(
				`⚠️ **Research failed** (ID: \`${researchId}\`)\n\nTavily API error ${initResponse.status}: ${errText.slice(0, 500)}`,
			);
			return;
		}

		const initResult = (await initResponse.json()) as {
			request_id?: string;
			content?: string;
			report?: string;
			status?: string;
			error?: string;
		};

		if (initResult.error) {
			pi.sendUserMessage(
				`⚠️ **Research failed** (ID: \`${researchId}\`)\n\nAPI error: ${initResult.error}`,
			);
			return;
		}

		// Step 2: Check if response is synchronous (has content) or async (has request_id)
		const content = initResult.content ?? initResult.report;

		if (content) {
			// Synchronous — results are ready immediately
			pi.sendUserMessage(
				`✅ **Research Complete** — ${input}\n\n${content.slice(0, 15000)}`,
			);
			return;
		}

		const requestId = initResult.request_id;
		if (!requestId) {
			pi.sendUserMessage(
				`⚠️ **Research failed** (ID: \`${researchId}\`)\n\nUnexpected response format. No content or request_id returned.`,
			);
			return;
		}

		// Step 3: Async mode — poll for results
		await pollResearch(apiKey, requestId, input, researchId, pi);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		pi.sendUserMessage(
			`⚠️ **Research error** (ID: \`${researchId}\`)\n\n${message.slice(0, 1000)}`,
		);
	}
}

async function pollResearch(
	apiKey: string,
	requestId: string,
	input: string,
	researchId: string,
	pi: ExtensionAPI,
	maxPolls = 60,
	pollIntervalMs = 5000,
): Promise<void> {
	for (let i = 0; i < maxPolls; i++) {
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

		try {
			const pollResponse = await fetch(
				`https://api.tavily.com/research/${requestId}`,
				{
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
				},
			);

			if (!pollResponse.ok) {
				if (pollResponse.status === 404) {
					// Research may not have been picked up yet, keep polling
					continue;
				}
				const errText = await pollResponse.text().catch(() => "");
				pi.sendUserMessage(
					`⚠️ **Research polling error** (ID: \`${researchId}\`)\n\nHTTP ${pollResponse.status}: ${errText.slice(0, 500)}`,
				);
				return;
			}

			const pollResult = (await pollResponse.json()) as {
				status?: string;
				content?: string;
				report?: string;
				error?: string;
			};

			if (pollResult.error) {
				pi.sendUserMessage(
					`⚠️ **Research failed** (ID: \`${researchId}\`)\n\n${pollResult.error}`,
				);
				return;
			}

			if (pollResult.status === "completed") {
				const report = pollResult.content ?? pollResult.report ?? "";
				pi.sendUserMessage(
					`✅ **Research Complete** — ${input}\n\n${report.slice(0, 15000)}`,
				);
				return;
			}

			if (pollResult.status === "failed") {
				pi.sendUserMessage(
					`⚠️ **Research failed** (ID: \`${researchId}\`)\n\nThe research API reported a failure.`,
				);
				return;
			}

			// Status is "running" or "queued" — keep polling
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// Network error — retry on next poll
			console.error(`Research poll error (attempt ${i + 1}): ${message}`);
		}
	}

	// Timed out after max polls
	pi.sendUserMessage(
		`⚠️ **Research timed out** (ID: \`${researchId}\`)\n\nThe research did not complete within ${(maxPolls * pollIntervalMs) / 1000}s. You can try again with a more specific query or the 'pro' model.`,
	);
}
