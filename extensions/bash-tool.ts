/**
 * Standalone bash tool extension — left-strip rendering for the bash tool.
 *
 * Split out of left-strip-tools.ts so the bash tool can be expanded
 * independently. Re-registers the built-in bash tool with renderShell: "self"
 * so the default Box background is bypassed, and renders the tool block as a
 * thin colored strip on the left edge of every line.
 *
 * Tool signature: adds a required `description` parameter — a one-line
 * summary of what the command does. The description is the only header
 * line unless the block is expanded (ctrl+o); the "$ <command>" line is
 * shown only in expanded view, so the header never changes while the
 * block runs or collapses. Execution is delegated to the built-in
 * createBashToolDefinition; the built-in renderResult (syntax
 * highlighting, truncation warnings, elapsed-time ticker) is wrapped
 * as-is. Errors and streaming/partial results always render in full — the
 * latter also avoids interfering with the stateful inner renderer
 * (BashResultRenderComponent) that accumulates across partial updates.
 *
 * Reload: /reload
 */

import type {
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Reusable component — applies theme background to only the first character
// ---------------------------------------------------------------------------

type BgFn = (s: string) => string;
type RenderResultOptions = { expanded: boolean; isPartial: boolean };
type RenderContext = { isError: boolean; isPartial: boolean };

/**
 * Renders each line with a colored strip on the leftmost character position.
 * Lines are passed as constructor args; `getBgFn` is called fresh on every
 * render() so the color can change dynamically across passes.
 */
class LeftStripBlock implements Component {
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

// ---------------------------------------------------------------------------
// Wrapper — applies a left strip to an existing component's output
// ---------------------------------------------------------------------------

/**
 * Wraps any Component and adds a colored strip to every line of its output.
 * Used to wrap the built-in tool renderers so that content rendering
 * (syntax highlighting, diff formatting, etc.) is preserved while only
 * the background appearance changes.
 */
class LeftStripWrapper implements Component {
  private child: Component;
  private getBgFn: () => BgFn;

  constructor(child: Component, getBgFn: () => BgFn) {
    this.child = child;
    this.getBgFn = getBgFn;
  }

  render(width: number): string[] {
    const bgFn = this.getBgFn();
    // Pass the narrower content width to the child so it renders correctly;
    // then we just prepend the strip + spacer without any truncation.
    const contentWidth = Math.max(1, width - 2);
    return this.child.render(contentWidth).map((line) => {
      if (line === "") return "";
      return bgFn(" ") + "\x1b[49m " + line;
    });
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

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

/**
 * The renderResult wrapper needs a bgFn but the context.isError is sourced
 * from ToolRenderContext.isError (which reflects this.result?.isError).
 * We use a simple getter closure.
 */
function resultBg(isError: boolean, theme: Theme): BgFn {
  return (s: string) => theme.bg(isError ? "toolErrorBg" : "toolSuccessBg", s);
}

// ---------------------------------------------------------------------------
// Collapsed-by-default result rendering
//
// By default tool results are hidden behind a one-line summary; the
// parameters (renderCall) are always shown. Ctrl+O flips the global
// `expanded` flag, which arrives here as options.expanded, revealing the
// full output. Errors and in-progress/streaming results are always shown
// in full — the latter also avoids interfering with the stateful inner
// renderers (bash/read) that accumulate across partial updates.
// ---------------------------------------------------------------------------

function countOutputLines(result: {
  content: Array<{ type: string; text?: string }>;
}): number {
  return result.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .reduce((n, c) => n + c.text!.split("\n").length, 0);
}

/**
 * Returns a one-line summary component when the result should be collapsed,
 * or null to signal the caller to render the full output. When `tookMs` is
 * provided, the elapsed duration is included in the summary.
 */
function collapsedSummary(
  result: { content: Array<{ type: string; text?: string }> },
  options: RenderResultOptions,
  context: Pick<RenderContext, "isError">,
  theme: Theme,
  tookMs?: number,
): Component | null {
  if (options.expanded || options.isPartial || context.isError) return null;
  const n = countOutputLines(result);
  const parts = [`└ ${n} line${n === 1 ? "" : "s"}`];
  if (tookMs !== undefined) {
    parts.push(`took ${(tookMs / 1000).toFixed(1)}s`);
  }
  parts.push("ctrl+o to expand");
  const line = theme.fg("dim", parts.join(" · "));
  return new LeftStripBlock([line], () => resultBg(false, theme));
}

/** Elapsed duration (ms) from the renderer state, if execution started. */
function tookMsFromState(state: any): number | undefined {
  if (state?.startedAt === undefined) return undefined;
  return (state.endedAt ?? Date.now()) - state.startedAt;
}

// ---------------------------------------------------------------------------
// Tool parameters — built-in schema plus a required `description`
// ---------------------------------------------------------------------------

const bashSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  description: Type.String({
    description:
      "One-line description of what the command does (shown in the UI instead of the command when collapsed)",
  }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
});

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // -- bash ----------------------------------------------------------------
  const bashDef = createBashToolDefinition(cwd);
  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      bashDef.description +
      " Always provide a one-line description of what the command does.",
    promptSnippet: bashDef.promptSnippet,
    promptGuidelines: [
      ...(bashDef.promptGuidelines ?? []),
      "Always provide a one-line description of what the bash command does",
    ],
    parameters: bashSchema,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return bashDef.execute(
        toolCallId,
        { command: params.command, timeout: params.timeout },
        signal,
        onUpdate,
        ctx,
      );
    },

    renderCall(args, theme, context) {
      const command = args?.command;
      const description = args?.description;
      // Mirror the built-in renderCall: record execution start so the built-in
      // renderResult can show Elapsed/Took and run its 1s ticker.
      const state = context.state as any;
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const bgFn = () =>
        pendingOrDoneColor(!context.isPartial, context.isError, theme);
      const timeoutSuffix = args?.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      // The description is the only header line unless the block is expanded;
      // the "$ <command>" line appears only in expanded view. This keeps the
      // header identical while running and after collapse.
      const lines = [
        theme.fg("toolTitle", theme.bold(description || `$ ${command ?? ""}`)) +
          timeoutSuffix,
      ];
      if (description && context.expanded) {
        lines.push(theme.fg("muted", `  $ ${command ?? ""}`));
      }
      return new LeftStripBlock(lines, bgFn);
    },

    renderResult(result, options, theme, context) {
      // The built-in bash renderResult owns the elapsed-time ticker: it sets
      // state.interval while streaming and clears it on the first completed
      // pass. The collapsed path below skips the built-in renderer, so run it
      // once after completion to clear the interval (otherwise it leaks and
      // invalidates the TUI every second for the rest of the session).
      if (!options.isPartial && (context.state as any).interval) {
        const inner = (context.state as any)._lsBashResultInner;
        const innerCtx = { ...context, lastComponent: inner };
        const child = bashDef.renderResult!(result as any, options, theme, innerCtx);
        (context.state as any)._lsBashResultInner = child;
      }
      const collapsed = collapsedSummary(
        result,
        options,
        context,
        theme,
        tookMsFromState(context.state as any),
      );
      if (collapsed) return collapsed;
      // Bash's renderResult uses lastComponent as a stateful render component
      // (BashResultRenderComponent). We store the inner one and pass it back.
      const inner = (context.state as any)._lsBashResultInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = bashDef.renderResult!(result, options, theme, innerCtx);
      (context.state as any)._lsBashResultInner = child;
      const isPartial = options.isPartial;
      return new LeftStripWrapper(child, () =>
        isPartial
          ? (s: string) => theme.bg("toolPendingBg", s)
          : resultBg(context.isError, theme),
      );
    },
  });
}
