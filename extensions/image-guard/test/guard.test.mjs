/**
 * Tests for image-guard. Fixtures live next to this file; gray16.png is the class of image
 * that broke a real session (16-bit grayscale PNG, under pi's size limits, forwarded verbatim).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import registerGuard, { guardImageBlock, inspectBytes, isCanonical } from "../index.ts";

const fixture = (name) => join(import.meta.dirname, "fixtures", name);
const load = (name) => readFileSync(fixture(name));
const block = (name, mimeType = "image/png") => ({
  type: "image",
  mimeType,
  data: load(name).toString("base64"),
});
const decode = (b) => Buffer.from(b.data, "base64");

test("detects the header facts that matter", () => {
  assert.deepEqual(
    { ...inspectBytes(load("gray16.png")), width: undefined, height: undefined },
    { kind: "png", width: undefined, height: undefined, bitDepth: 16, colorType: 0, animated: false },
  );
  assert.equal(inspectBytes(load("gray16.png")).width, 160);
  assert.equal(inspectBytes(load("animated.png")).animated, true);
  assert.equal(inspectBytes(load("animated.webp")).animated, true);
  assert.equal(inspectBytes(load("rgba8.png")).kind, "png");
  assert.equal(inspectBytes(load("animated.gif")).kind, "gif");
  assert.equal(inspectBytes(load("img.bmp")).kind, "bmp");
  const cmyk = inspectBytes(load("cmyk.jpg"));
  assert.equal(cmyk.kind, "jpeg");
  assert.equal(cmyk.components, 4);
});

test("classifies canonical and non-canonical images", () => {
  assert.equal(isCanonical(inspectBytes(load("plain8.png"))), true);
  assert.equal(isCanonical(inspectBytes(load("rgba8.png"))), true);
  assert.equal(isCanonical(inspectBytes(load("gray16.png"))), false);
  assert.equal(isCanonical(inspectBytes(load("rgb16.png"))), false);
  assert.equal(isCanonical(inspectBytes(load("animated.png"))), false);
  assert.equal(isCanonical(inspectBytes(load("animated.webp"))), false);
  assert.equal(isCanonical(inspectBytes(load("animated.gif"))), false);
  assert.equal(isCanonical(inspectBytes(load("cmyk.jpg"))), false);
  assert.equal(isCanonical(inspectBytes(load("img.bmp"))), false);
});

test("16-bit grayscale PNG is re-encoded to 8-bit and keeps its dimensions", async () => {
  const out = await guardImageBlock(block("gray16.png"));
  assert.equal(out.type, "image");
  assert.equal(out.mimeType, "image/png");
  const bytes = decode(out);
  assert.equal(inspectBytes(bytes).bitDepth, 8, "samples must be at most 8-bit");
  const meta = await sharp(bytes).metadata();
  assert.deepEqual([meta.width, meta.height], [160, 100]);
});

test("16-bit RGB PNG is re-encoded to 8-bit", async () => {
  const out = await guardImageBlock(block("rgb16.png"));
  assert.equal(out.type, "image");
  assert.equal(inspectBytes(decode(out)).bitDepth, 8);
});

test("animated PNG loses its animation", async () => {
  const out = await guardImageBlock(block("animated.png"));
  assert.equal(out.type, "image");
  assert.equal(inspectBytes(decode(out)).animated, false);
});

test("animated WebP and GIF come out as static PNG", async () => {
  for (const [name, mime] of [
    ["animated.webp", "image/webp"],
    ["animated.gif", "image/gif"],
  ]) {
    const out = await guardImageBlock(block(name, mime));
    assert.equal(out.type, "image", name);
    assert.equal(out.mimeType, "image/png", name);
    const header = inspectBytes(decode(out));
    assert.equal(header.kind, "png", name);
    assert.equal(header.animated, false, name);
  }
});

test("BMP degrades to a placeholder, since sharp cannot decode it", async () => {
  // Pi's own read path converts BMP to PNG before this hook runs; only a tool that hands
  // over raw BMP bytes reaches here, and no mainstream provider accepts BMP anyway.
  const out = await guardImageBlock(block("img.bmp", "image/bmp"));
  assert.equal(out.type, "text");
  assert.match(out.text, /^\[Image omitted: /);
});

test("CMYK JPEG is re-encoded without a 4-component layout", async () => {
  const out = await guardImageBlock(block("cmyk.jpg", "image/jpeg"));
  assert.equal(out.type, "image");
  const header = inspectBytes(decode(out));
  assert.notEqual(header.kind === "jpeg" ? header.components : 0, 4);
});

test("canonical images are returned untouched", async () => {
  for (const name of ["plain8.png", "rgba8.png"]) {
    const input = block(name);
    assert.equal(await guardImageBlock(input), input, name);
  }
});

test("declared MIME is corrected from the bytes", async () => {
  const input = block("plain8.png", "image/jpeg");
  const out = await guardImageBlock(input);
  assert.equal(out.mimeType, "image/png");
  assert.equal(out.data, input.data);
});

test("undecodable bytes degrade to a placeholder instead of an image", async () => {
  const truncated = load("gray16.png").subarray(0, 200);
  const out = await guardImageBlock({ type: "image", mimeType: "image/png", data: truncated.toString("base64") });
  assert.equal(out.type, "text");
  assert.match(out.text, /^\[Image omitted: /);
});

test("context handler rewrites only the blocks that need it", async () => {
  const handlers = [];
  registerGuard({ on: (name, handler) => name === "context" && handlers.push(handler) });
  assert.equal(handlers.length, 1);

  const bad = block("gray16.png");
  const good = block("plain8.png");
  const messages = [
    { role: "user", content: [{ type: "text", text: "hi" }, good] },
    { role: "toolResult", toolName: "read", content: [{ type: "text", text: "read image" }, bad] },
  ];
  const result = await handlers[0]({ messages }, { model: { id: "m", input: ["text", "image"] } });

  assert.ok(result?.messages, "changed context must be returned");
  assert.equal(result.messages[1].content[1].type, "image");
  assert.equal(inspectBytes(decode(result.messages[1].content[1])).bitDepth, 8);
  assert.equal(result.messages[0].content[1], good, "canonical block stays identity-equal");
});

test("context handler is a no-op for canonical-only context and non-vision models", async () => {
  const handlers = [];
  registerGuard({ on: (name, handler) => name === "context" && handlers.push(handler) });

  const clean = [{ role: "toolResult", content: [{ type: "image", ...block("plain8.png") }] }];
  assert.equal(await handlers[0]({ messages: clean }, { model: { id: "m", input: ["text", "image"] } }), undefined);

  const broken = [{ role: "toolResult", content: [{ type: "image", ...block("gray16.png") }] }];
  assert.equal(await handlers[0]({ messages: broken }, { model: { id: "m", input: ["text"] } }), undefined);
  assert.equal(inspectBytes(decode(broken[0].content[0])).bitDepth, 16, "non-vision models are not touched");
});
