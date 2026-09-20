import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Per-turn prefill & decode speed widget for pi-footer.
 *
 * Measures raw model throughput per LLM turn:
 *   - Prefill speed  = input_tokens / time_to_first_token  (tok/s)
 *   - Decode speed   = output_tokens / generation_time     (tok/s)
 *
 * Time-to-first-token is anchored on the first streamed token (message_update).
 * pi normalizes `usage.input` to the *non-cached* prompt tokens for every
 * provider (OpenAI-compatible: prompt_tokens - cacheRead - cacheWrite;
 * Anthropic/Google report the cached part separately), so prefill must NOT
 * subtract cacheRead again — doing so yields a negative number and no prefill.
 *
 * While a response is streaming the widget is refreshed every LIVE_INTERVAL_MS
 * (5 s) so long turns show progress before they finish:
 *   - Prefill uses the provider-reported non-cached input tokens, which land
 *     at the start of the stream, and the already-fixed time-to-first-token.
 *   - Decode uses the running generation time since the first token and a live
 *     output-token estimate (streamed chars / 4), because most providers only
 *     report exact output usage at the end of the stream.
 * The authoritative provider numbers replace the estimates at message_end.
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

/** Live refresh period while streaming. */
const LIVE_INTERVAL_MS = 5000;
/** Same estimator pi itself uses for trailing context. */
const CHARS_PER_TOKEN = 4;

const ICON_PREFILL = "\u{1F879}";
const ICON_DECODE = "\u{1F87B}";

// --- State ---

let turnStart = 0;
let firstTokenTime = 0;

// Live streaming state
let liveOutputChars = 0;
let liveInputTokens = 0;
let liveTimer: ReturnType<typeof setInterval> | null = null;

// Store last values so we only emit when something actually changed
let lastPrefillSpeed: number | null = null;
let lastDecodeSpeed: number | null = null;
let lastEmitted: string | null = null;

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

function startLiveTimer(pi: ExtensionAPI): void {
  if (liveTimer) return;
  liveTimer = setInterval(() => emitLive(pi), LIVE_INTERVAL_MS);
}

function stopLiveTimer(): void {
  if (!liveTimer) return;
  clearInterval(liveTimer);
  liveTimer = null;
}

/** Recompute both speeds from the start of the current turn and emit. */
function emitLive(pi: ExtensionAPI): void {
  if (firstTokenTime === 0) return;
  const now = performance.now();

  // Prefill: usage.input is already the non-cached prompt token count
  if (turnStart > 0) {
    const prefilled = liveInputTokens;
    const ttftMs = firstTokenTime - turnStart;
    if (ttftMs > 0 && prefilled > 0) {
      lastPrefillSpeed = prefilled / (ttftMs / 1000);
    }
  }

  // Decode: estimated output tokens so far / generation time so far
  const estimatedOutput = liveOutputChars / CHARS_PER_TOKEN;
  const genTimeMs = now - firstTokenTime;
  if (genTimeMs > 0 && estimatedOutput > 0) {
    lastDecodeSpeed = estimatedOutput / (genTimeMs / 1000);
  }

  emitSpeed(pi);
}

// --- Extension ---

export default function (pi: ExtensionAPI): void {
  // --- Turn tracking ---

  pi.on("turn_start", () => {
    turnStart = performance.now();
    firstTokenTime = 0;
    liveOutputChars = 0;
    liveInputTokens = 0;
    stopLiveTimer();
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;

    // First streamed token of an assistant response marks time-to-first-token.
    // message_start fires at HTTP response headers, before the first token.
    if (firstTokenTime === 0) {
      firstTokenTime = performance.now();
    }

    // The partial message's usage object is mutated in place by the provider,
    // so the non-cached input count may appear as soon as streaming starts.
    const msg = event.message as {
      usage?: { input?: number };
    };
    if (msg.usage) {
      liveInputTokens = msg.usage.input ?? 0;
    }

    const delta = (event.assistantMessageEvent as { delta?: unknown })?.delta;
    if (typeof delta === "string") {
      liveOutputChars += delta.length;
    }

    // Update immediately on the first token, then on the interval.
    if (!liveTimer) {
      startLiveTimer(pi);
      emitLive(pi);
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;

    stopLiveTimer();
    liveOutputChars = 0;
    liveInputTokens = 0;

    const now = performance.now();
    const msg = event.message as {
      usage?: { input: number; output: number };
    };
    const inputTokens = msg.usage?.input ?? 0;
    const outputTokens = msg.usage?.output ?? 0;

    // Prefill speed: usage.input is already the non-cached prompt token count
    if (turnStart > 0 && firstTokenTime > 0) {
      const prefilled = inputTokens;
      const ttftMs = firstTokenTime - turnStart;
      if (ttftMs > 0 && prefilled > 0) {
        lastPrefillSpeed = prefilled / (ttftMs / 1000);
      }
    }

    // Decode speed: output tokens / generation time (after first token)
    if (firstTokenTime > 0) {
      const genTimeMs = now - firstTokenTime;
      if (genTimeMs > 0 && outputTokens > 0) {
        lastDecodeSpeed = outputTokens / (genTimeMs / 1000);
      }
    }

    emitSpeed(pi);
  });

  // Safety net: never leave the interval running past the turn.
  pi.on("turn_end", () => {
    stopLiveTimer();
  });

  // Show "—" placeholder on startup (before any turn completes)
  pi.on("session_start", () => {
    emitSpeed(pi);
  });

  pi.on("session_shutdown", () => {
    stopLiveTimer();
  });
}
