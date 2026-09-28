/**
 * generate_image — text-to-image and image editing on a local ComfyUI instance (Qwen-Image 2.1).
 *
 * Two code paths, one tool:
 *   - no reference_images: the proven 9-node text-to-image graph.
 *   - reference_images:   the Qwen-Image 2.1 image-edit graph. The entry point is
 *     TextEncodeQwenImage21, not VAEEncode: the reference images are spliced into
 *     the text encoder, and its `latent` output (an empty latent at image_1's size)
 *     replaces EmptyLatentImage. KSampler.denoise stays 1.0 — lowering it is the
 *     Stable-Diffusion img2img reflex and is wrong for this model.
 *
 * The canonical edit graph, exported from ComfyUI in API format, is kept as a block
 * comment above buildEditGraph() so the code and the reference stay comparable.
 *
 * Each call builds the graph, submits it, polls /history, fetches the PNG via /view,
 * writes it to disk, and returns it inline. Calls are serialized so a shared GPU is
 * not hit by parallel renders.
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
import { getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";
import { randomInt, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";

const CLIP_TYPE = "qwen_image";
const SAVE_NODE_ID = "9";
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1024;
const DEFAULT_STEPS = 30;
const DEFAULT_TIMEOUT_SECONDS = 300;
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const DIMENSION_MIN = 16;
const DIMENSION_MAX = 16_384;
const DIMENSION_SNAP = 8;
const MAX_REFERENCES = 16;
const EDIT_RESOLUTION_DEFAULT = 1024;
const EDIT_RESOLUTION_MAX = 2048;
const EDIT_RESOLUTION_SNAP = 32;
const EDIT_CACHE_DTYPE = "int8";
const EDIT_CFG = 1;
// Node ids mirror the canonical graph in the block comment above buildEditGraph.
const EDIT_UNET_NODE = "451";
const EDIT_CLIP_NODE = "453";
const EDIT_VAE_NODE = "454";
const EDIT_CACHE_NODE = "469";
const EDIT_ENCODE_NODE = "474";
const EDIT_SAMPLER_NODE = "458";
const EDIT_DECODE_NODE = "457";
const EDIT_LOAD_IMAGE_BASE = 10;

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

interface UploadedImage {
	name?: string;
	subfolder?: string;
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

function isConfigured(): boolean {
	return Boolean(process.env.COMFYUI_URL?.trim());
}

function resolveOutputDir(): string {
	const configured = process.env.COMFYUI_OUTPUT_DIR?.trim();
	if (configured) {
		const dir = resolve(configured);
		mkdirSync(dir, { recursive: true });
		return dir;
	}
	// UID-scoped so a fixed name cannot be squatted, but world-readable so a
	// terminal running as another user can follow the file:// links. chmod is explicit
	// because the process umask (0007 here) strips the mode passed to mkdir, and it
	// also fails if another user already owns the directory, which is the point.
	const dir = join(tmpdir(), `pi-comfyui-${process.getuid?.() ?? "user"}`);
	mkdirSync(dir, { recursive: true, mode: 0o755 });
	chmodSync(dir, 0o755);
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

// Renders are serialized: the ComfyUI GPU is shared with other services, and two
// concurrent graphs would exhaust VRAM.
let renderQueue: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
	const run = renderQueue.then(fn, fn);
	renderQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function pngSize(data: Buffer): { width: number; height: number } | undefined {
	if (data.length < 24 || data.readUInt32BE(0) !== 0x89504e47) return undefined;
	return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

async function uploadReference(baseUrl: string, path: string, signal: AbortSignal | undefined): Promise<string> {
	let data: Buffer;
	try {
		data = readFileSync(path);
	} catch (error) {
		throw new Error(
			`Could not read reference image ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const form = new FormData();
	form.append("image", new Blob([new Uint8Array(data)]), `pi_ref_${randomUUID()}${extname(path) || ".png"}`);
	form.append("type", "input");

	const response = await comfyFetch(`${baseUrl}/upload/image`, {
		method: "POST",
		body: form,
		signal: withTimeout(signal, UPLOAD_TIMEOUT_MS),
	});
	const body = (await response.json().catch(() => undefined)) as UploadedImage | undefined;
	if (!response.ok || !body?.name) {
		throw new Error(
			`ComfyUI rejected reference image ${path} (HTTP ${response.status}): ${JSON.stringify(body)}`,
		);
	}
	return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
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

/*
 * Canonical Qwen-Image 2.1 image-edit graph, exported from the ComfyUI UI in API
 * format. Reference only: nothing reads this at runtime — buildEditGraph() below
 * builds the graph that is actually submitted. Kept so the node ids, wiring, and
 * sampler settings in code can be diffed against a known-working export.
 *
{
  "451": {
    "class_type": "UNETLoader",
    "inputs": {
      "unet_name": "qwen_image_2.1_int8_convrot.safetensors",
      "weight_dtype": "default"
    }
  },
  "453": {
    "class_type": "CLIPLoader",
    "inputs": {
      "clip_name": "qwen3vl_8b_int8_convrot.safetensors",
      "type": "qwen_image"
    }
  },
  "454": {
    "class_type": "VAELoader",
    "inputs": {
      "vae_name": "qwen_image_2.1_vae_bf16.safetensors"
    }
  },
  "469": {
    "class_type": "QwenImage21Cache",
    "inputs": {
      "model": ["451", 0],
      "device": "auto",
      "dtype": "int8"
    }
  },
  "10": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "image_1.png"
    }
  },
  "11": {
    "class_type": "LoadImage",
    "inputs": {
      "image": "image_2.png"
    }
  },
  "474": {
    "class_type": "TextEncodeQwenImage21",
    "inputs": {
      "clip": ["453", 0],
      "vae": ["454", 0],
      "prompt": "put the shirt from <image2> on <image1>, keep pose",
      "negative_prompt": "",
      "resolution": 1024,
      "images.image_1": ["10", 0],
      "images.image_2": ["11", 0]
    }
  },
  "458": {
    "class_type": "KSampler",
    "inputs": {
      "model": ["469", 0],
      "positive": ["474", 0],
      "negative": ["474", 1],
      "latent_image": ["474", 2],
      "seed": 0,
      "steps": 25,
      "cfg": 1,
      "sampler_name": "euler",
      "scheduler": "simple",
      "denoise": 1.0
    }
  },
  "457": {
    "class_type": "VAEDecode",
    "inputs": {
      "samples": ["458", 0],
      "vae": ["454", 0]
    }
  },
  "9": {
    "class_type": "SaveImage",
    "inputs": {
      "images": ["457", 0],
      "filename_prefix": "pi_edit"
    }
  }
}
 */
function buildEditGraph(options: {
	prompt: string;
	resolution: number;
	steps: number;
	seed: number;
	unetName: string;
	clipName: string;
	vaeName: string;
	imageNames: string[];
	filenamePrefix: string;
}) {
	const graph: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
		[EDIT_UNET_NODE]: {
			class_type: "UNETLoader",
			inputs: { unet_name: options.unetName, weight_dtype: "default" },
		},
		[EDIT_CLIP_NODE]: {
			class_type: "CLIPLoader",
			inputs: { clip_name: options.clipName, type: CLIP_TYPE },
		},
		[EDIT_VAE_NODE]: {
			class_type: "VAELoader",
			inputs: { vae_name: options.vaeName },
		},
		[EDIT_CACHE_NODE]: {
			class_type: "QwenImage21Cache",
			inputs: { model: [EDIT_UNET_NODE, 0], device: "auto", dtype: EDIT_CACHE_DTYPE },
		},
		[EDIT_ENCODE_NODE]: {
			class_type: "TextEncodeQwenImage21",
			inputs: {
				clip: [EDIT_CLIP_NODE, 0],
				vae: [EDIT_VAE_NODE, 0],
				prompt: options.prompt,
				negative_prompt: "",
				resolution: options.resolution,
			},
		},
		[EDIT_SAMPLER_NODE]: {
			class_type: "KSampler",
			inputs: {
				model: [EDIT_CACHE_NODE, 0],
				positive: [EDIT_ENCODE_NODE, 0],
				negative: [EDIT_ENCODE_NODE, 1],
				latent_image: [EDIT_ENCODE_NODE, 2],
				seed: options.seed,
				steps: options.steps,
				cfg: EDIT_CFG,
				sampler_name: "euler",
				scheduler: "simple",
				denoise: 1.0,
			},
		},
		[EDIT_DECODE_NODE]: {
			class_type: "VAEDecode",
			inputs: { samples: [EDIT_SAMPLER_NODE, 0], vae: [EDIT_VAE_NODE, 0] },
		},
		[SAVE_NODE_ID]: {
			class_type: "SaveImage",
			inputs: { images: [EDIT_DECODE_NODE, 0], filename_prefix: options.filenamePrefix },
		},
	};

	options.imageNames.forEach((image, index) => {
		const nodeId = String(EDIT_LOAD_IMAGE_BASE + index);
		graph[nodeId] = { class_type: "LoadImage", inputs: { image } };
		// Autogrow inputs flatten to "images.image_N" in API format.
		graph[EDIT_ENCODE_NODE]!.inputs[`images.image_${index + 1}`] = [nodeId, 0];
	});

	return graph;
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
	pi.registerTool({		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate an image from a text prompt, or edit images, on the local ComfyUI instance (Qwen-Image 2.1) and return the result inline. " +
			"Text-to-image defaults to 1024x1024 at 30 steps. " +
			"Pass reference_images (local file paths) to switch to image editing: image_1 is the edit target and sets the output size, image_2..image_16 are references, and the prompt refers to them as <image1>, <image2>, ... " +
			"Image editing has no denoise knob (it stays 1.0) and ignores width/height; the output size follows image_1. resolution is a pixel budget for resizing the references (0 = native size). " +
			"Low step counts fail silently: ComfyUI reports success and writes a PNG, but the image is washed out and under-resolved, so keep steps at 30 or higher. " +
			"Images below roughly 1 MP are also washed out even at 30 steps. " +
			"By default PNGs are written to UID-scoped scratch space under tmp, not asset storage; copy a keeper into the project or set COMFYUI_OUTPUT_DIR to generate into it.",
		promptSnippet: "Generate an image from a text prompt, or edit images from local reference files, via the local ComfyUI instance.",
		promptGuidelines: [
			"generate_image defaults to 30 steps; lower values silently produce washed-out images.",
			"generate_image writes to tmp scratch space by default; copy keepers into the project or set COMFYUI_OUTPUT_DIR.",
			"To edit images, pass reference_images (local file paths): image_1 is the edit target and sets the output size, image_2..image_16 are references. In the prompt, refer to them as <image1>, <image2>, ...",
			"With reference_images, width/height have no effect (the output size follows image_1), and do not try to lower denoise: Qwen-Image 2.1 edit is not Stable Diffusion img2img and keeps denoise at 1.0.",
			"Run one generate_image call at a time; the ComfyUI GPU is shared with other services.",
		],
		parameters: Type.Object({
			prompt: Type.String({
				description:
					"Text prompt. With reference_images, describe the edit and refer to the images as <image1>, <image2>, ...",
			}),
			reference_images: Type.Optional(
				Type.Array(Type.String(), {
					minItems: 1,
					maxItems: MAX_REFERENCES,
					description:
						"Local file paths for image editing (Qwen-Image 2.1 edit). image_1 is the edit target and sets the output size; image_2..image_16 are references. width/height have no effect in this mode.",
				}),
			),
			resolution: Type.Optional(
				Type.Integer({
					description:
						"Image editing only: reference images are resized to about resolution x resolution pixels (multiple of 32, aspect ratio preserved); 0 keeps each reference at native size. Capped at 2048 for the shared GPU.",
					minimum: 0,
					maximum: EDIT_RESOLUTION_MAX,
					default: EDIT_RESOLUTION_DEFAULT,
				}),
			),
			width: Type.Optional(
				Type.Integer({
					description: "Text-to-image only: image width in pixels, snapped to a multiple of 8. Ignored with reference_images.",
					minimum: DIMENSION_MIN,
					maximum: DIMENSION_MAX,
					default: DEFAULT_WIDTH,
				}),
			),
			height: Type.Optional(
				Type.Integer({
					description: "Text-to-image only: image height in pixels, snapped to a multiple of 8. Ignored with reference_images.",
					minimum: DIMENSION_MIN,
					maximum: DIMENSION_MAX,
					default: DEFAULT_HEIGHT,
				}),
			),
			steps: Type.Optional(
				Type.Integer({
					description:
						"Denoising steps. Low values silently produce washed-out images; do not go below the default.",
					minimum: 1,
					default: DEFAULT_STEPS,
				}),
			),
			seed: Type.Optional(
				Type.Integer({
					description: "Random seed; omit for a random one",
					minimum: 0,
					maximum: Number.MAX_SAFE_INTEGER,
				}),
			),
		}),

		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent ?? new Text("", 0, 0)) as Text;
			const details = result.details as GenerateImageDetails | undefined;

			// Errors and in-flight updates have no path yet; show their message as-is.
			if (!details?.path) {
				const message = result.content
					.filter((block) => block.type === "text")
					.map((block) => block.text ?? "")
					.join("\n");
				text.setText(context.isError ? theme.fg("error", message) : message);
				return text;
			}

			// OSC 8 makes the path open in the system image viewer on click. Terminals
			// without support ignore the sequence and show the path as plain text.
			const styled = theme.fg("accent", details.path);
			let output = getCapabilities().hyperlinks
				? hyperlink(styled, pathToFileURL(details.path).href)
				: styled;
			if (!getCapabilities().images || !context.showImages) {
				output += ` ${theme.fg("muted", `[image/png ${details.width}×${details.height}]`)}`;
			}
			text.setText(output);
			return text;
		},

		async execute(_toolCallId, params, signal, onUpdate) {
			return runExclusive(async () => {
				if (signal?.aborted) throw abortError();

				const baseUrl = requireBaseUrl();
				const outputDir = resolveOutputDir();

				const referenceImages = params.reference_images ?? [];
				const isEdit = referenceImages.length > 0;

				const steps = params.steps ?? envInt("COMFYUI_STEPS", DEFAULT_STEPS);
				const seed = params.seed ?? randomInt(0, 2 ** 48 - 1);
				const timeoutSeconds = envInt("COMFYUI_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS);

				const [unetName, clipName, vaeName] = await Promise.all([
					resolveModel(baseUrl, "diffusion_models", "COMFYUI_DIFFUSION_MODEL"),
					resolveModel(baseUrl, "text_encoders", "COMFYUI_CLIP_MODEL"),
					resolveModel(baseUrl, "vae", "COMFYUI_VAE"),
				]);

				const filenamePrefix = `pi_gen_${Date.now()}_${randomUUID().slice(0, 8)}`;
				let width = Math.round((params.width ?? DEFAULT_WIDTH) / DIMENSION_SNAP) * DIMENSION_SNAP;
				let height = Math.round((params.height ?? DEFAULT_HEIGHT) / DIMENSION_SNAP) * DIMENSION_SNAP;
				let graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;

				if (isEdit) {
					const imageNames: string[] = [];
					for (const path of referenceImages) {
						imageNames.push(await uploadReference(baseUrl, path, signal));
					}
					const resolution = Math.min(
						EDIT_RESOLUTION_MAX,
						Math.round((params.resolution ?? EDIT_RESOLUTION_DEFAULT) / EDIT_RESOLUTION_SNAP) *
							EDIT_RESOLUTION_SNAP,
					);
					graph = buildEditGraph({
						prompt: params.prompt,
						resolution,
						steps,
						seed,
						unetName,
						clipName,
						vaeName,
						imageNames,
						filenamePrefix,
					});
					// The edit output follows image_1; its real size is read after download.
					width = 0;
					height = 0;
				} else {
					graph = buildGraph({
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
				}

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
				writeFileSync(path, data, { mode: 0o644 });
				chmodSync(path, 0o644);

				if (isEdit) {
					const size = pngSize(data);
					if (size) {
						width = size.width;
						height = size.height;
					}
				}

				return {
					content: [
						{ type: "text", text: path },
						{ type: "image", data: data.toString("base64"), mimeType: "image/png" },
					],
					details: { path, width, height, steps, seed } satisfies GenerateImageDetails,
				};
			});
		},
	});

	// The tool stays registered so it can appear without a restart, but is only
	// active while COMFYUI_URL is set. setActiveTools() replaces the whole set, so
	// the other active tools are carried over explicitly. State is read back from
	// the live set rather than tracked locally, which keeps this idempotent and
	// correct no matter how the tool was activated at startup.
	const TOOL_NAME = "generate_image";

	const syncActivation = () => {
		const current = pi.getActiveTools();
		const active = current.includes(TOOL_NAME);
		const configured = isConfigured();
		if (active === configured) return;
		pi.setActiveTools(configured ? [...current, TOOL_NAME] : current.filter((name) => name !== TOOL_NAME));
	};

	// Covers startup and /reload; re-checked every turn so COMFYUI_URL can be
	// changed in .env without needing a reload.
	pi.on("session_start", syncActivation);
	pi.on("before_agent_start", syncActivation);
}
