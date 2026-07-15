import type { SettingsView } from "./types.ts";
import { api } from "./api.ts";

export type FirstRunLanguage = "en" | "ko";
export type FirstRunStep = "language" | "safety" | "install" | "model";
export type FirstRunConnectionMode = "bundled-agent";
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
  | { type: "cancel_setup" };

export interface FirstRunState {
  schema: "butler.app.first-run.v1";
  status: "pending" | "complete";
  language: FirstRunLanguage;
  step: FirstRunStep;
  language_confirmed?: boolean;
  safety_accepted?: boolean;
  install_status?: FirstRunInstallStatus;
  connection_mode?: FirstRunConnectionMode;
  error_message?: string;
  completed_at?: string;
}

export interface FirstRunSetupStatusView {
  phase: "idle" | "checking" | "ready" | "failed" | "cancelled";
  status_label: string;
  diagnostics_available: boolean;
  error_code?: string;
}

export interface FirstRunSetupDiagnosticsView {
  generated_at: string;
  phase: FirstRunSetupStatusView["phase"];
  checks: Array<{
    id: string;
    label: string;
    status: "pending" | "passed" | "failed" | "cancelled";
  }>;
  errors: Array<{
    code: string;
    message: string;
    details?: unknown;
  }>;
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
      "Butler는 사용자가 요청한 로컬 작업을 대신 실행합니다. 시작 전에 아래 기준을 확인하세요.",
    safetyItems: [
      "파일 변경, 명령 실행, 외부 요청은 사용자의 지시 안에서만 진행됩니다.",
      "민감한 경로나 토큰이 포함된 요청은 실행 전에 한 번 더 확인하세요.",
      "자동화 결과는 App 안의 기록과 진단 로그로 확인할 수 있습니다.",
    ],
    accept: "동의",
    installTitle: "Butler Agent를 준비합니다",
    installReady: "준비 완료",
    installChecking: "상태 확인 중",
    installFailed: "Butler Agent를 준비하지 못했습니다.",
    retry: "다시 시도",
    repair: "복구",
    diagnostics: "진단 복사",
    diagnosticsCopied: "진단을 복사했습니다.",
    diagnosticsUnavailable: "진단을 복사하지 못했습니다.",
    quit: "종료",
    modelTitle: "모델 설정",
    modelBody:
      "기본 모델과 연결 방식을 설정하세요.",
    modelSelectLabel: "기본 모델",
    modelLoading: "모델 목록을 불러오는 중",
    modelLoadFailed: "모델 목록을 불러오지 못했습니다.",
    modelRetry: "다시 불러오기",
    modelSave: "저장하고 시작",
    modelSaving: "저장 중",
    modelSaved: "모델 설정을 저장했습니다.",
    modelSaveFailed: "모델 설정을 저장하지 못했습니다.",
  },
  en: {
    product: "Butler",
    steps: ["Language", "Safety", "Install", "Model"],
    languageTitle: "Language",
    continue: "Continue",
    back: "Back",
    safetyTitle: "Safety notice",
    safetyBody:
      "Butler runs local work on your behalf. Review these basics before starting.",
    safetyItems: [
      "File changes, commands, and network requests stay within your instructions.",
      "Review requests that include sensitive paths or tokens before running them.",
      "Automation results are visible in App history and diagnostics logs.",
    ],
    accept: "Accept",
    installTitle: "Prepare Butler Agent",
    installReady: "Ready",
    installChecking: "Checking status",
    installFailed: "Butler Agent is not ready.",
    retry: "Retry",
    repair: "Repair",
    diagnostics: "Copy diagnostics",
    diagnosticsCopied: "Diagnostics copied.",
    diagnosticsUnavailable: "Diagnostics unavailable.",
    quit: "Quit",
    modelTitle: "Model setup",
    modelBody:
      "Set the default model and connection method.",
    modelSelectLabel: "Default model",
    modelLoading: "Loading models",
    modelLoadFailed: "Could not load models.",
    modelRetry: "Reload models",
    modelSave: "Save and start",
    modelSaving: "Saving",
    modelSaved: "Model settings saved.",
    modelSaveFailed: "Model settings could not be saved.",
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
    connection_mode: "bundled-agent",
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
    connection_mode: "bundled-agent",
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
  const connectionMode = normalizeConnectionMode(record.connection_mode);
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
      connection_mode: connectionMode,
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
    connection_mode: connectionMode,
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

function normalizeConnectionMode(_value: unknown): FirstRunConnectionMode {
  return "bundled-agent";
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
    connection_mode:
      patch.connection_mode ?? state.connection_mode ?? "bundled-agent",
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
        ? pendingState(state, {
          connection_mode: "bundled-agent",
          install_status: "checking",
        })
        : state;
    case "install_ready":
      return state.step === "install"
        ? pendingState(state, {
          connection_mode: "bundled-agent",
          step: "model",
          install_status: "ready",
        })
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

export async function startFirstRunSetup(
  mode: "check" | "repair" = "check",
): Promise<FirstRunSetupStatusView> {
  return await api<FirstRunSetupStatusView>("/setup/start", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

export async function cancelFirstRunSetup(): Promise<FirstRunSetupStatusView> {
  return await api<FirstRunSetupStatusView>("/setup/cancel", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function exportFirstRunSetupDiagnostics(): Promise<FirstRunSetupDiagnosticsView> {
  return await api<FirstRunSetupDiagnosticsView>("/setup/diagnostics");
}
