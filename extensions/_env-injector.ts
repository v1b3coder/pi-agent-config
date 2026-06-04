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
 *    (lowest)  1.  Actual shell / .profile env vars
 *             2.  ~/.pi/agent/settings.json  "env"   (global Pi settings)
 *             3.  ~/.pi/agent/.env                   (global dotenv)
 *             4.  ~/.pi/agent/.env.local             (global dotenv local)
 *             5.  .pi/settings.json          "env"   (per-project Pi settings)
 *             6.  $cwd/.env                          (project defaults)
 *    (highest) 7.  $cwd/.env.local                    (local overrides)
 *
 * Within each source, keys are applied in iteration / line order.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// ─── Extension factory ──────────────────────────────────────────────────────

export default function (_pi: ExtensionAPI): void {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const cwd = process.cwd();

  // Sources in priority order: later overrides earlier.
  // Actual shell env vars are the base (tier 1).
  const sources: Array<{ label: string; vars: Record<string, string> }> = [
    // Tier 2: global Pi settings
    { label: "~/.pi/agent/settings.json", vars: loadSettingsEnv(join(home, ".pi", "agent", "settings.json")) },
    // Tier 3: global dotenv (overrides settings.json)
    { label: "~/.pi/agent/.env",          vars: loadDotenvFile(join(home, ".pi", "agent", ".env")) },
    // Tier 4: global dotenv local overrides
    { label: "~/.pi/agent/.env.local",    vars: loadDotenvFile(join(home, ".pi", "agent", ".env.local")) },
    // Tier 5: per-project Pi settings
    { label: ".pi/settings.json",         vars: loadSettingsEnv(join(cwd, ".pi", "settings.json")) },
    // Tier 6: project defaults
    { label: ".env",                      vars: loadDotenvFile(join(cwd, ".env")) },
    // Tier 7: local overrides (highest)
    { label: ".env.local",                vars: loadDotenvFile(join(cwd, ".env.local")) },
  ];

  // Apply sources in priority order.
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.vars)) {
      process.env[key] = expandVars(value);
    }
  }
}
