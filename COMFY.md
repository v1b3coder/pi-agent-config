# `generate_image` — ComfyUI text-to-image tool for Pi

**Status: implemented** in `~/.pi/agent/extensions/generate-image.ts`.

A single scoped Pi tool that generates images from text prompts on the local
ComfyUI instance. Replaces fragile hand-rolled `curl` calls with one verified code
path, and returns the image inline so the agent can see what it produced.

---

## Verified environment

Endpoint: `http://beast.faias.slush.cz:8188` — ComfyUI `0.37.0`, RTX 3090 Ti
(24 GB), queue empty at time of testing.

The model is **not a checkpoint**. `CheckpointLoaderSimple` is unusable here; the
stack is a split trio:

| Role | File | Node |
|---|---|---|
| Diffusion | `qwen_image_2.1_int8_convrot.safetensors` | `UNETLoader` |
| Text encoder | `qwen3vl_8b_int8_convrot.safetensors` | `CLIPLoader`, `type: "qwen_image"` |
| VAE | `qwen_image_2.1_vae_bf16.safetensors` | `VAELoader` |

No checkpoints, no LoRAs, no ControlNet, no upscale models — one model per
category, which is what makes auto-discovery safe here.

### Proven node graph

Recovered verbatim from three successful runs still present in `/history`, then
replayed 8 times end-to-end (submit → poll → `/view` → PNG on disk):

```
1 UNETLoader        → qwen_image_2.1_int8_convrot.safetensors, weight_dtype: default
2 CLIPLoader        → qwen3vl_8b_int8_convrot.safetensors, type: qwen_image
3 VAELoader         → qwen_image_2.1_vae_bf16.safetensors
4 CLIPTextEncode    → positive prompt, clip: [2,0]
5 CLIPTextEncode    → "", clip: [2,0]            (negative, stays empty)
6 EmptyLatentImage  → width, height, batch_size: 1
7 KSampler          → model [1,0], pos [4,0], neg [5,0], latent [6,0]
                      seed, steps, cfg 2.5, euler, simple, denoise 1.0
8 VAEDecode         → samples [7,0], vae [3,0]
9 SaveImage         → images [8,0], filename_prefix <unique>
```

Fixed settings: **`cfg 2.5`**, **`euler`** / **`simple`**, empty negative prompt.
These match Qwen-Image's recommended low-CFG regime and are confirmed working.

`TextEncodeQwenImage21` exists on the server but the plain `CLIPTextEncode` path is
what the successful runs used — stay with it.

---

## Critical finding: `steps` is a silent failure mode

Same prompt (a flat database-cylinder icon) across resolutions and step counts:

| Resolution | Steps | Time | Result |
|---|---|---|---|
| 768×768 | 12 | 8 s | near-blank |
| 768×768 | 20 | 12 s | washed out |
| 1024×1024 | 12 | 14 s | washed out |
| 1024×1024 | 20 | 22 s | clean |
| 1024×1024 | 30 | 32 s | clean |
| 1536×1024 | 20 | 38 s | washed out |
| 1536×1024 | 30 | 54 s | good |
| 1536×1024 | 40 | 72 s | clean |

Two things to take from this:

1. **Under-stepping fails silently.** ComfyUI returns `status: success`, the PNG is
   written, nothing errors — the image is just pale and under-resolved. The
   `1536×1024 @ 20 steps` configuration currently sitting in the server's history
   produces washed-out output.
2. **768×768 is below the model's useful range.** It is still washed out even at 20
   steps, where 1024×1024 @ 20 is clean. Qwen-Image 2.1 wants roughly ≥1 MP.

**Therefore: `steps` is an explicit parameter with default `30`, and the tool's
description must state that low step counts silently produce washed-out images.**
Never inherit whatever the last UI session left behind.

---

## Tool design

One tool, one file: `~/.pi/agent/extensions/generate-image.ts`. No package, no npm
dependencies beyond what Pi already supplies.

```ts
generate_image({
  prompt: string,     // required
  width?: number,     // default 1024
  height?: number,    // default 1024
  steps?: number,     // default 30
  seed?: number,      // default random
})
```

Returns:

```ts
{
  content: [
    { type: "text",  text: "<absolute path>" },
    { type: "image", data: "<base64>", mimeType: "image/png" },
  ],
  details: { path, width, height, steps, seed }
}
```

Returning `ImageContent` means the agent sees the result without a second `read`
call. Pi auto-resizes tool-result images to 2000 px / 4.5 MiB base64, so a
1536×1024 PNG passes through intact.

### Execution flow

1. Resolve config from env (read at call time, so no restart needed on change).
2. Build the 9-node graph above with a unique `filename_prefix` (timestamp + random
   suffix) so the correct output is unambiguous.
3. `POST /prompt` with a `client_id`.
4. Poll `/history/{prompt_id}` every 2 s, bounded by `AbortSignal` and
   `COMFYUI_TIMEOUT_SECONDS`.
5. `GET /view?filename=…&subfolder=…&type=output`, write to disk.
6. Return path + inline image.

On timeout the poll stops but ComfyUI keeps generating — abort must not cancel the
job, since the work may still complete.

---

## Configuration

All paths and model names come from the environment. Nothing is hardcoded.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `COMFYUI_URL` | yes | — | e.g. `http://beast.faias.slush.cz:8188` |
| `COMFYUI_OUTPUT_DIR` | no | see below | Where PNGs are written |
| `COMFYUI_DIFFUSION_MODEL` | no | auto-discovered | `UNETLoader.unet_name` |
| `COMFYUI_CLIP_MODEL` | no | auto-discovered | `CLIPLoader.clip_name` |
| `COMFYUI_VAE` | no | auto-discovered | `VAELoader.vae_name` |
| `COMFYUI_STEPS` | no | `30` | Default step count |
| `COMFYUI_TIMEOUT_SECONDS` | no | `300` | Poll timeout |

If `COMFYUI_URL` is unset the tool fails with a clear message rather than
guessing an endpoint.

### Model auto-discovery

Resolve names from `/models/diffusion_models`, `/models/text_encoders`,
`/models/vae`, taking the single entry in each category.

**If a category returns more than one entry and the corresponding env var is unset,
fail with a clear message** instead of silently picking one. This is the failure mode
worth engineering against, and it costs about six lines. The `CLIPLoader.type` value
is not discoverable this way and stays fixed at `qwen_image`.

---

## Output directory: ephemeral by default

Default:

```ts
join(os.tmpdir(), `pi-comfyui-${process.getuid?.() ?? "user"}`)
```

Created with mode `0700`.

Rationale:

- `os.tmpdir()` respects `TMPDIR`, so it is itself environment-configurable.
- **UID-scoped, not a fixed name.** `/tmp` is mode `1777` (world-writable). A fixed
  path like `/tmp/pi-comfyui-images` lets another local user pre-create it, own it, or
  symlink it before we write. Scoping by UID plus `0700` closes that.
- On this host `/tmp` is **not tmpfs** — it is on the root filesystem, and
  systemd-tmpfiles (`/usr/lib/tmpfiles.d/tmp.conf`) cleans entries older than
  **30 days**. So the default is "scratch that survives reboots for weeks," not
  "gone on reboot."

### The tradeoff, stated plainly

The default is **scratch space, not asset storage**. For images meant to land in a
repo, either:

- set `COMFYUI_OUTPUT_DIR` to a project path, or
- copy the file out of tmp into the project before referencing it.

This is the tension worth naming: the stated use case is in-app assets, which are
keepers, but the requested default is ephemeral. The resolution is that tmp suits
throwaway exploration and iteration, and anything promoted to a real asset gets copied
into the repo (or generated with `COMFYUI_OUTPUT_DIR` set). The tool should say so in
its own description so the model does not leave a keeper in tmp.

---

## Confirmed: the agent can see generated images

Verified empirically in this session — generated PNGs were read back and their contents
correctly described (including the washed-out vs clean distinction above). The inline
`ImageContent` return path is therefore useful, not wasted payload.

Note: the Cloudflare-hosted variant of DeepSeek V4 Flash declares
`input: ["text"]` (text-only) in Pi's bundled catalog. The `litellm` provider used
here has no `input` declared in `~/.pi/agent/models.json`, so capability comes from
the upstream. Vision worked in this session; if a future model cannot accept images, the
tool still returns the path and the human can open the file.

---

## Not proposed

Deliberately out of scope, to keep this one tool:

- Workflow JSON authoring / `[VAR]` annotation systems
- Multiple backends, capability tags, queue-aware routing
- Durable background jobs, job store, reconciliation
- LoRA slots, input-file slots, image-to-image
- Progress streaming over WebSocket (polling `/history` is sufficient)
- Negative-prompt tuning (`cfg 2.5` with an empty negative is the working recipe)

If any of these become necessary, `pi-comfyui-paint` already covers them and remains
the better choice — see the alternatives note below.

---

## Alternatives considered

- **`pi-comfyui-paint`** (npm, MIT, v0.3.0) — the only existing Pi-scoped
  ComfyUI package. 10 `paint_*` tools plus a custom-workflow skill. Its multi-backend
  routing, capability negotiation, durable job store, and LoRA machinery are all dormant
  in a single-model setup, and its bundled workflows assume models not present here.
  Correct tool for a fleet of GPUs; heavy for one model.
- **`comfyui-mcp`** — MCP server, reachable through the already-installed
  `pi-mcp-adapter`. Adds a protocol hop and its own tool surface.
- **Shell script + `curl`** — no new abstractions, but fragile, and cannot hand the
  agent the image inline.

---

## Verification plan

Once implemented:

1. Generate at 1024×1024 / 30 steps and visually confirm the output is clean.
2. Confirm a deliberately under-stepped call is recognisably bad, validating the
   default.
3. Confirm the returned path exists on disk and matches the inline image.
4. Confirm a second call with a different seed produces a different image.
5. Confirm an unset `COMFYUI_URL` fails with a clear message.
6. Confirm a multi-entry model category with unset env var fails rather than guessing.
