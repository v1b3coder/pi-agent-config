/**
 * PTY — Lightweight Persistent PTY Sessions for Pi
 *
 * A single-file extension for running and controlling persistent interactive
 * CLI sessions (SSH, REPLs, database shells, dev servers) across agent turns.
 *
 * Tools: pty_start / pty_send / pty_drain / pty_tail / pty_list / pty_kill
 * Shortcut: Alt+T — toggle PTY session overlay
 * Widget: Shows active sessions below the editor
 *
 * Data flow:
 *   PTY data → xterm.write() → terminal emulator (viewport for overlay)
 *           → strip ANSI → line buffer (for agent reads via drain / lines)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createRequire } from "node:module";

// ── Native dependencies (CJS modules, loaded via createRequire) ─────

const req = createRequire(import.meta.url);
const zigpty = req("zigpty");
const { Terminal } = req("@xterm/headless");
const { SerializeAddon } = req("@xterm/addon-serialize");

// ── Constants ───────────────────────────────────────────────────────

const MAX_BUFFER_LINES = 100_000;
const VISIBLE_LINES = 20;
const REFRESH_MS = 250;

// ── ANSI stripping ──────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")      // CSI sequences
    .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, "")    // OSC sequences
    .replace(/\x1B[()]./g, "")                    // charset (ESC ( B, ESC ) B, ESC ( 0, etc.)
    .replace(/\r/g, "")                             // CR
    .replace(/\x1B\[?2004[hl]/g, "")               // bracketed paste
    .replace(/\x07/g, "")                           // BEL
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g, "");  // control chars only
}

// Strip only layout-breaking sequences, keep SGR color/style codes
function stripLayoutAnsi(s: string): string {
  return s
    // Strip CSI sequences that are NOT SGR (final byte != m / 0x6D)
    .replace(/\x1B\[[0-9;<=>?]*[ -/]*[\x40-\x6C\x6E-\x7E]/g, "")
    // Strip OSC sequences (e.g. window title)
    .replace(/\x1B\].*?(?:\x07|\x1B\\)/g, "")
    // Strip charset selection (ESC ( B, ESC ) B, ESC ( 0, etc.)
    .replace(/\x1B[()]./g, "")
    // Strip bracketed paste markers
    .replace(/\x1B\[?2004[hl]/g, "")
    // Strip CR and BEL
    .replace(/\r/g, "").replace(/\x07/g, "")
    // Strip other control chars except TAB, LF, ESC (needed for color codes)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F]/g, "");
}

// ── Runtime formatting ──────────────────────────────────────────────

function formatRuntime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
}

// ═══════════════════════════════════════════════════════════════════
// PtySession
// ═══════════════════════════════════════════════════════════════════

interface PtySessionInfo {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  runtime: number;
  createdAt: number;
}

class PtySession {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly xtermTerminal: InstanceType<typeof Terminal>;
  readonly serializeAddon: InstanceType<typeof SerializeAddon>;

  private pty: any;
  private _status: PtySessionInfo["status"] = "running";
  private _exitCode: number | null = null;
  private readonly createdAt: number = Date.now();

  private lineBuffer: string[] = [];
  private partialLine = "";

  constructor(id: string, command: string, cwd: string, cols = 80, rows = 24) {
    this.id = id;
    this.command = command;
    this.cwd = cwd;

    this.xtermTerminal = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
    this.serializeAddon = new SerializeAddon();
    this.serializeAddon.activate(this.xtermTerminal);

    const parts = command.split(/\s+/);
    const cmd = parts[0]!;
    const args = parts.slice(1);

    this.pty = zigpty.spawn(cmd, args, { cols, rows, cwd });

    this.pty._readable.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      this.xtermTerminal.write(text);

      const clean = stripAnsi(text);
      if (clean) {
        this.partialLine += clean;
        const lns = this.partialLine.split("\n");
        this.partialLine = lns.pop() ?? "";
        for (const l of lns) this.lineBuffer.push(l);
        if (this.lineBuffer.length > MAX_BUFFER_LINES) {
          this.lineBuffer = this.lineBuffer.slice(-MAX_BUFFER_LINES / 2);
        }
      }
    });

    this.pty._readable.on("end", () => {
      this._status = "exited";
      this._exitCode = 0;
      if (this.partialLine) { this.lineBuffer.push(this.partialLine); this.partialLine = ""; }
    });
  }

  get status() { return this._status; }
  get exitCode() { return this._exitCode; }
  get runtime() { return Date.now() - this.createdAt; }

  get info(): PtySessionInfo {
    return {
      id: this.id, command: this.command, cwd: this.cwd,
      status: this._status, exitCode: this._exitCode,
      runtime: this.runtime, createdAt: this.createdAt,
    };
  }

  write(text: string): void {
    if (this._status === "running") this.pty.write(text);
  }

  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
    this.xtermTerminal.resize(cols, rows);
  }

  kill(): void {
    if (this._status !== "running") return;
    this._status = "killed";
    try { this.pty.kill(); } catch { /* ok */ }
    if (this.partialLine) { this.lineBuffer.push(this.partialLine); this.partialLine = ""; }
  }

  readDrain(cursor: number): { text: string; more: boolean; newCursor: number } {
    const newLines = this.lineBuffer.slice(cursor);
    return {
      text: newLines.join("\n"),
      more: cursor + newLines.length < this.lineBuffer.length,
      newCursor: cursor + newLines.length,
    };
  }

  readTail(lines: number): string {
    return this.lineBuffer.slice(-Math.max(1, Math.min(lines, 200))).join("\n");
  }

  serializeViewport(rows?: number): string {
    try { return this.serializeAddon.serialize({ scrollback: rows ?? 24 }); }
    catch { return ""; }
  }

  dispose(): void {
    try { this.pty.close(); } catch { /* ok */ }
    this.xtermTerminal.reset();
  }
}

// ═══════════════════════════════════════════════════════════════════
// PtyManager
// ═══════════════════════════════════════════════════════════════════

const ADJECTIVES = [
  "amber", "brisk", "coral", "dusky", "ember", "frost", "golden", "hazy",
  "ivory", "jade", "keen", "lunar", "misty", "noble", "oaken", "plush",
  "quiet", "royal", "silver", "tawny", "umber", "velvet", "winter", "xenon",
  "amber", "azure", "bold", "calm", "dark", "deep", "dim", "dry",
];
const NOUNS = [
  "bloom", "cove", "dell", "elm", "fern", "glen", "hill", "isle",
  "june", "knoll", "lake", "moor", "nest", "oak", "peak", "quay",
  "reef", "slope", "tor", "vale", "wood", "yew", "zone", "brook",
  "creek", "dune", "edge", "ford", "gate", "heath", "inch", "key",
];

function generateSessionId(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]!;
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]!;
  const suffix = Math.random().toString(36).slice(2, 4);
  return `${adj}-${noun}-${suffix}`;
}

class PtyManager {
  private sessions = new Map<string, { session: PtySession; drainCursor: number }>();

  create(command: string, cwd: string, cols?: number, rows?: number) {
    const id = generateSessionId();
    const session = new PtySession(id, command, cwd, cols, rows);
    this.sessions.set(id, { session, drainCursor: 0 });
    return { session, id };
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id)?.session;
  }

  write(id: string, text: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry || entry.session.status !== "running") return false;
    entry.session.write(text);
    return true;
  }

  kill(id: string): PtySession | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    entry.session.kill();
    this.sessions.delete(id);
    return entry.session;
  }

  readDrain(id: string): { text: string; more: boolean } | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    const result = entry.session.readDrain(entry.drainCursor);
    entry.drainCursor = result.newCursor;
    return { text: result.text, more: result.more };
  }

  readTail(id: string, lines?: number): string | undefined {
    return this.sessions.get(id)?.session.readTail(lines ?? 30);
  }

  list(): PtySessionInfo[] {
    return Array.from(this.sessions.values(), (e) => e.session.info);
  }

  get size() { return this.sessions.size; }

  disposeAll(): void {
    for (const [id, entry] of this.sessions) {
      try { entry.session.kill(); entry.session.dispose(); } catch { /* ok */ }
      this.sessions.delete(id);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// PtyOverlay (TUI component)
// ═══════════════════════════════════════════════════════════════════

class PtyOverlay {
  private selectedIndex = 0;
  private scrollOffset = 0;
  private manager: PtyManager;
  private onClose: () => void;

  constructor(manager: PtyManager, onClose: () => void) {
    this.manager = manager;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    const sessions = this.manager.list();
    if (sessions.length === 0) { this.onClose(); return; }

    if (matchesKey(data, Key.left) || data === "shift+tab") {
      if (this.selectedIndex > 0) { this.selectedIndex--; this.scrollOffset = 0; }
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      if (this.selectedIndex < sessions.length - 1) { this.selectedIndex++; this.scrollOffset = 0; }
    } else if (matchesKey(data, Key.up)) {
      this.scrollOffset++;
    } else if (matchesKey(data, Key.down)) {
      if (this.scrollOffset > 0) this.scrollOffset--;
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollOffset += VISIBLE_LINES;
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - VISIBLE_LINES);
    } else if (matchesKey(data, Key.escape) || data === "q") {
      this.onClose();
    }
  }

  invalidate(): void { /* no cache */ }

  private bordered(text: string, innerWidth: number): string {
    const pad = Math.max(0, innerWidth - visibleWidth(text));
    return `\u2502 ${text}${" ".repeat(pad)} \u2502`;
  }

  render(width: number): string[] {
    const out: string[] = [];
    const innerW = Math.max(1, width - 4);
    const sessions = this.manager.list();

    if (sessions.length === 0) {
      out.push(`\u250c${"\u2500".repeat(width - 2)}\u2510`);
      out.push(`\u2502${" ".repeat(width - 2)}\u2502`);
      out.push(this.bordered("No active PTY sessions", innerW));
      out.push(`\u2502${" ".repeat(width - 2)}\u2502`);
      out.push(`\u2514${"\u2500".repeat(width - 2)}\u2518`);
      return out;
    }

    // ── Tabs ──
    const tabParts = sessions.map((s, i) => {
      const icon = s.status === "running" ? "\u25c9" : s.status === "exited" ? "\u2713" : "\u2717";
      const label = ` ${icon} ${s.id} `;
      return i === this.selectedIndex ? `\x1b[7m${label}\x1b[27m` : label;
    });
    const tabsStr = tabParts.join("\u2502");
    const truncatedTabs = truncateToWidth(tabsStr, width - 6);
    const tabsVis = visibleWidth(truncatedTabs);
    const fill = Math.max(0, width - 6 - tabsVis);
    out.push(`\u250c\u2500\u2500 ${truncatedTabs} ${"\u2500".repeat(fill)}\u2510`);

    // ── Info bar ──
    const sel = sessions[this.selectedIndex];
    if (sel) {
      const info = `${sel.status.padEnd(9)} ${formatRuntime(sel.runtime).padEnd(8)} ${truncateToWidth(sel.command, 40)}`;
      out.push(this.bordered(truncateToWidth(info, innerW), innerW));
      out.push(`\u2502${"\u2500".repeat(width - 2)}\u2502`);
    }

    // ── Terminal output ──
    if (sel) {
      const session = this.manager.get(sel.id);
      if (session) {
        const viewport = session.serializeViewport(VISIBLE_LINES + this.scrollOffset);
        const contentLines = viewport.split("\n");
        const totalLines = contentLines.length;
        const start = Math.max(0, totalLines - VISIBLE_LINES - this.scrollOffset);
        const end = Math.min(totalLines, start + VISIBLE_LINES);
        for (let i = start; i < end; i++) {
          const clean = stripLayoutAnsi(contentLines[i] ?? "");
          out.push(this.bordered(truncateToWidth(clean, innerW), innerW));
        }
        for (let i = end - start; i < VISIBLE_LINES; i++) {
          out.push(`\u2502${" ".repeat(width - 2)}\u2502`);
        }
      } else {
        for (let i = 0; i < VISIBLE_LINES; i++) out.push(`\u2502${" ".repeat(width - 2)}\u2502`);
      }
    }

    // ── Bottom bar ──
    const help = this.scrollOffset > 0
      ? "\u2191 more  \u2022  \u2191\u2193 scroll  \u2022  \u2190\u2192 tab  \u2022  Esc close"
      : "\u2191\u2193 scroll  \u2022  \u2190\u2192 tab  \u2022  Esc close";
    const helpVis = visibleWidth(help);
    out.push(`\u2514\u2500\u2500 ${truncateToWidth(help, width - 6)} ${"\u2500".repeat(Math.max(0, width - 6 - helpVis))}\u2518`);
    return out;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Extension bootstrap
// ═══════════════════════════════════════════════════════════════════

let manager: PtyManager | null = null;

function updateWidget(ctx: ExtensionContext): void {
  if (!manager || manager.size === 0) {
    ctx.ui.setWidget("pty", undefined);
    return;
  }
  const lines: string[] = [];
  for (const s of manager.list()) {
    const icon = s.status === "running" ? "\u25c9" : s.status === "exited" ? "\u2713" : "\u2717";
    const summary = `[${formatRuntime(s.runtime)}] ${s.command}`;
    const truncated = summary.length > 55 ? summary.slice(0, 52) + "..." : summary;
    lines.push(`${icon} ${s.id}: ${truncated}`);
  }
  if (lines.length > 0) lines.push("Alt+T: peek PTY sessions");
  ctx.ui.setWidget("pty", lines);
}

export default function (pi: ExtensionAPI) {
  manager = new PtyManager();

  // ── Shortcut ──
  pi.registerShortcut("alt+t", {
    description: "Toggle PTY session overlay",
    handler: async (ctx) => {
      if (!manager || manager.size === 0) {
        ctx.ui.notify("No active PTY sessions", "info");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, _theme, _kb, done) => {
          const pollInterval = setInterval(() => tui.requestRender(), REFRESH_MS);
          const overlay = new PtyOverlay(manager!, () => { clearInterval(pollInterval); done(undefined); });
          return {
            render: (w: number) => overlay.render(w),
            invalidate: () => overlay.invalidate(),
            handleInput: (data: string) => { overlay.handleInput(data); tui.requestRender(); },
          };
        },
        { overlay: true, overlayOptions: { anchor: "center", width: "85%", maxHeight: "90%" } },
      );
    },
  });

  // ── Tools ──
  pi.registerTool({
    name: "pty_start",
    label: "PTY Start",
    description: "Spawn a persistent interactive CLI session (SSH, REPL, db shell, docker, podman). Stateful: cd/export/venv carry over. Use over `bash` when state must persist.",
    promptGuidelines: [
      "- Prefer pty_start over `bash` when state must persist across commands (cd/export/venv). Prefer `bash` over pty_start for one-shot commands (simpler, cheaper).",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to start (e.g. ssh host, python3, psql -U user db)" }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new session" })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      if (!manager) return { content: [{ type: "text", text: "PTY manager not initialized" }], isError: true, details: {} };
      const cwd = params.cwd ?? ctx.cwd;
      const { id } = manager.create(params.command, cwd, 80, 24);
      onUpdate?.({ content: [{ type: "text", text: `→ started PTY session: ${id}` }], details: {} });
      updateWidget(ctx);
      return { content: [{ type: "text", text: JSON.stringify({ sessionId: id, status: "running", command: params.command }) }], isError: false, details: { sessionId: id } };
    },
  });

  pi.registerTool({
    name: "pty_send",
    label: "PTY Send",
    description: "Send text to a running PTY session. submit:true appends \\n (Enter). Then use pty_drain to read response.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID from pty_start" }),
      input: Type.String({ description: "Text to send to the session" }),
      submit: Type.Optional(Type.Boolean({ description: "Append \\n (Enter) after input", default: false })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      if (!manager) return { content: [{ type: "text", text: "PTY manager not initialized" }], isError: true, details: {} };
      const session = manager.get(params.sessionId);
      if (!session) return { content: [{ type: "text", text: `Session ${params.sessionId} not found` }], isError: true, details: {} };
      if (session.status !== "running") return { content: [{ type: "text", text: `Session ${params.sessionId} is ${session.status}` }], isError: true, details: {} };
      const text = params.submit ? params.input + "\n" : params.input;
      session.write(text);
      onUpdate?.({ content: [{ type: "text", text: `→ wrote to ${params.sessionId}` }], details: {} });
      updateWidget(ctx);
      const r: Record<string, any> = { sessionId: params.sessionId, input: params.input };
      if (params.submit) r.submitted = true;
      return { content: [{ type: "text", text: JSON.stringify(r) }], isError: false, details: {} };
    },
  });

  pi.registerTool({
    name: "pty_drain",
    label: "PTY Drain",
    description: "Read new output since last drain. Advances cursor (new-only, token-efficient). Empty = nothing new. Use pty_tail to peek without advancing.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID from pty_start" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!manager) return { content: [{ type: "text", text: "PTY manager not initialized" }], isError: true, details: {} };
      const session = manager.get(params.sessionId);
      if (!session) return { content: [{ type: "text", text: `Session ${params.sessionId} not found` }], isError: true, details: {} };
      const result = manager.readDrain(params.sessionId);
      return { content: [{ type: "text", text: JSON.stringify({ sessionId: params.sessionId, output: result?.text ?? "", hasMore: result?.more ?? false, runtime: formatRuntime(session.runtime) }) }], isError: false, details: {} };
    },
  });

  pi.registerTool({
    name: "pty_tail",
    label: "PTY Tail",
    description: "Read last N lines from a PTY session. Non-destructive (does not advance drain cursor). Max 200 lines.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID from pty_start" }),
      lines: Type.Optional(Type.Integer({ description: "Number of lines to return (1–200)", default: 30 })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!manager) return { content: [{ type: "text", text: "PTY manager not initialized" }], isError: true, details: {} };
      const session = manager.get(params.sessionId);
      if (!session) return { content: [{ type: "text", text: `Session ${params.sessionId} not found` }], isError: true, details: {} };
      const text = manager.readTail(params.sessionId, params.lines) ?? "";
      return { content: [{ type: "text", text: JSON.stringify({ sessionId: params.sessionId, output: text, status: session.status, runtime: formatRuntime(session.runtime) }) }], isError: false, details: {} };
    },
  });

  pi.registerTool({
    name: "pty_list",
    label: "PTY List",
    description: "List all active PTY sessions with status, runtime, and command.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!manager) return { content: [{ type: "text", text: "PTY manager not initialized" }], isError: true, details: {} };
      const sessions = manager.list();
      const text = sessions.length === 0 ? "No active PTY sessions"
        : sessions.map((s) => `${s.status === "running" ? "\u25c9" : s.status === "exited" ? "\u2713" : "\u2717"} ${s.id}  ${s.status}  ${formatRuntime(s.runtime)}  ${s.command}`).join("\n");
      return { content: [{ type: "text", text }], isError: false, details: { sessions: sessions.map((s) => s.id) } };
    },
  });

  pi.registerTool({
    name: "pty_kill",
    label: "PTY Kill",
    description: "Terminate a PTY session and return final output. Safe on dead sessions.",
    parameters: Type.Object({
      sessionId: Type.String({ description: "Session ID from pty_start" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!manager) return { content: [{ type: "text", text: "PTY manager not initialized" }], isError: true, details: {} };
      const killed = manager.kill(params.sessionId);
      if (!killed) return { content: [{ type: "text", text: `Session ${params.sessionId} not found` }], isError: true, details: {} };
      updateWidget(ctx);
      return { content: [{ type: "text", text: JSON.stringify({ sessionId: params.sessionId, status: "killed", output: killed.readTail(30), exitCode: killed.exitCode }) }], isError: false, details: {} };
    },
  });

  // ── Cleanup ──
  pi.on("session_shutdown", async () => { manager?.disposeAll(); manager = null; });
}
