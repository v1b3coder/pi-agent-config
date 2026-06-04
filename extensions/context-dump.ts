import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context-dump", {
    description: "Dump full context (messages, model, usage, raw entries) to a JSON file in the current directory",
    handler: async (_args, ctx) => {
      const filePath = join(ctx.cwd, `context-dump-${Date.now()}.json`);

      // Raw session tree entries (all of them, not just active branch)
      const entries = ctx.sessionManager.getEntries();

      // Current active branch (leaf → root path)
      const branch = ctx.sessionManager.getBranch();

      // What the LLM actually sees — resolved messages, thinkingLevel, model
      let sessionContext: ReturnType<typeof buildSessionContext> | { error: string } | null = null;
      try {
        const leafId = ctx.sessionManager.getLeafId();
        sessionContext = buildSessionContext(entries, leafId ?? undefined);
      } catch (e) {
        sessionContext = {
          error: `Could not build session context: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      // Current model
      const model = ctx.model;
      // Token usage estimate
      const usage = ctx.getContextUsage();
      // System prompt (may be empty outside agent turns)
      let systemPrompt: string | { error: string } | null = null;
      try {
        systemPrompt = ctx.getSystemPrompt();
      } catch (e) {
        systemPrompt = {
          error: `getSystemPrompt() not available: ${e instanceof Error ? e.message : String(e)}`,
        };
      }

      const dump = {
        timestamp: new Date().toISOString(),
        cwd: ctx.cwd,
        session: {
          file: ctx.sessionManager.getSessionFile() ?? "(in-memory)",
          id: ctx.sessionManager.getSessionId(),
          leafId: ctx.sessionManager.getLeafId(),
        },
        model: model
          ? {
              provider: model.provider,
              id: model.id,
              name: model.name,
              api: model.api,
              reasoning: model.reasoning,
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
            }
          : null,
        contextUsage: usage,
        systemPrompt,
        summary: {
          totalEntries: entries.length,
          branchLength: branch.length,
        },
        sessionContext,
        rawEntries: entries,
      };

      writeFileSync(filePath, JSON.stringify(dump, null, 2), "utf-8");
      ctx.ui.notify(
        `📄 Context dumped to ${filePath} (${entries.length} entries, ` +
          `${sessionContext && "messages" in sessionContext ? sessionContext.messages.length : "?"} msgs)`,
        "info",
      );
    },
  });
}
