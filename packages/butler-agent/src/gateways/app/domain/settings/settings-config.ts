import {
  mkdirSync,
  renameSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ModelFallbackSettingsView } from "../../interface/protocol/settings-contract.ts";
import { normalizeTimezone } from "./settings-preferences.ts";

type AppLanguage = "en" | "ko";

export interface ConfigUserSettings {
  timezone?: string;
  language?: AppLanguage;
  responseLanguage?: AppLanguage;
  modelFallback?: ModelFallbackSettingsView;
}

export function readConfigUserSettings(
  butlerData: string,
): ConfigUserSettings {
  try {
    const config = JSON.parse(
      readFileSync(join(butlerData, "butler.config.json"), "utf8"),
    ) as Record<string, any>;
    const user =
      config.user && typeof config.user === "object" ? config.user : {};
    const modelFallback = readConfigModelFallback(user.modelFallback);
    return {
      timezone: normalizeTimezone(config.user?.timezone) ?? undefined,
      language: normalizeAppLanguage(config.user?.language),
      responseLanguage: normalizeAppLanguage(config.user?.responseLanguage),
      ...(modelFallback ? { modelFallback } : {}),
    };
  } catch {
    return {};
  }
}

export function readConfigDefaultModel(
  butlerData: string,
): string | undefined {
  try {
    const config = JSON.parse(
      readFileSync(join(butlerData, "butler.config.json"), "utf8"),
    ) as Record<string, any>;
    const system =
      config.system && typeof config.system === "object" ? config.system : {};
    return safeString(system.butlerModel) ?? safeString(system.defaultModel);
  } catch {
    return undefined;
  }
}

export function writeConfigUserSettings(
  butlerData: string,
  settings: ConfigUserSettings,
): void {
  const path = join(butlerData, "butler.config.json");
  let config: Record<string, any>;
  try {
    config = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    config = {};
  }
  config.user = {
    ...(config.user && typeof config.user === "object" ? config.user : {}),
    ...(settings.timezone ? { timezone: settings.timezone } : {}),
    ...(settings.language ? { language: settings.language } : {}),
    ...(settings.responseLanguage
      ? { responseLanguage: settings.responseLanguage }
      : {}),
    ...(settings.modelFallback
      ? {
          modelFallback: {
            enabled: settings.modelFallback.enabled === true,
            models: settings.modelFallback.models.filter(
              (model): model is string => typeof model === "string",
            ),
          },
        }
      : {}),
  };
  mkdirSync(butlerData, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

function readConfigModelFallback(
  value: unknown,
): ModelFallbackSettingsView | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  return {
    enabled: input.enabled === true,
    models: Array.isArray(input.models)
      ? input.models.filter((model): model is string => typeof model === "string")
      : [],
  };
}

function normalizeAppLanguage(value: unknown): AppLanguage | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "ko" ||
    normalized === "kr" ||
    normalized.includes("korean") ||
    normalized.includes("한국")
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
  return undefined;
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
