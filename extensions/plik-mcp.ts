/**
 * plik-mcp — registers the Plik MCP server only when it is configured.
 *
 * Pi spawns every enabled mcp.json entry at session start, so an unconfigured
 * server shows "MCP servers need attention" on every launch. Registering from here
 * instead keeps Pi from spawning it until PLIK_URL and PLIK_TOKEN are set.
 *
 * The command is bin/plik-mcp, which generates a throwaway plikrc from those two
 * values, so the API token stays in .env.local instead of a second config file.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  if (!process.env.PLIK_URL || !process.env.PLIK_TOKEN) return;

  pi.registerMcpServer("plik", {
    command: resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "plik-mcp"),
    exposure: "codemode",
    description: "Upload files or text snippets to self hosted sharing service",
  });
}
