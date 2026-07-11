import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface ButlerConfig {
  user: { name: string; timezone: string; language: string; techLanguage: string };
  system: { butlerHome: string; butlerData?: string; devRoot: string; mcpServerName: string; defaultModel: string; activePersona?: string; runtime?: string };
  webSearch?: {
    provider?: string;
    readerBackend?: string;
    model?: string;
    apiBase?: string;
    braveApiBase?: string;
    tavilyApiBase?: string;
    planning?: {
      enabled?: boolean;
      defaultDepth?: string;
    };
  };
  projects: Array<{ name: string; path: string; description: string; ssh?: { user: string; host: string } }>;
  memory: { hotCacheMaxBytes: number; taskTtlMs: number; lancedbTable: string; notifySocket: string };
  timeouts: { workerDefaultSec: number; debounceMs: number };
}

const DEFAULTS: ButlerConfig = {
  user: { name: "User", timezone: "UTC", language: "en", techLanguage: "en" },
  system: { butlerHome: process.env.BUTLER_HOME || process.cwd(), butlerData: process.env.BUTLER_DATA || join(homedir(), ".butler"), devRoot: "~/dev", mcpServerName: "butler-main", defaultModel: "openai/gpt-5.5-codex", runtime: "codex-api" },
  webSearch: {
    provider: "duckduckgo-html",
    readerBackend: "lightweight",
    planning: {
      enabled: true,
      defaultDepth: "balanced",
    },
  },
  projects: [],
  memory: { hotCacheMaxBytes: 10240, taskTtlMs: 3600000, lancedbTable: "butler_memory", notifySocket: "/tmp/butler-notify.sock" },
  timeouts: { workerDefaultSec: 600, debounceMs: 3000 },
};

function loadConfigRaw(): ButlerConfig {
  const configPath = join(process.env.BUTLER_DATA || join(homedir(), ".butler"), "butler.config.json");
  if (existsSync(configPath)) {
    try {
      return JSON.parse(readFileSync(configPath, "utf8")) as ButlerConfig;
    } catch (err) {
      console.error("config: failed to parse butler.config.json, using defaults:", err);
    }
  }
  return DEFAULTS;
}

export const config = loadConfigRaw();
