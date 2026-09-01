/**
 * Stream Deck integration extension.
 *
 * Registers two commands for external control (Stream Deck sends them as
 * prompts with command expansion enabled):
 *
 *   /stop  — stop the current generation (same as the Esc shortcut in TUI)
 *   /undo  — stop the generation, branch the session back one user prompt,
 *            and clear the prompt input
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("stop", {
		description: "Stop the current generation (same as Esc)",
		handler: async (_args, ctx) => {
			if (ctx.isIdle()) return;
			ctx.abort();
		},
	});

	pi.registerCommand("undo", {
		description: "Stop generation, step back one prompt, clear prompt input",
		handler: async (_args, ctx) => {
			// 1. Stop any running generation and wait for the agent to settle
			if (!ctx.isIdle()) {
				ctx.abort();
				await ctx.waitForIdle();
			}

			// 2. Find the last user prompt on the current branch and the entry before it
			// getBranch() returns entries in chronological order (root -> leaf).
			const branch = ctx.sessionManager.getBranch();
			const lastUserIndex = branch.findLastIndex(
				(entry) => entry.type === "message" && entry.message.role === "user",
			);
			if (lastUserIndex === -1) {
				ctx.ui.notify("Nothing to undo", "warning");
				return;
			}
			if (lastUserIndex === 0) {
				ctx.ui.notify("Already at the first prompt", "warning");
				return;
			}

			const target = branch[lastUserIndex - 1];

			// 3. Branch back to before the last user prompt (no LLM summary)
			await ctx.navigateTree(target.id, { summarize: false });

			// 4. Clear the prompt input
			ctx.ui.setEditorText("");
		},
	});
}
