/**
 * PtyManager — manages PTY session lifecycle, drain cursors, and session IDs.
 */

import { PtySession } from "./pty-session.ts";
import type { PtySessionInfo } from "./pty-session.ts";

/** Adjective-noun word lists for session ID generation. */
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

export interface SessionEntry {
  session: PtySession;
  drainCursor: number;
}

export class PtyManager {
  private sessions = new Map<string, SessionEntry>();

  /** Create a new PTY session. */
  create(command: string, cwd: string, cols?: number, rows?: number): { session: PtySession; id: string } {
    const id = generateSessionId();
    const session = new PtySession(id, command, cwd, cols, rows);
    this.sessions.set(id, { session, drainCursor: 0 });
    return { session, id };
  }

  /** Get a session by ID. */
  get(id: string): PtySession | undefined {
    return this.sessions.get(id)?.session;
  }

  /** Write input to a session. Returns false if session not found or not running. */
  write(id: string, text: string): boolean {
    const entry = this.sessions.get(id);
    if (!entry || entry.session.status !== "running") return false;
    entry.session.write(text);
    return true;
  }

  /** Kill and unregister a session. Returns the session for final output. */
  kill(id: string): PtySession | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    entry.session.kill();
    this.sessions.delete(id);
    return entry.session;
  }

  /** Read new output since last drain. */
  readDrain(id: string, maxLines?: number): { text: string; more: boolean } | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    const result = entry.session.readDrain(entry.drainCursor);
    entry.drainCursor = result.newCursor;
    return { text: result.text, more: result.more };
  }

  /** Read last N lines without advancing drain cursor. */
  readTail(id: string, lines?: number): string | undefined {
    const entry = this.sessions.get(id);
    if (!entry) return undefined;
    return entry.session.readTail(lines ?? 30);
  }

  /** List all sessions with info. */
  list(): PtySessionInfo[] {
    const result: PtySessionInfo[] = [];
    for (const [, entry] of this.sessions) {
      result.push(entry.session.info);
    }
    return result;
  }

  /** Get the number of active sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Dispose all sessions. */
  disposeAll(): void {
    for (const [id, entry] of this.sessions) {
      try {
        entry.session.kill();
        entry.session.dispose();
      } catch {
        // ignore
      }
      this.sessions.delete(id);
    }
  }
}
