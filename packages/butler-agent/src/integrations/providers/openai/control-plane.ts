import type { OpenAIAuthSummary, ReasoningEffort } from "../runtime-contracts.ts";
import { arch, homedir, platform, release } from "os";
import { existsSync } from "fs";
import { getButlerData } from "../shared/runtime-support.ts";
import { join } from "path";
import { type OpenAIModelResolution } from "./model-config.ts";




export function getOpenAIAuthSummary(): OpenAIAuthSummary {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (apiKey) {
    return {
      mode: "api_key",
      envKey: "OPENAI_API_KEY",
    };
  }

  if (existsSync(process.env.BUTLER_CODEX_AUTH_PROFILE || process.env.BUTLER_OPENAI_AUTH_PROFILE || join(getButlerData(), "auth", "openai-codex.json"))) {
    return {
      mode: "codex_subscription",
      envKey: "BUTLER_CODEX_AUTH_PROFILE",
    };
  }

  if (existsSync(process.env.CODEX_AUTH_JSON || join(homedir(), ".codex", "auth.json"))) {
    return {
      mode: "codex_oauth",
      envKey: "CODEX_AUTH_JSON",
    };
  }

  throw new Error(
    "Codex subscription login or OPENAI_API_KEY is required when BUTLER_RUNTIME=codex-api",
  );
}




export function getResponsesUrl(): string {
  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  return base.endsWith("/responses") ? base : `${base}/responses`;
}




export function getCodexResponsesUrl(): string {
  const base = (process.env.BUTLER_CODEX_BASE_URL?.trim() || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  if (base.endsWith("/codex/responses")) return base;
  if (base.endsWith("/codex")) return `${base}/responses`;
  return `${base}/codex/responses`;
}




export function getCodexOriginator(): string {
  return process.env.BUTLER_CODEX_OAUTH_ORIGINATOR?.trim() ||
    process.env.BUTLER_OPENAI_OAUTH_ORIGINATOR?.trim() ||
    "butler";
}




export function getCodexUserAgent(): string {
  return process.env.BUTLER_CODEX_USER_AGENT?.trim() ||
    `butler (${platform()} ${release()}; ${arch()})`;
}




export function buildReasoningConfig(
  resolution: OpenAIModelResolution,
): { effort: Exclude<ReasoningEffort, "none"> } | undefined {
  if (resolution.reasoningEffort === "none") return undefined;
  return { effort: resolution.reasoningEffort };
}
