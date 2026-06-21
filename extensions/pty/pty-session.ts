/**
 * PtySession — wraps zigpty.spawn() + @xterm/headless Terminal + output buffer.
 *
 * Data flow:
 *   PTY data → xterm.write() → terminal emulator (viewport for overlay)
 *           → strip ANSI → line buffer (for agent reads via drain / lines)
 */

import { createRequire } from "node:module";

const req = createRequire(import.meta.url);
const zigpty = req("zigpty");
const { Terminal } = req("@xterm/headless");
const { SerializeAddon } = req("@xterm/addon-serialize");

/** Strip ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1B\][0-9;]*\x07/g, "")
    .replace(/\x1B\][0-9;]*(\\x1B\\\\)/g, "")
    .replace(/\x1B\(B/g, "")
    .replace(/\x1B\[[0-9;]*[Hf]/g, "")
    .replace(/\r/g, "")
    .replace(/\x1B\[[0-9;]*[h|l]/g, "")
    .replace(/\x1B\[?2004[hl]/g, "")
    .replace(/\x1B\]0;[^\x07]*\x07/g, "")
    .replace(/\x1B\[?[0-9;]*[A-Za-z]/g, "")
    .replace(/\x07/g, "")
    .replace(/[^\x20-\x7E\n]/g, "");
}

export interface PtySessionInfo {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "exited" | "killed";
  exitCode: number | null;
  runtime: number; // ms since creation
  createdAt: number;
}

export class PtySession {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly xtermTerminal: InstanceType<typeof Terminal>;
  readonly serializeAddon: InstanceType<typeof SerializeAddon>;

  private pty: any;
  private _status: PtySessionInfo["status"] = "running";
  private _exitCode: number | null = null;
  private readonly createdAt: number = Date.now();

  /** Plain-text line buffer (ANSI-stripped), for agent reads. */
  private lineBuffer: string[] = [];
  private partialLine = "";
  private rawOutput = "";

  /** Max lines in buffer to prevent unbounded growth. */
  private static readonly MAX_BUFFER_LINES = 100_000;

  constructor(id: string, command: string, cwd: string, cols = 80, rows = 24) {
    this.id = id;
    this.command = command;
    this.cwd = cwd;

    // Create xterm headless terminal for viewport rendering
    this.xtermTerminal = new Terminal({ cols, rows, scrollback: 10_000 });
    this.serializeAddon = new SerializeAddon();
    this.serializeAddon.activate(this.xtermTerminal);

    // Split command string into command + args
    const parts = command.split(/\s+/);
    const cmd = parts[0]!;
    const args = parts.slice(1);

    // Spawn PTY via zigpty
    this.pty = zigpty.spawn(cmd, args, { cols, rows, cwd });

    // Read from PTY: update xterm terminal, strip ANSI for line buffer
    this.pty._readable.on("data", (data: Buffer) => {
      const text = data.toString("utf-8");
      this.rawOutput += text;

      // Write to xterm headless for viewport rendering
      this.xtermTerminal.write(text);

      // Strip ANSI and buffer as plain text
      const clean = stripAnsi(text);
      if (clean) {
        this.partialLine += clean;
        const lines = this.partialLine.split("\n");
        this.partialLine = lines.pop() ?? "";
        for (const l of lines) {
          this.lineBuffer.push(l);
        }
        // Cap buffer
        if (this.lineBuffer.length > PtySession.MAX_BUFFER_LINES) {
          this.lineBuffer = this.lineBuffer.slice(-PtySession.MAX_BUFFER_LINES / 2);
        }
      }
    });

    // Handle process exit
    this.pty._readable.on("end", () => {
      this._status = "exited";
      this._exitCode = 0;
      // Flush partial line
      if (this.partialLine) {
        this.lineBuffer.push(this.partialLine);
        this.partialLine = "";
      }
    });
  }

  get status(): PtySessionInfo["status"] {
    return this._status;
  }

  get exitCode(): number | null {
    return this._exitCode;
  }

  get runtime(): number {
    return Date.now() - this.createdAt;
  }

  get info(): PtySessionInfo {
    return {
      id: this.id,
      command: this.command,
      cwd: this.cwd,
      status: this._status,
      exitCode: this._exitCode,
      runtime: this.runtime,
      createdAt: this.createdAt,
    };
  }

  /** Send text input to the PTY. */
  write(text: string): void {
    if (this._status !== "running") return;
    this.pty.write(text);
  }

  /** Resize the PTY and terminal. */
  resize(cols: number, rows: number): void {
    this.pty.resize(cols, rows);
    this.xtermTerminal.resize(cols, rows);
  }

  /** Kill the session. */
  kill(): void {
    if (this._status !== "running") return;
    this._status = "killed";
    try {
      this.pty.kill();
    } catch {
      // Already dead
    }
    // Flush partial line
    if (this.partialLine) {
      this.lineBuffer.push(this.partialLine);
      this.partialLine = "";
    }
  }

  /** Read new lines since last drain cursor, advancing the cursor. */
  readDrain(cursor: number): { text: string; more: boolean; newCursor: number } {
    const newLines = this.lineBuffer.slice(cursor);
    const text = newLines.join("\n");
    const more = cursor + newLines.length < this.lineBuffer.length;
    return { text, more, newCursor: cursor + newLines.length };
  }

  /** Read last N lines without advancing drain cursor. */
  readTail(lines: number): string {
    const slice = this.lineBuffer.slice(-Math.max(1, Math.min(lines, 200)));
    return slice.join("\n");
  }

  /** Get the serialized viewport for the overlay. */
  serializeViewport(rows?: number): string {
    try {
      return this.serializeAddon.serialize({ scrollback: rows ?? 24 });
    } catch {
      return "";
    }
  }

  /** Clean up resources. */
  dispose(): void {
    try { this.pty.close(); } catch { /* ignore */ }
    this.xtermTerminal.reset();
  }
}
