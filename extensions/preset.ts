/**
 * Preset Extension
 *
 * Switchable named presets that filter the active set of tools and skills.
 * Filters compose two modes per category (allowlist vs denylist) so a preset
 * can express either "only these" or "everything except these".
 *
 * Storage: two JSON files (both loaded at startup, merged at lookup time):
 *   - global  → ~/.pi/agent/presets.json     (follows you across projects)
 *   - project → <cwd>/.pi/presets.json       (per-project, takes precedence)
 *
 * Project presets win on name conflict. activePreset is persisted in the
 * file that owns it (project file if the active preset is project-scoped,
 * else global) and project's activePreset wins at load time.
 *
 * Example presets.json:
 * {
 *   "activePreset": "webdev",
 *   "presets": {
 *     "minimal": { "tools-enabled":  ["read", "bash", "edit", "write"] },
 *     "webdev":  { "skills-disabled":["bitcoin-core", "trezor"] }
 *   }
 * }
 *
 * Reserved presets ("all", "none") are built in and cannot be edited.
 * "custom" is a conventional name used by the Customize action; it's a
 * regular preset that can be edited or deleted like any other.
 *
 * Slash command:
 *   /preset              menu (activate / customize / new / edit / delete / reload)
 *   /preset <name>       activate directly (fast path)
 *   /preset clear        deactivate
 *   /preset reload       reread presets.json from disk (both scopes)
 *
 * Shortcut: Ctrl+Shift+P cycles through presets.
 * CLI flag: --preset <name> activates on startup.
 *
 * Footer integration (pi-footer widgets):
 *   - "Pi Extension Status" widgets (ctx.ui.setStatus channel):
 *       preset         — colored "NAME (Nt · Ns)"
 *       preset-name    — bare active preset name, e.g. "webdev"
 *       preset-tools   — "active/total" tools, e.g. "6/30"
 *       preset-skills  — "visible/total" skills, e.g. "24/28"
 *   - "Pi Event Value" widgets (pi.events channel): same widgetIds as above.
 * The extension publishes both channels with the same payload so either
 * widget kind in pi-footer works without configuration changes.
 * All values clear when no preset is active.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// =========================================================================
// Types
// =========================================================================

type Category = "tools" | "skills";
type Mode = "enabled" | "disabled";
type Scope = "global" | "project" | "builtin";

interface PresetData {
  "tools-enabled"?: string[];
  "tools-disabled"?: string[];
  "skills-enabled"?: string[];
  "skills-disabled"?: string[];
}

interface PresetsFile {
  activePreset?: string;
  presets: Record<string, PresetData>;
}

interface SkillInfo {
  name: string;
  description: string;
  location: string;
}

interface EditableItem {
  name: string;
  source: string;
  description: string;
}

interface PresetLookup {
  preset: PresetData;
  scope: Scope;
}

const RESERVED_NAMES = new Set(["all", "none"]);
const CUSTOM_NAME = "custom";

// Built-in presets are virtual — never persisted to disk.
const BUILTIN_PRESETS: Record<string, PresetData> = {
  all: {},
  none: { "tools-enabled": [], "skills-enabled": [] },
};

// Pi's project config dir (matches dist/config.js:375 — kept in sync manually).
const PROJECT_CONFIG_DIR = ".pi";

// =========================================================================
// File I/O
// =========================================================================

function loadFile(path: string): PresetsFile {
  if (!existsSync(path)) return { presets: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<PresetsFile>;
    const file: PresetsFile = {
      activePreset: raw.activePreset,
      presets: { ...(raw.presets ?? {}) },
    };
    // Strip reserved names — built-ins are injected at lookup time.
    for (const reserved of RESERVED_NAMES) delete file.presets[reserved];
    return file;
  } catch {
    return { presets: {} };
  }
}

function saveFile(file: PresetsFile, path: string) {
  // Don't persist reserved names; they're built-in.
  const out: PresetsFile = {
    activePreset: file.activePreset,
    presets: Object.fromEntries(
      Object.entries(file.presets).filter(([n]) => !RESERVED_NAMES.has(n)),
    ),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
}

// =========================================================================
// Resolver
// =========================================================================

function resolveFilter(preset: PresetData, category: Category, allItems: string[]): string[] {
  const en = preset[`${category}-enabled`];
  const dis = preset[`${category}-disabled`];
  if (en && dis) {
    // Schema error — prefer denylist (the less destructive of the two).
    return allItems.filter((n) => !dis.includes(n));
  }
  if (en) return en.filter((n) => allItems.includes(n));
  if (dis) return allItems.filter((n) => !dis.includes(n));
  return [...allItems];
}

// =========================================================================
// Prompt manipulation (skills)
// =========================================================================

const SKILL_BLOCK = /  <skill>\n((?:.|\n)*?)\n  <\/skill>\n?/g;

function decodeXml(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function extractSkills(prompt: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  const re = new RegExp(SKILL_BLOCK.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const body = m[1];
    const name = body.match(/<name>([^<]+)<\/name>/)?.[1];
    if (!name) continue;
    const desc = body.match(/<description>([^<]+)<\/description>/)?.[1] ?? "";
    const loc = body.match(/<location>([^<]+)<\/location>/)?.[1] ?? "";
    out.push({ name: decodeXml(name), description: decodeXml(desc), location: decodeXml(loc) });
  }
  return out;
}

/**
 * Turn an absolute SKILL.md path into a short label identifying where the
 * skill is published from. Recognises npm packages, project-local skills,
 * user skills under the agent dir, and the ~/.agents/skills convention.
 */
function skillSource(location: string, projectRoot: string, userRoot: string): string {
  if (!location) return "?";

  // npm packages — e.g. .../node_modules/pi-skill-tavily/skills/...
  // Capture scoped names (@scope/name) too.
  const npm = location.match(/[/\\]node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)[/\\]/);
  if (npm) return npm[1].replace(/\\/g, "/");

  if (projectRoot && location.startsWith(projectRoot)) return "project";
  if (userRoot    && location.startsWith(userRoot))    return "user";

  // ~/.agents/skills/foo/SKILL.md
  if (/[/\\]\.agents[/\\]skills[/\\]/.test(location)) return "user (.agents)";

  // Fall back to the directory containing the skill folder
  // (path layout is typically .../<source>/<skill-name>/SKILL.md).
  const parts = location.split(/[/\\]/).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 3] : "?";
}

function stripHiddenSkills(prompt: string, hidden: Set<string>): string {
  if (hidden.size === 0) return prompt;
  return prompt.replace(new RegExp(SKILL_BLOCK.source, "g"), (match, body: string) => {
    const name = body.match(/<name>([^<]+)<\/name>/)?.[1];
    if (!name) return match;
    return hidden.has(decodeXml(name)) ? "" : match;
  });
}

// =========================================================================
// Extension
// =========================================================================

export default function presetExtension(pi: ExtensionAPI) {
  // Two files, loaded fresh on session_start and on /preset reload.
  let globalFile: PresetsFile = { presets: {} };
  let projectFile: PresetsFile = { presets: {} };
  let globalFilePath = "";
  let projectFilePath = "";

  let activeName: string | undefined;
  let skillCache: SkillInfo[] = [];

  pi.registerFlag("preset", { description: "Activate named preset on startup", type: "string" });

  // -------------------------------------------------------------------------
  // Cross-scope lookup
  // -------------------------------------------------------------------------

  function loadAllPresets(cwd: string) {
    globalFilePath = join(getAgentDir(), "presets.json");
    projectFilePath = join(cwd, PROJECT_CONFIG_DIR, "presets.json");
    globalFile = loadFile(globalFilePath);
    projectFile = loadFile(projectFilePath);
  }

  function lookupPreset(name: string): PresetLookup | undefined {
    if (name in BUILTIN_PRESETS) return { preset: BUILTIN_PRESETS[name], scope: "builtin" };
    if (name in projectFile.presets) return { preset: projectFile.presets[name], scope: "project" };
    if (name in globalFile.presets)  return { preset: globalFile.presets[name],  scope: "global"  };
    return undefined;
  }

  function allPresetNames(): string[] {
    const names = new Set<string>([
      ...Object.keys(BUILTIN_PRESETS),
      ...Object.keys(globalFile.presets),
      ...Object.keys(projectFile.presets),
    ]);
    return [...names].sort((a, b) => {
      const ra = RESERVED_NAMES.has(a), rb = RESERVED_NAMES.has(b);
      if (ra && !rb) return -1;
      if (!ra && rb) return 1;
      return a.localeCompare(b);
    });
  }

  function getActiveFromFiles(): string | undefined {
    return projectFile.activePreset ?? globalFile.activePreset;
  }

  function scopeLabel(scope: Scope): string {
    return scope === "builtin" ? "built-in" : scope;
  }

  // -------------------------------------------------------------------------
  // Scope-aware writes
  // -------------------------------------------------------------------------

  function savePresetToScope(name: string, preset: PresetData, scope: "global" | "project") {
    if (scope === "project") {
      projectFile.presets[name] = preset;
      try { saveFile(projectFile, projectFilePath); } catch {}
    } else {
      globalFile.presets[name] = preset;
      try { saveFile(globalFile, globalFilePath); } catch {}
    }
  }

  function deletePresetByName(name: string): boolean {
    const lookup = lookupPreset(name);
    if (!lookup || lookup.scope === "builtin") return false;
    if (lookup.scope === "project") {
      delete projectFile.presets[name];
      try { saveFile(projectFile, projectFilePath); } catch {}
    } else {
      delete globalFile.presets[name];
      try { saveFile(globalFile, globalFilePath); } catch {}
    }
    return true;
  }

  /**
   * Persist activeName to the file that owns the active preset. For built-ins,
   * keep activePreset wherever it already lives (continuity); fall back to
   * project file if any project preset exists, else global.
   */
  function persistActive() {
    let target: "global" | "project" | undefined;

    if (!activeName) {
      target = undefined;
    } else {
      const lookup = lookupPreset(activeName);
      if (lookup?.scope === "project") target = "project";
      else if (lookup?.scope === "global") target = "global";
      else {
        // builtin
        if (projectFile.activePreset === activeName) target = "project";
        else if (globalFile.activePreset === activeName) target = "global";
        else target = Object.keys(projectFile.presets).length > 0 ? "project" : "global";
      }
    }

    globalFile.activePreset  = target === "global"  ? activeName : undefined;
    projectFile.activePreset = target === "project" ? activeName : undefined;

    // Always save global. Save project only if it exists or we're writing to it.
    try { saveFile(globalFile, globalFilePath); } catch {}
    if (existsSync(projectFilePath) || target === "project") {
      try { saveFile(projectFile, projectFilePath); } catch {}
    }
  }

  // -------------------------------------------------------------------------
  // Live state helpers
  // -------------------------------------------------------------------------

  function listToolNames(): string[] {
    return pi.getAllTools().map((t) => t.name);
  }

  function listToolItems(): EditableItem[] {
    return pi.getAllTools().map((t) => ({
      name: t.name,
      source: t.sourceInfo?.source ?? "core",
      description: collapseWs(t.description ?? ""),
    }));
  }

  function currentToolsOn(): string[] {
    return pi.getActiveTools();
  }

  function currentSkillsOn(): string[] {
    if (skillCache.length === 0) return [];
    const all = skillCache.map((s) => s.name);
    if (!activeName) return all;
    const lookup = lookupPreset(activeName);
    if (!lookup) return all;
    return resolveFilter(lookup.preset, "skills", all);
  }

  function seedFromCurrent(): PresetData {
    const allTools = listToolNames();
    const onTools = currentToolsOn();
    const offTools = allTools.filter((n) => !onTools.includes(n));
    const allSkills = skillCache.map((s) => s.name);
    const onSkills = currentSkillsOn();
    const offSkills = allSkills.filter((n) => !onSkills.includes(n));

    const preset: PresetData = {};
    if (onTools.length <= offTools.length) {
      preset["tools-enabled"] = onTools;
    } else if (offTools.length > 0) {
      preset["tools-disabled"] = offTools;
    }
    if (allSkills.length > 0 && offSkills.length > 0) {
      preset["skills-disabled"] = offSkills;
    }
    return preset;
  }

  function applyPreset(name: string, ctx: ExtensionContext): boolean {
    const lookup = lookupPreset(name);
    if (!lookup) {
      ctx.ui.notify(`Unknown preset "${name}"`, "error");
      return false;
    }
    const wantedTools = resolveFilter(lookup.preset, "tools", listToolNames());
    pi.setActiveTools(wantedTools);
    activeName = name;
    persistActive();
    pi.appendEntry("preset-active", { name });
    updateStatus(ctx);
    return true;
  }

  function clearPreset(ctx: ExtensionContext) {
    activeName = undefined;
    persistActive();
    pi.setActiveTools(listToolNames());
    updateStatus(ctx);
  }

  // -------------------------------------------------------------------------
  // Footer / status publication
  // -------------------------------------------------------------------------

  /** Publish on both pi-footer channels (Extension Status + Pi Event Value). */
  function publish(ctx: ExtensionContext, key: string, value: string | undefined) {
    ctx.ui.setStatus(key, value);
    pi.events.emit("pi-footer:update-widget", { widgetId: key, value: value ?? null });
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!activeName) {
      publish(ctx, "preset", undefined);
      publish(ctx, "preset-name", undefined);
      publish(ctx, "preset-tools", undefined);
      publish(ctx, "preset-skills", undefined);
      return;
    }
    const totalTools = pi.getAllTools().length;
    const activeTools = pi.getActiveTools().length;
    const toolStat = `${activeTools}/${totalTools}`;
    let skillStat = "";
    let skillStatVerbose = "";
    if (skillCache.length > 0) {
      const lookup = lookupPreset(activeName);
      const visible = lookup ? resolveFilter(lookup.preset, "skills", skillCache.map((s) => s.name)).length : skillCache.length;
      skillStat = `${visible}/${skillCache.length}`;
      skillStatVerbose = ` · ${skillStat}s`;
    }
    publish(ctx, "preset", ctx.ui.theme.fg("accent", `${activeName} (${toolStat}t${skillStatVerbose})`));
    publish(ctx, "preset-name", activeName);
    publish(ctx, "preset-tools", toolStat);
    publish(ctx, "preset-skills", skillStat || undefined);
  }

  // -------------------------------------------------------------------------
  // Descriptions
  // -------------------------------------------------------------------------

  function presetSummary(p: PresetData): string {
    const parts: string[] = [];
    const tEn = p["tools-enabled"], tDis = p["tools-disabled"];
    const sEn = p["skills-enabled"], sDis = p["skills-disabled"];
    if (tEn) parts.push(`tools: only ${tEn.length}`);
    else if (tDis) parts.push(`tools: −${tDis.length}`);
    if (sEn) parts.push(`skills: only ${sEn.length}`);
    else if (sDis) parts.push(`skills: −${sDis.length}`);
    return parts.length > 0 ? parts.join(" · ") : "all on";
  }

  function describeWithScope(name: string, lookup: PresetLookup): string {
    return `${scopeLabel(lookup.scope)} · ${presetSummary(lookup.preset)}`;
  }

  // -------------------------------------------------------------------------
  // Selector overlay
  // -------------------------------------------------------------------------

  async function pickFromList(
    title: string,
    items: SelectItem[],
    ctx: ExtensionContext,
  ): Promise<string | null> {
    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title))));

      const list = new SelectList(items, Math.min(items.length, 14), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);

      container.addChild(new Text(theme.fg("dim", "↑↓ select · enter confirm · esc cancel")));
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

      return {
        render(width) { return container.render(width); },
        invalidate() { container.invalidate(); },
        handleInput(data) { list.handleInput(data); tui.requestRender(); },
      };
    });
  }

  async function askScope(ctx: ExtensionContext, name: string): Promise<"global" | "project" | null> {
    const items: SelectItem[] = [
      { value: "project", label: "project", description: `${projectFilePath} (this directory only)` },
      { value: "global",  label: "global",  description: `${globalFilePath} (everywhere)` },
    ];
    const choice = await pickFromList(`Save "${name}" as global or project preset?`, items, ctx);
    if (choice === "global" || choice === "project") return choice;
    return null;
  }

  // -------------------------------------------------------------------------
  // Main menu
  // -------------------------------------------------------------------------

  async function showMenu(ctx: ExtensionContext): Promise<void> {
    while (true) {
      const names = allPresetNames();
      const presetItems: SelectItem[] = [];
      for (const name of names) {
        const lookup = lookupPreset(name);
        if (!lookup) continue;
        presetItems.push({
          value: `preset:${name}`,
          label: name === activeName ? `${name}  ● active` : name,
          description: describeWithScope(name, lookup),
        });
      }

      const clearItem: SelectItem[] = activeName
        ? [{ value: "preset:__clear__", label: "(clear)", description: "Deactivate preset" }]
        : [];

      const actions: SelectItem[] = [
        { value: "action:customize", label: "Customize…",   description: "Tweak active tools/skills, save as 'custom'" },
        { value: "action:new",       label: "New preset…",  description: "Save current active set as a new named preset" },
        { value: "action:edit",      label: "Edit preset…", description: "Pick a preset and modify its tools/skills" },
        { value: "action:delete",    label: "Delete preset…", description: "Permanently remove a saved preset" },
        { value: "action:reload",    label: "Reload",       description: "Reread presets.json from disk" },
      ];

      const choice = await pickFromList("Presets", [...presetItems, ...clearItem, ...actions], ctx);
      if (!choice) return;                              // esc on main menu → exit

      if (choice.startsWith("preset:")) {
        const target = choice.slice("preset:".length);
        if (target === "__clear__") {
          clearPreset(ctx);
          ctx.ui.notify("Preset cleared", "info");
        } else if (applyPreset(target, ctx)) {
          ctx.ui.notify(`Activated preset "${target}"`, "info");
        }
        return;                                         // activation/clear → exit
      }

      switch (choice.slice("action:".length)) {
        case "customize": { if (await customize(ctx)) return; break; }
        case "new":       await newPreset(ctx); break;
        case "edit":      await editFromMenu(ctx); break;
        case "delete":    await deleteFromMenu(ctx); break;
        case "reload":    await reloadPresets(ctx); break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Returns true if 'custom' was committed and activated, false if cancelled. */
  async function customize(ctx: ExtensionContext): Promise<boolean> {
    const preset = seedFromCurrent();

    const tools = await editCategory(preset, "tools", CUSTOM_NAME, ctx);
    if (tools === null) {
      ctx.ui.notify("Customize cancelled", "info");
      return false;
    }

    if (skillCache.length > 0) {
      const editSkills = await ctx.ui.confirm("Customize skills?", "Also edit which skills are visible?");
      if (editSkills) {
        await editCategory(preset, "skills", CUSTOM_NAME, ctx);
      }
    } else {
      ctx.ui.notify("Skills not discovered yet — re-run after sending a message to edit them", "info");
    }

    // Decide scope: keep existing scope if "custom" already exists; else ask.
    const existing = lookupPreset(CUSTOM_NAME);
    let scope: "global" | "project";
    if (existing && existing.scope !== "builtin") {
      scope = existing.scope;
    } else {
      const chosen = await askScope(ctx, CUSTOM_NAME);
      if (chosen === null) {
        ctx.ui.notify("Customize cancelled (no scope chosen)", "info");
        return false;
      }
      scope = chosen;
    }

    savePresetToScope(CUSTOM_NAME, preset, scope);
    applyPreset(CUSTOM_NAME, ctx);
    ctx.ui.notify(`Saved & activated ${scope} preset "${CUSTOM_NAME}"`, "info");
    return true;
  }

  async function newPreset(ctx: ExtensionContext): Promise<void> {
    const raw = await ctx.ui.input("New preset name");
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    if (RESERVED_NAMES.has(name)) {
      ctx.ui.notify(`"${name}" is reserved`, "error");
      return;
    }

    const existing = lookupPreset(name);
    let scope: "global" | "project";

    if (existing && existing.scope !== "builtin") {
      const ok = await ctx.ui.confirm(
        "Overwrite?",
        `Preset "${name}" exists in ${existing.scope}. Overwrite?`,
      );
      if (!ok) return;
      scope = existing.scope;
    } else {
      const chosen = await askScope(ctx, name);
      if (chosen === null) return;
      scope = chosen;
    }

    savePresetToScope(name, seedFromCurrent(), scope);
    ctx.ui.notify(`Created ${scope} preset "${name}" from current state`, "info");
  }

  async function editFromMenu(ctx: ExtensionContext): Promise<void> {
    while (true) {
      const editable = allPresetNames().filter((n) => !RESERVED_NAMES.has(n));
      if (editable.length === 0) {
        ctx.ui.notify("No user presets to edit yet — create one with New preset…", "info");
        return;
      }
      const items: SelectItem[] = [];
      for (const name of editable) {
        const lookup = lookupPreset(name);
        if (!lookup) continue;
        items.push({
          value: name,
          label: name === activeName ? `${name}  ● active` : name,
          description: describeWithScope(name, lookup),
        });
      }
      const target = await pickFromList("Edit which preset?", items, ctx);
      if (!target) return;
      await showEditor(target, ctx);
    }
  }

  async function deleteFromMenu(ctx: ExtensionContext): Promise<void> {
    while (true) {
      const deletable = allPresetNames().filter((n) => !RESERVED_NAMES.has(n));
      if (deletable.length === 0) {
        ctx.ui.notify("No user presets to delete", "info");
        return;
      }
      const items: SelectItem[] = [];
      for (const name of deletable) {
        const lookup = lookupPreset(name);
        if (!lookup) continue;
        items.push({
          value: name,
          label: name === activeName ? `${name}  ● active` : name,
          description: describeWithScope(name, lookup),
        });
      }
      const target = await pickFromList("Delete which preset?", items, ctx);
      if (!target) return;

      const lookup = lookupPreset(target);
      if (!lookup) continue;
      const ok = await ctx.ui.confirm(
        "Delete?",
        `Permanently remove ${scopeLabel(lookup.scope)} preset "${target}"?`,
      );
      if (!ok) continue;
      if (deletePresetByName(target)) {
        if (activeName === target) clearPreset(ctx);
        ctx.ui.notify(`Deleted ${scopeLabel(lookup.scope)} preset "${target}"`, "info");
      }
    }
  }

  async function reloadPresets(ctx: ExtensionContext): Promise<void> {
    loadAllPresets(ctx.cwd);
    ctx.ui.notify(`Reloaded presets (global + project)`, "info");
    const restored = getActiveFromFiles();
    if (restored && lookupPreset(restored)) {
      applyPreset(restored, ctx);
    } else {
      activeName = undefined;
      updateStatus(ctx);
    }
  }

  // -------------------------------------------------------------------------
  // Editor (per-category)
  // -------------------------------------------------------------------------

  async function showEditor(name: string, ctx: ExtensionContext): Promise<void> {
    if (RESERVED_NAMES.has(name)) {
      ctx.ui.notify(`"${name}" is built in and cannot be edited`, "warning");
      return;
    }
    const lookup = lookupPreset(name);
    if (!lookup || lookup.scope === "builtin") {
      ctx.ui.notify(`Unknown preset "${name}"`, "error");
      return;
    }

    while (true) {
      const category = await ctx.ui.select(
        `Edit ${scopeLabel(lookup.scope)} preset "${name}" — which section?`,
        ["tools", "skills"],
      );
      if (!category) return;                            // esc → back to preset picker

      if (category === "skills" && skillCache.length === 0) {
        ctx.ui.notify("No skills discovered yet — send any message first so the prompt loads", "warning");
        continue;
      }

      const result = await editCategory(lookup.preset, category as Category, name, ctx);
      if (result === null) continue;                    // esc in editor → back to category picker

      // Save to the owning scope's file.
      if (lookup.scope === "project") {
        try { saveFile(projectFile, projectFilePath); } catch {}
      } else {
        try { saveFile(globalFile, globalFilePath); } catch {}
      }
      ctx.ui.notify(
        `Saved ${scopeLabel(lookup.scope)} preset "${name}" → ${category}: ${result.on}/${result.total} on (${result.mode})`,
        "info",
      );
      if (name === activeName) applyPreset(name, ctx);
    }
  }

  /**
   * Edit a single category of a preset. Mutates `preset` in place when the
   * user commits. Returns null on cancel, or a summary on save. The caller is
   * responsible for persisting and re-applying.
   */
  async function editCategory(
    preset: PresetData,
    category: Category,
    displayName: string,
    ctx: ExtensionContext,
  ): Promise<{ on: number; total: number; mode: Mode } | null> {
    const projectSkillsRoot = join(ctx.cwd, PROJECT_CONFIG_DIR, "skills");
    const userSkillsRoot = join(getAgentDir(), "skills");
    const items: EditableItem[] = category === "tools"
      ? listToolItems()
      : skillCache.map((s) => ({
          name: s.name,
          source: skillSource(s.location, projectSkillsRoot, userSkillsRoot),
          description: collapseWs(s.description),
        }));

    if (items.length === 0) {
      ctx.ui.notify(`No ${category} available`, "warning");
      return null;
    }

    const enKey = `${category}-enabled` as const;
    const disKey = `${category}-disabled` as const;
    const allNames = items.map((i) => i.name);

    let mode: Mode;
    let on: Set<string>;
    if (preset[enKey] !== undefined) {
      mode = "enabled";
      on = new Set(preset[enKey].filter((n) => allNames.includes(n)));
    } else if (preset[disKey] !== undefined) {
      mode = "disabled";
      on = new Set(allNames.filter((n) => !preset[disKey]!.includes(n)));
    } else {
      mode = "disabled";
      on = new Set(allNames);
    }

    const result = await ctx.ui.custom<{ on: Set<string>; mode: Mode } | null>((tui, theme, _kb, done) => {
      let cursor = 0;
      const maxVisible = 14;
      let scrollTop = 0;

      // Horizontal scroll offset into the selected row's description.
      // Resets whenever the cursor moves so each item starts from the left.
      let descScroll = 0;
      const DESC_STEP = 8;

      const ensureVisible = () => {
        if (cursor < scrollTop) scrollTop = cursor;
        else if (cursor >= scrollTop + maxVisible) scrollTop = cursor - maxVisible + 1;
      };

      const moveCursor = (delta: number) => {
        const next = Math.min(items.length - 1, Math.max(0, cursor + delta));
        if (next !== cursor) {
          cursor = next;
          descScroll = 0;
        }
      };

      const render = (width: number): string[] => {
        ensureVisible();
        const lines: string[] = [];
        const fg = theme.fg.bind(theme);
        const border = "─".repeat(Math.max(0, width - 2));

        lines.push(fg("accent", `┌${border}┐`));
        lines.push(fg("accent", "│") + pad(` Edit ${displayName} → ${category}`, width - 2) + fg("accent", "│"));
        lines.push(
          fg("accent", "│") +
          pad(
            ` mode: ${theme.bold(mode)}   ${mode === "enabled" ? "(only listed are on)" : "(all except listed are on)"}`,
            width - 2,
          ) +
          fg("accent", "│"),
        );
        lines.push(
          fg("accent", "│") +
          pad(fg("dim", ` ${on.size}/${allNames.length} on`), width - 2) +
          fg("accent", "│"),
        );
        lines.push(fg("accent", "├") + fg("accent", border) + fg("accent", "┤"));

        const slice = items.slice(scrollTop, scrollTop + maxVisible);
        // Compute name column width so source/description align across rows.
        const visibleSlice = items.slice(scrollTop, scrollTop + maxVisible);
        const maxNameLen = visibleSlice.reduce((m, it) => Math.max(m, it.name.length), 0);
        const maxSrcLen = visibleSlice.reduce((m, it) => Math.max(m, it.source.length), 0);

        slice.forEach((it, idx) => {
          const absIdx = scrollTop + idx;
          const selected = absIdx === cursor;
          const checked = on.has(it.name);
          const mark = checked ? fg("accent", "[✔]") : fg("dim", "[ ]");
          const labelText = it.name.padEnd(maxNameLen);
          const label = selected ? fg("accent", labelText) : labelText;
          const srcRaw = it.source.padEnd(maxSrcLen);
          const src = it.source ? fg("dim", "  " + srcRaw) : "";

          // Description fills the remainder of the row, truncated to fit.
          // For the selected row, apply horizontal scroll so the user can
          // walk through long descriptions with ←/→.
          const fixedLen = 1 /* leading space */ + 3 /* [x] / [ ] */ + 1 /* space */
                         + maxNameLen
                         + (it.source ? 2 + maxSrcLen : 0)
                         + 3 /* "  ·" */ + 1 /* trailing space */;
          const budget = (width - 2) - fixedLen;
          let descText = it.description ?? "";
          let scrolledPrefix = "";
          if (selected && descScroll > 0 && descScroll < descText.length) {
            descText = descText.slice(descScroll);
            scrolledPrefix = "…";
          }
          const desc = it.description && budget > 4
            ? fg("dim", "  · " + scrolledPrefix + shorten(descText, budget - scrolledPrefix.length))
            : "";

          lines.push(
            fg("accent", "│") +
            pad(` ${mark} ${label}${src}${desc}`, width - 2) +
            fg("accent", "│"),
          );
        });

        if (items.length > maxVisible) {
          lines.push(
            fg("accent", "│") +
            pad(fg("dim", `   ${scrollTop + 1}-${Math.min(scrollTop + maxVisible, items.length)} of ${items.length}`), width - 2) +
            fg("accent", "│"),
          );
        }

        lines.push(fg("accent", "├") + fg("accent", border) + fg("accent", "┤"));
        lines.push(
          fg("accent", "│") +
          pad(fg("dim", " ↑↓ move · ←→ scroll desc · space toggle · m mode · a/n all/none · enter save · esc cancel"), width - 2) +
          fg("accent", "│"),
        );
        lines.push(fg("accent", `└${border}┘`));
        return lines;
      };

      return {
        render,
        invalidate() { },
        handleInput(data: string) {
          if (matchesKey(data, Key.up))       { moveCursor(-1); tui.requestRender(); return; }
          if (matchesKey(data, Key.down))     { moveCursor(1); tui.requestRender(); return; }
          if (matchesKey(data, Key.pageUp))   { moveCursor(-maxVisible); tui.requestRender(); return; }
          if (matchesKey(data, Key.pageDown)) { moveCursor(maxVisible); tui.requestRender(); return; }
          if (matchesKey(data, Key.home))     { moveCursor(-items.length); tui.requestRender(); return; }
          if (matchesKey(data, Key.end))      { moveCursor(items.length); tui.requestRender(); return; }
          if (matchesKey(data, Key.left)) {
            descScroll = Math.max(0, descScroll - DESC_STEP);
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.right)) {
            const desc = items[cursor]?.description ?? "";
            // Cap so at least one char of the description stays visible.
            descScroll = Math.min(Math.max(0, desc.length - 1), descScroll + DESC_STEP);
            tui.requestRender();
            return;
          }
          if (data === " ") {
            const n = items[cursor].name;
            if (on.has(n)) on.delete(n); else on.add(n);
            tui.requestRender();
            return;
          }
          if (data === "m") { mode = mode === "enabled" ? "disabled" : "enabled"; tui.requestRender(); return; }
          if (data === "a") { for (const i of items) on.add(i.name); tui.requestRender(); return; }
          if (data === "n") { on.clear(); tui.requestRender(); return; }
          if (matchesKey(data, Key.enter))  { done({ on, mode }); return; }
          if (matchesKey(data, Key.escape)) { done(null); return; }
        },
      };
    }, { overlay: true });

    if (!result) return null;

    const onArr  = allNames.filter((n) => result.on.has(n));
    const offArr = allNames.filter((n) => !result.on.has(n));

    if (result.mode === "enabled") {
      delete preset[disKey];
      preset[enKey] = onArr;
    } else {
      delete preset[enKey];
      if (offArr.length === 0) delete preset[disKey];
      else preset[disKey] = offArr;
    }

    return { on: onArr.length, total: allNames.length, mode: result.mode };
  }

  // -------------------------------------------------------------------------
  // Slash command + shortcut
  // -------------------------------------------------------------------------

  pi.registerCommand("preset", {
    description: "Manage tool+skill presets (menu, or activate by name)",
    handler: async (rawArgs, ctx) => {
      const tokens = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "";
      const rest = tokens.slice(1).join(" ");

      switch (sub) {
        case "":
          await showMenu(ctx);
          return;
        case "reload":
          await reloadPresets(ctx);
          return;
        case "clear":
        case "off":
          clearPreset(ctx);
          ctx.ui.notify("Preset cleared", "info");
          return;
        default: {
          const target = rest ? `${sub} ${rest}` : sub;
          if (applyPreset(target, ctx)) {
            ctx.ui.notify(`Activated preset "${target}"`, "info");
          }
        }
      }
    },
    getArgumentCompletions: (prefix) => {
      const fast = ["clear", "reload"];
      const names = allPresetNames();
      return [...names, ...fast]
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ value: n, label: n }));
    },
  });

  pi.registerShortcut(Key.ctrlShift("p"), {
    description: "Cycle presets",
    handler: async (ctx) => {
      const names = allPresetNames();
      if (names.length === 0) return;
      const i = activeName ? names.indexOf(activeName) : -1;
      const next = names[(i + 1) % names.length];
      if (applyPreset(next, ctx)) {
        ctx.ui.notify(`Activated "${next}"`, "info");
      }
    },
  });

  // -------------------------------------------------------------------------
  // Hooks
  // -------------------------------------------------------------------------

  pi.on("before_agent_start", async (event) => {
    const found = extractSkills(event.systemPrompt);
    if (found.length > 0) skillCache = found;

    if (!activeName) return;
    const lookup = lookupPreset(activeName);
    if (!lookup) return;
    if (skillCache.length === 0) return;

    const allSkills = skillCache.map((s) => s.name);
    const visible = new Set(resolveFilter(lookup.preset, "skills", allSkills));
    const hidden = new Set(allSkills.filter((n) => !visible.has(n)));
    if (hidden.size === 0) return;

    const rewritten = stripHiddenSkills(event.systemPrompt, hidden);
    if (rewritten !== event.systemPrompt) return { systemPrompt: rewritten };
  });

  pi.on("session_start", async (_event, ctx) => {
    loadAllPresets(ctx.cwd);

    const flag = pi.getFlag("preset");
    if (typeof flag === "string" && flag) {
      if (applyPreset(flag, ctx)) {
        ctx.ui.notify(`Activated preset "${flag}" from --preset`, "info");
      }
      return;
    }

    // Restore from session entry (same-session priority), falling back to file state.
    const entries = ctx.sessionManager.getEntries();
    const last = entries
      .filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "preset-active")
      .pop() as { data?: { name: string } } | undefined;
    const target = last?.data?.name ?? getActiveFromFiles();

    if (target && lookupPreset(target)) {
      applyPreset(target, ctx);
    } else {
      updateStatus(ctx);
    }
  });
}

// =========================================================================
// Helpers
// =========================================================================

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Flatten newlines and runs of whitespace into single spaces for inline display. */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function pad(s: string, width: number): string {
  // Pad to visible width; the ANSI colour wrappers in theme.fg don't
  // contribute to terminal width.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - visible.length);
  return s + " ".repeat(pad);
}
