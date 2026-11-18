import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function truncateToWidth(text: string, width: number): string {
	if (text.length <= width) return text;
	return text.slice(0, Math.max(0, width - 1)) + "…";
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_CONTENT_LENGTH = 100_000; // 100KB
const TIMEOUT = 60_000;
const RETRY_DELAYS = [0, 30_000, 90_000];

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/gif": ".gif",
	"image/webp": ".webp",
};

function getHeaders(includeJinaAuth = false): Record<string, string> {
	const headers: Record<string, string> = { "User-Agent": "pi-skill/1.0" };
	const apiKey = process.env["JINA_API_KEY"];
	if (includeJinaAuth && apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}
	return headers;
}

async function checkContentType(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, {
			method: "HEAD",
			headers: getHeaders(),
			signal: AbortSignal.timeout(TIMEOUT),
		});
		return response.headers.get("Content-Type")?.toLowerCase().split(";")[0] ?? null;
	} catch {
		return null;
	}
}

async function downloadImage(url: string): Promise<string> {
	const response = await fetch(url, {
		headers: getHeaders(),
		signal: AbortSignal.timeout(TIMEOUT),
	});

	const contentType = response.headers.get("Content-Type")?.toLowerCase().split(";")[0] ?? "";
	const ext = IMAGE_EXTENSIONS[contentType];
	if (!ext) {
		throw new Error(`Unsupported image type: ${contentType}`);
	}

	const contentLength = response.headers.get("Content-Length");
	if (contentLength && Number(contentLength) > MAX_IMAGE_SIZE) {
		throw new Error(`Image too large: ${contentLength} bytes (max ${MAX_IMAGE_SIZE})`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length > MAX_IMAGE_SIZE) {
		throw new Error(`Image too large: ${buffer.length} bytes (max ${MAX_IMAGE_SIZE})`);
	}

	const filePath = join(tmpdir(), `visit-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
	writeFileSync(filePath, buffer);
	return filePath;
}

type Crawl4aiConfig = { endpoint: string; token: string };

/** Crawl4AI is used when both CRAWL4AI_URL and CRAWL4AI_API_TOKEN are set. */
function getCrawl4aiConfig(): Crawl4aiConfig | null {
	const base = process.env["CRAWL4AI_URL"]?.trim();
	const token = process.env["CRAWL4AI_API_TOKEN"]?.trim();
	if (!base || !token) return null;
	return { endpoint: `${base.replace(/\/+$/, "")}/md`, token };
}

class FetchError extends Error {
	retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.retryable = retryable;
	}
}

async function fetchViaCrawl4ai(config: Crawl4aiConfig, url: string, signal?: AbortSignal): Promise<string> {
	const response = await fetch(config.endpoint, {
		method: "POST",
		headers: {
			...getHeaders(),
			Authorization: `Bearer ${config.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ url, f: "fit" }),
		signal: signal ?? AbortSignal.timeout(TIMEOUT),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new FetchError(
			`Crawl4AI HTTP ${response.status}${detail ? `: ${truncateToWidth(detail, 300)}` : ""}`,
			response.status === 451 || response.status >= 500,
		);
	}

	const parsed = (await response.json()) as { markdown?: string; success?: boolean; detail?: string };
	if (parsed.success === false) {
		throw new FetchError(`Crawl4AI crawl failed: ${parsed.detail ?? "unknown error"}`, true);
	}
	if (!parsed.markdown) {
		throw new FetchError("Crawl4AI returned empty markdown", true);
	}
	return parsed.markdown;
}

async function fetchViaJina(url: string, signal?: AbortSignal): Promise<string> {
	const response = await fetch(`https://r.jina.ai/${url}`, {
		headers: getHeaders(true),
		signal: signal ?? AbortSignal.timeout(TIMEOUT),
	});

	if (!response.ok) {
		throw new FetchError(`HTTP ${response.status} ${response.statusText}`, response.status === 451 || response.status >= 500);
	}

	return response.text();
}

async function fetchWebpage(url: string, signal?: AbortSignal): Promise<{ markdown: string; via: string }> {
	const crawl4ai = getCrawl4aiConfig();
	const via = crawl4ai ? "crawl4ai" : "jina";

	let lastError: Error | null = null;

	for (let i = 0; i < RETRY_DELAYS.length; i++) {
		if (RETRY_DELAYS[i] > 0) {
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[i]));
		}

		try {
			const text = crawl4ai ? await fetchViaCrawl4ai(crawl4ai, url, signal) : await fetchViaJina(url, signal);

			// Clean up multiple line breaks (same as Python re.sub(r"\n{3,}", "\n\n", content))
			const cleaned = text.replace(/\n{3,}/g, "\n\n");

			// Truncate if too long
			if (cleaned.length > MAX_CONTENT_LENGTH) {
				return { markdown: cleaned.slice(0, MAX_CONTENT_LENGTH) + "\n\n..._Content truncated_...", via };
			}

			return { markdown: cleaned, via };
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				throw err;
			}
			lastError = err instanceof Error ? err : new Error(String(err));
			if (err instanceof FetchError && !err.retryable) {
				break;
			}
		}
	}

	throw lastError ?? new Error("Failed after retries");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "visit_webpage",
		label: "Visit Webpage",
		description:
			"Fetch a URL and extract its content as markdown (via Crawl4AI when CRAWL4AI_URL + CRAWL4AI_API_TOKEN are set, otherwise Jina Reader), or download images to a temp file. " +
			"Use for reading articles, documentation, or any web page content. " +
			"Handles both HTML pages (JavaScript-rendered) and image URLs.",
		promptSnippet:
			"Fetch a webpage and extract content as markdown, or download images. Use this tool when the user asks to open, visit, fetch, or read a URL.",
		promptGuidelines: [
			"Use visit_webpage when the user asks to visit, open, fetch, or read a URL or website.",
			"visit_webpage handles both HTML pages (returns markdown) and images (downloads to temp file).",
			"Use the read tool to view downloaded images whose paths are returned by visit_webpage.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to visit (e.g., https://example.com/article)" }),
		}),
		renderCall(args, _theme, context) {
			const text: Text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(`visit_webpage: ${truncateToWidth(args.url ?? "", 120)}`);
			return text;
		},

		renderResult(
			result: { content: { type: string; text?: string }[]; details: unknown },
			options: { expanded: boolean; isPartial: boolean },
			_theme: any,
			context: any,
		): Component {
			const text: Text = context.lastComponent ?? new Text("", 0, 0);
			const details = result.details as { url?: string; type?: string; filePath?: string; via?: string } | undefined;

			if (!options.expanded) {
				// Collapsed mode: show a short summary
				if (details?.type === "image") {
					text.setText(`— Image saved to ${details.filePath ?? "temp file"}`);
				} else if (result.isError) {
					text.setText(`— Error fetching ${details?.url ?? "URL"}`);
				} else {
					const fullText = result.content
						.filter((c) => c.type === "text")
						.map((c) => c.text ?? "")
						.join("\n");
					// Count non-whitespace chars as content
					const contentLen = fullText.replace(/\s/g, "").length;
					text.setText(
						`— ${contentLen} chars fetched from ${details?.url ?? "URL"}${details?.via ? ` · ${details.via}` : ""}`,
					);
				}
			} else {
				// Expanded mode: show full content
				const fullText = result.content
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n");
				text.setText(fullText);
			}
			return text;
		},

		async execute(_toolCallId, params, signal, onUpdate) {
			const { url } = params;

			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				return {
					content: [{ type: "text", text: `Error: URL must start with http:// or https://\n\nGot: ${url}` }],
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `🌐 Fetching ${url}...` }],
			});

			try {
				// Check content type first via HEAD request
				const contentType = await checkContentType(url);

				if (contentType && contentType.startsWith("image/")) {
					// Handle image
					const filePath = await downloadImage(url);
					return {
						content: [
							{
								type: "text",
								text: `Image downloaded to: ${filePath}\n\nUse the read tool to view it: read ${filePath}`,
							},
						],
						details: { filePath, type: "image" },
					};
				}

				// Handle webpage
				const { markdown, via } = await fetchWebpage(url, signal);
				return {
					content: [{ type: "text", text: `## Content from ${url}\n\n${markdown}` }],
					details: { url, type: "html", via },
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error fetching ${url}: ${message}` }],
					isError: true,
				};
			}
		},
	});
}
