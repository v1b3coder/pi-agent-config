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

	const MAX_REVERT_ATTEMPTS = 5;

	/** Consecutive revert-retry attempts (reset on any clean message) */
	let revertAttempts = 0;

	/** Fingerprint of the bad assistant message content (first 200 chars) */
	let badMessageFingerprint: string | null = null;

	/** Whether we have a pending revert-retry cycle */
	let pendingRetry = false;

	/** Label of the grammar that triggered the last revert */
	let triggeredLabel = "";

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
			pendingRetry = false;
			badMessageFingerprint = null;
			return;
		}

		// Found a bad response — prepare the revert
		badMessageFingerprint = allText.slice(0, 200);
		pendingRetry = true;
		triggeredLabel = matchedLabel;

		ctx.ui.notify(
			`⚠️ [${matchedLabel}] Attempt ${revertAttempts}/${MAX_REVERT_ATTEMPTS} — reverting and retrying...`,
			"warning",
		);

		pi.sendUserMessage(
			"[internal tool-call-revert: re-respond to the previous request using proper tool_use blocks]",
			{ deliverAs: "followUp" },
		);
	});

	// =========================================================================
	// Step 2: Clean the context on the retry LLM call
	// =========================================================================

	pi.on("context", async (event) => {
		if (!pendingRetry) return;

		const messages = event.messages;
		let foundBad = false;
		let foundInternal = false;

		const filtered = messages.filter((m: any) => {
			// Remove the bad assistant response (match by fingerprint)
			if (!foundBad && m.role === "assistant") {
				const text = extractAssistantText(m);
				if (text && badMessageFingerprint && text.startsWith(badMessageFingerprint)) {
					foundBad = true;
					return false;
				}
			}

			// Remove the internal retry user message (match by exact content)
			if (
				!foundInternal &&
				m.role === "user" &&
				m.content ===
					"[internal tool-call-revert: re-respond to the previous request using proper tool_use blocks]"
			) {
				foundInternal = true;
				return false;
			}

			// Same check for content as array (pi.sendUserMessage may stringify)
			if (
				!foundInternal &&
				m.role === "user" &&
				typeof m.content === "object" &&
				Array.isArray(m.content) &&
				m.content.length === 1 &&
				m.content[0]?.type === "text" &&
				m.content[0]?.text ===
					"[internal tool-call-revert: re-respond to the previous request using proper tool_use blocks]"
			) {
				foundInternal = true;
				return false;
			}

			return true;
		});

		if (foundBad && foundInternal) {
			pendingRetry = false;
			badMessageFingerprint = null;
			return { messages: filtered };
		}

		if (foundBad) {
			// Bad message found but internal retry not yet — keep pendingRetry
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
