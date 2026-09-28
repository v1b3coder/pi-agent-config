/**
 * generate_image — text-to-image on a local ComfyUI instance (Qwen-Image 2.1).
 *
 * One tool, one code path: build the proven 9-node graph, submit, poll /history,
 * fetch the PNG via /view, write it to disk, and return it inline.
 *
 * Configuration comes from the environment, read at call time:
 *   COMFYUI_URL               required endpoint, e.g. http://host:8188
 *   COMFYUI_OUTPUT_DIR        where PNGs are written (default: UID-scoped tmp)
 *   COMFYUI_DIFFUSION_MODEL   UNETLoader.unet_name (default: auto-discovered)
 *   COMFYUI_CLIP_MODEL        CLIPLoader.clip_name (default: auto-discovered)
 *   COMFYUI_VAE                VAELoader.vae_name (default: auto-discovered)
 *   COMFYUI_STEPS             default step count (default: 30)
 *   COMFYUI_TIMEOUT_SECONDS   poll timeout (default: 300)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomInt, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";

const CLIP_TYPE = "qwen_image";
const SAVE_NODE_ID = "9";
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_STEPS = 30;
const DEFAULT_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DIMENSION_MIN = 16;
const DIMENSION_MAX = 16_384;
const DIMENSION_SNAP = 8;

interface GenerateImageDetails {
	path: string;
	width: number;
	height: number;
	steps: number;
	seed: number;
}

interface HistoryImage {
	filename: string;
	subfolder?: string;
	type?: string;
}

interface HistoryEntry {
	status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
	outputs?: Record<string, { images?: HistoryImage[] } | undefined>;
}

function abortError(): Error {
	const error = new Error("generate_image aborted by the caller; the ComfyUI job keeps running.");
	error.name = "AbortError";
	return error;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
	const requestTimeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout;
}

async function comfyFetch(url: string | URL, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") throw error;
		const cause = error instanceof Error ? error.message : String(error);
		throw new Error(`ComfyUI request to ${url} failed: ${cause}`);
	}
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requireBaseUrl(): string {
	const url = process.env.COMFYUI_URL?.trim();
	if (!url) {
		throw new Error(
			"COMFYUI_URL is not set. Set it to the ComfyUI endpoint (e.g. COMFYUI_URL=http://host:8188) before calling generate_image.",
		);
	}
	return url.replace(/\/+$/, "");
}

function resolveOutputDir(): string {
	const configured = process.env.COMFYUI_OUTPUT_DIR?.trim();
	if (configured) {
		const dir = resolve(configured);
		mkdirSync(dir, { recursive: true });
		return dir;
	}
	// UID-scoped and 0700: /tmp is world-writable, so a fixed path could be
	// pre-created or symlinked by another local user.
	const dir = join(tmpdir(), `pi-comfyui-${process.getuid?.() ?? "user"}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

async function resolveModel(baseUrl: string, category: string, envVar: string): Promise<string> {
	const fromEnv = process.env[envVar]?.trim();
	if (fromEnv) return fromEnv;

	const response = await comfyFetch(`${baseUrl}/models/${category}`, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(
			`Could not list ${category} models from ComfyUI (HTTP ${response.status}); set ${envVar} to skip auto-discovery.`,
		);
	}
	const entries = (await response.json()) as string[];
	if (entries.length === 1) return entries[0]!;
	if (entries.length === 0) {
		throw new Error(`ComfyUI reports no ${category} models; set ${envVar}.`);
	}
	throw new Error(
		`ComfyUI reports ${entries.length} ${category} models (${entries.join(", ")}); set ${envVar} to choose one.`,
	);
}

function buildGraph(options: {
	prompt: string;
	width: number;
	height: number;
	steps: number;
	seed: number;
	unetName: string;
	clipName: string;
	vaeName: string;
	filenamePrefix: string;
}) {
	return {
		"1": {
			class_type: "UNETLoader",
			inputs: { unet_name: options.unetName, weight_dtype: "default" },
		},
		"2": {
			class_type: "CLIPLoader",
			inputs: { clip_name: options.clipName, type: CLIP_TYPE },
		},
		"3": {
			class_type: "VAELoader",
			inputs: { vae_name: options.vaeName },
		},
		"4": {
			class_type: "CLIPTextEncode",
			inputs: { clip: ["2", 0], text: options.prompt },
		},
		"5": {
			class_type: "CLIPTextEncode",
			inputs: { clip: ["2", 0], text: "" },
		},
		"6": {
			class_type: "EmptyLatentImage",
			inputs: { width: options.width, height: options.height, batch_size: 1 },
		},
		"7": {
			class_type: "KSampler",
			inputs: {
				model: ["1", 0],
				positive: ["4", 0],
				negative: ["5", 0],
				latent_image: ["6", 0],
				seed: options.seed,
				steps: options.steps,
				cfg: 2.5,
				sampler_name: "euler",
				scheduler: "simple",
				denoise: 1.0,
			},
		},
		"8": {
			class_type: "VAEDecode",
			inputs: { samples: ["7", 0], vae: ["3", 0] },
		},
		"9": {
			class_type: "SaveImage",
			inputs: { images: ["8", 0], filename_prefix: options.filenamePrefix },
		},
	};
}

function executionError(promptId: string, entry: HistoryEntry): Error {
	const messages = Array.isArray(entry.status?.messages) ? entry.status.messages : [];
	const details = messages
		.filter((message): message is unknown[] => Array.isArray(message) && message[0] === "execution_error")
		.map((message) => {
			const payload = message[1] as { exception_message?: string; node_type?: string } | undefined;
			return payload?.exception_message ?? payload?.node_type ?? JSON.stringify(payload);
		});
	return new Error(`ComfyUI prompt ${promptId} failed: ${details.join("; ") || "unknown execution error"}`);
}

function timeoutError(promptId: string, seconds: number): Error {
	return new Error(
		`Timed out after ${seconds}s waiting for ComfyUI prompt ${promptId}. ` +
			"The job keeps running on the server; its output will still appear in ComfyUI history.",
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate an image from a text prompt on the local ComfyUI instance and return it inline. " +
			"Defaults to 1024x1024 at 30 steps. " +
			"Low step counts fail silently: ComfyUI reports success and writes a PNG, but the image is washed out and under-resolved, so keep steps at 30 or higher. " +
			"Images below roughly 1 MP are also washed out even at 30 steps. " +
			"By default PNGs are written to UID-scoped scratch space under tmp, not asset storage; copy a keeper into the project or set COMFYUI_OUTPUT_DIR to generate into it.",
		promptSnippet: "Generate an image from a text prompt via the local ComfyUI instance.",
		promptGuidelines: [
			"generate_image defaults to 30 steps; lower values silently produce washed-out images.",
			"generate_image writes to tmp scratch space by default; copy keepers into the project or set COMFYUI_OUTPUT_DIR.",
		],
		parameters: Type.Object({
			prompt: Type.String({ description: "Text prompt describing the image to generate" }),
			width: Type.Integer({
				description: "Image width in pixels, snapped to a multiple of 8",
				minimum: DIMENSION_MIN,
				maximum: DIMENSION_MAX,
				default: DEFAULT_WIDTH,
			}),
			height: Type.Integer({
				description: "Image height in pixels, snapped to a multiple of 8",
				minimum: DIMENSION_MIN,
				maximum: DIMENSION_MAX,
				default: DEFAULT_HEIGHT,
			}),
			steps: Type.Integer({
				description:
					"Denoising steps. Low values silently produce washed-out images; do not go below the default.",
				minimum: 1,
				default: DEFAULT_STEPS,
			}),
			seed: Type.Integer({
				description: "Random seed; omit for a random one",
				minimum: 0,
				maximum: Number.MAX_SAFE_INTEGER,
			}),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const baseUrl = requireBaseUrl();
			const outputDir = resolveOutputDir();

			const width = Math.round((params.width ?? DEFAULT_WIDTH) / DIMENSION_SNAP) * DIMENSION_SNAP;
			const height = Math.round((params.height ?? DEFAULT_HEIGHT) / DIMENSION_SNAP) * DIMENSION_SNAP;
			const steps = params.steps ?? envInt("COMFYUI_STEPS", DEFAULT_STEPS);
			const seed = params.seed ?? randomInt(0, 2 ** 48 - 1);
			const timeoutSeconds = envInt("COMFYUI_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS);

			const [unetName, clipName, vaeName] = await Promise.all([
				resolveModel(baseUrl, "diffusion_models", "COMFYUI_DIFFUSION_MODEL"),
				resolveModel(baseUrl, "text_encoders", "COMFYUI_CLIP_MODEL"),
				resolveModel(baseUrl, "vae", "COMFYUI_VAE"),
			]);

			const filenamePrefix = `pi_gen_${Date.now()}_${randomUUID().slice(0, 8)}`;
			const graph = buildGraph({
				prompt: params.prompt,
				width,
				height,
				steps,
				seed,
				unetName,
				clipName,
				vaeName,
				filenamePrefix,
			});

			const submitResponse = await comfyFetch(`${baseUrl}/prompt`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: graph, client_id: randomUUID() }),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			const submitBody = (await submitResponse.json().catch(() => undefined)) as
				| { prompt_id?: string; node_errors?: Record<string, unknown> }
				| undefined;
			if (!submitResponse.ok) {
				throw new Error(
					`ComfyUI rejected the prompt (HTTP ${submitResponse.status}): ${JSON.stringify(submitBody)}`,
				);
			}
			if (submitBody?.node_errors && Object.keys(submitBody.node_errors).length > 0) {
				throw new Error(`ComfyUI node errors: ${JSON.stringify(submitBody.node_errors)}`);
			}
			const promptId = submitBody?.prompt_id;
			if (!promptId) {
				throw new Error(`ComfyUI returned no prompt_id: ${JSON.stringify(submitBody)}`);
			}

			const startedAt = Date.now();
			const deadline = startedAt + timeoutSeconds * 1000;
			let image: HistoryImage | undefined;

			while (!image) {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) throw timeoutError(promptId, timeoutSeconds);

				let entry: HistoryEntry | undefined;
				try {
					const response = await comfyFetch(`${baseUrl}/history/${promptId}`, {
						signal: withTimeout(signal, Math.min(REQUEST_TIMEOUT_MS, remainingMs)),
					});
					if (response.ok) {
						entry = ((await response.json()) as Record<string, HistoryEntry>)[promptId];
					}
				} catch (error) {
					if (signal?.aborted) throw abortError();
					// Transient network or request timeout: retry until the deadline.
				}

				if (entry) {
					if (entry.status?.status_str === "error") throw executionError(promptId, entry);
					const images = entry.outputs?.[SAVE_NODE_ID]?.images;
					if (images?.length) {
						image = images[0];
						break;
					}
					if (entry.status?.completed) {
						throw new Error(`ComfyUI prompt ${promptId} finished without an image on node ${SAVE_NODE_ID}.`);
					}
				}

				await sleep(POLL_INTERVAL_MS, signal);
				onUpdate?.({
					content: [{ type: "text", text: `Generating… ${Math.round((Date.now() - startedAt) / 1000)}s` }],
					details: { path: "", width, height, steps, seed },
				});
			}

			const viewUrl = new URL(`${baseUrl}/view`);
			viewUrl.searchParams.set("filename", image.filename);
			viewUrl.searchParams.set("subfolder", image.subfolder ?? "");
			viewUrl.searchParams.set("type", image.type ?? "output");
			const imageResponse = await comfyFetch(viewUrl, { signal: withTimeout(signal, REQUEST_TIMEOUT_MS) });
			if (!imageResponse.ok) {
				throw new Error(`Failed to download generated image (HTTP ${imageResponse.status}).`);
			}
			const data = Buffer.from(await imageResponse.arrayBuffer());

			const path = join(outputDir, basename(image.filename));
			writeFileSync(path, data);

			return {
				content: [
					{ type: "text", text: path },
					{ type: "image", data: data.toString("base64"), mimeType: "image/png" },
				],
				details: { path, width, height, steps, seed } satisfies GenerateImageDetails,
			};
		},
	});
}
