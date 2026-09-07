/**
 * Standalone bash tool extension — left-strip rendering for the bash tool.
 *
 * Split out of left-strip-tools.ts so the bash tool can be expanded
 * independently. Re-registers the built-in bash tool with renderShell: "self"
 * so the default Box background is bypassed, and wraps the built-in
 * renderCall/renderResult components in LeftStripWrapper, which prefixes every
 * line with a colored strip character. This preserves syntax highlighting,
 * truncation warnings, elapsed-time ticker, and key hints.
 *
 * Execution is delegated to the built-in createBashToolDefinition — no
 * behavior change. Results are collapsed by default to a one-line summary
 * (ctrl+o to expand); errors and streaming/partial results always render in
 * full — the latter also avoids interfering with the stateful inner renderer
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
 * or null to signal the caller to render the full output.
 */
function collapsedSummary(
  result: { content: Array<{ type: string; text?: string }> },
  options: RenderResultOptions,
  context: Pick<RenderContext, "isError">,
  theme: Theme,
): Component | null {
  if (options.expanded || options.isPartial || context.isError) return null;
  const n = countOutputLines(result);
  const line = theme.fg("dim", `└ ${n} line${n === 1 ? "" : "s"} · ctrl+o to expand`);
  return new LeftStripBlock([line], () => resultBg(false, theme));
}

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
    description: bashDef.description,
    promptSnippet: bashDef.promptSnippet,
    promptGuidelines: bashDef.promptGuidelines,
    parameters: bashDef.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return bashDef.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      const inner = (context.state as any)._lsBashCallInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = bashDef.renderCall!(args, theme, innerCtx);
      (context.state as any)._lsBashCallInner = child;
      return new LeftStripWrapper(child, () =>
        pendingOrDoneColor(!context.isPartial, context.isError, theme),
      );
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
      const collapsed = collapsedSummary(result, options, context, theme);
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
