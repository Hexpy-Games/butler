import { homedir } from "os";
import { join } from "path";
import { resolveOpenAIAuth } from "./auth.ts";

export const AUTO_CODEX_LATEST = "auto:codex-latest";
export const DEFAULT_CODEX_MODEL = "gpt-5.5-codex";
export const DEFAULT_CODEX_MODEL_REF = `openai/${DEFAULT_CODEX_MODEL}` as const;
export const FALLBACK_OPENAI_MODELS = [
  DEFAULT_CODEX_MODEL,
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5-codex",
  "gpt-5",
] as const;
export const DEFAULT_OPENAI_MODEL_REF = DEFAULT_CODEX_MODEL_REF;

function getButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function getModelsUrl(): string {
  const base = (process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  return base.endsWith("/models") ? base : `${base}/models`;
}

function versionScore(model: string): number[] {
  const match = model.match(/gpt-(\d+(?:\.\d+)?)/i);
  const version = match ? Number(match[1]) : 0;
  const tierBoost = modelTierScore(model);
  const maxBoost = /max/i.test(model) ? 100 : 0;
  const miniPenalty = /mini|nano/i.test(model) ? -10 : 0;
  return [version, tierBoost + maxBoost + miniPenalty, model.length];
}

function modelTierScore(model: string): number {
  if (/-(?:sol)$/i.test(model) || /^gpt-\d+(?:\.\d+)?$/i.test(model)) return 90;
  if (/-codex(?:$|-)/i.test(model)) return 80;
  if (/-terra$/i.test(model)) return 60;
  if (/-luna$/i.test(model)) return 30;
  return 0;
}

function isAutoSelectableCodexModel(model: string): boolean {
  if (/^gpt-\d+(?:\.\d+)?-codex(?:$|-)/i.test(model)) return true;
  if (/^gpt-\d+(?:\.\d+)?-(?:sol|terra|luna)$/i.test(model)) return true;
  return /^gpt-5\.6$/i.test(model);
}

export function pickLatestCodexModel(models: string[]): string {
  const codex = models
    .filter(isAutoSelectableCodexModel)
    .sort((a, b) => {
      const as = versionScore(a);
      const bs = versionScore(b);
      return bs[0] - as[0] || bs[1] - as[1] || bs[2] - as[2] || b.localeCompare(a);
    });
  if (!codex[0]) {
    throw new Error("No Codex-capable OpenAI model was returned by the configured model list.");
  }
  return codex[0];
}

export async function listOpenAIModelIds(): Promise<string[]> {
  const auth = await resolveOpenAIAuth();
  const response = await fetch(getModelsUrl(), {
    headers: {
      Authorization: auth.authorization,
    },
  });
  if (!response.ok) {
    throw new Error(`OpenAI models API error (${response.status}): ${await response.text()}`);
  }
  const data = await response.json() as { data?: Array<{ id?: string }> };
  return (data.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function resolveDynamicOpenAIModel(model: string): Promise<string> {
  if (model !== AUTO_CODEX_LATEST) return model;
  try {
    return pickLatestCodexModel(await listOpenAIModelIds());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Configured OpenAI model ${AUTO_CODEX_LATEST} could not be resolved from provider model discovery: ${reason}`,
      { cause: error },
    );
  }
}

export function openAIModelCachePath(): string {
  return join(getButlerData(), "cache", "openai-models.json");
}
