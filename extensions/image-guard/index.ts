/**
 * image-guard — canonicalize inline images before every model call.
 *
 * Pi normalizes images for *size* and *container format*, but its fast path forwards any
 * PNG/JPEG/GIF/WebP that already fits the dimension and byte limits untouched. A 16-bit
 * PNG, an animated GIF, or a 4-component CMYK JPEG therefore reaches the provider
 * verbatim, and the provider rejects the entire request:
 *
 *   400 PNG requires non-animated, at most 8-bit samples
 *
 * That error is terminal. Because the image is persisted in the session, every later turn
 * re-sends it and hits the same 400: the thread is dead for good.
 *
 * This closes the hole one level earlier, on the `context` hook: it fires before every
 * model call, sees typed messages (not a serialized payload), and is provider-agnostic.
 * Every image block that is not already canonical is decoded and re-encoded as an 8-bit,
 * static, sRGB PNG. Canonical images are left byte-identical, so the common case costs a
 * 4 KB header read. Unreadable images degrade to a text placeholder instead of poisoning
 * the request.
 *
 * The header predicate is an optimization, never an admission decision: a false negative
 * costs one re-encode, not a rejected request.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sharp from "sharp";

type ImageBlock = { type: "image"; data: string; mimeType: string };
type TextBlock = { type: "text"; text: string };
type Block = ImageBlock | TextBlock;

type Header =
  | { kind: "png"; width: number; height: number; bitDepth: number; colorType: number; animated: boolean }
  | { kind: "jpeg"; width: number; height: number; bitDepth: number; components: number }
  | { kind: "webp"; animated: boolean }
  | { kind: "gif" | "bmp" | "other" };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_COLOR_TYPES = new Set([0, 2, 3, 4, 6]);
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const KIND_MIME: Partial<Record<Header["kind"], string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Decoding a larger image risks an OOM in the shared pi process; refuse it instead. */
const MAX_DECODE_PIXELS = 40_000_000;
/** Anthropic's inline image ceiling is 5 MB of base64; pi aims at 4.5 MB. */
const MAX_BASE64_BYTES = 4.5 * 1024 * 1024;
/** Every header fact we need lives in the first chunks; no need to decode whole payloads. */
const HEADER_BYTES = 4096;
const CACHE_LIMIT = 64;

const base64Size = (bytes: Buffer): number => Math.ceil(bytes.byteLength / 3) * 4;

function decodeHeader(bytes: string): Buffer {
  const prefixChars = Math.ceil(HEADER_BYTES / 3) * 4;
  return Buffer.from(bytes.length > prefixChars ? bytes.slice(0, prefixChars) : bytes, "base64");
}

function inspectPng(bytes: Buffer): Header {
  let animated = false;
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (type === "acTL") {
      animated = true;
      break;
    }
    if (type === "IDAT" || type === "IEND") break;
    const next = offset + 12 + length;
    if (next <= offset || next > bytes.length) break;
    offset = next;
  }
  return {
    kind: "png",
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colorType: bytes[25],
    animated,
  };
}

function inspectJpeg(bytes: Buffer): Header {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    // Standalone markers carry no length segment.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) break;
    if (JPEG_SOF_MARKERS.has(marker)) {
      return {
        kind: "jpeg",
        bitDepth: bytes[offset + 4],
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
        components: bytes[offset + 9],
      };
    }
    offset += 2 + length;
  }
  return { kind: "other" };
}

function inspectWebp(bytes: Buffer): Header {
  // WebP samples are always 8-bit; only animation can make a decoder reject it.
  return { kind: "webp", animated: bytes.toString("latin1", 12, 16) === "VP8X" && (bytes[20] & 0x02) !== 0 };
}

export function inspectBytes(bytes: Buffer): Header {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return inspectPng(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return inspectJpeg(bytes);
  const magic = bytes.toString("latin1", 0, 4);
  if (magic === "GIF8") return { kind: "gif" };
  if (magic === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return inspectWebp(bytes);
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return { kind: "bmp" };
  return { kind: "other" };
}

/** 8-bit samples, single frame, no exotic component layout. */
export function isCanonical(header: Header): boolean {
  switch (header.kind) {
    case "png":
      return !header.animated && header.bitDepth <= 8 && PNG_COLOR_TYPES.has(header.colorType);
    case "jpeg":
      return header.bitDepth === 8 && (header.components === 1 || header.components === 3);
    case "webp":
      return !header.animated;
    default:
      return false;
  }
}

function placeholder(reason: string): TextBlock {
  return { type: "text", text: `[Image omitted: ${reason}]` };
}

async function reencode(bytes: Buffer): Promise<Block> {
  try {
    const png = await sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS, failOn: "none" })
      .rotate()
      .toColourspace("srgb")
      .png({ bitdepth: 8, compressionLevel: 9 })
      .toBuffer();
    if (base64Size(png) <= MAX_BASE64_BYTES) {
      return { type: "image", mimeType: "image/png", data: png.toString("base64") };
    }
  } catch {
    // Fall through to JPEG: the image may be decodable but not as PNG.
  }
  try {
    const jpeg = await sharp(bytes, { limitInputPixels: MAX_DECODE_PIXELS, failOn: "none" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
    if (base64Size(jpeg) <= MAX_BASE64_BYTES) {
      return { type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") };
    }
    return placeholder("could not be re-encoded below the inline image size limit");
  } catch {
    return placeholder("could not be decoded");
  }
}

const cache = new Map<string, Block>();

/** Returns the block to send: the same object when already canonical, else a replacement. */
export async function guardImageBlock(block: ImageBlock): Promise<Block> {
  const cached = cache.get(block.data);
  if (cached) return { ...cached };

  const header = inspectBytes(decodeHeader(block.data));

  // Bytes win over the declared MIME: a mismatched type breaks data-URL decoding.
  const declaredMime = KIND_MIME[header.kind];
  if (isCanonical(header)) {
    return declaredMime && declaredMime !== block.mimeType ? { ...block, mimeType: declaredMime } : block;
  }

  const pixels = header.kind === "png" || header.kind === "jpeg" ? header.width * header.height : 0;
  const replacement =
    pixels > MAX_DECODE_PIXELS
      ? placeholder("image is too large to normalize")
      : await reencode(Buffer.from(block.data, "base64"));

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(block.data, replacement);
  return { ...replacement };
}

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event, ctx) => {
    if (!ctx.model?.input?.includes("image")) return;
    let changed = false;
    for (const message of event.messages) {
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (let index = 0; index < content.length; index++) {
        const block = content[index] as Block;
        if (block?.type !== "image" || typeof block.data !== "string") continue;
        const next = await guardImageBlock(block);
        if (next !== block) {
          content[index] = next;
          changed = true;
        }
      }
    }
    return changed ? { messages: event.messages } : undefined;
  });
}
