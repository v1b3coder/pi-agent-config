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

type Format = "md" | "html" | "png";

type Crawl4aiConfig = { base: string; token: string };

/** Crawl4AI is used when both CRAWL4AI_URL and CRAWL4AI_API_TOKEN are set. */
function getCrawl4aiConfig(): Crawl4aiConfig | null {
	const base = process.env["CRAWL4AI_URL"]?.trim();
	const token = process.env["CRAWL4AI_API_TOKEN"]?.trim();
	if (!base || !token) return null;
	return { base: base.replace(/\/+$/, ""), token };
}

function parseFormat(value: "md" | "html" | "png" | undefined): Format {
	return value ?? "md";
}

class FetchError extends Error {
	retryable: boolean;

	constructor(message: string, retryable: boolean) {
		super(message);
		this.retryable = retryable;
	}
}

function saveImage(buffer: Buffer, mime: string | undefined): string {
	if (buffer.length > MAX_IMAGE_SIZE) {
		throw new Error(`Image too large: ${buffer.length} bytes (max ${MAX_IMAGE_SIZE})`);
	}

	const ext = IMAGE_EXTENSIONS[mime?.toLowerCase() ?? ""] ?? ".png";
	const filePath = join(tmpdir(), `visit-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
	writeFileSync(filePath, buffer);
	return filePath;
}

async function crawl4aiPost(config: Crawl4aiConfig, path: string, body: unknown, signal?: AbortSignal): Promise<any> {
	const response = await fetch(`${config.base}${path}`, {
		method: "POST",
		headers: {
			...getHeaders(),
			Authorization: `Bearer ${config.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: signal ?? AbortSignal.timeout(TIMEOUT),
	});

	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new FetchError(
			`Crawl4AI ${path} HTTP ${response.status}${detail ? `: ${truncateToWidth(detail, 300)}` : ""}`,
			response.status === 451 || response.status >= 500,
		);
	}

	return response.json();
}

/** Neither /md nor /html accept css_selector, so selectors go through /crawl. */
async function crawl4aiCrawl(config: Crawl4aiConfig, url: string, selector: string | undefined, withFilter: boolean, signal?: AbortSignal): Promise<any> {
	const params: Record<string, unknown> = {};
	if (selector) params.css_selector = selector;
	if (withFilter) {
		params.markdown_generator = {
			type: "DefaultMarkdownGenerator",
			params: { content_filter: { type: "PruningContentFilter", params: {} } },
		};
	}

	const data = await crawl4aiPost(config, "/crawl", { urls: [url], crawler_config: { type: "CrawlerRunConfig", params } }, signal);
	const result = data?.results?.[0];
	if (!result) {
		throw new FetchError("Crawl4AI /crawl returned no results", true);
	}
	if (!result.success) {
		throw new FetchError(`Crawl4AI crawl failed: ${result.error_message ?? "unknown error"}`, true);
	}
	return result;
}

async function fetchMarkdownCrawl4ai(config: Crawl4aiConfig, url: string, selector: string | undefined, signal?: AbortSignal): Promise<string> {
	if (!selector) {
		const data = await crawl4aiPost(config, "/md", { url, f: "fit" }, signal);
		if (data?.success === false) {
			throw new FetchError(`Crawl4AI crawl failed: ${data?.detail ?? "unknown error"}`, true);
		}
		if (!data?.markdown?.trim()) {
			throw new FetchError("Crawl4AI returned empty markdown", true);
		}
		return data.markdown.trim();
	}

	const result = await crawl4aiCrawl(config, url, selector, true, signal);
	const markdown = result.markdown ?? {};
	const text = (markdown.fit_markdown || markdown.raw_markdown || "").trim();
	if (!text) {
		throw new FetchError(`Crawl4AI found no content for css_selector "${selector}"`, false);
	}
	return text;
}

async function fetchHtmlCrawl4ai(config: Crawl4aiConfig, url: string, selector: string | undefined, signal?: AbortSignal): Promise<string> {
	const result = await crawl4aiCrawl(config, url, selector, false, signal);
	const html = (result.cleaned_html || result.html || "").trim();
	// A non-matching selector yields an empty <html></html> shell rather than an error
	if (!html || (selector && !html.replace(/<[^>]*>/g, "").trim())) {
		throw new FetchError(
			selector ? `Crawl4AI found no HTML for css_selector "${selector}"` : "Crawl4AI returned empty HTML",
			!selector,
		);
	}
	return html;
}

async function fetchScreenshotCrawl4ai(config: Crawl4aiConfig, url: string, signal?: AbortSignal): Promise<string> {
	const data = await crawl4aiPost(config, "/screenshot", { url }, signal);
	if (!data?.screenshot) {
		throw new FetchError(`Crawl4AI screenshot failed: ${data?.detail ?? "no screenshot returned"}`, true);
	}
	return saveImage(Buffer.from(data.screenshot, "base64"), data.mime);
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

type Content = { kind: "markdown" | "html" | "image"; body: string; via: string };

async function fetchContent(
	url: string,
	format: Format,
	selector: string | undefined,
	signal?: AbortSignal,
): Promise<Content> {
	const crawl4ai = getCrawl4aiConfig();
	const via = crawl4ai ? "crawl4ai" : "jina";

	const fetchOnce = async (): Promise<Content> => {
		if (format === "png") {
			if (!crawl4ai) throw new FetchError("format 'png' requires Crawl4AI", false);
			return { kind: "image", body: await fetchScreenshotCrawl4ai(crawl4ai, url, signal), via };
		}

		if (format === "html") {
			if (!crawl4ai) throw new FetchError("format 'html' requires Crawl4AI", false);
			return { kind: "html", body: await fetchHtmlCrawl4ai(crawl4ai, url, selector, signal), via };
		}

		if (crawl4ai) {
			return { kind: "markdown", body: await fetchMarkdownCrawl4ai(crawl4ai, url, selector, signal), via };
		}
		if (selector) throw new FetchError("css_selector requires Crawl4AI", false);
		return { kind: "markdown", body: await fetchViaJina(url, signal), via };
	};

	let lastError: Error | null = null;

	for (let i = 0; i < RETRY_DELAYS.length; i++) {
		if (RETRY_DELAYS[i] > 0) {
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[i]));
		}

		try {
			const result = await fetchOnce();
			if (result.kind === "image") {
				return result;
			}

			// Clean up multiple line breaks (same as Python re.sub(r"\n{3,}", "\n\n", content))
			const cleaned = result.body.replace(/\n{3,}/g, "\n\n");

			// Truncate if too long
			result.body =
				cleaned.length > MAX_CONTENT_LENGTH
					? cleaned.slice(0, MAX_CONTENT_LENGTH) + "\n\n..._Content truncated_..."
					: cleaned;

			return result;
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
			"Fetch a URL and return its content as markdown (default), cleaned HTML, or a PNG screenshot saved to a temp file. " +
			"Uses Crawl4AI when CRAWL4AI_URL + CRAWL4AI_API_TOKEN are set, otherwise Jina Reader (markdown only). " +
			"Image URLs are downloaded to a temp file regardless of format.",
		promptSnippet:
			"Fetch a webpage as markdown, HTML, or screenshot, or download images. Use this tool when the user asks to open, visit, fetch, or read a URL.",
		promptGuidelines: [
			"Use visit_webpage when the user asks to visit, open, fetch, or read a URL or website.",
			"Default format 'md' returns readable markdown; use 'html' when you need page structure or attributes, 'png' when visual layout matters (screenshot goes to a temp file for the read tool).",
			"Use css_selector to drop navigation and boilerplate when you know the container element (e.g. 'article', '#search', 'td.title'). It works with format 'md' and 'html'.",
			"Use the read tool to view downloaded images or screenshots whose paths are returned by visit_webpage.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to visit (e.g., https://example.com/article)" }),
			format: Type.Optional(
				Type.Union([Type.Literal("md"), Type.Literal("html"), Type.Literal("png")], {
					description: "'md' (default) readable markdown, 'html' cleaned page HTML, 'png' screenshot saved to a temp file.",
				}),
			),
			css_selector: Type.Optional(
				Type.String({
					description:
						"CSS selector narrowing the extracted content, e.g. 'article', '#search', 'td.title'. Only for format 'md' or 'html'.",
				}),
			),
		}),
		renderCall(args, _theme, context) {
			const text: Text = context.lastComponent ?? new Text("", 0, 0);
			text.setText(`visit_webpage: ${truncateToWidth(args.url ?? "", 100)}${args.format && args.format !== "md" ? ` [${args.format}]` : ""}${args.css_selector ? ` {${truncateToWidth(args.css_selector, 40)}}` : ""}`);
			return text;
		},

		renderResult(
			result: { content: { type: string; text?: string }[]; details: unknown },
			options: { expanded: boolean; isPartial: boolean },
			_theme: any,
			context: any,
		): Component {
			const text: Text = context.lastComponent ?? new Text("", 0, 0);
			const details = result.details as
				| { url?: string; type?: string; filePath?: string; via?: string; format?: string }
				| undefined;

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
						`— ${contentLen} chars fetched from ${details?.url ?? "URL"}${details?.via ? ` · ${details.via}` : ""}${details?.format && details.format !== "md" ? ` · ${details.format}` : ""}`,
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
			const { url, css_selector } = params;

			if (!url.startsWith("http://") && !url.startsWith("https://")) {
				return {
					content: [{ type: "text", text: `Error: URL must start with http:// or https://\n\nGot: ${url}` }],
					isError: true,
				};
			}

			const format = parseFormat(params.format);
			const selector = css_selector?.trim() || undefined;

			if (format === "png" && selector) {
				return {
					content: [{ type: "text", text: "Error: css_selector cannot be combined with format 'png' (only the viewport is captured)." }],
					isError: true,
				};
			}

			if ((format !== "md" || selector) && !getCrawl4aiConfig()) {
				const needs = format === "md" ? "css_selector" : `format '${format}'`;
				return {
					content: [
						{
							type: "text",
							text: `Error: ${needs} needs Crawl4AI. Set CRAWL4AI_URL and CRAWL4AI_API_TOKEN, or use format 'md' (Jina Reader supports markdown only).`,
						},
					],
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
				const content = await fetchContent(url, format, selector, signal);

				if (content.kind === "image") {
					return {
						content: [
							{
								type: "text",
								text: `Screenshot saved to: ${content.body}\n\nUse the read tool to view it: read ${content.body}`,
							},
						],
						details: { filePath: content.body, type: "image", format, via: content.via },
					};
				}

				const heading = content.kind === "html" ? "## HTML from" : "## Content from";
				return {
					content: [{ type: "text", text: `${heading} ${url}\n\n${content.body}` }],
					details: { url, type: content.kind, format, via: content.via },
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
