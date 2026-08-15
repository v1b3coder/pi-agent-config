/**
 * litellm — minimal LiteLLM proxy provider for Pi.
 *
 * From-scratch, trimmed-down replacement for the npm package
 * `pi-provider-litellm` (https://github.com/balcsida/pi-provider-litellm,
 * https://www.npmjs.com/package/pi-provider-litellm, author balcsida) that
 * this setup previously loaded from `settings.json` → `packages`.
 *
 * ── Reasoning ─────────────────────────────────────────────────────────────
 * The original is a general-purpose integration (~2.4k lines) covering SSO
 * login with virtual-key generation, gcloud ADC token exchange, `!command`
 * API-key helpers, multi-provider aliases, LiteLLM MCP REST tools, the
 * Skills Gateway (incl. system-prompt injection), models.dev metadata
 * enrichment (external "call home"), a `/health` discovery fallback for
 * ancient proxies, per-model request hacks for Moonshot/gpt-5.5/Gemini
 * routes, cost extraction from `x-litellm-response-cost`, and — the final
 * straw — an HTTPS-only enforcement in `normalizeBaseUrl` that throws at
 * startup for plain-http LAN proxies.
 *
 * This machine only runs DeepSeek/Qwen/vLLM routes behind a LiteLLM proxy
 * on the local network, authenticated with one static API key. None of the
 * above applies, so this rewrite keeps only:
 *
 *   • provider registration under `litellm` (openai-completions /
 *     openai-responses) — same model ids as before, so `enabledModels` and
 *     the `defaultProvider` in settings.json keep working;
 *   • model discovery via GET /model/info (rich metadata: pricing, context
 *     window, reasoning flags, vision), falling back to GET /v1/models only
 *     when /model/info returns 401/403/404 (LiteLLM virtual keys);
 *   • metadata enrichment from pi's *bundled* catalog only (local data).
 *     No network calls beyond the proxy itself;
 *   • per-request auth via pi's native `$LITELLM_API_KEY` resolution —
 *     stored `/login` credentials and `--api-key` keep working for free;
 *   • `models.json` modelOverrides (e.g. the deepseek thinkingFormat) still
 *     apply on top, composed by pi itself.
 *
 * Deliberately dropped / behavioral differences:
 *   • no HTTPS policing — the proxy is on a LAN and may be plain http;
 *   • no models.dev fetch, no gcloud/SSO/auth-helper machinery;
 *   • no /health fallback path for old LiteLLM versions;
 *   • no `x-litellm-response-cost` hook — pricing already arrives via
 *     /model/info `*_cost_per_token` fields, so pi's native cost
 *     calculation gives the same numbers; the header hook was redundant;
 *   • no `cacheControlFormat: "anthropic"` compat — no Claude routes here.
 *
 * Trade-off: models are registered statically at startup (discovery is one
 * fast LAN request, 5 s timeout). There is no offline model cache — if the
 * proxy is unreachable when pi starts, the provider is registered without
 * models; run /reload once the proxy is back. If a Claude route is ever
 * added through this proxy, add the anthropic compat flag back.
 */
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "litellm";
const ENV_BASE_URL = "LITELLM_BASE_URL";
const ENV_API_KEY = "LITELLM_API_KEY";
const DISCOVERY_TIMEOUT_MS = 5000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

// ─── small helpers ─────────────────────────────────────────────────────────

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" ? trimmed : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Strip trailing slashes and an optional `/v1` suffix. No scheme policing:
 *  the proxy sits on the local network and may serve plain HTTP. */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1\/?$/i, "");
}

type LmModel = {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat: { supportsStore: false };
  api?: "openai-completions" | "openai-responses";
};

// ─── catalog lookup (bundled models.dev snapshot inside pi-ai — local) ─────

function findCatalogModel(id: string) {
  const unprefixed = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const candidates = new Set([id, unprefixed]);
  for (const provider of getProviders()) {
    const models = getModels(provider);
    for (const candidate of candidates) {
      const match = models.find((model) => model.id === candidate || model.id === `${provider}/${candidate}`);
      if (match) return match;
    }
  }
  return undefined;
}

// ─── discovery ─────────────────────────────────────────────────────────────

async function fetchJson(url: string, apiKey: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)])
      : AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) return { ok: false as const, status: response.status, data: undefined };
  return { ok: true as const, status: response.status, data: (await response.json()) as Record<string, any> };
}

/** /model/info entries: per-token pricing, context window, reasoning flags. */
function mapModelInfoEntry(entry: any): LmModel | undefined {
  const id = typeof entry?.model_name === "string" ? entry.model_name : undefined;
  if (!id) return undefined;
  const info = entry.model_info ?? {};
  const mode = typeof info.mode === "string" ? info.mode : undefined;
  if (mode !== undefined && !/^chat$/i.test(mode) && !/^responses$/i.test(mode)) return undefined;
  const catalog = findCatalogModel(id);

  // supports_*_reasoning_effort booleans → pi thinking-level map (null = unsupported)
  const effortFlags: Array<[level: string, flag: string]> = [
    ["off", "none"],
    ["minimal", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
  ];
  const efforts: Record<string, string | null> = {};
  let hasEfforts = false;
  for (const [level, flag] of effortFlags) {
    const supported = bool(info[`supports_${flag}_reasoning_effort`]);
    if (supported === undefined) continue;
    hasEfforts = true;
    efforts[level] = supported ? flag : null;
  }
  const thinkingLevelMap =
    catalog?.thinkingLevelMap || hasEfforts ? { ...catalog?.thinkingLevelMap, ...efforts } : undefined;

  return {
    id,
    name: id,
    reasoning: bool(info.supports_reasoning) ?? false,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: bool(info.supports_vision) ? ["text", "image"] : ["text"],
    cost: {
      input: (num(info.input_cost_per_token) ?? catalog?.cost?.input ?? 0) * 1_000_000,
      output: (num(info.output_cost_per_token) ?? catalog?.cost?.output ?? 0) * 1_000_000,
      cacheRead: (num(info.cache_read_input_token_cost) ?? catalog?.cost?.cacheRead ?? 0) * 1_000_000,
      cacheWrite: (num(info.cache_creation_input_token_cost) ?? catalog?.cost?.cacheWrite ?? 0) * 1_000_000,
    },
    contextWindow: num(info.max_input_tokens) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: num(info.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
    compat: { supportsStore: false },
    ...(/^responses$/i.test(mode ?? "") ? { api: "openai-responses" as const } : {}),
  };
}

/** /v1/models entries (fallback for 401/403/404 on /model/info): sparse — fill from catalog. */
function mapModelsListEntry(entry: any): LmModel | undefined {
  const id = typeof entry?.id === "string" ? entry.id : undefined;
  if (!id) return undefined;
  const catalog = findCatalogModel(id);
  return {
    id,
    name: catalog?.name ?? `${id} (no metadata)`,
    reasoning: catalog?.reasoning ?? false,
    thinkingLevelMap: catalog?.thinkingLevelMap,
    input: catalog?.input ?? ["text"],
    cost: catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: catalog?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: catalog?.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: { supportsStore: false },
  };
}

async function discoverModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<LmModel[]> {
  const info = await fetchJson(`${baseUrl}/model/info`, apiKey, signal);
  if (info.ok) {
    const entries = Array.isArray(info.data?.data) ? info.data.data : [];
    // Wildcard rows ("lemonade/*") are not usable model ids — drop them.
    return entries.map(mapModelInfoEntry).filter((model): model is LmModel => model !== undefined && !model.id.includes("*"));
  }
  if (![401, 403, 404].includes(info.status)) {
    throw new Error(`/model/info returned HTTP ${info.status}`);
  }
  const list = await fetchJson(`${baseUrl}/v1/models`, apiKey, signal);
  if (!list.ok) throw new Error(`/v1/models returned HTTP ${list.status}`);
  const entries = Array.isArray(list.data?.data) ? list.data.data : [];
  return entries.map(mapModelsListEntry).filter((model): model is LmModel => model !== undefined);
}

// ─── extension factory ─────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI): Promise<void> {
  const base = clean(process.env[ENV_BASE_URL]);
  const key = clean(process.env[ENV_API_KEY]);

  if (!base || !key) {
    process.stderr.write(
      `litellm: set ${ENV_BASE_URL} and ${ENV_API_KEY} (see ~/.pi/agent/.env.local) and run /reload to enable the LiteLLM provider.`,
    );
    return;
  }

  const root = normalizeBaseUrl(base);
  let models: LmModel[] = [];
  try {
    models = await discoverModels(root, key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `litellm: model discovery failed (${message}); provider registered without models — run /reload once the proxy is reachable.\n`,
    );
  }

  pi.registerProvider(PROVIDER, {
    name: "LiteLLM",
    baseUrl: `${root}/v1`,
    apiKey: `$${ENV_API_KEY}`, // pi resolves this per request; /login + --api-key work natively
    api: "openai-completions",
    models,
  });
}
