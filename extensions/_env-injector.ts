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
 * Values from JSON settings undergo shell-like variable expansion so that
 * "$VAR", "${VAR}", and "$$" work as expected.  .env files are parsed as
 * plain KEY=VALUE lines (no expansion).
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

// ─── Variable expansion (settings.json values only) ─────────────────────────

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
      result[key] = expandVars(String(value));
    }
    return result;
  } catch {
    return {};
  }
}

// ─── .env file parser ───────────────────────────────────────────────────────

/**
 * Parse a standard .env file (KEY=VALUE lines).
 *
 * Handles:
 *   - `#` line comments
 *   - Inline comments (`#` after value, respecting quotes)
 *   - `export KEY=VALUE` (strips the export keyword)
 *   - Single- and double-quoted values (quotes stripped, no interpolation)
 *   - Unquoted values (trimmed, comment-stripped)
 *   - Leading/trailing whitespace trimming
 *   - Empty lines
 *
 * Does NOT do shell-like expansion inside values (unlike the settings.json
 * loader above).  This matches the standard dotenv convention.
 */
function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (line === "" || line.startsWith("#")) continue;

    // Strip optional `export` prefix
    const exportMatch = line.match(/^export\s+/);
    const body = exportMatch ? line.slice(exportMatch[0].length).trimStart() : line;

    // Find the first `=` separator
    const eqIdx = body.indexOf("=");
    if (eqIdx === -1) continue; // no value — skip

    const key = body.slice(0, eqIdx).trim();
    if (!key) continue; // empty key — skip

    // Parse the value part after `=`, respecting quotes and inline comments.
    // Walk character-by-character so we know when we're inside quotes and thus
    // can distinguish inline `#` (comment) from a `#` inside a quoted string.
    const rawPart = body.slice(eqIdx + 1);
    let value = "";
    let quoteChar: string | null = null;
    let escaped = false;

    for (let i = 0; i < rawPart.length; i++) {
      const ch = rawPart[i];

      if (escaped) {
        value += ch;
        escaped = false;
        continue;
      }

      if (ch === "\\" && quoteChar === '"') {
        // Backslash-escape only inside double quotes (bash convention)
        escaped = true;
        continue;
      }

      if (ch === "\\" && quoteChar === "'") {
        // Inside single quotes, backslash is literal
        value += ch;
        continue;
      }

      if (quoteChar) {
        if (ch === quoteChar) {
          quoteChar = null; // close quote
        } else {
          value += ch;
        }
        continue;
      }

      // Not inside quotes
      if (ch === "'" || ch === '"') {
        quoteChar = ch; // open quote
        continue;
      }

      if (ch === "#") {
        // Unquoted `#` starts an inline comment — stop here.
        break;
      }

      value += ch;
    }

    // After parsing, trim whitespace from unquoted values
    if (!quoteChar) {
      value = value.trim();
    }

    result[key] = value;
  }

  return result;
}

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

  // Start with current process.env as the base
  const merged: Record<string, string> = {};
  for (const key of Object.keys(process.env)) {
    if (process.env[key] !== undefined) merged[key] = process.env[key]!;
  }

  for (const source of sources) {
    for (const [key, value] of Object.entries(source.vars)) {
      merged[key] = value;
    }
  }

  // Apply everything back — higher tiers freely override lower ones
  for (const [key, value] of Object.entries(merged)) {
    process.env[key] = value;
  }
}
