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
  const history = loadHistory();
  const filtered = history.filter((e) => e.text !== text);
  filtered.push({ text, timestamp: Date.now() });
  saveHistory(filtered.slice(-MAX_HISTORY));
}

// ─── Patch Editor.prototype.handleInput ─────────────────────────────────────
// Injects global prompts into the editor's history on the first keypress,
// so ↑ works from the very first keystroke — no submit needed first.

const origHandleInput = Editor.prototype.handleInput;
const globalPrompts = loadHistory(); // loaded once at startup

Editor.prototype.handleInput = function (this: any, data: string) {
  if (!this.__promptHistoryInjected && globalPrompts.length > 0) {
    this.__promptHistoryInjected = true;
    // Iterate oldest-first so the last unshift() leaves the most recent
    // prompt at history[0] (shown first when pressing ↑).
    for (let i = 0; i < globalPrompts.length; i++) {
      this.history.unshift(globalPrompts[i].text);
    }
  }
  return origHandleInput.call(this, data);
};

// ─── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Capture every submitted user prompt to persist globally.
  pi.on("input", (event) => {
    const cleaned = event.text.replace(/[\x00-\x1f]/g, "").trim();
    if (event.text.startsWith("/") || event.text.startsWith("!") || !cleaned || cleaned.includes("tool-call")) {
      return { action: "continue" };
    }

    const text =
      cleaned.length > MAX_PROMPT_LENGTH
        ? cleaned.slice(0, MAX_PROMPT_LENGTH)
        : cleaned;

    persistPrompt(text);

    return { action: "continue" };
  });
}
