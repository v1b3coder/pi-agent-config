import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Real-time token/context widgets for pi-footer.
 *
 * pi persists messages and usage only at `message_end`, so during streaming
 * every footer data source (`ctx.getContextUsage()`, session/turn metrics)
 * is frozen at the last completed message. With thinking hidden/collapsed the
 * footer therefore looks dead for minutes.
 *
 * This extension closes the gap by listening to `message_update` streaming
 * deltas and counting generated characters live (tokens ~= chars / 4, the
 * same estimator pi itself uses for trailing context). It publishes:
 *
 *   - widgetId "live-gen":  tokens generated in the current agent round
 *     (thinking + text + tool-call args), e.g. `+12.3k`. Hidden when idle.
 *   - widgetId "live-ctx":  live estimated next-request context size:
 *     `getContextUsage()` (covers everything already completed) plus the
 *     in-flight assistant message, e.g. `[████░░░░] 84.2k/400k (21%)`.
 *     Reads the same numbers as the built-in context bar when idle, updates
 *     in real time while streaming.
 *
 * Emits are throttled (500 ms by default — set LIVE_TOKENS_INTERVAL_MS to tune,
 * minimum 100 ms) and only pushed when the value actually changes; each
 * `pi-footer:update-widget` emission also forces a footer re-render, so the
 * built-in widgets (cost, turn tokens, ...) snap right after each message
 * completes too.
 *
 * Throttling matters: the TUI repaints every streaming frame anyway (one
 * requestRender per delta), but the footer LINE itself is only cleared+redrawn
 * when its content changes. Lowering our emission rate keeps the footer line
 * stable between updates and avoids visible flicker.
 *
 * Usage:
 *   1. Load this extension (auto-discovered in ~/.pi/agent/extensions/)
 *   2. /footer → tab to widgets → add "Pi Event Value" with Widget ID
 *      "live-gen" and/or "live-ctx" (or edit ~/.pi/agent/extensions/pi-footer.json)
 */

const WIDGET_GEN_ID = "live-gen";
const WIDGET_CTX_ID = "live-ctx";

const CHARS_PER_TOKEN = 4;
/** Emission throttle: 500 ms default. Override with LIVE_TOKENS_INTERVAL_MS. */
const EMIT_INTERVAL_MS = (() => {
  const raw = Number(process.env.LIVE_TOKENS_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 100 ? Math.floor(raw) : 500;
})();
const BAR_WIDTH = 32;
const BAR_FILLED = "█";
const BAR_EMPTY = "░";

// --- State ---

let roundActive = false;
/** Chars generated in the current agent round (all assistant messages). */
let roundChars = 0;
/** Chars of the assistant message currently streaming (not in session yet). */
let inFlightChars = 0;
let lastEmitMs = 0;
let lastGenValue: string | null = null;
let lastCtxValue: string | null = null;

// --- Helpers ---

function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function formatCount(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function emit(
  pi: ExtensionAPI,
  widgetId: string,
  value: string | null,
  cacheKey: "gen" | "ctx",
): void {
  const cached = cacheKey === "gen" ? lastGenValue : lastCtxValue;
  if (cacheKey === "gen") lastGenValue = value;
  else lastCtxValue = value;
  if (cached === value) return;

  pi.events.emit("pi-footer:update-widget", { widgetId, value });
}

function emitGen(pi: ExtensionAPI, value: string | null): void {
  emit(pi, WIDGET_GEN_ID, value, "gen");
}

function emitCtx(pi: ExtensionAPI, value: string | null): void {
  emit(pi, WIDGET_CTX_ID, value, "ctx");
}

/**
 * Live context value: everything pi already knows about (last assistant usage
 * + trailing estimate) plus the assistant message currently streaming, which
 * is not persisted to the session until message_end.
 */
function liveContextValue(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const base = usage?.tokens ?? null;
  const max = usage?.contextWindow ?? 0;
  const tokens = base === null ? null : base + estimateTokens(inFlightChars);

  if (tokens === null || max <= 0) return "?";

  const percent = Math.min(100, Math.max(0, (tokens / max) * 100));
  const filledWidth = Math.round((percent / 100) * BAR_WIDTH);
  const meter = `${BAR_FILLED.repeat(filledWidth)}${BAR_EMPTY.repeat(Math.max(0, BAR_WIDTH - filledWidth))}`;
  return `[${meter}] ${formatCount(tokens)}/${formatCount(max)} (${Math.round(percent)}%)`;
}

interface DeltaReader {
  contentIndex?: unknown;
  delta?: unknown;
}

function deltaLength(streamEvent: unknown): number {
  const s = streamEvent as DeltaReader;
  return typeof s?.delta === "string" ? s.delta.length : 0;
}

function emitGeneratorValue(pi: ExtensionAPI): void {
  emitGen(pi, roundActive ? `+${formatCount(estimateTokens(roundChars))}` : null);
}

// --- Extension ---

export default function (pi: ExtensionAPI): void {
  pi.on("agent_start", (_event, ctx) => {
    roundActive = true;
    roundChars = 0;
    inFlightChars = 0;
    lastEmitMs = 0;
    emitGeneratorValue(pi);
    emitCtx(pi, liveContextValue(ctx));
  });

  pi.on("agent_settled", (_event, ctx) => {
    // Round finished: hide the generator counter and show the exact context
    // size that the just-completed round's usage now reports.
    roundActive = false;
    inFlightChars = 0;
    emitGeneratorValue(pi);
    emitCtx(pi, liveContextValue(ctx));
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    inFlightChars = 0;
    emitGeneratorValue(pi);
    emitCtx(pi, liveContextValue(ctx));
  });

  pi.on("message_update", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const streamEvent = event.assistantMessageEvent;
    if (!streamEvent) return;

    if (
      streamEvent.type === "text_delta" ||
      streamEvent.type === "thinking_delta" ||
      streamEvent.type === "toolcall_delta"
    ) {
      const len = deltaLength(streamEvent);
      if (len > 0) {
        roundChars += len;
        inFlightChars += len;
      }
    }

    const now = Date.now();
    if (now - lastEmitMs < EMIT_INTERVAL_MS) return;
    lastEmitMs = now;
    emitGeneratorValue(pi);
    emitCtx(pi, liveContextValue(ctx));
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    // The finalized message is persisted (and its exact usage recorded) only
    // AFTER this handler returns, so re-reading context usage here would show
    // a stale, lower value. Update the generator counter now (unthrottled);
    // the context bar is refreshed on turn_end / agent_settled instead.
    inFlightChars = 0;
    lastEmitMs = Date.now();
    emitGeneratorValue(pi);
  });

  pi.on("turn_end", (_event, ctx) => {
    // Assistant message + tool results are persisted by now: exact numbers.
    emitCtx(pi, liveContextValue(ctx));
  });

  pi.on("session_start", (_event, ctx) => {
    roundActive = false;
    roundChars = 0;
    inFlightChars = 0;
    emitGeneratorValue(pi);
    emitCtx(pi, liveContextValue(ctx));
  });

  pi.on("session_shutdown", () => {
    // Footer is being torn down; clear widget values for cleanliness.
    emitGen(pi, null);
    emitCtx(pi, null);
  });
}
