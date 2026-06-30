import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  readPrivateEnv,
  upsertPrivateEnvValue,
} from "../../interfaces/cli/private-env.ts";
import type {
  WebSearchProviderSetting,
  WebSearchSettingsUpdate,
  WebSearchSettingsView,
} from "./protocol.ts";

export function sanitizeWebSearchSettingsUpdate(
  input: WebSearchSettingsUpdate,
): WebSearchSettingsUpdate {
  const output: WebSearchSettingsUpdate = {};
  if (
    input.provider === "duckduckgo-html" ||
    input.provider === "auto" ||
    input.provider === "brave" ||
    input.provider === "tavily" ||
    input.provider === "openai-web-search" ||
    input.provider === "codex-subscription-web-search" ||
    input.provider === "disabled"
  )
    output.provider = input.provider;
  if (
    input.reader_backend === "lightweight" ||
    input.reader_backend === "auto" ||
    input.reader_backend === "lightpanda" ||
    input.reader_backend === "jina-hosted" ||
    input.reader_backend === "disabled"
  )
    output.reader_backend = input.reader_backend;
  if (typeof input.api_key === "string" && input.api_key.trim())
    output.api_key = input.api_key.trim();
  if (typeof input.planning_enabled === "boolean")
    output.planning_enabled = input.planning_enabled;
  if (
    input.planning_default_depth === "quick" ||
    input.planning_default_depth === "balanced" ||
    input.planning_default_depth === "deep"
  )
    output.planning_default_depth = input.planning_default_depth;
  return output;
}

export function webSearchSettingsPatchFrom(
  input: WebSearchSettingsUpdate,
): Partial<WebSearchSettingsView> {
  const { api_key: _apiKey, ...settings } = input;
  return settings;
}

export function normalizeWebSearchSettings(
  input: Partial<WebSearchSettingsView> = {},
  butlerData: string,
): WebSearchSettingsView {
  const legacyInput = input as Partial<WebSearchSettingsView> & {
    planning_mode?: string;
  };
  const provider =
    sanitizeWebSearchSettingsUpdate({
      provider: input.provider,
    }).provider ?? "duckduckgo-html";
  const apiKeyStatus = webSearchProviderApiKeyStatus(butlerData, provider);
  return {
    provider,
    reader_backend:
      sanitizeWebSearchSettingsUpdate({ reader_backend: input.reader_backend })
        .reader_backend ?? "lightweight",
    api_key_configured: apiKeyStatus.configured,
    api_key_env_var: apiKeyStatus.envVar,
    planning_enabled:
      legacyInput.planning_mode === "off"
        ? false
        : typeof input.planning_enabled === "boolean"
          ? input.planning_enabled
          : true,
    planning_default_depth:
      input.planning_default_depth === "quick" ||
      input.planning_default_depth === "deep"
        ? input.planning_default_depth
        : "balanced",
  };
}

export function readConfigWebSearchSettings(
  butlerData: string,
): Partial<WebSearchSettingsView> {
  try {
    const config = JSON.parse(
      readFileSync(join(butlerData, "butler.config.json"), "utf8"),
    ) as Record<string, any>;
    const webSearch = config.webSearch ?? {};
    const planning = webSearch.planning ?? {};
    const settings = sanitizeWebSearchSettingsUpdate({
      provider: webSearch.provider,
      reader_backend: webSearch.readerBackend,
      planning_enabled: planning.enabled,
      planning_default_depth: planning.defaultDepth,
    });
    if (planning.mode === "off") settings.planning_enabled = false;
    return settings;
  } catch {
    return {};
  }
}

export function writeConfigWebSearchSettings(
  butlerData: string,
  settings: WebSearchSettingsView,
): void {
  const path = join(butlerData, "butler.config.json");
  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    config = {};
  }
  config.webSearch = {
    ...(config.webSearch && typeof config.webSearch === "object"
      ? config.webSearch
      : {}),
    provider: settings.provider,
    readerBackend: settings.reader_backend,
    planning: {
      ...(config.webSearch?.planning &&
      typeof config.webSearch.planning === "object"
        ? config.webSearch.planning
        : {}),
      enabled: settings.planning_enabled,
      defaultDepth: settings.planning_default_depth,
    },
  };
  delete config.webSearch.planning.mode;
  delete config.webSearch.planning.allowParallelSearch;
  delete config.webSearch.planning.disableSmartForWeakModel;
  mkdirSync(butlerData, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function writeWebSearchProviderApiKey(
  butlerData: string,
  provider: WebSearchProviderSetting,
  apiKey: string,
): void {
  const spec = WEB_SEARCH_API_KEY_ENV[provider];
  const value = apiKey.trim();
  if (!spec || !value) return;
  upsertPrivateEnvValue(butlerData, spec.primary, value);
  process.env[spec.primary] = value;
}

const WEB_SEARCH_API_KEY_ENV: Partial<
  Record<WebSearchProviderSetting, { primary: string; accepted: string[] }>
> = {
  brave: {
    primary: "BUTLER_BRAVE_SEARCH_API_KEY",
    accepted: ["BUTLER_BRAVE_SEARCH_API_KEY", "BRAVE_SEARCH_API_KEY"],
  },
  tavily: {
    primary: "BUTLER_TAVILY_API_KEY",
    accepted: ["BUTLER_TAVILY_API_KEY", "TAVILY_API_KEY"],
  },
  "openai-web-search": {
    primary: "OPENAI_API_KEY",
    accepted: ["OPENAI_API_KEY"],
  },
};

function webSearchProviderApiKeyStatus(
  butlerData: string,
  provider: WebSearchProviderSetting,
): { configured: boolean; envVar: string | null } {
  const spec = WEB_SEARCH_API_KEY_ENV[provider];
  if (!spec) return { configured: false, envVar: null };
  const privateEnv = readPrivateEnv(butlerData);
  return {
    configured: spec.accepted.some((key) =>
      Boolean(process.env[key]?.trim() || privateEnv[key]?.trim()),
    ),
    envVar: spec.primary,
  };
}
