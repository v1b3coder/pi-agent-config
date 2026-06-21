/**
 * PTY — Lightweight Persistent PTY Sessions for Pi
 *
 * A focused extension for running and controlling persistent interactive CLI
 * sessions (SSH, REPLs, database shells, dev servers) across agent turns.
 *
 * Tool: pty({ command | sessionId + (input|drain|lines|kill) | list })
 * Shortcut: Alt+T — toggle PTY session overlay
 * Widget: Shows active sessions below the editor
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PtyManager } from "./pty-manager.ts";
import { PtyOverlay } from "./pty-overlay.ts";
let manager: PtyManager | null = null;

const REFRESH_MS = 250;

// ── Helper: format runtime for display ──
function formatRuntime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

// ── Widget update ──
function updateWidget(ctx: { ui: { setWidget: (key: string, content: string[] | undefined, opts?: any) => void } }): void {
  if (!manager || manager.size === 0) {
    ctx.ui.setWidget("pty", undefined);
    return;
  }

  const sessions = manager.list();
  const lines: string[] = [];
  for (const s of sessions) {
    const icon = s.status === "running" ? "◉" : s.status === "exited" ? "✓" : "✗";
    const rt = formatRuntime(s.runtime);
    const summary = `[${rt}] ${s.command}`;
    const truncated = summary.length > 55 ? summary.slice(0, 52) + "..." : summary;
    lines.push(`${icon} ${s.id}: ${truncated}`);
  }
  if (lines.length > 0) {
    lines.push("Alt+T: peek PTY sessions");
  }
  ctx.ui.setWidget("pty", lines);
}

// ── Extension bootstrap ──

export default function (pi: ExtensionAPI) {
  manager = new PtyManager();

  // ── Keyboard shortcut: toggle PTY overlay ──
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
          const overlay = new PtyOverlay(manager!, {
            onClose: () => {
              clearInterval(pollInterval);
              done(undefined);
            },
          });
          return {
            render: (w: number) => overlay.render(w),
            invalidate: () => overlay.invalidate(),
            handleInput: (data: string) => {
              overlay.handleInput(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "85%",
            maxHeight: "90%",
          },
        },
      );
    },
  });

  // ── Tool registration ──
  pi.registerTool({
    name: "pty",
    label: "PTY",
    description:
      "Run and control persistent interactive CLI sessions (SSH, REPLs, database shells, dev servers).\n\n" +
      "Usage:\n" +
      '- Start: pty({ command: "ssh user@host" }) or pty({ command: "python3", cwd: "/project" })\n' +
      '- Send input: pty({ sessionId: "...", input: "ls /var/log" })\n' +
      '- Submit (press Enter): pty({ sessionId: "...", input: "git pull", submit: true })\n' +
      '- Read new output (drain): pty({ sessionId: "...", drain: true })\n' +
      '- Read last N lines: pty({ sessionId: "...", lines: 50 })\n' +
      '- List sessions: pty({ list: true })\n' +
      '- Kill session: pty({ sessionId: "...", kill: true })\n\n' +
      "Sessions persist across agent turns — `cd`, `export`, source .venv all carry over." +
      "Use for stateful tools where you need the shell/environment to persist.",

    parameters: Type.Object({
      command: Type.Optional(Type.String({
        description: "Shell command to start a new persistent session",
      })),
      sessionId: Type.Optional(Type.String({
        description: "Session to interact with",
      })),
      input: Type.Optional(Type.String({
        description: "Text to send to the session",
      })),
      submit: Type.Optional(Type.Boolean({
        description: "Append \\n (Enter) after input",
        default: false,
      })),
      drain: Type.Optional(Type.Boolean({
        description: "Return only new output since last drain call",
      })),
      lines: Type.Optional(Type.Integer({
        description: "Lines of output to return (1–200)",
      })),
      kill: Type.Optional(Type.Boolean({
        description: "Terminate a running session",
      })),
      list: Type.Optional(Type.Boolean({
        description: "List all sessions",
      })),
      cwd: Type.Optional(Type.String({
        description: "Working directory for new sessions",
      })),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      if (!manager) {
        return {
          content: [{ type: "text", text: "PTY manager not initialized" }],
          isError: true,
          details: {},
        };
      }

      // ── List sessions ──
      if (params.list) {
        const sessions = manager.list();
        const text = sessions.length === 0
          ? "No active PTY sessions"
          : sessions.map((s) => {
              const icon = s.status === "running" ? "◉" : s.status === "exited" ? "✓" : "✗";
              return `${icon} ${s.id}  ${s.status}  ${formatRuntime(s.runtime)}  ${s.command}`;
            }).join("\n");
        return {
          content: [{ type: "text", text }],
          isError: false,
          details: { sessions: sessions.map((s) => s.id) },
        };
      }

      // ── Start new session ──
      if (params.command) {
        const cwd = params.cwd ?? ctx.cwd;
        const { session, id } = manager.create(params.command, cwd, 80, 24);
        onUpdate?.({ content: [{ type: "text", text: `→ started PTY session: ${id}` }], details: {} });
        updateWidget(ctx);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ sessionId: id, status: "running", command: params.command }),
          }],
          isError: false,
          details: { sessionId: id },
        };
      }

      // ── Interact with existing session ──
      if (!params.sessionId) {
        return {
          content: [{ type: "text", text: "Provide command to start a session, or sessionId + action, or list: true" }],
          isError: true,
          details: {},
        };
      }

      const session = manager.get(params.sessionId);

      // ── Kill session ──
      if (params.kill) {
        const killed = manager.kill(params.sessionId);
        if (!killed) {
          return {
            content: [{ type: "text", text: `Session ${params.sessionId} not found` }],
            isError: true,
            details: {},
          };
        }
        updateWidget(ctx);
        const tail = killed.readTail(30);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              sessionId: params.sessionId,
              status: "killed",
              output: tail,
              exitCode: killed.exitCode,
            }),
          }],
          isError: false,
          details: {},
        };
      }

      if (!session) {
        return {
          content: [{ type: "text", text: `Session ${params.sessionId} not found or no longer running` }],
          isError: true,
          details: {},
        };
      }

      // ── Check session is running before interaction ──
      if (session.status !== "running") {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `Session ${params.sessionId} is ${session.status} (exit code: ${session.exitCode ?? "unknown"})` }) }],
          isError: true,
          details: {},
        };
      }

      // ── Send input ──
      if (params.input !== undefined) {
        const text = params.submit ? params.input + "\n" : params.input;
        session.write(text);
        // Notify onUpdate with the input info
        onUpdate?.({ content: [{ type: "text", text: `→ wrote to ${params.sessionId}` }], details: {} });
        updateWidget(ctx);
        const response: Record<string, any> = { sessionId: params.sessionId, input: params.input };
        if (params.submit) response.submitted = true;
        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
          isError: false,
          details: {},
        };
      }

      // ── Drain read ──
      if (params.drain) {
        const result = manager.readDrain(params.sessionId);
        const runtime = session.runtime;
        const response: Record<string, any> = {
          sessionId: params.sessionId,
          output: result?.text ?? "",
          hasMore: result?.more ?? false,
          runtime: formatRuntime(runtime),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
          isError: false,
          details: {},
        };
      }

      // ── Lines read ──
      if (params.lines !== undefined) {
        const text = manager.readTail(params.sessionId, params.lines) ?? "";
        const runtime = session.runtime;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              sessionId: params.sessionId,
              output: text,
              status: session.status,
              runtime: formatRuntime(runtime),
            }),
          }],
          isError: false,
          details: {},
        };
      }

      // ── Default: return session info ──
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sessionId: params.sessionId,
            status: session.status,
            runtime: formatRuntime(session.runtime),
          }),
        }],
        isError: false,
        details: {},
      };
    },
  });

  // ── Session shutdown: kill all PTY processes ──
  pi.on("session_shutdown", async () => {
    manager?.disposeAll();
    manager = null;
  });
}
