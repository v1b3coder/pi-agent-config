/**
 * _env-injector — injects env vars from settings.json + .env / .env.local
 *
 * Loads before other extensions (sorted first alphabetically), reads:
 *   - ~/.pi/agent/settings.json  "env" block
 *   - ~/.pi/agent/.env           global dotenv (overrides settings.json)
 *   - ~/.pi/agent/.env.local     global dotenv local overrides
 *   - .pi/settings.json          "env" block
 *   - $cwd/.env
 *   - $cwd/.env.local
 *
 * All values (from both settings.json and .env files) undergo shell-like
 * variable expansion so that "$VAR", "${VAR}", and "$$" work as expected.
 * Expansion happens during the merge loop, so each tier can reference
 * variables from any earlier (lower-priority) tier already in process.env.
 *
 * Priority (later in the list overrides earlier — i.e. more specific wins):
 *
 *    (lowest)  1.  ~/.pi/agent/settings.json  "env"   (global Pi settings)
 *              2.  ~/.pi/agent/.env                   (global dotenv)
 *              3.  ~/.pi/agent/.env.local             (global dotenv local)
 *              4.  .pi/settings.json          "env"   (per-project Pi settings)
 *              5.  $cwd/.env                          (project defaults)
 *    (highest) 6.  $cwd/.env.local                    (local overrides)
 *
 *    Above all of these sits the real shell / .profile environment: variables
 *    already exported when pi starts are never overwritten by any file-based
 *    source (those can still add variables the shell does not define), so
 *    `FOO=bar pi` always beats `FOO=baz` in .env.local. A file tier that
 *    redefines a shell variable therefore has no effect, and later tiers that
 *    reference it expand to the shell value.
 *
 *    Values this extension wrote itself do not count as shell variables on a later
 *    run in the same process (`/reload`, `ctx.reload()`, session switch) or in a
 *    nested pi started from a pty shell — they are recognized via
 *    INJECTED_KEYS_ENV and stay overridable, so editing an env file and
 *    reloading still works.
 *
 *    Tiers 4–6 apply only when the project is trusted. Trust is resolved the
 *    way pi resolves it: the --approve/--no-approve CLI override, then
 *    trust-requiring project resources (including .env/.env.local, which pi does
 *    not count itself), then the nearest saved trust.json entry, then
 *    defaultProjectTrust; see resolveProjectTrust(). "ask" cannot be answered
 *    before extensions load, so a project trusted only by an interactive answer
 *    is picked up by the session_start fallback in the factory.
 *
 * Within each source, keys are applied in iteration / line order.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { hasTrustRequiringProjectResources, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Variable expansion ──────────────────────────────────────────────────────

/**
 * Expand $VAR, ${VAR}, and $$ references in a string using the current
 * process.env.  Unknown variables are left as-is (e.g. "$UNDEFINED" stays
 * "$UNDEFINED" so broken configs are visible rather than silently empty).
 */
function expandVars(value: string): string {
  let result = "";
  let i = 0;

  while (i < value.length) {
    const dollar = value.indexOf("$", i);
    if (dollar === -1) {
      result += value.slice(i);
      break;
    }

    // Copy everything up to the $
    result += value.slice(i, dollar);
    i = dollar + 1;

    if (i >= value.length) {
      result += "$";
      break;
    }

    const ch = value[i];

    // $$ → literal $
    if (ch === "$") {
      result += "$";
      i++;
      continue;
    }

    // ${VAR} — braced form
    if (ch === "{") {
      const close = value.indexOf("}", i + 1);
      if (close === -1) {
        result += value.slice(dollar);
        break;
      }
      const varName = value.slice(i + 1, close);
      const envVal = process.env[varName];
      result += envVal !== undefined ? envVal : `\${${varName}}`;
      i = close + 1;
      continue;
    }

    // $VAR — simple form (alphanumeric + underscore, first char cannot be digit)
    const nameMatch = value.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (nameMatch) {
      const varName = nameMatch[0];
      const envVal = process.env[varName];
      result += envVal !== undefined ? envVal : `$${varName}`;
      i += nameMatch[0].length;
      continue;
    }

    result += "$";
  }

  return result;
}

// ─── Settings reader (settings.json) ────────────────────────────────────────

function loadSettingsEnv(filePath: string): Record<string, string> {
  try {
    if (!existsSync(filePath)) return {};
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    const block = data?.env;
    if (!block || typeof block !== "object") return {};

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(block)) {
      if (value === null || value === undefined) continue;
      result[key] = String(value);
    }
    return result;
  } catch {
    return {};
  }
}

// ─── Inline dotenv parse ────────────────────────────────────────────────────

/**
 * Minimal inline replacement for dotenv.parse().
 * Parses "KEY=VALUE" lines, strips comments (" # comment"),
 * handles single/double-quoted values, trims whitespace.
 * Does NOT expand $VAR references — that is handled separately
 * in expandVars() during the merge loop.
 */
function parseDotenv(src: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of src.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Find first unescaped =
    let eqIndex = -1;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === "=" && (i === 0 || trimmed[i - 1] !== "\\")) {
        eqIndex = i;
        break;
      }
    }
    if (eqIndex === -1) {
      result[trimmed] = "";
      continue;
    }

    let key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip inline comment (space + #) from value — but not inside quotes
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const close = value.indexOf(quote, 1);
      if (close !== -1) {
        value = value.slice(1, close);
      }
    } else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
      const hash2 = value.indexOf("\t#");
      if (hash2 !== -1) value = value.slice(0, hash2).trim();
    }

    result[key] = value;
  }
  return result;
}

// ─── .env file loader ───────────────────────────────────────────────────────

function loadDotenvFile(filePath: string): Record<string, string> {
  try {
    if (!existsSync(filePath)) return {};
    const text = readFileSync(filePath, "utf-8");
    return parseDotenv(text);
  } catch {
    return {};
  }
}

// ─── Project trust ──────────────────────────────────────────────────────────

/** CLI flags pi uses to force the decision; parsing stops at "--", like pi's. */
function readTrustOverride(): boolean | undefined {
  let override: boolean | undefined;
  for (const arg of process.argv.slice(2)) {
    if (arg === "--") break;
    if (arg === "--approve" || arg === "-a") override = true;
    else if (arg === "--no-approve" || arg === "-na") override = false;
  }
  return override;
}

/**
 * Project env files are not on pi's list of trust-requiring resources, so add
 * them here: a project that can change our env vars should need a trust decision
 * even when it ships nothing else that pi gates on.
 */
function hasProjectEnvFiles(cwd: string): boolean {
  return existsSync(join(cwd, ".env")) || existsSync(join(cwd, ".env.local"));
}

/**
 * Mirrors pi's resolveProjectTrusted() from outside the runtime: a project
 * without trust-requiring resources is trusted, otherwise the --approve/
 * --no-approve override wins, then the nearest saved trust.json entry (pi walks
 * up parent folders), then defaultProjectTrust ("always" trusts; "never" and "ask"
 * decline). Never prompts, so a project pi gates on cannot inject or override
 * e.g. LITELLM_API_KEY via its .env.local.
 */
function resolveProjectTrust(cwd: string, home: string): boolean {
  if (!hasTrustRequiringProjectResources(cwd) && !hasProjectEnvFiles(cwd)) return true;
  const override = readTrustOverride();
  if (override !== undefined) return override;
  const saved = readTrustStoreEntry(cwd, home);
  if (saved !== null) return saved;
  return readDefaultProjectTrust(home) === "always";
}

/** Nearest saved decision, walking up like pi's findNearestTrustEntry(). */
function readTrustStoreEntry(cwd: string, home: string): boolean | null {
  try {
    const data = JSON.parse(
      readFileSync(join(home, ".pi", "agent", "trust.json"), "utf-8"),
    ) as Record<string, unknown>;
    let dir = cwd;
    while (true) {
      const decision = data[dir];
      if (decision === true || decision === false) return decision;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/** Global defaultProjectTrust, normalized like pi's getDefaultProjectTrust(). */
function readDefaultProjectTrust(home: string): "always" | "never" | "ask" {
  try {
    const data = JSON.parse(
      readFileSync(join(home, ".pi", "agent", "settings.json"), "utf-8"),
    ) as { defaultProjectTrust?: string };
    const value = data?.defaultProjectTrust;
    return value === "always" || value === "never" ? value : "ask";
  } catch {
    return "ask";
  }
}

// ─── Injection marker ──────────────────────────────────────────────────────

/**
 * Env var holding a JSON object of {KEY: sha256(value)[0..16]} for every variable
 * this extension has written itself.
 *
 * The factory can run more than once inside a single process: `/reload`,
 * `ctx.reload()`, session switches (new/resume/fork), and nested pi processes
 * started from a pty shell all inherit our own output in process.env. Without the
 * marker those values would look like real shell variables and could never be
 * updated. A key therefore counts as "from the shell" only while its current value
 * differs from the recorded hash — our own values stay overridable, while a value
 * the user re-exported in a nested shell keeps winning. Only hashes are stored, so
 * no secret values are duplicated into child environments.
 */
const INJECTED_KEYS_ENV = "__PI_ENV_INJECTOR_KEYS";

function readInjectedKeys(): Map<string, string> {
  try {
    const parsed: unknown = JSON.parse(process.env[INJECTED_KEYS_ENV] ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return new Map();
  }
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// ─── Extension factory ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cwd = process.cwd();

  // Variables present before any file is read come from the real shell (or from
  // pi itself) and are the highest priority: file-based sources may add new
  // variables but never overwrite these. The one exception is a key still holding
  // the exact value this extension wrote earlier (see INJECTED_KEYS_ENV) — that is
  // our own output being seen again after /reload, a session switch, or in a nested
  // pi process, so it stays overridable. Windows env lookups are case-insensitive.
  const caseInsensitive = process.platform === "win32";
  const norm = (key: string): string => (caseInsensitive ? key.toUpperCase() : key);
  // Starts as what we wrote on an earlier run in this process (or in a parent
  // pi), and grows as the merge loop below writes more. A key is ours while it
  // still holds the value recorded here, so a later tier can override an earlier
  // one while a genuinely exported value stays protected.
  const injected = new Map(
    [...readInjectedKeys()].map(([key, hash]) => [norm(key), hash]),
  );
  const isShellVar = (key: string): boolean => {
    const current = process.env[key];
    if (current === undefined) return false;
    return injected.get(norm(key)) !== hashValue(current);
  };

  // Project tiers are only honored for trusted projects (see resolveProjectTrust).
  const projectTrusted = resolveProjectTrust(cwd, home);

  // File sources in priority order: later overrides earlier. Shell env sits
  // above all of them and wins by being skipped, not by being re-applied.
  type EnvSource = { label: string; vars: Record<string, string> };
  const globalSources: EnvSource[] = [
    // Tier 1: global Pi settings
    { label: "~/.pi/agent/settings.json", vars: loadSettingsEnv(join(home, ".pi", "agent", "settings.json")) },
    // Tier 2: global dotenv (overrides settings.json)
    { label: "~/.pi/agent/.env",          vars: loadDotenvFile(join(home, ".pi", "agent", ".env")) },
    // Tier 3: global dotenv local overrides
    { label: "~/.pi/agent/.env.local",    vars: loadDotenvFile(join(home, ".pi", "agent", ".env.local")) },
  ];
  const projectSources: EnvSource[] = [
    // Tier 4: per-project Pi settings
    { label: ".pi/settings.json", vars: loadSettingsEnv(join(cwd, ".pi", "settings.json")) },
    // Tier 5: project defaults
    { label: ".env",              vars: loadDotenvFile(join(cwd, ".env")) },
    // Tier 6: local overrides (highest file tier)
    { label: ".env.local",        vars: loadDotenvFile(join(cwd, ".env.local")) },
  ];

  // Apply file sources in priority order, skipping anything the shell already
  // set. Expansion reads the live process.env, so a skipped key resolves to the
  // shell value in later tiers rather than to a value that never took effect.
  const applySources = (sources: EnvSource[]): void => {
    for (const source of sources) {
      for (const [key, value] of Object.entries(source.vars)) {
        if (isShellVar(key)) continue;
        const expanded = expandVars(value);
        process.env[key] = expanded;
        injected.set(norm(key), hashValue(expanded));
      }
    }
  };

  // Record what we wrote so the next run in this process (or a nested pi) can
  // tell our output apart from a real shell variable. Keys we wrote before but no
  // longer define stay listed, so a stale value remains overridable if it returns.
  const flushMarker = (): void => {
    if (injected.size > 0) {
      process.env[INJECTED_KEYS_ENV] = JSON.stringify(Object.fromEntries(injected));
    }
  };

  applySources(globalSources);
  flushMarker();

  if (projectTrusted) {
    applySources(projectSources);
    flushMarker();
  } else {
    // A project trusted only by an interactive answer is not recognizable yet: pi
    // loads extensions once to ask (with project trust forced off), then reloads
    // them with the decision. A remembered answer is already in trust.json by that
    // second pass, so the factory above sees it; a session-only answer is not, so
    // re-check before the first turn runs.
    pi.on("session_start", (_event, ctx) => {
      if (!ctx.isProjectTrusted()) return;
      applySources(projectSources);
      flushMarker();
    });
  }
}
