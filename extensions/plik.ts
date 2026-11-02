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
 * Configuration comes from the environment, read at call time:
 *   PLIK_URL    required base URL, e.g. https://share.slush.cz
 *   PLIK_TOKEN  API token, created in the Plik web UI
 */

import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type UploadParams = {
	ttl?: number;
	one_shot?: boolean;
	removable?: boolean;
	comments: string;
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
	const response = await fetch(url, init);
	if (!response.ok) {
		const detail = (await response.text()).trim();
		throw new Error(
			`Plik ${init.method ?? "GET"} ${url} failed (${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	return response;
}

async function share(
	fileName: string,
	size: number,
	content: () => Blob | Promise<Blob>,
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
			files: [{ fileName, fileSize: size, reference: "0" }],
		}),
		signal,
	});
	const upload = (await create.json()) as PlikUpload;
	const file = upload.files[0];
	if (!file) {
		throw new Error("Plik did not return a file entry for the upload");
	}

	const form = new FormData();
	form.append("file", await content(), fileName);
	await call(`${base}/file/${upload.id}/${file.id}/${encodeURIComponent(fileName)}`, {
		method: "POST",
		headers: { "X-PlikToken": token },
		body: form,
		signal,
	});

	const domain = (upload.downloadURL || upload.downloadDomain || base).replace(/\/+$/, "");
	const result = {
		id: upload.id,
		url: `${base}/#/?id=${upload.id}`,
		file: `${domain}/file/${upload.id}/${file.id}/${encodeURIComponent(fileName)}`,
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
			"Upload a local file to the user's Plik instance and return the upload page and direct download URLs.",
		promptSnippet: "Share a local file through Plik",
		promptGuidelines: [
			"Write a short comment describing what the file is.",
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
				info.size,
				() => openAsBlob(params.path),
				params,
				signal,
			);
		},
	});

	pi.registerTool({
		name: "share_text",
		label: "Share Text",
		description:
			"Upload inline text as a named file to the user's Plik instance and return the upload page and direct download URLs.",
		promptSnippet: "Share text through Plik",
		promptGuidelines: [
			"Write a short comment describing what the content is.",
		],
		parameters: Type.Object({
			filename: Type.String({ description: "Name for the uploaded file (e.g. snippet.go)" }),
			content: Type.String({ description: "Text content to upload" }),
			...uploadParams,
		}),
		async execute(_toolCallId, params, signal) {
			const blob = new Blob([params.content]);
			return share(params.filename, blob.size, () => blob, params, signal);
		},
	});
}
