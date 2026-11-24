/**
 * plik — share files and text through a self-hosted Plik instance.
 *
 * Registers two native tools that call the Plik REST API directly:
 *   - `share_file` — upload a local file by absolute path
 *   - `share_text` — upload inline text as a named file
 *
 * Both require a `comments` description of the content. Optional `ttl`,
 * `one_shot`, and `removable` default to the server's behavior.
 *
 * Each share creates an upload with one file reference, then uploads the file:
 *   POST /upload                          { files: [{ fileName, fileSize, reference }] }
 *   POST /file/{uploadID}/{fileID}/{name}   multipart field "file"
 *
 * A short-lived PIN is minted for the resulting download URL so the recipient
 * can type a 6-character code instead of the long URL:
 *   POST /pin/mint  { url, ttl }  →  { code, short, expires, ttl }
 * The PIN is a bonus: any failure here (no token, service down, bad response)
 * leaves `pin` null plus a `pinNote` and the share still returns the full URL.
 *
 * Configuration comes from the environment, read at call time:
 *   PLIK_URL         required base URL, e.g. https://share.slush.cz
 *   PLIK_TOKEN       API token, created in the Plik web UI
 *   SHAREPIN_TOKEN   optional token for the PIN service, same base URL
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type UploadParams = {
	ttl?: number;
	one_shot?: boolean;
	removable?: boolean;
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

type Pin = {
	code: string;
	short: string;
	page: string;
	expires?: string;
	ttl: number;
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
		// undici collapses transport failures into a bare "fetch failed"; carry the cause.
		const cause = (error as { cause?: { code?: string; message?: string } }).cause;
		throw new Error(
			`Plik ${init.method ?? "GET"} ${url} failed: ${String(error)} <- ${cause?.code || cause?.message || "unknown cause"}`,
		);
	}
	if (!response.ok) {
		const detail = (await response.text()).trim();
		throw new Error(
			`Plik ${init.method ?? "GET"} ${url} failed (${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	return response;
}

/** Escape a filename for a quoted `Content-Disposition` parameter. */
function quotedString(value: string): string {
	return value
		.replace(/[\\"]/g, (c) => `\\${c}`)
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
}

/**
 * Mint a short PIN for a download URL. Never throws: a missing token or an
 * unreachable/unhappy PIN service degrades to a null PIN plus a note, so the
 * share itself always succeeds with the full URL.
 */
async function mintPin(base: string, url: string, signal?: AbortSignal): Promise<{ pin: Pin | null; note?: string }> {
	const token = process.env.SHAREPIN_TOKEN?.trim();
	if (!token) {
		return { pin: null, note: "SHAREPIN_TOKEN is not set; no PIN created" };
	}

	const timeout = AbortSignal.timeout(PIN_TIMEOUT_MS);
	try {
		const response = await fetch(`${base}/pin/mint`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
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
	const body = Readable.toWeb(
		Readable.from(
			(async function* () {
				yield head;
				yield* payload.open();
				yield tail;
			})(),
		),
	);

	await call(`${base}/file/${upload.id}/${file.id}/${encodeURIComponent(fileName)}`, {
		method: "POST",
		headers: {
			"X-PlikToken": token,
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
			"Content-Length": String(head.length + payload.size + tail.length),
		},
		body,
		duplex: "half",
		signal,
	});

	const domain = (upload.downloadURL || upload.downloadDomain || base).replace(/\/+$/, "");
	const fileUrl = `${domain}/file/${upload.id}/${file.id}/${encodeURIComponent(fileName)}`;
	const { pin, note } = await mintPin(base, fileUrl, signal);
	const result = {
		id: upload.id,
		url: `${base}/#/?id=${upload.id}`,
		file: fileUrl,
		pin,
		...(note ? { pinNote: note } : {}),
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
			"Upload a local file to the user's Plik instance and return the upload page and direct download URLs, plus a short-lived PIN for the download URL when the PIN service is configured.",
		promptSnippet: "Share a local file through Plik",
		promptGuidelines: [
			"Write a short comment describing what the file is.",
			"When the result has a pin, tell the human to open pin.page and enter pin.code, and say when it expires.",
			"When pin is null, share the full URL only and do not mention PINs.",
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
			"Upload inline text as a named file to the user's Plik instance and return the upload page and direct download URLs, plus a short-lived PIN for the download URL when the PIN service is configured.",
		promptSnippet: "Share text through Plik",
		promptGuidelines: [
			"Write a short comment describing what the content is.",
			"When the result has a pin, tell the human to open pin.page and enter pin.code, and say when it expires.",
			"When pin is null, share the full URL only and do not mention PINs.",
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
