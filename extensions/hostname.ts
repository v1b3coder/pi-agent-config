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
  // The captured pi goes stale after session replacement (newSession/fork/
  // switchSession) or /reload. A stale emit must never escape as an uncaught
  // exception and kill pi; the replacement instance re-emits on session_start
  // anyway, so swallowing a stale emit is correct.
  try {
    pi.events.emit("pi-footer:update-widget", {
      widgetId: WIDGET_ID,
      value: `${currentUser()}@${os.hostname()}`,
    });
  } catch {
    // stale ctx — ignore
  }
}

export default function (pi: ExtensionAPI): void {
  // Emit shortly after load so pi-footer's event listener is guaranteed to be registered.
  const timer = setTimeout(() => emitHostname(pi), 1000);
  // The captured pi goes stale when the session is replaced (newSession/fork/
  // switchSession/reload). A pending timer would then throw the "stale ctx"
  // assertion and crash pi, so clear it on shutdown.
  pi.on("session_shutdown", () => clearTimeout(timer));
  // Re-emit on session start (pi-footer re-applies its footer then).
  pi.on("session_start", () => emitHostname(pi));
}
