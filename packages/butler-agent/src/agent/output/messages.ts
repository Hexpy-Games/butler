import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
    normalizeLanguage(process.env.BUTLER_LANG) ??
    normalizeLanguage(config?.user?.responseLanguage) ??
    normalizeLanguage(config?.user?.language) ??
    languageFromPersona(butlerData) ??
    "en";
}

const EN_MESSAGES: RuntimeMessages = {
  ungroundedWorkerDispatch() {
    return [
      "I could not verify worker execution for this response.",
      "",
      "I will not claim background work has started until the execution record confirms it. If you ask again, I will first verify the state and then continue safely.",
    ].join("\n");
  },
  ungroundedTaskInspection() {
    return [
      "The task queue has not been checked yet.",
      "",
      "I will not report task status from memory alone. If you ask again, I will read the durable task state before answering.",
    ].join("\n");
  },
};

const KO_MESSAGES: RuntimeMessages = {
  ungroundedWorkerDispatch() {
    return [
      "이번 답변에서는 워커 또는 백그라운드 작업 실행을 확인하지 못했습니다.",
      "",
      "실행 기록으로 확인되기 전에는 백그라운드 작업이 시작됐다고 단정하지 않겠습니다. 다시 요청하시면 먼저 상태를 확인한 뒤 안전하게 이어가겠습니다.",
    ].join("\n");
  },
  ungroundedTaskInspection() {
    return [
      "아직 작업 큐를 확인하지 않았습니다.",
      "",
      "기억만으로 작업 상태를 보고하지 않겠습니다. 다시 물어보시면 저장된 작업 상태를 먼저 읽고 답하겠습니다.",
    ].join("\n");
  },
};

export function runtimeMessages(language: RuntimeMessageLanguage): RuntimeMessages {
  return language === "ko" ? KO_MESSAGES : EN_MESSAGES;
}

export function resolveRuntimeMessages(options: {
  butlerData?: string;
  explicit?: string;
} = {}): RuntimeMessages {
  return runtimeMessages(resolveRuntimeMessageLanguage(options));
}
