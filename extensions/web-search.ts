/**
 * Web Search Extension
 *
 * Registers one native tool:
 *   - `web_search` — Tavily search with scores, publish dates, optional LLM answer
 *
 * No skill files to read, no scripts to resolve — just native tool calls.
 *
 * Install:
 *   Place this file in ~/.pi/agent/extensions/web-search.ts
 *   Then /reload or restart pi.
 *
 * Requires TAVILY_API_KEY environment variable.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Left-strip rendering (same pattern as extensions/left-strip-tools.ts) ──

type BgFn = (s: string) => string;

/**
 * Renders each line with a colored strip on the leftmost character position,
 * keeping the rest of the line on the default background.
 */
class LeftStripBlock {
	private lines: string[];
	private getBgFn: () => BgFn;

	constructor(lines: string[], getBgFn: () => BgFn) {
		this.lines = lines;
		this.getBgFn = getBgFn;
	}

	render(width: number): string[] {
		const bgFn = this.getBgFn();
		return this.lines.map((line) => {
			if (line === "") return "";
			return (
				bgFn(" ") +
				"\x1b[49m " +
				truncateToWidth(line, Math.max(1, width - 2))
			);
		});
	}

	invalidate(): void {
		// Nothing cached — getBgFn is called per render
	}
}

function pendingOrDoneColor(
	isDone: boolean,
	isError: boolean,
	theme: Theme,
): BgFn {
	const color = isDone
		? isError
			? "toolErrorBg"
			: "toolSuccessBg"
		: "toolPendingBg";
	return (s: string) => theme.bg(color, s);
}

function resultBg(isError: boolean, theme: Theme): BgFn {
	return (s: string) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", s);
}

// Tavily returns ~500 chars per chunk (800 at advanced depth) and 3 chunks per
// source by default, so anything below ~1.5K chars silently discards retrieval.
const MAX_SNIPPET_CHARS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
// 429 = rate limit, 434 = flex-tier capacity exceeded.
const RETRYABLE_STATUS = new Set([429, 434, 500, 502, 503, 504]);

type TavilyResult = {
	title: string;
	url: string;
	content?: string;
	score: number;
	published_date?: string | null;
};

type TavilySearchResponse = {
	query: string;
	answer?: string;
	response_time: number;
	results?: TavilyResult[];
	usage?: { credits: number };
	error?: string;
};

/** Search with a hard timeout, retrying the transient statuses Tavily uses. */
async function tavilyFetch(
	apiKey: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const response = await fetch("https://api.tavily.com/search", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!RETRYABLE_STATUS.has(response.status) || attempt >= MAX_ATTEMPTS) {
			return response;
		}
		await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
	}
}

/** Tavily dates are RFC-ish strings; ISO day is what the model can compare. */
function shortDate(value: string | null | undefined): string | null {
	if (!value) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime())
		? value
		: parsed.toISOString().slice(0, 10);
}

function formatSearchResults(
	query: string,
	depth: string,
	parsed: TavilySearchResponse,
	results: TavilyResult[],
): string {
	const header = `## Search Results: "${query}" · ${depth} · ${results.length} result${results.length === 1 ? "" : "s"}`;
	const answer = parsed.answer ? `**Tavily answer:** ${parsed.answer}\n\n` : "";
	const body = results.map((r, i) => {
		const meta = [`score ${(r.score ?? 0).toFixed(2)}`];
		const published = shortDate(r.published_date);
		if (published) meta.push(`published ${published}`);
		const content = r.content ?? "";
		const snippet =
			content.length > MAX_SNIPPET_CHARS
				? `${content.slice(0, MAX_SNIPPET_CHARS)} …(truncated)`
				: content;
		return `**[${i + 1}] ${r.title}** · ${meta.join(" · ")}\n    ${r.url}\n    ${snippet}`;
	});
	return `${header}\n\n${answer}${body.join("\n\n")}`;
}

export default function webSearchExtension(pi: ExtensionAPI) {
	// ─── Quick Search Tool (synchronous) ───────────────────────────────────

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Tavily. Returns ranked results with relevance score, publish date and up to 2 KB of content per source, plus an optional LLM-written answer. Use for current information, documentation, news, facts, prices.",
		promptSnippet: "Search the web for current information",
		promptGuidelines: [
			"Use web_search when you need current information not available in training data — prices, recent events, docs updates, real-time data.",
			"search_depth defaults to 'advanced' (2 credits, best snippets). Use 'basic' or 'fast' when latency matters; 'ultra-fast' only for throwaway lookups.",
			"Keep queries under 400 characters; keywords beat full sentences. Split multi-part questions into separate searches.",
			"Set time_range, or start_date/end_date, for anything time-sensitive. Results carry a published date so you can judge recency.",
			"Use topic 'news' for breaking events and 'finance' for markets; include_domains to pin trusted sources (e.g. ['docs.python.org']), exclude_domains to drop content farms.",
			"include_answer adds a Tavily-written summary grounded in the results — fine for facts, still verify anything precise against the sources.",
			"chunks_per_source (1-3) controls snippet length per source: raise it for dense technical docs, lower it to save tokens.",
			"max_results defaults to 5 (~2.5K tokens). Raise to 10-20 only for broad coverage or comparisons.",
		],

		renderShell: "self",

		renderCall(args, theme, context) {
			const query = String(args.query ?? "").split("\n")[0] ?? "";
			const title =
				theme.fg("toolTitle", theme.bold("web_search ")) +
				theme.fg("accent", truncateToWidth(query, 120));
			return new LeftStripBlock([title], () =>
				pendingOrDoneColor(!context.isPartial, context.isError, theme),
			);
		},

		renderResult(result, options, theme, context): Component {
			if (options.isPartial) {
				return new LeftStripBlock(
					[theme.fg("accent", "→ searching...")],
					() => (s: string) => theme.bg("toolPendingBg", s),
				);
			}

			const details = result.details as
				| {
						query: string;
						search_depth?: string;
						response_time_sec?: number;
						total_results?: number;
						credits?: number;
						results?: Array<{ title: string; url: string; score: number }>;
				  }
				| undefined;

			if (!options.expanded && !context.isError) {
				// Collapsed mode: just the result count (renderCall already shows the query)
				const count = details?.total_results ?? 0;
				const credits = details?.credits;
				const hint = keyHint("app.tools.expand", "to expand");
				return new LeftStripBlock(
					[
						theme.fg(
							"dim",
							`└ ${count} result${count !== 1 ? "s" : ""}${
								credits ? ` · ${credits} credit${credits !== 1 ? "s" : ""}` : ""
							} · ${hint}`,
						),
					],
					() => resultBg(false, theme),
				);
			}

			// Expanded mode: show full results
			const fullText = result.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text ?? "")
				.join("\n");
			return new LeftStripBlock(fullText.split("\n"), () =>
				resultBg(context.isError, theme),
			);
		},
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query. Keep concise — keywords work better than full sentences. Max 400 chars.",
			}),
			max_results: Type.Optional(
				Type.Number({
					default: 5,
					minimum: 1,
					maximum: 20,
					description: "Number of results to return (1-20). Default 5. Lower = fewer tokens.",
				}),
			),
			search_depth: Type.Optional(
				Type.Union(
					[
						Type.Literal("ultra-fast"),
						Type.Literal("fast"),
						Type.Literal("basic"),
						Type.Literal("advanced"),
					],
					{
						default: "advanced",
						description:
							"'advanced' (default, 2 credits, most relevant snippets), 'basic' (1 credit, summary), 'fast' (1 credit, chunks), 'ultra-fast' (1 credit, one summary per source).",
					},
				),
			),
			topic: Type.Optional(
				Type.Union(
					[
						Type.Literal("general"),
						Type.Literal("news"),
						Type.Literal("finance"),
					],
					{
						default: "general",
						description:
							"Search category: 'general' (default), 'news' for breaking events, 'finance' for markets.",
					},
				),
			),
			time_range: Type.Optional(
				Type.Union(
					[
						Type.Literal("day"),
						Type.Literal("week"),
						Type.Literal("month"),
						Type.Literal("year"),
					],
					{ description: "Time filter relative to today: 'day', 'week', 'month', 'year'." },
				),
			),
			start_date: Type.Optional(
				Type.String({
					description: "Only results published on or after this date, format YYYY-MM-DD.",
				}),
			),
			end_date: Type.Optional(
				Type.String({
					description: "Only results published on or before this date, format YYYY-MM-DD.",
				}),
			),
			chunks_per_source: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 3,
					description:
						"Snippet chunks per source (1-3). Default 3. Raise for dense docs, lower to save tokens. Ignored at 'ultra-fast'.",
				}),
			),
			include_answer: Type.Optional(
				Type.Boolean({
					default: false,
					description:
						"Add a short LLM-written answer grounded in the results. Costs no extra credits; useful for factual lookups.",
				}),
			),
			include_domains: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Restrict results to these domains (max 300), e.g. ['docs.python.org', 'github.com'].",
				}),
			),
			exclude_domains: Type.Optional(
				Type.Array(Type.String(), {
					description: "Drop results from these domains (max 150).",
				}),
			),
			language: Type.Optional(
				Type.String({
					description:
					"Boost results in this language (ISO 639-1, e.g. 'cs'). Write the query in the same language.",
				}),
			),
			country: Type.Optional(
				Type.String({
					description:
					"Boost results from this country, lowercase English name (e.g. 'czech republic'). Only with topic 'general'.",
				}),
			),
			exact_match: Type.Optional(
				Type.Boolean({
					default: false,
					description:
						"Return only results containing the quoted phrases from the query, bypassing synonyms.",
				}),
			),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Search cancelled" }], isError: true, details: {} };
			}

			const apiKey = process.env.TAVILY_API_KEY;
			if (!apiKey) {
				throw new Error(
					"TAVILY_API_KEY is not set. Set it in ~/.pi/settings.json under env or export it.",
				);
			}

			onUpdate?.({
				content: [{ type: "text", text: `🔍 Searching for "${params.query}"...` }],
				details: {},
			});

			const depth = params.search_depth ?? "advanced";
			const maxResults = Math.min(Math.max(params.max_results ?? 5, 1), 20);

			const body: Record<string, unknown> = {
				query: params.query,
				max_results: maxResults,
				search_depth: depth,
				// Neither costs extra credits: we need recency to trust a result,
				// and credit usage to keep spend visible.
				include_published_date: true,
				include_usage: true,
			};
			if (params.topic) body.topic = params.topic;
			if (params.time_range) body.time_range = params.time_range;
			if (params.start_date) body.start_date = params.start_date;
			if (params.end_date) body.end_date = params.end_date;
			if (params.chunks_per_source && depth !== "ultra-fast") {
				body.chunks_per_source = params.chunks_per_source;
			}
			if (params.include_answer) body.include_answer = true;
			if (params.include_domains?.length) body.include_domains = params.include_domains;
			if (params.exclude_domains?.length) body.exclude_domains = params.exclude_domains;
			if (params.language) body.language = params.language;
			if (params.country) body.country = params.country;
			if (params.exact_match) body.exact_match = true;

			const response = await tavilyFetch(apiKey, body, signal);

			if (!response.ok) {
				const errText = await response.text().catch(() => "");
				throw new Error(`Tavily API error ${response.status}: ${errText.slice(0, 300)}`);
			}

			const parsed = (await response.json()) as TavilySearchResponse;

			if (parsed.error) {
				throw new Error(`Search API error: ${parsed.error}`);
			}

			const results = (parsed.results ?? []).slice(0, maxResults);

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

			return {
				content: [
					{
						type: "text",
						text: formatSearchResults(params.query, depth, parsed, results),
					},
				],
				details: {
					query: params.query,
					search_depth: depth,
					topic: params.topic ?? "general",
					response_time_sec: parsed.response_time,
					total_results: results.length,
					credits: parsed.usage?.credits,
					results: results.map((r) => ({
						title: r.title,
						url: r.url,
						score: r.score,
						published_date: r.published_date,
						content: (r.content ?? "").slice(0, MAX_SNIPPET_CHARS),
					})),
				},
			};
		},
	});
}
