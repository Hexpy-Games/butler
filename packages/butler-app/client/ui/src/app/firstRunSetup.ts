import type { SettingsView } from "./types.ts";

export type FirstRunLanguage = "en" | "ko";
export type FirstRunStep = "language" | "safety" | "install" | "model";
export type FirstRunInstallStatus =
  | "idle"
  | "checking"
  | "ready"
  | "failed"
  | "cancelled";

export type FirstRunAction =
  | { type: "select_language"; language: FirstRunLanguage }
  | { type: "continue_language" }
  | { type: "back_to_language" }
  | { type: "accept_safety" }
  | { type: "begin_install" }
  | { type: "install_ready" }
  | { type: "install_failed"; error: string }
  | { type: "retry_install" }
  | { type: "cancel_setup" }
  | { type: "open_model_setup" }
  | { type: "defer_model_setup" };

export interface FirstRunState {
  schema: "butler.app.first-run.v1";
  status: "pending" | "complete";
  language: FirstRunLanguage;
  step: FirstRunStep;
  language_confirmed?: boolean;
  safety_accepted?: boolean;
  install_status?: FirstRunInstallStatus;
  error_message?: string;
  completed_at?: string;
}

export const FIRST_RUN_STORAGE_KEY = "butler:first-run-setup:v1";
export const FIRST_RUN_STEPS: FirstRunStep[] = [
  "language",
  "safety",
  "install",
  "model",
];

export const firstRunCopy = {
  ko: {
    product: "Butler",
    steps: ["언어", "안전고지", "설치", "모델"],
    languageTitle: "언어 선택",
    continue: "계속",
    back: "이전",
    safetyTitle: "안전고지",
    safetyBody:
      "Butler는 로컬 파일과 앱을 다룰 수 있습니다. 요청한 작업만 실행하고, 민감한 정보는 신중하게 확인하세요.",
    accept: "동의",
    installTitle: "Butler Agent를 준비합니다",
    installReady: "준비 완료",
    installChecking: "상태 확인 중",
    installFailed: "Butler Agent를 준비하지 못했습니다.",
    retry: "다시 시도",
    modelTitle: "모델 설정",
    modelBody: "모델은 지금 설정하거나 나중에 설정할 수 있습니다.",
    openModelSettings: "모델 설정 열기",
    finish: "나중에 설정",
  },
  en: {
    product: "Butler",
    steps: ["Language", "Safety", "Install", "Model"],
    languageTitle: "Language",
    continue: "Continue",
    back: "Back",
    safetyTitle: "Safety notice",
    safetyBody:
      "Butler can work with local files and apps. Run only requested work and review sensitive information carefully.",
    accept: "Accept",
    installTitle: "Butler Agent를 준비합니다",
    installReady: "Ready",
    installChecking: "Checking status",
    installFailed: "Butler Agent is not ready.",
    retry: "Retry",
    modelTitle: "Model setup",
    modelBody: "Set up a model now or continue and configure it later.",
    openModelSettings: "Open model settings",
    finish: "Set up later",
  },
} as const;

export function detectFirstRunLanguage(
  languages: readonly string[] = [],
): FirstRunLanguage {
  return languages.some((language) =>
    language.toLocaleLowerCase("en-US").startsWith("ko"),
  )
    ? "ko"
    : "en";
}

export function createInitialFirstRunState(
  language: FirstRunLanguage,
): FirstRunState {
  return {
    schema: "butler.app.first-run.v1",
    status: "pending",
    language,
    step: "language",
    language_confirmed: false,
    safety_accepted: false,
    install_status: "idle",
  };
}

export function firstRunCompleteState(
  language: FirstRunLanguage,
): FirstRunState {
  return {
    schema: "butler.app.first-run.v1",
    status: "complete",
    language,
    step: "model",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "ready",
    completed_at: new Date().toISOString(),
  };
}

export function parseFirstRunState(value: unknown): FirstRunState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<FirstRunState>;
  if (record.schema !== "butler.app.first-run.v1") return null;
  if (record.status !== "pending" && record.status !== "complete") return null;
  const parsedLanguage =
    record.language === "ko" || record.language === "en"
      ? record.language
      : null;
  const language = parsedLanguage ?? "en";
  let step = FIRST_RUN_STEPS.includes(record.step as FirstRunStep)
    ? (record.step as FirstRunStep)
    : "language";
  const installStatus = normalizeInstallStatus(record.install_status);
  const languageConfirmed =
    parsedLanguage !== null && record.language_confirmed === true;
  const safetyAccepted = languageConfirmed && record.safety_accepted === true;
  if (record.status === "complete") {
    if (
      step !== "model" ||
      !languageConfirmed ||
      !safetyAccepted ||
      installStatus !== "ready" ||
      typeof record.completed_at !== "string"
    ) {
      return createInitialFirstRunState(language);
    }
    return {
      schema: "butler.app.first-run.v1",
      status: "complete",
      language,
      step: "model",
      language_confirmed: true,
      safety_accepted: true,
      install_status: "ready",
      completed_at: record.completed_at,
    };
  }
  if (record.status === "pending") {
    if (!languageConfirmed) {
      step = "language";
    } else if (!safetyAccepted && (step === "install" || step === "model")) {
      step = "safety";
    } else if (step === "model" && installStatus !== "ready") {
      step = "install";
    }
  }
  return {
    schema: "butler.app.first-run.v1",
    status: "pending",
    language,
    step,
    language_confirmed: languageConfirmed,
    safety_accepted: safetyAccepted,
    install_status:
      step === "install" && installStatus === "checking"
        ? "idle"
        : installStatus,
    ...(typeof record.error_message === "string" &&
    installStatus === "failed"
      ? { error_message: record.error_message }
      : {}),
  };
}

function normalizeInstallStatus(value: unknown): FirstRunInstallStatus {
  return value === "checking" ||
    value === "ready" ||
    value === "failed" ||
    value === "cancelled"
    ? value
    : "idle";
}

function pendingState(
  state: FirstRunState,
  patch: Partial<FirstRunState>,
): FirstRunState {
  return {
    schema: "butler.app.first-run.v1",
    status: "pending",
    language: patch.language ?? state.language,
    step: patch.step ?? state.step,
    language_confirmed:
      patch.language_confirmed ?? state.language_confirmed ?? false,
    safety_accepted: patch.safety_accepted ?? state.safety_accepted ?? false,
    install_status: patch.install_status ?? state.install_status ?? "idle",
    ...(patch.error_message ? { error_message: patch.error_message } : {}),
  };
}

export function nextFirstRunState(
  state: FirstRunState,
  action: FirstRunAction,
): FirstRunState {
  if (state.status === "complete") return state;
  switch (action.type) {
    case "select_language":
      return pendingState(state, {
        language: action.language,
        step: "language",
        language_confirmed: false,
        safety_accepted: false,
        install_status: "idle",
      });
    case "continue_language":
      return state.step === "language"
        ? pendingState(state, {
          step: "safety",
          language_confirmed: true,
          install_status: "idle",
        })
        : state;
    case "back_to_language":
      return pendingState(state, {
        step: "language",
        language_confirmed: false,
        safety_accepted: false,
        install_status: "idle",
      });
    case "accept_safety":
      return state.step === "safety"
        ? pendingState(state, {
          step: "install",
          safety_accepted: true,
          install_status: "idle",
        })
        : state;
    case "begin_install":
      return state.step === "install"
        ? pendingState(state, { install_status: "checking" })
        : state;
    case "install_ready":
      return state.step === "install"
        ? pendingState(state, { step: "model", install_status: "ready" })
        : state;
    case "install_failed":
      return state.step === "install"
        ? pendingState(state, {
          install_status: "failed",
          error_message: action.error,
        })
        : state;
    case "retry_install":
      return state.step === "install"
        ? pendingState(state, { install_status: "checking" })
        : state;
    case "cancel_setup":
      return pendingState(state, { install_status: "cancelled" });
    case "defer_model_setup":
    case "open_model_setup":
      return state.step === "model"
        ? firstRunCompleteState(state.language)
        : state;
    default:
      return state;
  }
}

export function readFirstRunState(
  storage: Pick<Storage, "getItem">,
  languages: readonly string[],
): FirstRunState {
  try {
    const raw = storage.getItem(FIRST_RUN_STORAGE_KEY);
    const parsed = raw ? parseFirstRunState(JSON.parse(raw)) : null;
    if (parsed) return parsed;
  } catch {
    // Invalid local setup state falls back to a clean first-run sequence.
  }
  return createInitialFirstRunState(detectFirstRunLanguage(languages));
}

export function writeFirstRunState(
  storage: Pick<Storage, "setItem">,
  state: FirstRunState,
): void {
  storage.setItem(FIRST_RUN_STORAGE_KEY, JSON.stringify(state));
}

export function settingsLanguagePatch(
  language: FirstRunLanguage,
): Pick<SettingsView, "language"> {
  return { language };
}
