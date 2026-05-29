/**
 * _env-injector — injects settings.json "env" block into process.env
 *
 * Loads before other extensions (sorted first alphabetically), reads both
 * global and project settings files, and applies their "env" values to
 * process.env. Values undergo shell-like variable expansion so that
 * "$VAR", "${VAR}", and "$$" work as expected.
 *
 * Priority (later overrides earlier):
 *   1. Already-set process.env values (actual shell env vars)
 *   2. ~/.pi/agent/settings.json  "env" block
 *   3. .pi/settings.json          "env" block
 *
 * Within each file, keys are applied in JSON iteration order.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Variable expansion ─────────────────────────────────────────────────────

/**
 * Expand $VAR, ${VAR}, and $$ references in a string using the current
 * process.env. Unknown variables are left as-is (e.g. "$UNDEFINED" stays
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
        // No closing brace — leave as-is
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

    // Not a valid variable — emit the $ literally
    result += "$";
  }

  return result;
}

// ─── Settings reader ────────────────────────────────────────────────────────

interface SettingsFile {
  path: string;
  env: Record<string, string>;
}

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

// ─── Extension factory ──────────────────────────────────────────────────────

export default function (_pi: ExtensionAPI): void {
  const home = process.env.HOME || process.env.USERPROFILE || "";

  const files: SettingsFile[] = [
    {
      path: join(home, ".pi", "agent", "settings.json"),
      env: {},
    },
    {
      path: join(process.cwd(), ".pi", "settings.json"),
      env: {},
    },
  ];

  // Load env blocks, later files override earlier ones
  const merged: Record<string, string> = {};

  for (const file of files) {
    const vars = loadSettingsEnv(file.path);
    for (const [key, value] of Object.entries(vars)) {
      merged[key] = value;
    }
  }

  // Apply to process.env (actual shell env vars already in place — we never
  // unset them; these only fill in what's missing or override empties).
  for (const [key, value] of Object.entries(merged)) {
    // Only set if not already present in the real environment, so actual
    // shell exports / .profile variables always win.
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  console.error(
    `[_env-injector] injected ${Object.keys(merged).length} env var(s) from settings.json`,
  );
}
