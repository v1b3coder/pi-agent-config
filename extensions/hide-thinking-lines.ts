/**
 * Hide "Thinking..." placeholder lines in the transcript.
 *
 * When thinking blocks are hidden (`hideThinkingBlock: true`, Ctrl+T or
 * /settings), pi replaces each thinking block with a persistent "Thinking..."
 * line. This extension blanks that label (setHiddenThinkingLabel("")) so no
 * "Thinking..." text is rendered. A blank spacer line may remain between
 * blocks - that is pi's built-in spacing and cannot be removed via the
 * extension API (pi's renderer is bundled, so monkey patching it from an
 * extension does not work on npm installs).
 *
 * Activity is still shown by the streaming "Working" indicator, and thinking
 * content still appears when visibility is toggled on (Ctrl+T).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setHiddenThinkingLabel("");
	});
}
