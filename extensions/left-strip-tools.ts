/**
 * Left-Strip Tool Blocks — replaces full-block colored backgrounds with a
 * thin colored bar on the left edge of each tool call/result line.
 *
 * This re-registers all seven built-in coding tools
 * (read, bash, edit, write, grep, find, ls) with renderShell: "self" so the
 * default Box background is bypassed.
 * Instead of reimplementing content rendering, it wraps the built-in
 * renderCall/renderResult components in LeftStripWrapper, which prefixes
 * every line with a colored strip character. This preserves syntax
 * highlighting, diff formatting, truncation warnings, and key hints.
 *
 * For write (which has no built-in renderers), simple custom renderers
 * are used.
 *
 * Install: copy to ~/.pi/agent/extensions/left-strip-tools.ts
 * Reload:  /reload
 */

import type {
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
// renderers (bash/read/edit) that accumulate across partial updates.
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
// Helpers called by renderCall wrappers for title lines
// ---------------------------------------------------------------------------

function writeTitle(path: string, content: string, t?: Theme): string {
  if (!t) return `write ${path}`;
  const lc = content.split("\n").length;
  return (
    t.fg("toolTitle", t.bold("write ")) +
    t.fg("accent", path) +
    t.fg("dim", ` (${lc} lines)`)
  );
}

// ---------------------------------------------------------------------------
// Write renderers — no built-in renderers exist, so we provide simple ones
// ---------------------------------------------------------------------------

function makeWriteCall(
  args: { path: string; content: string },
  theme: Theme,
  context: RenderContext,
): Component {
  const titleLine = writeTitle(args.path, args.content, theme);
  return new LeftStripBlock([titleLine], () =>
    pendingOrDoneColor(!context.isPartial, context.isError, theme),
  );
}

function makeWriteResult(
  args: { path: string; content: string },
  result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
  isError: boolean,
  theme: Theme,
): Component {
  const lines: string[] = [];
  const content = result.content[0];
  if (content?.type === "text" && content.text.startsWith("Error")) {
    lines.push(theme.fg("error", content.text.split("\n")[0]!));
  } else {
    lines.push(theme.fg("success", "Written"));
  }
  return new LeftStripBlock(lines, () => resultBg(isError, theme));
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // -- read ----------------------------------------------------------------
  const readDef = createReadToolDefinition(cwd);
  pi.registerTool({
    name: "read",
    label: "read",
    description: readDef.description,
    promptSnippet: readDef.promptSnippet,
    promptGuidelines: readDef.promptGuidelines,
    parameters: readDef.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return readDef.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      const inner = (context.state as any)._lsReadCallInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = readDef.renderCall!(args, theme, innerCtx);
      (context.state as any)._lsReadCallInner = child;
      return new LeftStripWrapper(child, () =>
        pendingOrDoneColor(!context.isPartial, context.isError, theme),
      );
    },

    renderResult(result, options, theme, context) {
      const collapsed = collapsedSummary(result, options, context, theme);
      if (collapsed) return collapsed;
      const inner = (context.state as any)._lsReadResultInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = readDef.renderResult!(result, options, theme, innerCtx);
      (context.state as any)._lsReadResultInner = child;
      const isPartial = options.isPartial;
      return new LeftStripWrapper(child, () =>
        isPartial
          ? (s: string) => theme.bg("toolPendingBg", s)
          : resultBg(context.isError, theme),
      );
    },
  });

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

  // -- grep ----------------------------------------------------------------
  const grepDef = createGrepToolDefinition(cwd);
  pi.registerTool({
    name: "grep",
    label: "grep",
    description: grepDef.description,
    promptSnippet: grepDef.promptSnippet,
    promptGuidelines: grepDef.promptGuidelines,
    parameters: grepDef.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return grepDef.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      const inner = (context.state as any)._lsGrepCallInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = grepDef.renderCall!(args, theme, innerCtx);
      (context.state as any)._lsGrepCallInner = child;
      return new LeftStripWrapper(child, () =>
        pendingOrDoneColor(!context.isPartial, context.isError, theme),
      );
    },

    renderResult(result, options, theme, context) {
      const collapsed = collapsedSummary(result, options, context, theme);
      if (collapsed) return collapsed;
      const inner = (context.state as any)._lsGrepResultInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = grepDef.renderResult!(result, options, theme, innerCtx);
      (context.state as any)._lsGrepResultInner = child;
      return new LeftStripWrapper(child, () =>
        options.isPartial
          ? (s: string) => theme.bg("toolPendingBg", s)
          : resultBg(context.isError, theme),
      );
    },
  });

  // -- find ----------------------------------------------------------------
  const findDef = createFindToolDefinition(cwd);
  pi.registerTool({
    name: "find",
    label: "find",
    description: findDef.description,
    promptSnippet: findDef.promptSnippet,
    promptGuidelines: findDef.promptGuidelines,
    parameters: findDef.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return findDef.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      const inner = (context.state as any)._lsFindCallInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = findDef.renderCall!(args, theme, innerCtx);
      (context.state as any)._lsFindCallInner = child;
      return new LeftStripWrapper(child, () =>
        pendingOrDoneColor(!context.isPartial, context.isError, theme),
      );
    },

    renderResult(result, options, theme, context) {
      const collapsed = collapsedSummary(result, options, context, theme);
      if (collapsed) return collapsed;
      const inner = (context.state as any)._lsFindResultInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = findDef.renderResult!(result, options, theme, innerCtx);
      (context.state as any)._lsFindResultInner = child;
      return new LeftStripWrapper(child, () =>
        options.isPartial
          ? (s: string) => theme.bg("toolPendingBg", s)
          : resultBg(context.isError, theme),
      );
    },
  });

  // -- ls ------------------------------------------------------------------
  const lsDef = createLsToolDefinition(cwd);
  pi.registerTool({
    name: "ls",
    label: "ls",
    description: lsDef.description,
    promptSnippet: lsDef.promptSnippet,
    promptGuidelines: lsDef.promptGuidelines,
    parameters: lsDef.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return lsDef.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      const inner = (context.state as any)._lsLsCallInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = lsDef.renderCall!(args, theme, innerCtx);
      (context.state as any)._lsLsCallInner = child;
      return new LeftStripWrapper(child, () =>
        pendingOrDoneColor(!context.isPartial, context.isError, theme),
      );
    },

    renderResult(result, options, theme, context) {
      const collapsed = collapsedSummary(result, options, context, theme);
      if (collapsed) return collapsed;
      const inner = (context.state as any)._lsLsResultInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = lsDef.renderResult!(result, options, theme, innerCtx);
      (context.state as any)._lsLsResultInner = child;
      return new LeftStripWrapper(child, () =>
        options.isPartial
          ? (s: string) => theme.bg("toolPendingBg", s)
          : resultBg(context.isError, theme),
      );
    },
  });

  // -- edit ----------------------------------------------------------------
  // DISABLED: the left-strip wrapper currently leaks the built-in edit
  // renderer's own line backgrounds into the body (body gets colored
  // background behind the strip). Fall back to the built-in edit tool
  // (default Box shell) until that is fixed. Set to true to re-enable.
  const EDIT_LEFT_STRIP_ENABLED = false;
  if (EDIT_LEFT_STRIP_ENABLED) {
  const editDef = createEditToolDefinition(cwd);
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: editDef.description,
    promptSnippet: editDef.promptSnippet,
    promptGuidelines: editDef.promptGuidelines,
    parameters: editDef.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return editDef.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      // Edit's renderCall uses context.state.callComponent and lastComponent.
      // We store the inner call component and pass it as lastComponent.
      const inner = (context.state as any)._lsEditCallInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = editDef.renderCall!(args, theme, innerCtx);
      (context.state as any)._lsEditCallInner = child;
      return new LeftStripWrapper(child, () =>
        pendingOrDoneColor(!context.isPartial, context.isError, theme),
      );
    },

    renderResult(result, options, theme, context) {
      // Edit is never collapsed: its diff is rendered in renderCall, and this
      // renderResult also reconciles the applied diff back into the call
      // component, so it must always run.
      // Edit's renderResult reuses lastComponent as a Container (clear/addChild).
      // We pass the inner container and wrap the returned component.
      const inner = (context.state as any)._lsEditResultInner;
      const innerCtx = { ...context, lastComponent: inner };
      const child = editDef.renderResult!(result as any, options, theme, innerCtx);
      (context.state as any)._lsEditResultInner = child;
      const isPartial = options.isPartial;
      return new LeftStripWrapper(child, () =>
        isPartial
          ? (s: string) => theme.bg("toolPendingBg", s)
          : resultBg(context.isError, theme),
      );
    },
  });
  } // end EDIT_LEFT_STRIP_ENABLED

  // -- write ---------------------------------------------------------------
  const writeDef = createWriteToolDefinition(cwd);
  pi.registerTool({
    name: "write",
    label: "write",
    description: writeDef.description,
    promptSnippet: writeDef.promptSnippet,
    promptGuidelines: writeDef.promptGuidelines,
    parameters: writeDef.parameters,
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return writeDef.execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall(args, theme, context) {
      return makeWriteCall(args, theme, context);
    },

    renderResult(result, { expanded }, theme, context) {
      const args = context.args as { path: string; content: string };
      return makeWriteResult(args, result, context.isError, theme);
    },
  });
}
