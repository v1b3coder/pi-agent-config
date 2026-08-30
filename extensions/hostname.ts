import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Shows `user@host` in the pi-footer, like a bash prompt.
 *
 * Emits via pi.events for the pi-footer "Pi Event Value" widget.
 *
 * Usage:
 *   1. This extension is auto-discovered from ~/.pi/agent/extensions/ (run /reload)
 *   2. /footer → Add Widget → "Pi Event Value"
 *   3. Set Widget ID to "hostname"
 *   4. Position it before the Working Dir widget
 *   → renders as `dev@bro | ~/repo | ...`
 */

const WIDGET_ID = "hostname";

function currentUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    // os.userInfo() throws when the current uid has no passwd entry
    // (containers, some SSH setups)
    return process.env.USER ?? process.env.USERNAME ?? "unknown";
  }
}

function emitHostname(pi: ExtensionAPI): void {
  pi.events.emit("pi-footer:update-widget", {
    widgetId: WIDGET_ID,
    value: `${currentUser()}@${os.hostname()}`,
  });
}

export default function (pi: ExtensionAPI): void {
  // Emit shortly after load so pi-footer's event listener is guaranteed to be registered.
  setTimeout(() => emitHostname(pi), 1000);
  // Re-emit on session start (pi-footer re-applies its footer then).
  pi.on("session_start", () => emitHostname(pi));
}
