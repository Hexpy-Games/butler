import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { appLocaleFromLanguage, getAppCopy } from "../../../../butler-i18n/src/index.ts";

export type RuntimeMessageLanguage = "en" | "ko";

export interface RuntimeMessages {
  ungroundedWorkerDispatch(): string;
  ungroundedTaskInspection(): string;
}

function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function readJson(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeLanguage(value: unknown): RuntimeMessageLanguage | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "ko" ||
    normalized === "kr" ||
    normalized.includes("korean") ||
    normalized.includes("한국") ||
    normalized.includes("한글")
  ) {
    return "ko";
  }
  if (
    normalized === "en" ||
    normalized.includes("english") ||
    normalized.includes("영어")
  ) {
    return "en";
  }
  return null;
}

function languageFromPersona(butlerData: string): RuntimeMessageLanguage | null {
  const path = join(butlerData, "personas", "active.md");
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const match = text.match(/\*\*Language:\*\*\s*([^\n]+)/i);
    return normalizeLanguage(match?.[1]);
  } catch {
    return null;
  }
}

export function resolveRuntimeMessageLanguage(options: {
  butlerData?: string;
  explicit?: string;
} = {}): RuntimeMessageLanguage {
  const butlerData = getButlerData(options.butlerData);
  const config = readJson(join(butlerData, "butler.config.json"));
  return normalizeLanguage(options.explicit) ??
    normalizeLanguage(process.env.BUTLER_RESPONSE_LANGUAGE) ??
    normalizeLanguage(config?.user?.responseLanguage) ??
    languageFromPersona(butlerData) ??
    "en";
}

/** A response preference is a default, not a ban on the user's requested language. */
export function responseLanguageInstruction(language: string): string {
  return `Use ${language.trim()} for every user-facing message by default. Follow the user's explicit request to answer or translate into another language instead. Interface language controls app labels only and must not change the answer language.`;
}

export function runtimeMessages(language: RuntimeMessageLanguage): RuntimeMessages {
  return getAppCopy(appLocaleFromLanguage(language)).runtimeMessages;
}

export function resolveRuntimeMessages(options: {
  butlerData?: string;
  explicit?: string;
} = {}): RuntimeMessages {
  return runtimeMessages(resolveRuntimeMessageLanguage(options));
}
