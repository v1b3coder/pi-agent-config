import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";

// ── Shared types ───────────────────────────────────────────────────

interface AgentState {
  agent: string;
  output: string;
  status: "running" | "done" | "error";
}

interface RunState {
  agentStates: Map<string, AgentState>;
  agentOrder: string[];
}

interface RunEntry {
  runState: RunState;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

// Stack of active invocations — each parallel subagent call gets its own entry
const activeRuns: RunEntry[] = [];
// Ref-counted guard: safe under parallel execution (see spawnChild)
let subagentChildCount = 0;

// ── Peek overlay component ─────────────────────────────────────────

import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  Text,
} from "@earendil-works/pi-tui";

// Strip only layout-breaking ANSI, preserve SGR color/style codes
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

class SubagentPeek {
  private agentStates: Map<string, AgentState>;
  private agentOrder: string[];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private static VISIBLE_LINES = 20;
  private onClose: () => void;

  constructor(
    agentStates: Map<string, AgentState>,
    agentOrder: string[],
    onClose: () => void,
  ) {
    this.agentStates = agentStates;
    this.agentOrder = agentOrder;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.left) && this.selectedIndex > 0) {
      this.selectedIndex--;
      this.scrollOffset = 0;
    } else if (
      matchesKey(data, Key.right) &&
      this.selectedIndex < this.agentOrder.length - 1
    ) {
      this.selectedIndex++;
      this.scrollOffset = 0;
    } else if (matchesKey(data, Key.up)) {
      const state = this.agentStates.get(
        this.agentOrder[this.selectedIndex] ?? "",
      );
      const totalLines = state?.output.split("\n").length ?? 0;
      const maxScroll = Math.max(0, totalLines - SubagentPeek.VISIBLE_LINES);
      if (this.scrollOffset < maxScroll) {
        this.scrollOffset++;
      }
    } else if (matchesKey(data, Key.down)) {
      if (this.scrollOffset > 0) {
        this.scrollOffset--;
      }
    } else if (matchesKey(data, Key.escape)) {
      this.onClose();
    }
  }

  private bordered(text: string, innerWidth: number): string {
    const visible = visibleWidth(text);
    const pad = Math.max(0, innerWidth - visible);
    return `\u2502 ${text}${pad ? " ".repeat(pad) : ""} \u2502`;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const innerW = Math.max(1, width - 4);

    // ── Agent tabs embedded in top border ────────
    const tabs = this.agentOrder.map((key, i) => {
      const state = this.agentStates.get(key);
      const icon = state?.status === "done" ? "\u2713" : "\u25c9";
      const label = `${icon} ${state?.agent ?? key}`;
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

    // ── Output of selected agent ─────────────────
    const selectedKey = this.agentOrder[this.selectedIndex];
    const state = this.agentStates.get(selectedKey ?? "");
    if (state) {
      const contentLines = state.output.split("\n");
      const totalLines = contentLines.length;
      const maxStart = Math.max(0, totalLines - SubagentPeek.VISIBLE_LINES);
      const start = Math.max(0, maxStart - this.scrollOffset);
      const end = Math.min(totalLines, start + SubagentPeek.VISIBLE_LINES);

      for (let i = start; i < end; i++) {
        const clean = stripLayoutAnsi(contentLines[i] ?? "");
        lines.push(this.bordered(
          truncateToWidth(clean, innerW),
          innerW,
        ));
      }

      // ── Bottom border with help ────────────────
      const help =
        this.scrollOffset > 0
          ? `\u2191 ${totalLines - end} more  \u2022  \u2193 scroll  \u2022  \u2190\u2192 agent  \u2022  Esc close`
          : `\u2191\u2193 scroll  \u2022  \u2190\u2192 agent  \u2022  Esc close`;
      const truncatedHelp = truncateToWidth(help, width - 6);
      const helpVisible = visibleWidth(truncatedHelp);
      const helpFill = Math.max(0, width - 6 - helpVisible);
      lines.push(
        `\u2514\u2500\u2500 ${truncatedHelp}${helpFill > 0 ? "\u2500".repeat(helpFill) : ""}\u2518`,
      );
    } else {
      lines.push(this.bordered("No output", innerW));
      lines.push(`\u2514\u2500\u2500 ${truncateToWidth("Esc close", width - 6)} ${"\u2500".repeat(Math.max(0, width - 6 - visibleWidth("Esc close")))}\u2518`);
    }

    return lines;
  }

  invalidate(): void {
    // No cache — render() reads live state every time
  }
}

// ── Guard ──────────────────────────────────────────────────────────

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

// ── Agent definitions ──────────────────────────────────────────────

interface AgentDef {
  systemPrompt: string;
  tools: string[];
}

const AGENTS: Record<string, AgentDef> = {
  reviewer: {
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    systemPrompt:
      `You are a disciplined review subagent.\n` +
      `Inspect, evaluate, and report findings with evidence.\n` +
      `- Read relevant files first\n` +
      `- Verify correctness, edge cases, and regressions\n` +
      `- Use bash only for read-only inspection\n` +
      `- Report findings with file paths and line numbers\n` +
      `- If everything looks good, say so plainly`,
  },
  scout: {
    tools: ["read", "grep", "find", "ls", "bash", "write"],
    systemPrompt:
      `You are a scouting subagent for fast codebase recon.\n` +
      `Use grep, find, and read to map the relevant area.\n` +
      `Focus on: entry points, key types, data flow, files\n` +
      `likely to need changes, constraints, and risks.\n` +
      `- Prefer targeted search over reading whole files\n` +
      `- Use bash only for non-interactive inspection`,
  },
  researcher: {
    tools: ["read", "write", "grep", "find", "web_search", "visit_webpage"],
    systemPrompt:
      `You are a research subagent.\n` +
      `Run focused web research on the given topic.\n` +
      `- Break into 2-4 angles, search each\n` +
      `- Prefer primary sources and official docs\n` +
      `- Drop stale or redundant sources\n` +
      `- Call out gaps you couldn't answer confidently`,
  },
  "context-builder": {
    tools: ["read", "grep", "find", "ls", "bash", "write"],
    systemPrompt:
      `You are a context-builder subagent.\n` +
      `Analyze requirements against the codebase and produce\n` +
      `structured handoff material for planning.\n` +
      `- Follow imports, callers, tests, config, docs\n` +
      `- Surface constraints, dependencies, risks\n` +
      `- Write a compact meta-prompt with goal, evidence,\n` +
      `  success criteria, and suggested approach`,
  },
  worker: {
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    systemPrompt:
      `You are a worker subagent tasked with implementation.\n` +
      `- Read the plan or context first\n` +
      `- Make minimal, correct changes\n` +
      `- Follow existing codebase patterns\n` +
      `- Validate with appropriate checks\n` +
      `- Report: what changed, validation results, open risks`,
  },
  delegate: {
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    systemPrompt:
      `You are a delegate subagent.\n` +
      `You have the same capabilities as the parent session.\n` +
      `Complete the assigned task with whatever tools are appropriate.`,
  },
};

const AGENT_NAMES = Object.keys(AGENTS);

// ── Child session spawn ────────────────────────────────────────────

async function spawnChild(
  agentName: string,
  task: string,
  cwd: string,
  _signal: AbortSignal | undefined,
  onProgress?: (delta: string) => void,
): Promise<string> {
  const def = AGENTS[agentName];
  if (!def) throw new Error(`Unknown agent: ${agentName}`);

  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  const settingsManager = SettingsManager.create(cwd, agentDir);

  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();

  // Apply provider registrations from extensions (e.g., pi-provider-litellm)
  const extResult = resourceLoader.getExtensions();
  for (const { name, config } of extResult.runtime.pendingProviderRegistrations) {
    modelRegistry.registerProvider(name, config);
  }
  extResult.runtime.pendingProviderRegistrations = [];

  subagentChildCount++;
  process.env[SUBAGENT_CHILD_ENV] = "1";
  try {
    // ═══════════════════════════════════════════════════════════════════
    // Retry compatibility with tool-call-revert extension
    // ═══════════════════════════════════════════════════════════════════
    //
    // The resourceLoader loads global extensions from ~/.pi/agent/extensions/
    // into every child session. If tool-call-revert.ts is installed, it
    // automatically handles malformed tool calls (e.g. DeepSeek DSML text
    // blocks) inside child sessions by reverting the bad response and
    // retrying the prompt — transparently, before this spawnChild function
    // sees the result.
    //
    // The subagent tool itself (in the parent session) does NOT add its own
    // retry loop. Instead, it relies on tool-call-revert at the SDK level
    // inside each child session. If tool-call-revert is NOT installed,
    // child sessions get exactly one attempt per task.
    //
    // See: extensions/tool-call-revert.ts
    // ═══════════════════════════════════════════════════════════════════

    const { session } = await createAgentSession({
      cwd,
      tools: def.tools,
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });

    const outputParts: string[] = [];
    const unsub = session.subscribe((ev) => {
      if (
        ev.type === "message_update" &&
        ev.assistantMessageEvent.type === "text_delta"
      ) {
        const delta = ev.assistantMessageEvent.delta;
        outputParts.push(delta);
        onProgress?.(delta);
      }
    });

    try {
      await session.prompt(`${def.systemPrompt}\n\nTask: ${task}`);
      return outputParts.join("").trim();
    } finally {
      unsub();
      session.dispose();
    }
  } finally {
    subagentChildCount--;
    if (subagentChildCount === 0) {
      delete process.env[SUBAGENT_CHILD_ENV];
    }
  }
}

// ── Extension registration ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (process.env[SUBAGENT_CHILD_ENV]) return;

  // ── Keyboard shortcut: peek subagent overlay ───────────
  pi.registerShortcut("alt+o", {
    description: "Peek subagent output",
    handler: async (ctx) => {
      // Merge all active runs into one combined overlay view
      const combinedStates = new Map<string, AgentState>();
      const combinedOrder: string[] = [];
      for (let ri = 0; ri < activeRuns.length; ri++) {
        const entry = activeRuns[ri];
        if (!entry) continue;
        for (const [key, state] of entry.runState.agentStates) {
          combinedStates.set(key, state);
          combinedOrder.push(key);
        }
      }
      if (combinedStates.size === 0) {
        ctx.ui.notify("No subagent activity to peek", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, _theme, _kb, done) => {
          const peek = new SubagentPeek(
            combinedStates,
            combinedOrder,
            () => {
              clearInterval(pollInterval);
              done(undefined);
            },
          );
          const pollInterval = setInterval(
            () => tui.requestRender(),
            350,
          );
          return {
            render: (w) => peek.render(w),
            invalidate: () => peek.invalidate(),
            handleInput: (data) => {
              peek.handleInput(data);
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

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate work to sub-agents in isolated sessions.\n" +
      "Single: { task, agent }. Parallel: { tasks: [{agent, task}, ...] }.\n" +
      "Builtin agents: reviewer (code review), scout (codebase recon),\n" +
      "researcher (web research), context-builder (analysis),\n" +
      "worker (plan implementation), delegate (generic).",

    parameters: Type.Object({
      task: Type.Optional(Type.String({
        description: "Task description (required with agent)",
      })),
      agent: Type.Optional(Type.String({
        enum: AGENT_NAMES,
        description: "Which agent to run (required with task)",
      })),
      tasks: Type.Optional(Type.Array(Type.Object({
        task: Type.String({ description: "Task for this agent" }),
        agent: Type.String({
          enum: AGENT_NAMES,
          description: "Which agent",
        }),
      }), {
        description: "Parallel tasks — run all agents concurrently (max wall time)",
      })),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      type TaskItem = { agent: string; task: string };
      const tasks: TaskItem[] = [];

      if (params.tasks) {
        tasks.push(...params.tasks);
      } else if (params.agent && params.task) {
        tasks.push({ agent: params.agent, task: params.task });
      } else {
        return {
          content: [{ type: "text",
            text: "Provide {task, agent} for single or {tasks} for parallel." }],
          isError: true,
          details: {},
        };
      }

      for (const t of tasks) {
        if (!AGENTS[t.agent]) {
          return {
            content: [{ type: "text",
              text: `Unknown agent: ${t.agent}. Available: ${AGENT_NAMES.join(", ")}` }],
            isError: true,
            details: {},
          };
        }
      }

      // ── Per-agent state tracking for live widget + overlay ──
      const agentStates = new Map<string, AgentState>();
      const agentOrder: string[] = [];
      for (const t of tasks) {
        const key = `${t.agent}::${t.task}`;
        agentStates.set(key, {
          agent: t.agent,
          output: "",
          status: "running",
        });
        agentOrder.push(key);
      }

      const runState: RunState = { agentStates, agentOrder };
      const entry: RunEntry = { runState, cleanupTimer: null };
      activeRuns.push(entry);

      let lastWidgetUpdate = 0;
      const updateWidget = () => {
        const lines: string[] = [];
        for (const [, state] of agentStates) {
          const icon = state.status === "done" ? "✓" : "◉";
          const lastLine = state.output.trim().split("\n").pop() || "working...";
          const snippet = lastLine.length > 55
            ? lastLine.slice(0, 52) + "..."
            : lastLine;
          lines.push(`${icon} ${state.agent}: ${snippet}`);
        }
        if (lines.length > 0) {
          lines.push("Alt+O: peek agent output");
        }
        ctx.ui.setWidget("subagent", lines);
      };

      if (tasks.length > 1) {
        onUpdate?.({ content: [{ type: "text",
          text: `→ running ${tasks.length} agents concurrently...` }] });
      }

      const results = await Promise.all(
        tasks.map(async (t) => {
          try {
            return await spawnChild(t.agent, t.task, ctx.cwd, signal, (delta: string) => {
              const key = `${t.agent}::${t.task}`;
              const state = agentStates.get(key);
              if (state) state.output += delta;

              // Throttle widget updates to ~150ms intervals
              const now = Date.now();
              if (now - lastWidgetUpdate > 150) {
                lastWidgetUpdate = now;
                updateWidget();
              }
            });
          } catch (err) {
            const key = `${t.agent}::${t.task}`;
            const state = agentStates.get(key);
            if (state) state.status = "error";
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }),
      );

      // Mark done/error, final widget update, then clear
      for (const t of tasks) {
        const state = agentStates.get(`${t.agent}::${t.task}`);
        if (state && state.status === "running") state.status = "done";
      }
      updateWidget();
      entry.cleanupTimer = setTimeout(() => {
        const idx = activeRuns.indexOf(entry);
        if (idx !== -1) activeRuns.splice(idx, 1);
        if (activeRuns.length === 0) {
          ctx.ui.setWidget("subagent", undefined);
        }
        entry.cleanupTimer = null;
      }, 4000);

      const summaryLines: string[] = [];
      const lines: string[] = [];
      for (let i = 0; i < tasks.length; i++) {
        const header = `── ${tasks[i]!.agent} (${tasks[i]!.task.slice(0, 60)}) ──`;
        summaryLines.push(header);
        lines.push(header);
        lines.push(results[i] || "(no output)");
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n").trim() || "(no output)" }],
        isError: false,
        details: { summary: summaryLines.join("\n") },
      };
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("accent", "→ running subagents..."), 0, 0);
      }

      const full = result.content?.[0]?.type === "text" ? result.content[0].text : "";

      if (!expanded) {
        const summary = result.details?.summary ?? full.split("\n").slice(0, 2).join("\n");
        const text = theme.fg("success", "✓ ") + theme.fg("muted", summary);
        return new Text(text + ` (${keyHint("app.tools.expand", "to expand")})`, 0, 0);
      }

      return new Text(full, 0, 0);
    },
  });

  // ── Cleanup ──
  pi.on("session_shutdown", async () => {
    for (const entry of activeRuns) {
      if (entry.cleanupTimer) { clearTimeout(entry.cleanupTimer); entry.cleanupTimer = null; }
    }
    activeRuns.length = 0;
    subagentChildCount = 0;
    delete process.env[SUBAGENT_CHILD_ENV];
  });
}
