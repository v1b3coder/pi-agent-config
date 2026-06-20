import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";

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
    tools: ["read", "write", "grep", "find"],
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
  _signal?: AbortSignal,
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

  process.env[SUBAGENT_CHILD_ENV] = "1";
  try {
    const { session } = await createAgentSession({
      cwd,
      tools: def.tools,
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });

    let output = "";
    const unsub = session.subscribe((ev) => {
      if (
        ev.type === "message_update" &&
        ev.assistantMessageEvent.type === "text_delta"
      ) {
        output += ev.assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(`${def.systemPrompt}\n\nTask: ${task}`);
      return output.trim();
    } finally {
      unsub();
      session.dispose();
    }
  } finally {
    delete process.env[SUBAGENT_CHILD_ENV];
  }
}

// ── Extension registration ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (process.env[SUBAGENT_CHILD_ENV] === "1") return;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate work to sub-agents in isolated sessions.\n" +
      "Single: { task, agent }. Parallel: { tasks: [{agent, task}, ...] }.\n" +
      "Builtin agents: reviewer (code review), scout (codebase recon),\n" +
      "researcher (web research), context-builder (analysis),\n" +
      "worker (plan implementation), delegate (generic).\n" +
      "Compatible with pi-openplan plan mode.",

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

      if (tasks.length > 1) {
        onUpdate?.({ content: [{ type: "text",
          text: `→ running ${tasks.length} agents concurrently...` }] });
      }

      const results = await Promise.all(
        tasks.map((t) => spawnChild(t.agent, t.task, ctx.cwd, signal)),
      );

      const lines: string[] = [];
      for (let i = 0; i < tasks.length; i++) {
        lines.push(`── ${tasks[i]!.agent} (${tasks[i]!.task.slice(0, 60)}) ──`);
        lines.push(results[i] || "(no output)");
        lines.push("");
      }

      return {
        content: [{ type: "text", text: lines.join("\n").trim() || "(no output)" }],
        isError: false,
        details: {},
      };
    },
  });
}
