/**
 * _install-deps — Auto-install npm dependencies for sibling extensions.
 *
 * Scans the extensions/ directory for subdirectories with a package.json
 * and runs `npm install` in them if node_modules is missing or incomplete.
 *
 * The underscore prefix ensures this loads first (alphabetically), and
 * the async factory ensures pi awaits completion before loading other
 * extensions — so node_modules/ is ready when they need it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default async function (_pi: ExtensionAPI) {
  const extensionsDir = dirname(fileURLToPath(import.meta.url));

  const entries = readdirSync(extensionsDir, { withFileTypes: true });

  for (const entry of entries) {
    // Only process sibling directories, skip hidden/internal ones
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules") continue;

    const dirPath = join(extensionsDir, entry.name);
    const pkgJsonPath = join(dirPath, "package.json");
    if (!existsSync(pkgJsonPath)) continue;

    const nmPath = join(dirPath, "node_modules");

    if (existsSync(nmPath)) {
      // Quick verification: every declared dep has its module in node_modules
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const allPresent = Object.keys(allDeps).every((dep) =>
        existsSync(join(nmPath, dep)),
      );
      if (allPresent) continue;
    }

    try {
      execSync("npm install --no-audit --no-fund", {
        cwd: dirPath,
        stdio: "pipe",
        timeout: 120_000,
      });
      console.error(`[install-deps] Installed dependencies for ${entry.name}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[install-deps] Failed for ${entry.name}: ${msg}`);
    }
  }
}
