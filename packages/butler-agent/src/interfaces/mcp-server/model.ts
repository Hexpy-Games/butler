import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { BUTLER_DIR } from "./constants.ts";
import { parseModelRef } from "../../integrations/providers/model-ref.ts";

export const BUTLER_CONFIG_PATH = join(BUTLER_DIR.DATA, "butler.config.json");
export const DEFAULT_MODEL = "openai/gpt-5.5-codex";

export const VALID_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5-codex",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "auto:codex-latest",
] as const;
export const ALL_MODELS = [...VALID_MODELS] as const;

export type ModelAlias = (typeof ALL_MODELS)[number];

type ModelField = "butlerModel" | "workerModel";
export interface ModelDetails {
  raw: string;
  providerId: string;
  modelId: string;
  canonicalRef: string;
}

function readConfig(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(BUTLER_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(cfg: Record<string, any>): void {
  mkdirSync(dirname(BUTLER_CONFIG_PATH), { recursive: true });
  writeFileSync(BUTLER_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function isValid(model: unknown): model is string {
  return typeof model === "string" && (ALL_MODELS as readonly string[]).includes(model);
}

function isNamespacedRef(model: unknown): model is string {
  return typeof model === "string" && /^[^/\s]+\/[^/\s].*$/.test(model);
}

function isSupportedRawModelId(model: unknown): model is string {
  return (
    typeof model === "string" &&
    (model === "auto:codex-latest" ||
      /^gpt-5[a-z0-9.-]*$/i.test(model) ||
      /^o[1-9]/i.test(model))
  );
}

function readModelField(field: ModelField): string {
  const sys = readConfig()?.system ?? {};
  if (isValid(sys[field]) || isNamespacedRef(sys[field])) return sys[field];
  // Backward-compat: fall back to legacy defaultModel for butler.
  if (field === "butlerModel" && (isValid(sys.defaultModel) || isNamespacedRef(sys.defaultModel))) {
    return sys.defaultModel;
  }
  return DEFAULT_MODEL;
}

function readModelDetails(field: ModelField): ModelDetails {
  const raw = readModelField(field);
  const parsed = parseModelRef(raw);
  return {
    raw,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    canonicalRef: parsed.canonicalRef,
  };
}

function writeModelField(field: ModelField, model: string, label: string): void {
  const trimmed = model.trim();
  if (!trimmed) {
    throw new Error(`Invalid ${label} model: "${model}". Valid: ${VALID_MODELS.join(", ")}`);
  }
  if (!isValid(trimmed) && !isNamespacedRef(trimmed) && !isSupportedRawModelId(trimmed)) {
    throw new Error(`Invalid ${label} model: "${model}". Valid: ${VALID_MODELS.join(", ")}`);
  }
  const normalized = parseModelRef(trimmed).canonicalRef;
  const cfg = readConfig();
  if (!cfg.system || typeof cfg.system !== "object") cfg.system = {};
  cfg.system[field] = normalized;
  writeConfig(cfg);
}

// Worker model (used by dispatch_task)
export function getModel(): string {
  return readModelField("workerModel");
}

export function getModelDetails(): ModelDetails {
  return readModelDetails("workerModel");
}

export function setModel(model: string): void {
  writeModelField("workerModel", model, "worker");
}

// Butler model (used by start-butler.sh at next restart)
export function getButlerModel(): string {
  return readModelField("butlerModel");
}

export function getButlerModelDetails(): ModelDetails {
  return readModelDetails("butlerModel");
}

export function setButlerModel(model: string): void {
  writeModelField("butlerModel", model, "butler");
}
