/**
 * Tool Call Revert Extension
 *
 * Detects when a model outputs text that looks like a tool call invocation
 * but isn't a proper tool_use API block. Reverts the bad response from the
 * LLM context and retries the original user prompt cleanly — as if the bad
 * response never happened.
 *
 * The session file retains the bad response (append-only), but it never
 * reaches the LLM.
 *
 * ---
 *
 * Grammars: this extension supports multiple independent detection patterns.
 * Each grammar defines when to trigger a revert-retry cycle.
 *
 * To add a new grammar, call registerGrammar() in the extension factory.
 *
 * Example:
 *   registerGrammar("my-grammar", {
 *     detect(text) { return /my-pattern/.test(text); },
 *     label: "My Grammar",
 *   });
 *
 * ---
 *
 * Safety: after 5 consecutive revert attempts the extension gives up to
 * prevent infinite retry loops and token waste. The counter resets on any
 * message that does NOT trigger a revert.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Types
// =============================================================================

interface Grammar {
	/** Check if the assistant's text output matches this grammar's pattern */
	detect(text: string): boolean;

	/** Human-readable label for the notification (e.g. "DeepSeek V4 DSML") */
	label?: string;
}

interface GrammarRegistration {
	name: string;
	grammar: Grammar;
}

// =============================================================================
// Constants
// =============================================================================

const MAX_REVERT_ATTEMPTS = 5;
const MAX_FINGERPRINTS = 50;

/** Distinctive customType for the internal retry-trigger message */
const REVERT_CUSTOM_TYPE = "tool-call-revert";

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
	const grammars: GrammarRegistration[] = [];

	/**
	 * Register a detection grammar.
	 *
	 * Call at module level (synchronously during factory execution) to ensure
	 * grammars are available before agent_end fires.
	 */
	function registerGrammar(name: string, grammar: Grammar): void {
		grammars.push({ name, grammar });
	}

	// -------------------------------------------------------------------------
	// Grammars
	// -------------------------------------------------------------------------

	// DeepSeek V4 — outputs DSML (DeepSeek Markup Language) with tool call
	// labels as text instead of using the proper tool_use API blocks.
	// Detected by: DSML marker + ends with _calls>
	registerGrammar("deepseek-v4", {
		label: "DeepSeek V4 DSML",
		detect(text: string): boolean {
			const trimmed = text.trim();
			return /DSML/i.test(text) && trimmed.endsWith("_calls>");
		},
	});

	if (grammars.length === 0) {
		console.warn("[tool-call-revert] No grammars registered — extension is a no-op");
		return;
	}

	// =========================================================================
	// State
	// =========================================================================

	/** Consecutive revert-retry attempts (reset on any clean message) */
	let revertAttempts = 0;

	/**
	 * Set of bad assistant fingerprints (first 200 chars of text content).
	 * Accumulated across revert cycles so the context filter can always
	 * identify and remove bad responses on ANY turn — not just the retry.
	 */
	let badFingerprints = new Set<string>();

	// =========================================================================
	// Step 1: Detect on agent_end
	// =========================================================================

	pi.on("agent_end", async (event, ctx) => {
		const messages = event.messages;

		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
		if (!lastAssistant) return;

		// Extract text content
		const textBlocks = lastAssistant.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => ("text" in c ? c.text : ""));
		const allText = textBlocks.join("\n");

		// Check each grammar
		let matchedName: string | undefined;
		let matchedLabel: string | undefined;
		for (const reg of grammars) {
			if (reg.grammar.detect(allText)) {
				matchedName = reg.name;
				matchedLabel = reg.grammar.label ?? reg.name;
				break;
			}
		}

		if (!matchedName) {
			// Clean message — reset the revert counter
			revertAttempts = 0;
			return;
		}

		// Increment attempt counter
		revertAttempts++;

		// Check if we've exhausted retries — give up to prevent infinite loop
		if (revertAttempts >= MAX_REVERT_ATTEMPTS) {
			ctx.ui.notify(
				`⚠️ [${matchedLabel}] ${MAX_REVERT_ATTEMPTS} consecutive failures — giving up.`,
				"error",
			);
			revertAttempts = 0;
			badFingerprints.clear();
			return;
		}

		// Found a bad response — store its fingerprint for the context filter
		const fingerprint = allText.slice(0, 200);
		badFingerprints.add(fingerprint);
		if (badFingerprints.size > MAX_FINGERPRINTS) {
			// Evict oldest entries (Set iteration order = insertion order)
			const first = badFingerprints.values().next().value;
			if (first) badFingerprints.delete(first);
		}

		ctx.ui.notify(
			`⚠️ [${matchedLabel}] Attempt ${revertAttempts}/${MAX_REVERT_ATTEMPTS} — reverting and retrying...`,
			"warning",
		);

		// Trigger retry via pi.sendMessage with a distinctive customType.
		// The context handler (Step 2) removes this message from the LLM context
		// by matching its customType — no content text matching needed.
		// Using sendMessage (not sendUserMessage) gives us a structured
		// customType property that survives deep cloning.
		pi.sendMessage(
			{
				customType: REVERT_CUSTOM_TYPE,
				content: "",
				display: false,
			},
			{ deliverAs: "followUp" },
		);
	});

	// =========================================================================
	// Step 1.5: Reset counter after every successful tool call
	// =========================================================================

	pi.on("tool_execution_end", async (event) => {
		if (!event.isError) {
			revertAttempts = 0;
		}
	});

	// =========================================================================
	// Step 2: Clean the context on EVERY LLM call
	//
	// Unlike the previous approach (which only filtered during pendingRetry),
	// this filter runs unconditionally. This is critical because:
	//   - The bad assistant response is persisted to the session
	//   - On subsequent turns (new user prompts), ALL session messages are
	//     included in context — including the bad response
	//   - The filter removes any assistant message whose text matches a
	//     known bad fingerprint, PLUS any custom messages with our
	//     revert customType
	//
	// This ensures the model NEVER sees the bad response or the internal
	// retry message, not even on future turns.
	// =========================================================================

	pi.on("context", async (event) => {
		const messages = event.messages;
		const hasBadFingerprints = badFingerprints.size > 0;

		// Fast path: nothing to filter
		if (!hasBadFingerprints && !messages.some((m: any) => m.role === "custom" && m.customType === REVERT_CUSTOM_TYPE)) {
			return;
		}

		const filtered = messages.filter((m: any) => {
			// Remove any assistant message matching a known bad fingerprint
			if (hasBadFingerprints && m.role === "assistant") {
				const text = extractAssistantText(m);
				if (text && badFingerprints.has(text.slice(0, 200))) {
					return false;
				}
			}

			// Remove any custom message from our revert mechanism
			// Filtered by structured customType — reliable, not fragile content matching
			if (m.role === "custom" && m.customType === REVERT_CUSTOM_TYPE) {
				return false;
			}

			return true;
		});

		// Only return filtered if we actually changed something
		if (filtered.length !== messages.length) {
			return { messages: filtered };
		}
	});
}

// =============================================================================
// Helpers
// =============================================================================

function extractAssistantText(message: any): string | null {
	const blocks = message.content?.filter((c: any) => c.type === "text") ?? [];
	const text = blocks.map((c: any) => ("text" in c ? c.text : "")).join("");
	return text || null;
}
