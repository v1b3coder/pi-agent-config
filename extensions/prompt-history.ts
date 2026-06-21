/**
 * Prompt History
 *
 * Injects global prompts from ~/.pi/agent/prompt-history.json into every
 * editor's history on the first keypress, making ↑ work immediately even
 * on a fresh session.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Editor } from "@earendil-works/pi-tui";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

// ─── Config ────────────────────────────────────────────────────────────────

const MAX_HISTORY = 20;
const MAX_PROMPT_LENGTH = 2000;
const HISTORY_FILE = "prompt-history.json";

// ─── Data ──────────────────────────────────────────────────────────────────

interface HistoryEntry {
  text: string;
  timestamp: number;
}

function historyPath(): string {
  return join(getAgentDir(), HISTORY_FILE);
}

function loadHistory(): HistoryEntry[] {
  const path = historyPath();
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as HistoryEntry[];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]): void {
  writeFileSync(historyPath(), JSON.stringify(entries, null, 2), "utf-8");
}

function persistPrompt(text: string): void {
  try {
    const history = loadHistory();
    const filtered = history.filter((e) => e.text !== text);
    filtered.push({ text, timestamp: Date.now() });
    saveHistory(filtered.slice(-MAX_HISTORY));
  } catch {
    // File write errors (permissions, disk full) are non-fatal.
    // History simply won't persist — no crash.
  }
}

// ─── Patch Editor.prototype.handleInput ─────────────────────────────────────
// Injects global prompts into the editor's history on the first keypress,
// so ↑ works from the very first keystroke — no submit needed first.

// Use a Symbol to detect if this patch is already applied, preventing
// double-wrapping on /reload events.
const PATCH_KEY = Symbol("prompt-history-patch");

// Track per-instance injection to avoid re-injecting when the same
// Editor gets reused (e.g., /reload). Uses WeakMap so GC is not blocked.
const injectedEditors = new WeakMap<object, boolean>();

const globalPrompts = loadHistory(); // loaded once at startup

// Only patch on first load; skip if /reload already set up the wrapper.
if (!(Editor.prototype as any)[PATCH_KEY]) {
  (Editor.prototype as any)[PATCH_KEY] = true;

  // ── Patch handleInput: inject global prompts on first keypress ──────────
  const origHandleInput = Editor.prototype.handleInput;

  Editor.prototype.handleInput = function (this: any, data: string) {
    if (!injectedEditors.has(this) && globalPrompts.length > 0) {
      injectedEditors.set(this, true);
      // Iterate oldest-first so the last unshift() leaves the most recent
      // prompt at history[0] (shown first when pressing ↑).
      for (let i = 0; i < globalPrompts.length; i++) {
        this.history.unshift(globalPrompts[i].text);
      }
    }
    return origHandleInput.call(this, data);
  };

  // ── Patch addToHistory: persist every prompt added to history ───────────
  // Catches !-commands, /-commands, extension commands, and normal messages
  // alike — everything the user submits. The 'input' event only fires for
  // normal messages, missing bang and built-in commands entirely.
  const origAddToHistory = Editor.prototype.addToHistory;

  Editor.prototype.addToHistory = function (this: any, text: string) {
    origAddToHistory.call(this, text);

    const trimmed = text.trim();
    if (!trimmed) return;

    const cleaned = trimmed.replace(/[\x00-\x1f]/g, "");
    if (!cleaned) return;

    const persisted =
      cleaned.length > MAX_PROMPT_LENGTH
        ? cleaned.slice(0, MAX_PROMPT_LENGTH)
        : cleaned;

    persistPrompt(persisted);
  };
}

// ─── Extension (empty shell) ───────────────────────────────────────────────
// All logic is handled by the prototype patches above — no event hooks needed.

export default function (_pi: ExtensionAPI) {
  // Extension exists solely to be auto-discovered by pi's extension loader.
  // The prototype patches run at module scope and handle everything.
}
