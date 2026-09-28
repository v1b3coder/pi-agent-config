# Serve the diagram image to every client by default, keep it out of model context

**Package:** `@mcuste/pi-diagram` (observed on 0.6.3)
**Repo:** https://github.com/mcuste/pi-diagram

## Summary

The `diagram` tool returns only text in `content`. The rendered PNG is drawn only by the
extension's own TUI `renderResult`, so any other host — RPC, print, JSON, a GUI client — receives
the Unicode art and never the image, even though those hosts can render images and the protocol
already carries them.

Proposal: in non-TUI modes, put the image block in `content` by default, and append a `context_edit`
at `turn_end` so the model's context keeps only the text. The client renders the image if it can, and
shows the text it already gets if it cannot. No flags, no capability declaration, no client change, and
the README's guarantee that the PNG never enters the model's context still holds — by construction, in
every mode, not only by default.

## Constraint this must not break

The README states two invariants that stay exactly as they are:

> D2 keeps generation token-efficient: the model describes nodes, edges, groups, and labels instead
> of spending tokens on layout or SVG coordinates.

> The PNG never enters the model's context. It is written to a private temporary directory and read
> only by the display renderer.

The model's context is what matters here, and this proposal does not change it. Serving the image to a
client does not require ingesting it into the model's context: `turn_end` supports a `context_edit` that
"changes only future model context; the target entry and its metadata remain unchanged in raw history,
UI, exports, and session accounting". The image therefore reaches the client and its raw history while the
model continues to read text only.

The second sentence of that quote changes: the PNG is no longer read only by the display renderer, it is also
read by whichever client renders it. What the sentence protects — model context — is preserved.

## Problem

### The image is TUI-only today

`execute()` returns:

```js
return {
  content: [{ type: "text", text: contentFor(rendering, drawnHere) }],
  details: detailsFor(parameters, rendering)
};
```

`content` is text only. `contentFor()` returns the title, the Unicode art, and the saved paths.
`details.image` holds `{ path, widthPx, heightPx }`, and the PNG is drawn only by the extension's own
`renderResult`, which runs in the interactive TUI.

### Consequences

- **RPC hosts get no image.** `pi --mode rpc` forwards `tool_execution_end.result.content` verbatim, so an RPC client sees only the Unicode art. A GUI client that renders image content blocks correctly — for example the built-in `read` tool's output — has nothing to render for `diagram`.
- **The client cannot ask either.** Tool parameters are chosen by the model, so a client cannot make the tool pass `render: "image"` on its behalf.
- **`render: "image"` is a no-op outside the TUI.** `parseRepresentation()` collapses `"image"` into `"unicode"`, so `render: "image"` and `render: "unicode"` are identical in print, JSON, and RPC modes.
- **`details.image.path` is not a client contract.** `keepImage()` writes through `sessionDirectory()`, a private `mkdtemp` directory (`pi-diagram-store-*`) that the README describes as read only by the display renderer. Clients would have to read a private OS temp file, with OS cleanup, remote-host, and sandbox failure modes, and re-implement base64 and MIME handling the protocol already has.

### Reproduction

```bash
pi --mode rpc --no-session
{"type":"prompt","message":"Draw a diagram of how Pi works"}
```

The `tool_execution_end` event's `result.content` contains one text block with the Unicode art and no
image block, while `result.details.image.path` points at the PNG.

## Proposal

### 1. Serve the image in `content` in non-TUI modes

In `execute()`, add the image block next to the text block when a PNG was rasterized:

```js
const content = [{ type: "text", text: contentFor(rendering, drawnHere) }];

if (servesImage(parameters.render) && rendering.image) {
  content.push({
    type: "image",
    data: await readPngBase64(rendering.image.path), // cache per sourceHash
    mimeType: "image/png"
  });
}
```

Any client that renders image blocks shows the diagram. Any client that ignores them shows the text
block it already gets. No client has to opt in, declare a capability, or change anything.

### 2. Keep the model's context text-only with a `context_edit` at `turn_end`

`turn_end` makes this exact:

- `TurnEndEvent.toolResultEntryIds` gives the entry IDs of this turn's tool results.
- `ContextEditEntryDraft { type: "context_edit", targetId, replacement }` is an allowed draft at `turn_end`.
- `agent-loop.js` emits `turn_end` after the tool results and before the next provider request, so the edit applies to the very request that would otherwise carry the image.

So at `turn_end` the extension appends a `context_edit` whose replacement is the text-only content.
The client renders the image, and the model reads text only, exactly as it does today.

### 3. Keep `render` meaningful

| `render` | Image in `content` | Text block |
|---|---|---|
| `auto` (default) | yes | summary in the TUI, Unicode art elsewhere |
| `image` | yes | summary in the TUI, saved paths elsewhere |
| `unicode` | no | Unicode art — the opt-out |
| `source` | no | D2 source |

`unicode` and `source` remain explicit opt-outs for callers that want no image at all.

### 4. Leave the TUI path alone

The TUI keeps its current behaviour through `renderResult`: `auto` shows Unicode with the `Ctrl+O` hint
and replaces it with the PNG when expanded, `image` shows a compact inline PNG, `unicode` stays Unicode in
both views, and `source` shows the source. Because `content` carries no image block in TUI mode, the host's
generic content-image rendering does not draw a second copy.

### 5. Precondition: the `turn_end` boundary API

`context_edit` drafts at `turn_end` are the part that keeps the model's context unchanged, so the package
needs a Pi core version that supports them. On an older Pi, the extension should fall back to today's behaviour
— text only in `content` — rather than serve an image the model would then ingest. Worth stating the minimum
version in the README.

### 6. Document what each host receives

The README's "PNG never enters the model's context" statement stays true, with a note that in non-TUI modes
the image is attached to the tool result and excluded from model context at the `turn_end` boundary. Also worth
documenting that `get_messages` returns the projected context and so omits the image, while `get_entries` returns
the raw entries and keeps it, so a client that rebuilds history from raw entries keeps showing the image after reload.

## Why this is safe

- **The model's context is unchanged in every mode.** The `context_edit` excludes the image from the model's context in the same turn the tool runs, so no conversation gains image tokens.
- **Non-vision models were already handled.** `pi-ai`'s `downgradeUnsupportedImages()` replaces image blocks with `(tool image omitted: model does not support images)`; the `context_edit` means this path is rarely reached.
- **Injected images are already normalized.** `core/agent-session.js` `afterToolCall()` runs `normalizeToolResultImages()` on the hook result, honoring `images.autoResize`.
- **The protocol already supports it.** `ToolResultMessage.content` is `(TextContent | ImageContent)[]`; the built-in `read` tool returns exactly this shape for PNG/JPG files.
- **No client regresses.** A client that ignores image blocks sees the same text it sees today. A client that renders them gains the diagram.
- **No capability negotiation is needed.** Because the model's context is unchanged either way, the extension does not need to know whether the client can render images. The client decides, which is where that decision belongs.

## Accepted costs

- **Session size.** The base64 image is persisted in the session JSONL. That is storage, not model context, and callers who care can still pass `render: "unicode"`.
- **Reload path.** A client that rebuilds history from `get_messages` sees the projected context and so loses the image; one that uses `get_entries` keeps it. Documenting this is enough.

## Alternative considered

An environment variable by which a client declares that it renders images. Rejected: it puts a decision on the client that the client does not need to make, since the image is excluded from model context regardless, and it leaves every client that does not set the variable without the image.

## Alternative considered

Ask clients to read `details.image.path` themselves. Rejected: it is a private temp path by design, it may be unreadable or short-lived, it does not exist at all for a remote client, and it makes every client re-implement work the protocol already has a representation for.
