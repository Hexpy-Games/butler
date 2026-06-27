import { safeRuntimeFailure } from "../../integrations/providers/provider-errors.ts";
import { INTERNAL_RECOVERY_REQUIRED_CODE } from "../../runtime/internal-recovery-failure.ts";
import {
  classifyRuntimeFailureDelivery,
  deliveredWithLimitationsState,
  safeLimitationText,
  type RuntimeDeliveryClassification,
} from "./runtime-delivery-state.ts";

const DEFAULT_LIMITED_DELIVERY_REASON =
  "진행한 내용은 보존했습니다. 다만 마지막 마무리 단계까지 완전히 닫지는 못했습니다.\n\n남은 부분: 완료 보고에 필요한 마지막 결과 정리가 남아 있습니다.\n다음 진행에서는 이 지점부터 이어가면 됩니다.";

export interface RecoverableLimitedDelivery {
  text: string;
  reason: string;
  delivery: RuntimeDeliveryClassification;
}

export function recoverableLimitedDeliveryForError(error: unknown): RecoverableLimitedDelivery | null {
  const classified = classifyRuntimeFailureDelivery(error);
  if (classified.issue_kind !== "internal_recovery") return null;
  if (isPromptUsageModelCallBudget(error)) return null;
  const failure = safeRuntimeFailure(error);
  const progressText = progressFinalizationTextFromError(error);
  const reason = safeLimitationText(
    progressText ?? failure.message,
    DEFAULT_LIMITED_DELIVERY_REASON,
  );
  const text = progressText ?? (isGenericVerificationFailure(reason) ? DEFAULT_LIMITED_DELIVERY_REASON : reason);
  return {
    text,
    reason: text,
    delivery: deliveredWithLimitationsState({
      limitationCodes: [classified.limitation_codes[0] ?? failure.code ?? INTERNAL_RECOVERY_REQUIRED_CODE],
      limitations: [text],
    }),
  };
}

function isPromptUsageModelCallBudget(error: unknown): boolean {
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown };
    return record.code === "prompt_usage_model_call_budget_exhausted" ||
      error.name === "PromptUsageModelCallBudgetExhaustedError" ||
      /prompt usage model-call budget exhausted/iu.test(error.message);
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return record.code === "prompt_usage_model_call_budget_exhausted" ||
      record.name === "PromptUsageModelCallBudgetExhaustedError" ||
      (typeof record.message === "string" &&
        /prompt usage model-call budget exhausted/iu.test(record.message));
  }
  return typeof error === "string" &&
    /prompt usage model-call budget exhausted/iu.test(error);
}

function progressFinalizationTextFromError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { progressFinalizationText?: unknown }).progressFinalizationText;
  if (typeof value !== "string" || !value.trim()) return null;
  return safeProgressFinalizationText(value);
}

function isGenericVerificationFailure(value: string): boolean {
  return /Butler could not verify that the requested goal was completed/iu.test(value) ||
    /요청한 결과를 완료했는지 확인하지 못했습니다/u.test(value);
}

function safeProgressFinalizationText(value: string): string | null {
  const safe = stripUnsafeControlCharacters(value)
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  if (!safe) return null;
  if (containsPrivateText(safe) || /raw prompt text/iu.test(safe)) return null;
  return safe.slice(0, 1_200);
}

function containsPrivateText(value: string): boolean {
  return /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|\/private\/[^/\s]+|~\/|\$HOME\/|[A-Za-z]:\\Users\\[^\\\s]+)/u
    .test(value);
}

function stripUnsafeControlCharacters(value: string): string {
  return [...value].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || code >= 32;
  }).join("");
}
