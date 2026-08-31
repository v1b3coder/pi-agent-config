import {
  AssistantMessageComponent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  getMarkdownTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";

// ── Shared types ───────────────────────────────────────────────────

// AssistantMessage as consumed by the main window's message component
// (avoids importing the pi-ai type directly)
type AssistantMsg = NonNullable<
  ConstructorParameters<typeof AssistantMessageComponent>[0]
>;

// Result shape accepted by the tool execution component
// (avoids importing the pi-ai AgentToolResult type directly)
type ToolResultLike = Parameters<ToolExecutionComponent["updateResult"]>[0];

interface AssistantBlock {
  kind: "assistant";
  message: AssistantMsg | undefined;
  streaming: boolean;
  version: number;
}

interface ToolBlock {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partial: ToolResultLike | undefined;
  result: ToolResultLike | undefined;
  isError: boolean;
  version: number;
}

type AgentBlock = AssistantBlock | ToolBlock;

interface AgentState {
  agent: string;
  task: string;
  status: "running" | "done" | "error";
  blocks: AgentBlock[];
  version: number;
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
// Global sequence for agent state keys — identical agent+task pairs running
// twice in parallel must not collide (states would overwrite each other)
let taskKeySeq = 0;

// ── Peek overlay component ─────────────────────────────────────────

import {
  matchesKey,
  Key,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";

// ── Left-strip rendering (same pattern as extensions/left-strip-tools.ts) ──

type BgFn = (s: string) => string;

/**
 * Renders each line with a colored strip on the leftmost character position,
 * keeping the rest of the line on the default background.
 */
class LeftStripBlock {
  private lines: string[];
  private getBgFn: () => BgFn;

  constructor(lines: string[], getBgFn: () => BgFn) {
    this.lines = lines;
    this.getBgFn = getBgFn;
  }

  render(width: number): string[] {
    const bgFn = this.getBgFn();
    return this.lines.map((line) => {
      if (line === "") return "";
      return (
        bgFn(" ") +
        "\x1b[49m " +
        truncateToWidth(line, Math.max(1, width - 2))
      );
    });
  }

  invalidate(): void {
    // Nothing cached — getBgFn is called per render
  }
}

function pendingOrDoneColor(
  isDone: boolean,
  isError: boolean,
  theme: Theme,
): BgFn {
  const color = isDone
    ? isError
      ? "toolErrorBg"
      : "toolSuccessBg"
    : "toolPendingBg";
  return (s: string) => theme.bg(color, s);
}

function resultBg(isError: boolean, theme: Theme): BgFn {
  return (s: string) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", s);
}

// ── Full-screen tabbed viewer (Alt+O) ──────────────────────────────

/** Last human-meaningful line of an agent's activity, for the footer widget. */
function lastSnippet(state: AgentState): string {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i]!;
    if (b.kind === "tool") {
      if (b.result !== undefined) {
        return `${b.toolName} ${b.isError ? "\u2717" : "\u2713"}`;
      }
      return `\u27f3 ${b.toolName}\u2026`;
    }
    const content = b.message?.content;
    if (!content) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const c = content[j] as { type: string; text?: string; thinking?: string };
      const text = c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : undefined;
      if (text) {
        const line = text.trim().split("\n").pop() ?? "";
        if (line) return line;
      }
    }
  }
  return "working...";
}

/** Cached rendered lines for one transcript block. */
interface BlockEntry {
  component: AssistantMessageComponent | ToolExecutionComponent;
  renderedVersion: number;
  width: number;
  lines: string[];
}

/**
 * Full-screen overlay: tab bar on top, the selected agent's transcript
 * rendered with the main window's components (markdown, tool blocks),
 * windowed to the terminal height, following live output by default.
 */
class AgentViewer {
  private states: Map<string, AgentState>;
  private order: string[];
  private tui: TUI;
  private cwd: string;
  private theme: Theme;
  private selectedIndex = 0;
  /** Absolute first visible line of the body; null = follow the end. */
  private anchor: number | null = null;
  private blockEntries = new Map<string, Map<number, BlockEntry>>();
  private lastBody: string[] = [];
  private lastBodyKey = "";
  private onClose: () => void;

  constructor(
    states: Map<string, AgentState>,
    order: string[],
    tui: TUI,
    cwd: string,
    theme: Theme,
    onClose: () => void,
  ) {
    this.states = states;
    this.order = order;
    this.tui = tui;
    this.cwd = cwd;
    this.theme = theme;
    this.onClose = onClose;
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal?.rows ?? 30;
    return Math.max(3, rows - 2); // tab bar + help line
  }

  private currentLength(): number {
    return this.lastBodyKey === (this.order[this.selectedIndex] ?? "")
      ? this.lastBody.length
      : 0;
  }

  private select(index: number): void {
    this.selectedIndex = ((index % this.order.length) + this.order.length) % this.order.length;
    this.anchor = null;
  }

  handleInput(data: string): void {
    const vh = this.viewportHeight();
    const digit = /^[1-9]$/.exec(data);
    if (digit) {
      const idx = Number(digit[0]) - 1;
      if (idx < this.order.length) this.select(idx);
    } else if (matchesKey(data, Key.left)) {
      this.select(this.selectedIndex - 1);
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.select(this.selectedIndex + 1);
    } else if (matchesKey(data, Key.up)) {
      if (this.anchor === null) this.anchor = Math.max(0, this.currentLength() - vh);
      this.anchor = Math.max(0, this.anchor - 1);
    } else if (matchesKey(data, Key.down)) {
      if (this.anchor === null) return;
      this.anchor = Math.min(this.anchor + 1, Math.max(0, this.currentLength() - vh));
      if (this.currentLength() - this.anchor <= vh) this.anchor = null;
    } else if (matchesKey(data, Key.pageUp)) {
      if (this.anchor === null) this.anchor = Math.max(0, this.currentLength() - vh);
      this.anchor = Math.max(0, this.anchor - vh);
    } else if (matchesKey(data, Key.pageDown)) {
      if (this.anchor === null) return;
      this.anchor = Math.min(this.anchor + vh, Math.max(0, this.currentLength() - vh));
      if (this.currentLength() - this.anchor <= vh) this.anchor = null;
    } else if (matchesKey(data, Key.end)) {
      this.anchor = null;
    } else if (matchesKey(data, Key.escape)) {
      this.onClose();
    }
  }

  private createEntry(block: AgentBlock): BlockEntry {
    if (block.kind === "assistant") {
      const component = new AssistantMessageComponent(
        block.message ?? undefined,
        false,
        getMarkdownTheme(),
      );
      return { component, renderedVersion: block.version, width: -1, lines: [] };
    }
    const component = new ToolExecutionComponent(
      block.toolName,
      block.toolCallId,
      block.args,
      {},
      undefined,
      this.tui,
      this.cwd,
    );
    component.setExpanded(true);
    if (block.result !== undefined) {
      component.updateResult(block.result, false);
    } else {
      component.markExecutionStarted();
      if (block.partial !== undefined) component.updateResult(block.partial, true);
    }
    return { component, renderedVersion: block.version, width: -1, lines: [] };
  }

  private updateEntry(block: AgentBlock, entry: BlockEntry): void {
    if (block.kind === "assistant") {
      if (block.message !== undefined) {
        (entry.component as AssistantMessageComponent).updateContent(
          block.message,
          block.streaming,
        );
      }
    } else {
      const component = entry.component as ToolExecutionComponent;
      if (block.result !== undefined) {
        component.updateResult(block.result, false);
      } else if (block.partial !== undefined) {
        component.updateResult(block.partial, true);
      }
    }
  }

  /** Render the selected agent's transcript into a line buffer (cached per block). */
  private renderBody(state: AgentState, width: number, agentKey: string): string[] {
    let perAgent = this.blockEntries.get(agentKey);
    if (!perAgent) {
      perAgent = new Map();
      this.blockEntries.set(agentKey, perAgent);
    }

    const lines: string[] = [];
    const taskLine = `Task: ${(state.task.split("\n")[0] ?? "").trim()}`;
    lines.push(this.theme.fg("dim", truncateToWidth(taskLine, Math.max(1, width - 1))));
    lines.push("");

    state.blocks.forEach((block, bi) => {
      let entry = perAgent.get(bi);
      if (!entry) {
        entry = this.createEntry(block);
        perAgent.set(bi, entry);
      }
      const versionChanged = entry.renderedVersion !== block.version;
      const widthChanged = entry.width !== width;
      if (versionChanged) {
        this.updateEntry(block, entry);
        entry.renderedVersion = block.version;
      }
      // Re-render the block's lines whenever its content changed (live
      // streaming) or the terminal width changed — not just on width.
      if (versionChanged || widthChanged) {
        entry.width = width;
        entry.lines = entry.component.render(width);
      }
      lines.push(...entry.lines);
    });

    this.lastBody = lines;
    this.lastBodyKey = agentKey;
    return lines;
  }

  render(width: number): string[] {
    const vh = this.viewportHeight();
    const agentKey = this.order[this.selectedIndex] ?? "";
    const state = this.states.get(agentKey);

    // ── Tab bar ──
    const tabs = this.order.map((key, i) => {
      const st = this.states.get(key);
      const icon = st?.status === "done" ? "\u2713" : st?.status === "error" ? "\u2717" : "\u25c9";
      const label = `${i + 1} ${icon} ${st?.agent ?? key}`;
      return i === this.selectedIndex ? `\x1b[7m ${label} \x1b[27m` : ` ${label} `;
    });
    const out: string[] = [truncateToWidth(tabs.join("\u2502"), width - 1)];

    // ── Body window ──
    const body = state
      ? this.renderBody(state, width, agentKey)
      : [this.theme.fg("error", "No agent selected")];
    const total = body.length;
    const start = this.anchor === null
      ? Math.max(0, total - vh)
      : Math.max(0, Math.min(this.anchor, Math.max(0, total - vh)));
    const visible = body.slice(start, start + vh);
    while (visible.length < vh) visible.push("");
    out.push(...visible);

    // ── Help line ──
    const pos = this.anchor === null
      ? "\u2193 follow"
      : `\u2261 ${start + 1}\u2013${Math.min(start + vh, total)} / ${total}`;
    const help = truncateToWidth(
      `${pos}  \u2022  1-9 tab  \u2022  \u2190\u2192/Tab agent  \u2022  \u2191\u2193 scroll  \u2022  PgUp/PgDn page  \u2022  End bottom  \u2022  Esc close`,
      width,
    );
    out.push(this.theme.fg("dim", help));

    return out;
  }

  invalidate(): void {
    // Components cache their own lines; versions drive updates.
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
  signal: AbortSignal | undefined,
  state: AgentState,
  onTick?: () => void,
): Promise<string> {
  const def = AGENTS[agentName];
  if (!def) throw new Error(`Unknown agent: ${agentName}`);

  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);

  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();

  // Apply provider registrations queued by extensions (e.g. litellm.ts) to a
  // canonical ModelRuntime and pass it explicitly. Must happen BEFORE
  // createAgentSession: AgentSession constructs its ExtensionRunner (which
  // would flush the same queue) only after findInitialModel has already
  // picked the default model — too late for settings defaultProvider=litellm.
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const extResult = resourceLoader.getExtensions();
  for (const { name, config } of extResult.runtime.pendingProviderRegistrations) {
    modelRuntime.registerProvider(name, config);
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
      agentDir,
      tools: def.tools,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });

    // Abort wiring: Esc / ctx.abort() in the parent must stop the child run.
    if (signal?.aborted) {
      session.dispose();
      throw new Error("cancelled before start");
    }
    const killSession = () => { void session.abort(); };
    signal?.addEventListener("abort", killSession, { once: true });

    // Structured transcript for the full-screen viewer and widget:
    // assistant messages (thinking + text) and tool executions as blocks.
    // The value returned to the parent model stays the assistant text only.
    let finalText = "";

    const lastAssistantBlock = (): AssistantBlock | undefined => {
      for (let i = state.blocks.length - 1; i >= 0; i--) {
        const b = state.blocks[i]!;
        if (b.kind === "assistant") return b;
      }
      return undefined;
    };
    const toolBlock = (toolCallId: string): ToolBlock | undefined => {
      for (let i = state.blocks.length - 1; i >= 0; i--) {
        const b = state.blocks[i]!;
        if (b.kind === "tool" && b.toolCallId === toolCallId) return b;
      }
      return undefined;
    };

    const unsub = session.subscribe((ev) => {
      if (ev.type === "message_start" && ev.message.role === "assistant") {
        state.blocks.push({
          kind: "assistant",
          message: ev.message as AssistantMsg,
          streaming: true,
          version: 0,
        });
      } else if (ev.type === "message_update" && ev.message.role === "assistant") {
        const block = lastAssistantBlock();
        if (block) {
          block.message = ev.message as AssistantMsg;
          block.streaming = true;
          block.version++;
        }
      } else if (ev.type === "message_end" && ev.message.role === "assistant") {
        const block = lastAssistantBlock();
        if (block) {
          block.message = ev.message as AssistantMsg;
          block.streaming = false;
          block.version++;
        }
        finalText += (ev.message.content as { type: string; text?: string }[])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("");
      } else if (ev.type === "tool_execution_start") {
        state.blocks.push({
          kind: "tool",
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          args: ev.args,
          partial: undefined,
          result: undefined,
          isError: false,
          version: 0,
        });
      } else if (ev.type === "tool_execution_update") {
        const block = toolBlock(ev.toolCallId);
        if (block) {
          block.partial = ev.partialResult;
          block.version++;
        }
      } else if (ev.type === "tool_execution_end") {
        const block = toolBlock(ev.toolCallId);
        if (block) {
          block.result = ev.result;
          block.isError = ev.isError;
          block.partial = undefined;
          block.version++;
        }
      } else {
        return;
      }
      state.version++;
      onTick?.();
    });

    try {
      await session.prompt(`${def.systemPrompt}\n\nTask: ${task}`);
      // Fallback: if no message_end text was captured (e.g. unusual event
      // ordering), assemble the answer from the assistant blocks.
      if (!finalText.trim()) {
        finalText = state.blocks
          .filter((b): b is AssistantBlock => b.kind === "assistant")
          .map((b) =>
            ((b.message?.content as { type: string; text?: string }[] | undefined) ?? [])
              .filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join(""),
          )
          .filter((t) => t.trim())
          .join("\n\n");
      }
      return finalText.trim();
    } finally {
      signal?.removeEventListener("abort", killSession);
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

  // ── Keyboard shortcut: full-screen agent tabs viewer ──────
  pi.registerShortcut("alt+o", {
    description: "Subagent tabs viewer",
    handler: async (ctx) => {
      // Merge all active runs into one combined viewer
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
        ctx.ui.notify("No subagent activity to view", "info");
        return;
      }

      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const viewer = new AgentViewer(
            combinedStates,
            combinedOrder,
            tui,
            ctx.cwd,
            theme,
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
            render: (w) => viewer.render(w),
            invalidate: () => viewer.invalidate(),
            handleInput: (data) => {
              viewer.handleInput(data);
              tui.requestRender();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-left",
            width: "100%",
            maxHeight: "100%",
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

      // ── Per-agent state tracking for live widget + viewer ──
      const agentStates = new Map<string, AgentState>();
      const agentOrder: string[] = [];
      const taskKeys = tasks.map((t) => `#${++taskKeySeq} ${t.agent}`);
      for (const [i, t] of tasks.entries()) {
        agentStates.set(taskKeys[i]!, {
          agent: t.agent,
          task: t.task,
          status: "running",
          blocks: [],
          version: 0,
        });
        agentOrder.push(taskKeys[i]!);
      }

      const runState: RunState = { agentStates, agentOrder };
      const entry: RunEntry = { runState, cleanupTimer: null };
      activeRuns.push(entry);

      let lastWidgetUpdate = 0;
      const updateWidget = () => {
        const lines: string[] = [];
        for (const [, state] of agentStates) {
          const icon = state.status === "done" ? "✓" : state.status === "error" ? "✗" : "◉";
          const snippet = lastSnippet(state);
          const cut = snippet.length > 55 ? snippet.slice(0, 52) + "..." : snippet;
          lines.push(`${icon} ${state.agent}: ${cut}`);
        }
        if (lines.length > 0) {
          lines.push("Alt+O: agent tabs");
        }
        ctx.ui.setWidget("subagent", lines);
      };

      if (tasks.length > 1) {
        onUpdate?.({ content: [{ type: "text",
          text: `→ running ${tasks.length} agents concurrently...` }], details: {} });
      }

      const results = await Promise.all(
        tasks.map(async (t, i) => {
          const key = taskKeys[i]!;
          try {
            return await spawnChild(t.agent, t.task, ctx.cwd, signal, agentStates.get(key)!, () => {
              // Throttle widget updates to ~150ms intervals
              const now = Date.now();
              if (now - lastWidgetUpdate > 150) {
                lastWidgetUpdate = now;
                updateWidget();
              }
            });
          } catch (err) {
            const state = agentStates.get(key);
            if (state) state.status = "error";
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }),
      );

      // Mark done/error, final widget update, then clear
      for (const key of taskKeys) {
        const state = agentStates.get(key);
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

      const lines: string[] = [];
      for (let i = 0; i < tasks.length; i++) {
        const header = `── ${tasks[i]!.agent} (${tasks[i]!.task.slice(0, 60)}) ──`;
        lines.push(header);
        lines.push(results[i] || "(no output)");
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n").trim() || "(no output)" }],
        isError: false,
        details: {},
      };
    },

    renderShell: "self",

    renderCall(args, theme, context) {
      let title: string;
      if (args.tasks) {
        title =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", `×${args.tasks.length} `) +
          theme.fg("dim", args.tasks.map((t: { agent: string }) => t.agent).join(", "));
      } else {
        const task = String(args.task ?? "").split("\n")[0] ?? "";
        title =
          theme.fg("toolTitle", theme.bold("subagent ")) +
          theme.fg("accent", String(args.agent ?? "")) +
          theme.fg("dim", ` · ${task.slice(0, 60)}`);
      }
      return new LeftStripBlock([title], () =>
        pendingOrDoneColor(!context.isPartial, context.isError, theme),
      );
    },

    renderResult(result, options, theme, context) {
      if (options.isPartial) {
        return new LeftStripBlock(
          [theme.fg("accent", "→ running subagents...")],
          () => (s: string) => theme.bg("toolPendingBg", s),
        );
      }

      const full = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      const n = full.split("\n").length;

      if (!options.expanded && !context.isError) {
        const hint = keyHint("app.tools.expand", "to expand");
        return new LeftStripBlock(
          [theme.fg("dim", `└ ${n} line${n === 1 ? "" : "s"} · ${hint}`)],
          () => resultBg(false, theme),
        );
      }

      return new LeftStripBlock(full.split("\n"), () =>
        resultBg(context.isError, theme),
      );
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
