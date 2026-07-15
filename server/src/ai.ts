import { spawnSync } from "node:child_process";
import { getActiveProject, projectStore } from "./projects.js";

/** Where model access comes from. */
export type Provider = "nexotao" | "claude";

/**
 * AI provider config. Default provider is Nexotao (https://nexotao.com) — an
 * Anthropic-compatible gateway. The user supplies a Nexotao API key (sk-nexo-…)
 * and picks a model; requests route to Nexotao's /v1/messages via the Claude
 * Agent SDK by setting ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY per call.
 */

export interface ModelInfo {
  id: string;
  name: string;
  series: "claude" | "gpt" | "grok" | "deepseek";
  recommended: boolean;
  vision: boolean;
}

// Nexotao catalog (GET https://api.nexotao.com/models). Claude series recommended —
// they're native Anthropic models, so Claude Code's tool-use / agent features work fully.
export const MODELS: ModelInfo[] = [
  { id: "claude-opus-4-8", name: "Claude Opus 4.8", series: "claude", recommended: true, vision: true },
  { id: "claude-opus-4-7", name: "Claude Opus 4.7", series: "claude", recommended: true, vision: true },
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", series: "claude", recommended: true, vision: true },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", series: "claude", recommended: true, vision: true },
  { id: "gpt-5-mini", name: "GPT-5 Mini", series: "gpt", recommended: false, vision: true },
  { id: "grok-4.3", name: "Grok 4.3", series: "grok", recommended: false, vision: false },
  { id: "DeepSeek-V4-Pro", name: "DeepSeek V4 Pro", series: "deepseek", recommended: false, vision: false },
  { id: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash", series: "deepseek", recommended: false, vision: false },
];

export const DEFAULT_MODEL = "claude-opus-4-8";
export const NEXOTAO_BASE_URL = process.env.NEXOTAO_BASE_URL || "https://api.nexotao.com";

const API_KEY_SETTING = "nexotao_api_key";
const PROVIDER_SETTING = "ai_provider";
let apiKeyCache: string | null = null;
let providerCache: Provider = "nexotao";

export async function initAi() {
  apiKeyCache = await projectStore.getSetting(API_KEY_SETTING);
  providerCache = (await projectStore.getSetting(PROVIDER_SETTING)) === "claude" ? "claude" : "nexotao";
  const detail =
    providerCache === "claude"
      ? `local Claude Code (${claudeAvailable() ? "detected" : "CLI not found on PATH"})`
      : apiKeyCache ? "Nexotao (key set)" : "Nexotao (no key yet)";
  console.log(`[ai] provider: ${detail}`);
}

export function getProvider(): Provider {
  return providerCache;
}
export async function setProvider(p: Provider) {
  providerCache = p === "claude" ? "claude" : "nexotao";
  await projectStore.setSetting(PROVIDER_SETTING, providerCache);
}

export function hasApiKey(): boolean {
  return Boolean(apiKeyCache);
}

/** Is the provider usable so onboarding/first-run can proceed? */
export function providerReady(): boolean {
  return providerCache === "claude" || Boolean(apiKeyCache);
}

/** Is the local `claude` CLI installed (for the Claude Code adapter)? */
export function claudeAvailable(): boolean {
  try {
    return spawnSync("claude", ["--version"], { stdio: "ignore", timeout: 4000 }).status === 0;
  } catch {
    return false;
  }
}

/** Masked key for display, e.g. sk-nexo-…a1b2. */
export function maskedApiKey(): string | null {
  if (!apiKeyCache) return null;
  return apiKeyCache.length > 10 ? `${apiKeyCache.slice(0, 8)}…${apiKeyCache.slice(-4)}` : "set";
}
export async function setApiKey(key: string) {
  apiKeyCache = key.trim();
  await projectStore.setSetting(API_KEY_SETTING, apiKeyCache);
}

/**
 * Provider-routing env vars set by other tools (Bedrock/Vertex/Azure Foundry,
 * custom gateways, model remaps). If the host shell — or the operator's global
 * `~/.claude/settings.json` — sets these, they'd hijack our spawned agent and
 * override the Nexotao key. We strip them so the agent talks ONLY to Nexotao.
 */
// Vars that route Claude Code to a NON-Anthropic or custom gateway (Bedrock/
// Vertex/Foundry, a proxy base URL, model remaps). Stripped for both providers
// so neither Nexotao nor the local Claude Code adapter gets hijacked. Note this
// list intentionally does NOT include ANTHROPIC_API_KEY — the Claude adapter may
// legitimately use a host ANTHROPIC_API_KEY.
const PROVIDER_ROUTER_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
];

/**
 * Nexotao Orce's OWN operational env — its server port, runtime mode, storage,
 * and secrets. These must NEVER reach the agent's shell: a dev server the agent
 * runs (Next.js/Vite/CRA all read PORT) would otherwise bind to Nexotao's port
 * (8787) instead of its own default, and secrets/DB creds would leak into the
 * user's subprocesses.
 */
const OPERATIONAL_ENV_KEYS = [
  "PORT",
  "NODE_ENV",
  "APP_PASSWORD",
  "JWT_SECRET",
  "DATABASE_URL",
  "NEXOTAO_DB",
  "NEXOTAO_DATA",
  "NEXOTAO_BASE_URL",
  "NEXOTAO_RESET_PASSWORD",
  "PERMISSION_MODE",
  "GRAPH_ENABLED",
  "AGENT_CWD",
];

/**
 * Build the environment for a spawned agent.
 * 1. ALWAYS strip Nexotao's own operational vars + secrets (PORT, NODE_ENV, DB,
 *    passwords) so the agent's tools run in a clean, normal shell.
 * 2. When a Nexotao key is set, take control of provider routing: strip any
 *    inherited hijackers and force Nexotao. With no key, leave provider auth
 *    alone so the operator's own `claude` CLI login still works.
 */
export function buildAgentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  for (const k of OPERATIONAL_ENV_KEYS) delete env[k];

  // An EMPTY ANTHROPIC_API_KEY (the launcher passes "" when the operator has no
  // key) would make the Claude CLI try an invalid empty key instead of falling
  // back to the subscription login. Drop it so local Claude Code auth works.
  if (env.ANTHROPIC_API_KEY === "") delete env.ANTHROPIC_API_KEY;

  if (providerCache === "nexotao" && apiKeyCache) {
    // Nexotao: take full control — strip any provider hijackers and route
    // through the gateway with the stored key (see also settingSources: [] on
    // the query, so ~/.claude settings can't re-inject a provider).
    for (const k of PROVIDER_ROUTER_KEYS) delete env[k];
    delete env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_BASE_URL = NEXOTAO_BASE_URL;
    env.ANTHROPIC_API_KEY = apiKeyCache;
  }
  // Claude Code adapter: leave the machine's own Claude config UNTOUCHED
  // (subscription login, host API key, or even Bedrock/Vertex/Foundry) so it
  // connects exactly like running `claude` in the terminal. Only Nexotao's own
  // operational vars were stripped above.
  return env;
}

/** Whether to load the host's ~/.claude settings for a spawned agent. */
export function usesLocalClaudeSettings(): boolean {
  return !(providerCache === "nexotao" && apiKeyCache);
}

/** Resolve the model for a run: agent override → active project default → default. */
export function resolveModel(agentModel?: string | null): string | undefined {
  const explicit = agentModel || getActiveProject()?.model;
  if (explicit) return explicit;
  // Nexotao needs an explicit model; the Claude adapter lets the CLI pick.
  return providerCache === "nexotao" && apiKeyCache ? DEFAULT_MODEL : undefined;
}
