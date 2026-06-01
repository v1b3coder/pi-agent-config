import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Per-turn prefill & decode speed widget for pi-footer.
 *
 * Measures raw model throughput per LLM turn:
 *   - Prefill speed  = new_input_tokens_delta / time_to_first_token  (tok/s)
 *   - Decode speed   = output_tokens / generation_time              (tok/s)
 *
 * Prefill uses delta of input tokens between consecutive turns to exclude
 * cached/reused context and measure only newly processed prompt tokens.
 *
 * Emits values via pi.events for the pi-footer "Event" widget.
 *
 * Usage:
 *   1. Install this extension
 *   2. /footer → Add Widget → "Pi Event Value"
 *   3. Set Widget ID to "perf-speed"
 *   4. Position and style as desired
 */

const WIDGET_ID = "perf-speed";

const ICON_PREFILL = "\u{1F879}";
const ICON_DECODE = "\u{1F87B}";

// --- State ---

let turnStart = 0;
let firstTokenTime = 0;

// Store last values so we only emit when something actually changed
let lastPrefillSpeed: number | null = null;
let lastDecodeSpeed: number | null = null;
let lastEmitted: string | null = null;

// Track input token delta across turns (prefill = new tokens, not full context)
let previousInputTokens = 0;

// --- Helpers ---

function formatSpeed(tokensPerSec: number): string {
  if (tokensPerSec >= 1000) {
    return `${(tokensPerSec / 1000).toFixed(1)}k`;
  }
  return Math.round(tokensPerSec).toString();
}

function emitSpeed(pi: ExtensionAPI): void {
  let value: string;

  if (lastPrefillSpeed !== null && lastDecodeSpeed !== null) {
    value = `${ICON_PREFILL} ${formatSpeed(lastPrefillSpeed)} tok/s ${ICON_DECODE} ${formatSpeed(lastDecodeSpeed)} tok/s`;
  } else if (lastPrefillSpeed !== null) {
    value = `${ICON_PREFILL} ${formatSpeed(lastPrefillSpeed)} tok/s`;
  } else if (lastDecodeSpeed !== null) {
    value = `${ICON_DECODE} ${formatSpeed(lastDecodeSpeed)} tok/s`;
  } else {
    value = "—";
  }

  if (value === lastEmitted) return;
  lastEmitted = value;

  pi.events.emit("pi-footer:update-widget", {
    widgetId: WIDGET_ID,
    value,
  });
}

// --- Extension ---

export default function (pi: ExtensionAPI): void {
  // --- Turn tracking ---

  pi.on("turn_start", (_event, ctx) => {
    turnStart = performance.now();
    firstTokenTime = 0;

    // Initialize baseline from current context on first turn after load
    if (previousInputTokens === 0) {
      const usage = ctx.getContextUsage();
      if (usage?.tokens && usage.tokens > 0) {
        previousInputTokens = usage.tokens;
      }
    }
  });

  pi.on("message_start", (event) => {
    // The first assistant message_start of a turn marks time-to-first-token
    if (event.message.role === "assistant" && firstTokenTime === 0) {
      firstTokenTime = performance.now();
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;

    const now = performance.now();
    const msg = event.message as { usage?: { input: number; output: number } };
    const inputTokens = msg.usage?.input ?? 0;
    const outputTokens = msg.usage?.output ?? 0;

    // Prefill speed: only delta since last turn (new tokens, not full context)
    if (turnStart > 0 && firstTokenTime > 0 && previousInputTokens > 0) {
      const newTokens = inputTokens - previousInputTokens;
      const ttftMs = firstTokenTime - turnStart;
      if (ttftMs > 0 && newTokens > 0) {
        lastPrefillSpeed = newTokens / (ttftMs / 1000);
      }
    }

    // Store for next turn's delta
    previousInputTokens = inputTokens;

    // Decode speed: output tokens / generation time (after first token)
    if (firstTokenTime > 0) {
      const genTimeMs = now - firstTokenTime;
      if (genTimeMs > 0 && outputTokens > 0) {
        lastDecodeSpeed = outputTokens / (genTimeMs / 1000);
      }
    }

    emitSpeed(pi);
  });

  // Show "—" placeholder on startup (before any turn completes)
  pi.on("session_start", () => {
    emitSpeed(pi);
  });
}
