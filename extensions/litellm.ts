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
 * fast LAN request, 5 s timeout, retried once). If live discovery fails, the
 * provider falls back to the last successful model list cached in
 * `litellm-cache.json` in the agent dir — delete that file to force a clean
 * fetch. If a Claude route is ever added through this proxy, add the
 * anthropic compat flag back.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "litellm";
const ENV_BASE_URL = "LITELLM_BASE_URL";
const ENV_API_KEY = "LITELLM_API_KEY";
const ENV_MAX_VLLM_OUTPUT_TOKENS = "LITELLM_MAX_VLLM_OUTPUT_TOKENS";
const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_ATTEMPTS = 2; // one retry: a single LAN/DNS hiccup must not empty the model list
const RETRY_DELAY_MS = 500;
const CACHE_FILE = "litellm-cache.json";
const CACHE_VERSION = 1;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const DEFAULT_VLLM_MAX_OUTPUT_TOKENS = 65_536;

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

/** Optional env override for the per-turn output cap on vLLM-style routes. */
function configuredMaxOutputTokens(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** vLLM mirrors max_model_len — one combined input+output budget — into both
 *  max_input_tokens and max_output_tokens. Advertised literally, max_output_tokens
 *  makes pi request ~all remaining context and overshoot the real budget by its
 *  token-counting error → hard 400s on large sessions. Cap it instead; contextWindow
 *  stays untouched (still correct for compaction). Detected via litellm_provider, or
 *  via mirrored budgets (max_input_tokens present and output >= input) as a heuristic. */
function vllmCappedMaxTokens(modelInfo: Record<string, any>, advertised: number, cap: number): number {
  const maxInput = num(modelInfo.max_input_tokens);
  const isVllmStyle = modelInfo.litellm_provider === "hosted_vllm" || (maxInput !== undefined && advertised >= maxInput);
  return isVllmStyle ? Math.min(advertised, cap) : advertised;
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

/** fetchJson with a bounded retry: transient failures (network errors,
 *  timeouts, HTTP 5xx) get one more attempt; 4xx responses are terminal. */
async function fetchJsonWithRetry(url: string, apiKey: string, signal?: AbortSignal) {
  let lastError: Error = new Error("no attempt made");
  for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
    try {
      const result = await fetchJson(url, apiKey, signal);
      if (result.ok || result.status < 500) return result;
      lastError = new Error(`HTTP ${result.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    if (attempt < DISCOVERY_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  throw lastError;
}

/** /model/info entries: per-token pricing, context window, reasoning flags. */
function mapModelInfoEntry(entry: any, vllmMaxOutputTokens: number): LmModel | undefined {
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
    maxTokens: vllmCappedMaxTokens(info, num(info.max_output_tokens) ?? DEFAULT_MAX_TOKENS, vllmMaxOutputTokens),
    compat: { supportsStore: false },
    ...(/^responses$/i.test(mode ?? "") ? { api: "openai-responses" as const } : {}),
  };
}

/** /v1/models entries (fallback for 401/403/404 on /model/info): sparse — fill from catalog. */
function mapModelsListEntry(entry: any, vllmMaxOutputTokens: number): LmModel | undefined {
  const id = typeof entry?.id === "string" ? entry.id : undefined;
  if (!id) return undefined;
  const catalog = findCatalogModel(id);
  const info = entry?.model_info ?? {};
  const advertised = num(info.max_output_tokens) ?? catalog?.maxTokens ?? DEFAULT_MAX_TOKENS;
  return {
    id,
    name: catalog?.name ?? `${id} (no metadata)`,
    reasoning: catalog?.reasoning ?? false,
    thinkingLevelMap: catalog?.thinkingLevelMap,
    input: catalog?.input ?? ["text"],
    cost: catalog?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: catalog?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: vllmCappedMaxTokens(info, advertised, vllmMaxOutputTokens),
    compat: { supportsStore: false },
  };
}

async function discoverModels(
  baseUrl: string,
  apiKey: string,
  vllmMaxOutputTokens: number,
  signal?: AbortSignal,
): Promise<LmModel[]> {
  const info = await fetchJsonWithRetry(`${baseUrl}/model/info`, apiKey, signal);
  if (info.ok) {
    const entries = Array.isArray(info.data?.data) ? info.data.data : [];
    // Wildcard rows ("lemonade/*") are not usable model ids — drop them.
    return entries.map((entry) => mapModelInfoEntry(entry, vllmMaxOutputTokens)).filter((model): model is LmModel => model !== undefined && !model.id.includes("*"));
  }
  if (![401, 403, 404].includes(info.status)) {
    throw new Error(`/model/info returned HTTP ${info.status}`);
  }
  const list = await fetchJsonWithRetry(`${baseUrl}/v1/models`, apiKey, signal);
  if (!list.ok) throw new Error(`/v1/models returned HTTP ${list.status}`);
  const entries = Array.isArray(list.data?.data) ? list.data.data : [];
  return entries.map((entry) => mapModelsListEntry(entry, vllmMaxOutputTokens)).filter((model): model is LmModel => model !== undefined);
}

// ─── disk cache (last successful discovery, keyed by proxy URL) ────────────

type CachedModels = {
  version: typeof CACHE_VERSION;
  baseUrl: string;
  vllmMaxOutputTokens: number;
  fetchedAt: string;
  models: LmModel[];
};

/** Fallback used only when live discovery fails; stale entries are harmless
 *  because a fresh fetch always wins on the next start. */
function readModelCache(baseUrl: string, vllmMaxOutputTokens: number): LmModel[] | undefined {
  try {
    const cached = JSON.parse(readFileSync(join(getAgentDir(), CACHE_FILE), "utf-8")) as Partial<CachedModels>;
    if (
      cached.version !== CACHE_VERSION ||
      cached.baseUrl !== baseUrl ||
      cached.vllmMaxOutputTokens !== vllmMaxOutputTokens ||
      !Array.isArray(cached.models) ||
      cached.models.length === 0
    ) {
      return undefined;
    }
    return cached.models as LmModel[];
  } catch {
    return undefined; // missing or unreadable — start without models
  }
}

function writeModelCache(baseUrl: string, vllmMaxOutputTokens: number, models: LmModel[]): void {
  if (models.length === 0) return; // never clobber a good cache with an empty list
  try {
    const cached: CachedModels = {
      version: CACHE_VERSION,
      baseUrl,
      vllmMaxOutputTokens,
      fetchedAt: new Date().toISOString(),
      models,
    };
    writeFileSync(join(getAgentDir(), CACHE_FILE), `${JSON.stringify(cached, null, 2)}\n`, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`litellm: could not write model cache (${message})\n`);
  }
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
  const vllmMaxOutputTokens = configuredMaxOutputTokens(
    process.env[ENV_MAX_VLLM_OUTPUT_TOKENS],
    DEFAULT_VLLM_MAX_OUTPUT_TOKENS,
  );
  let models: LmModel[] = [];
  try {
    models = await discoverModels(root, key, vllmMaxOutputTokens);
    writeModelCache(root, vllmMaxOutputTokens, models);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    models = readModelCache(root, vllmMaxOutputTokens) ?? [];
    if (models.length > 0) {
      process.stderr.write(
        `litellm: live model discovery failed (${message}); using ${models.length} cached models (${CACHE_FILE} in the agent dir) — delete the file to force a clean fetch.\n`,
      );
    } else {
      process.stderr.write(
        `litellm: model discovery failed (${message}); provider registered without models — run /reload once the proxy is reachable.\n`,
      );
    }
  }

  pi.registerProvider(PROVIDER, {
    name: "LiteLLM",
    baseUrl: `${root}/v1`,
    apiKey: `$${ENV_API_KEY}`, // pi resolves this per request; /login + --api-key work natively
    api: "openai-completions",
    models,
  });
}
