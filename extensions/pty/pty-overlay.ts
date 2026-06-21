/**
 * PtyOverlay — TUI peek overlay for PTY sessions, inspired by SubagentPeek.
 *
 * Renders tabbed session view with scrollable output.
 * Uses xterm headless serialization for ANSI-rendered viewport.
 */

import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { PtyManager } from "./pty-manager.ts";

/** How many lines of terminal output to show. */
const VISIBLE_LINES = 20;

export interface PtyOverlayOptions {
  onClose: () => void;
}

export class PtyOverlay {
  private selectedIndex = 0;
  private scrollOffset = 0;
  private options: PtyOverlayOptions;
  private manager: PtyManager;

  constructor(
    manager: PtyManager,
    options: PtyOverlayOptions,
  ) {
    this.manager = manager;
    this.options = options;
  }

  handleInput(data: string): void {
    const sessions = this.manager.list();
    if (sessions.length === 0) {
      this.options.onClose();
      return;
    }

    if (matchesKey(data, Key.left)) {
      // Previous session
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.scrollOffset = 0;
      }
    } else if (matchesKey(data, Key.right)) {
      // Next session
      if (this.selectedIndex < sessions.length - 1) {
        this.selectedIndex++;
        this.scrollOffset = 0;
      }
    } else if (data === "shift+tab") {
      // Previous session (tab backwards)
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
        this.scrollOffset = 0;
      }
    } else if (matchesKey(data, Key.tab)) {
      // Next session (tab forward)
      if (this.selectedIndex < sessions.length - 1) {
        this.selectedIndex++;
        this.scrollOffset = 0;
      }
    } else if (matchesKey(data, Key.up)) {
      // Scroll up
      this.scrollOffset++;
    } else if (matchesKey(data, Key.down)) {
      // Scroll down
      if (this.scrollOffset > 0) {
        this.scrollOffset--;
      }
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset += VISIBLE_LINES;
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - VISIBLE_LINES);
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.options.onClose();
    }
  }

  invalidate(): void {
    // No cache — render() reads live state every time
  }

  private bordered(text: string, innerWidth: number): string {
    const visible = visibleWidth(text);
    const pad = Math.max(0, innerWidth - visible);
    return `\u2502 ${text}${pad ? " ".repeat(pad) : ""} \u2502`;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const innerW = Math.max(1, width - 4);
    const sessions = this.manager.list();

    if (sessions.length === 0) {
      lines.push(`\u250c${"\u2500".repeat(width - 2)}\u2510`);
      lines.push(`\u2502${" ".repeat(width - 2)}\u2502`);
      lines.push(this.bordered("No active PTY sessions", innerW));
      lines.push(`\u2502${" ".repeat(width - 2)}\u2502`);
      lines.push(`\u2514${"\u2500".repeat(width - 2)}\u2518`);
      return lines;
    }

    // ── Session tabs in top border ──
    const tabs = sessions.map((s, i) => {
      const icon = s.status === "running" ? "\u25c9" : s.status === "exited" ? "\u2713" : "\u2717";
      const label = `${icon} ${s.id}`;
      if (i === this.selectedIndex) {
        return `\x1b[7m ${label} \x1b[27m`;
      }
      return ` ${label} `;
    });
    const tabsStr = tabs.join("\u2502");
    const truncatedTabs = truncateToWidth(tabsStr, width - 6);
    const tabsVisible = visibleWidth(truncatedTabs);
    const dashFill = Math.max(0, width - 6 - tabsVisible);
    lines.push(
      `\u250c\u2500\u2500 ${truncatedTabs} ${dashFill > 0 ? "\u2500".repeat(dashFill) : ""}\u2510`,
    );

    // ── Info bar ──
    const selected = sessions[this.selectedIndex];
    if (selected) {
      const runtime = formatRuntime(selected.runtime);
      const truncatedCmd = truncateToWidth(selected.command, 40);
      const info = `${selected.status.padEnd(9)} ${runtime.padEnd(8)} ${truncatedCmd}`;
      lines.push(this.bordered(truncateToWidth(info, innerW), innerW));
      lines.push(`\u2502${"\u2500".repeat(width - 2)}\u2502`);
    }

    // ── Terminal output ──
    if (selected) {
      const session = this.manager.get(selected.id);
      if (session) {
        // Serialize the xterm viewport
        const viewport = session.serializeViewport(VISIBLE_LINES + this.scrollOffset);

        // Calculate visible rows from viewport
        const contentLines = viewport.split("\n");
        const totalLines = contentLines.length;
        const start = Math.max(0, totalLines - VISIBLE_LINES - this.scrollOffset);
        const end = Math.min(totalLines, start + VISIBLE_LINES);

        for (let i = start; i < end; i++) {
          const rawLine = contentLines[i] ?? "";
          // Truncate to terminal width
          const truncated = truncateToWidth(rawLine, innerW);
          lines.push(this.bordered(truncated, innerW));
        }

        // Pad remaining visible rows
        const rendered = end - start;
        for (let i = rendered; i < VISIBLE_LINES; i++) {
          lines.push(`\u2502${" ".repeat(width - 2)}\u2502`);
        }
      } else {
        // Session gone
        for (let i = 0; i < VISIBLE_LINES; i++) {
          lines.push(`\u2502${" ".repeat(width - 2)}\u2502`);
        }
      }
    }

    // ── Bottom border with help ──
    const help = this.scrollOffset > 0
      ? "\u2191 more  \u2022  \u2191\u2193 scroll  \u2022  \u2190\u2192 agent  \u2022  Esc close"
      : "\u2191\u2193 scroll  \u2022  \u2190\u2192 agent  \u2022  Esc close";
    const truncatedHelp = truncateToWidth(help, width - 6);
    const helpVisible = visibleWidth(truncatedHelp);
    const helpFill = Math.max(0, width - 6 - helpVisible);
    lines.push(
      `\u2514\u2500\u2500 ${truncatedHelp}${helpFill > 0 ? "\u2500".repeat(helpFill) : ""}\u2518`,
    );

    return lines;
  }
}

function formatRuntime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}
