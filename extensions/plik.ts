/**
 * plik — share files and text through a self-hosted Plik instance.
 *
 * Registers two native tools that call the Plik REST API directly:
 *   - `share_file` — upload a local file by absolute path
 *   - `share_text` — upload inline text as a named file
 *
 * Both require a `comments` description of the content. Optional `ttl`,
 * `one_shot`, and `removable` default to the server's behavior; optional `slug`
 * additionally reserves a human-readable name for the result.
 *
 * Each share creates an upload with one file reference, then uploads the file:
 *   POST /upload                          { files: [{ fileName, fileSize, reference }] }
 *   POST /file/{uploadID}/{fileID}/{name}   multipart field "file"
 *
 * A short-lived PIN is minted for the resulting download URL so the recipient
 * can type a 6-character code instead of the long URL:
 *   POST /pin/mint  { url, ttl }  →  { code, short, expires, ttl }
 *
 * When `slug` is given, a human-readable reservation is written for the same
 * URL, and reusing a slug this user already owns repoints it at the new upload:
 *   PUT /pin/slug/{slug}  { url }  →  { slug, short, expires, created }
 * The server lowercases the requested name, so its answer is the canonical one.
 *
 * Both are best-effort: any failure (service down, slug taken, upload about to
 * expire) leaves `pin`/`slug` null plus a note, and the share still returns the
 * full download URL.
 *
 * The PIN and slug endpoints authenticate with the same `X-PlikToken` header as
 * the rest of the API (`Authorization: Bearer` is not read), so one token does
 * everything.
 *
 * Configuration comes from the environment, read at call time:
 *   PLIK_URL         required base URL, e.g. https://share.slush.cz
 *   PLIK_TOKEN       Plik API token (`plik_…`), created in the Plik web UI
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type UploadParams = {
	ttl?: number;
	one_shot?: boolean;
	removable?: boolean;
	slug?: string;
	comments: string;
};

/** A request body plus the exact byte count to declare to the server. */
type Payload = {
	size: number;
	open: () => Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
};

type PlikFile = { id: string; fileName: string };

type PlikUpload = {
	id: string;
	files: PlikFile[];
	downloadURL?: string;
	downloadDomain?: string;
	expireAt?: string;
	oneShot?: boolean;
	removable?: boolean;
};

const PIN_TTL_SECONDS = 1800;
const PIN_TIMEOUT_MS = 8_000;

/** Pins TLS to HTTP/1.1 so uploads are not throttled by HTTP/2 flow control. */
const HTTPS1_AGENT = new https.Agent({ ALPNProtocols: ["http/1.1"] });

type Pin = {
	code: string;
	short: string;
	page: string;
	expires?: string;
	ttl: number;
};

type Slug = {
	name: string;
	url: string;
	created: boolean;
	expires?: string;
};

/** Statuses whose bare code does not say what the caller can do about it. */
const SLUG_HINTS: Record<number, string> = {
	403: "the upload belongs to another user",
	409: "the slug is reserved by another owner",
	410: "the upload must stay valid for at least 60 s",
	507: "the slug table is full (10 000)",
};

const uploadParams = {
	ttl: Type.Optional(
		Type.Number({ description: "Time to live in seconds (0 = server default)" }),
	),
	one_shot: Type.Optional(
		Type.Boolean({ description: "Delete the file after the first download" }),
	),
	removable: Type.Optional(
		Type.Boolean({ description: "Allow anyone to delete the upload" }),
	),
	slug: Type.Optional(
		Type.String({
			pattern: "^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$",
			description:
				"Optional human-readable slug (3-63 chars, lowercase a-z 0-9 and dashes, no leading or trailing dash). " +
				"Reusing a slug you already own repoints it at this new upload, which makes it a long-lived link. " +
				"The slug expires together with this upload, so set ttl if it should outlive the default.",
		}),
	),
	comments: Type.String({
		minLength: 1,
		description: "Markdown comment describing what the shared content is",
	}),
};

function config(): { base: string; token: string } {
	const base = process.env.PLIK_URL?.replace(/\/+$/, "");
	const token = process.env.PLIK_TOKEN;
	if (!base || !token) {
		throw new Error(
			"PLIK_URL and PLIK_TOKEN must be set (see ~/.pi/agent/.env.local)",
		);
	}
	return { base, token };
}

async function call(url: string, init: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		throw transportError(init.method ?? "GET", url, error);
	}
	if (!response.ok) {
		const detail = (await response.text()).trim();
		throw new Error(
			`Plik ${init.method ?? "GET"} ${url} failed (${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	return response;
}

/** Build a transport error that keeps the underlying cause (undici reports a bare "fetch failed"). */
function transportError(method: string, url: string, error: unknown): Error {
	const cause = (error as { cause?: { code?: string; message?: string } }).cause;
	return new Error(
		`Plik ${method} ${url} failed: ${String(error)} <- ${cause?.code || cause?.message || "unknown cause"}`,
	);
}

/**
 * POST a streamed body over HTTP/1.1.
 *
 * `fetch()` negotiates HTTP/2, whose default per-stream flow-control window is
 * 64 KiB: on a 64 ms path that caps the body at ~1 MB/s no matter how the file
 * is chunked, while the same upload over HTTP/1.1 uses the whole link (~19x
 * faster here). Pinning ALPN to http/1.1 also keeps backpressure native.
 */
async function postStream(
	url: string,
	headers: Record<string, string>,
	body: Readable,
	signal?: AbortSignal,
): Promise<void> {
	const target = new URL(url);
	const transport = target.protocol === "http:" ? http : https;
	let status: number;
	let detail: string;
	try {
		const result = await new Promise<{ status: number; detail: string }>((resolve, reject) => {
			const request = transport.request(
				target,
				{
					method: "POST",
					headers,
					signal,
					...(target.protocol === "https:" ? { agent: HTTPS1_AGENT } : {}),
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () =>
						resolve({ status: response.statusCode ?? 0, detail: Buffer.concat(chunks).toString().trim() }),
					);
					response.on("error", reject);
				},
			);
			request.on("error", (error) => {
				body.destroy();
				reject(error);
			});
			body.on("error", (error) => request.destroy(error));
			body.pipe(request);
		});
		status = result.status;
		detail = result.detail;
	} catch (error) {
		throw transportError("POST", url, error);
	}
	if (status < 200 || status >= 300) {
		throw new Error(`Plik POST ${url} failed (${status})${detail ? `: ${detail}` : ""}`);
	}
}

/** Escape a filename for a quoted `Content-Disposition` parameter. */
function quotedString(value: string): string {
	return value
		.replace(/[\\"]/g, (c) => `\\${c}`)
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
}

/**
 * Mint a short PIN for a download URL. Never throws: an unreachable/unhappy
 * PIN service degrades to a null PIN plus a note, so the share itself always
 * succeeds with the full URL.
 */
async function mintPin(
	base: string,
	token: string,
	url: string,
	signal?: AbortSignal,
): Promise<{ pin: Pin | null; note?: string }> {
	const timeout = AbortSignal.timeout(PIN_TIMEOUT_MS);
	try {
		const response = await fetch(`${base}/pin/mint`, {
			method: "POST",
			headers: {
				"X-PlikToken": token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ url, ttl: PIN_TTL_SECONDS }),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		if (!response.ok) {
			const detail = (await response.text()).trim();
			return {
				pin: null,
				note: `PIN mint failed (${response.status})${detail ? `: ${detail}` : ""}`,
			};
		}

		const minted = (await response.json()) as Partial<Pin>;
		if (!minted.code || !minted.short) {
			return { pin: null, note: "PIN mint returned no code" };
		}
		return {
			pin: {
				code: minted.code,
				short: minted.short,
				page: minted.short.replace(/\/[^/]+$/, ""),
				expires: minted.expires,
				ttl: minted.ttl ?? PIN_TTL_SECONDS,
			},
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { pin: null, note: `PIN service unavailable: ${reason}` };
	}
}

/**
 * Reserve a slug for a download URL, or repoint one this user already owns.
 * Never throws: like the PIN, a failure degrades to a null slug plus a note so
 * the uploaded artifact is not stranded. The response carries the canonical
 * slug, and echoing the requested name instead would hand out a dead link.
 */
async function putSlug(
	base: string,
	token: string,
	name: string,
	url: string,
	domain: string,
	signal?: AbortSignal,
): Promise<{ slug: Slug | null; note?: string }> {
	try {
		const response = await fetch(`${base}/pin/slug/${encodeURIComponent(name)}`, {
			method: "PUT",
			headers: { "X-PlikToken": token, "Content-Type": "application/json" },
			body: JSON.stringify({ url }),
			signal,
		});
		const detail = (await response.text()).trim();
		if (!response.ok) {
			const hint = SLUG_HINTS[response.status];
			return {
				slug: null,
				note: `slug ${name} failed (${response.status})${detail ? `: ${detail}` : ""}${hint ? ` — ${hint}` : ""}`,
			};
		}
		const stored = JSON.parse(detail || "{}") as {
			slug?: string;
			short?: string;
			expires?: string;
			created?: boolean;
		};
		const canonical = stored.slug ?? name;
		return {
			slug: {
				name: canonical,
				url: stored.short ?? `${domain}/s/${canonical}`,
				created: stored.created ?? false,
				expires: stored.expires,
			},
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { slug: null, note: `slug ${name} request failed: ${reason}` };
	}
}

async function share(
	fileName: string,
	payload: Payload,
	params: UploadParams,
	signal?: AbortSignal,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }> {
	const { base, token } = config();

	const create = await call(`${base}/upload`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-PlikToken": token },
		body: JSON.stringify({
			ttl: params.ttl ?? 0,
			oneShot: params.one_shot ?? false,
			removable: params.removable ?? false,
			comments: params.comments,
			files: [{ fileName, fileSize: payload.size, reference: "0" }],
		}),
		signal,
	});
	const upload = (await create.json()) as PlikUpload;
	const file = upload.files[0];
	if (!file) {
		throw new Error("Plik did not return a file entry for the upload");
	}

	// Hand-built multipart body, streamed from disk. `FormData` derives its
	// Content-Length from `Blob.size`, and `fs.openAsBlob()` reports that size
	// modulo 2^32 for files >= 4 GiB — the declared length then overshoots the
	// body, the closing boundary never arrives and the server stalls until it
	// times out. `payload.size` comes from stat(), so the length stays exact.
	const boundary = `----plik${randomUUID()}`;
	const head = Buffer.from(
		`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="file"; filename="${quotedString(fileName)}"\r\n` +
			`Content-Type: application/octet-stream\r\n\r\n`,
	);
	const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
	const body = Readable.from(
		(async function* () {
			yield head;
			yield* payload.open();
			yield tail;
		})(),
	);

	await postStream(
		`${base}/file/${upload.id}/${file.id}/${encodeURIComponent(fileName)}`,
		{
			"X-PlikToken": token,
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
			"Content-Length": String(head.length + payload.size + tail.length),
		},
		body,
		signal,
	);

	const domain = (upload.downloadURL || upload.downloadDomain || base).replace(/\/+$/, "");
	const fileUrl = `${domain}/file/${upload.id}/${file.id}/${encodeURIComponent(fileName)}`;
	const { pin, note } = await mintPin(base, token, fileUrl, signal);
	const slug = params.slug ? await putSlug(base, token, params.slug, fileUrl, domain, signal) : undefined;
	const result = {
		id: upload.id,
		url: `${base}/#/?id=${upload.id}`,
		file: fileUrl,
		pin,
		...(note ? { pinNote: note } : {}),
		...(!slug ? {} : { slug: slug.slug }),
		...(slug?.note ? { slugNote: slug.note } : {}),
		expireAt: upload.expireAt,
		oneShot: upload.oneShot ?? false,
		removable: upload.removable ?? false,
	};
	return {
		content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
		details: result,
	};
}

export default function plikExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "share_file",
		label: "Share File",
		description:
			"Upload a local file to the user's Plik instance and return the upload page and direct download URLs, a short-lived PIN for the download URL, and, on request, a human-readable slug that can later be repointed at a new upload.",
		promptSnippet: "Share a local file through Plik",
		promptGuidelines: [
			"Write a short comment describing what the file is.",
			"When the result has a pin, tell the human to open pin.page and enter pin.code, and say when it expires.",
			"When pin is null, share the full URL only and do not mention PINs.",
			"When the result has a slug, offer slug.url as the stable link and say whether it was created or repointed (created false).",
			"When slug is null and slugNote is set, say the slug was not reserved and give its reason instead of implying it worked.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Absolute path of the file to share" }),
			...uploadParams,
		}),
		async execute(_toolCallId, params, signal) {
			const info = await stat(params.path);
			if (!info.isFile()) {
				throw new Error(`${params.path} is not a file`);
			}
			const name = basename(params.path);
			return share(
				name,
				{ size: info.size, open: () => createReadStream(params.path) },
				params,
				signal,
			);
		},
	});

	pi.registerTool({
		name: "share_text",
		label: "Share Text",
		description:
			"Upload inline text as a named file to the user's Plik instance and return the upload page and direct download URLs, a short-lived PIN for the download URL, and, on request, a human-readable slug that can later be repointed at a new upload.",
		promptSnippet: "Share text through Plik",
		promptGuidelines: [
			"Write a short comment describing what the content is.",
			"When the result has a pin, tell the human to open pin.page and enter pin.code, and say when it expires.",
			"When pin is null, share the full URL only and do not mention PINs.",
			"When the result has a slug, offer slug.url as the stable link and say whether it was created or repointed (created false).",
			"When slug is null and slugNote is set, say the slug was not reserved and give its reason instead of implying it worked.",
		],
		parameters: Type.Object({
			filename: Type.String({ description: "Name for the uploaded file (e.g. snippet.go)" }),
			content: Type.String({ description: "Text content to upload" }),
			...uploadParams,
		}),
		async execute(_toolCallId, params, signal) {
			const data = Buffer.from(params.content);
			return share(
				params.filename,
				{ size: data.length, open: () => [data] },
				params,
				signal,
			);
		},
	});
}
