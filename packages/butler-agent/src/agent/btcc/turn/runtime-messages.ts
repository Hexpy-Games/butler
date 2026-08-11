import { ModelProviderRequestError } from
  "../../../integrations/providers/provider-errors.ts";
import { ModelRouteRecoveredFailureError } from "../model-route/index.ts";
import type { TurnContinuationBudgetExhaustedError } from
  "./continuation-budget.ts";

export function operationalFailureMessage(
  originalMessage: string,
  error?: unknown,
): string {
  const korean = /[가-힣]/.test(originalMessage);
  const kind = operationalFailureKind(error);
  if (korean) {
    if (kind === "transient_provider") {
      return "모델 연결이 일시적으로 중단되어 이 Turn의 답변을 완료하지 못했습니다. 저장된 작업과 확인된 결과는 변경하지 않았습니다.";
    }
    if (kind === "permanent_provider") {
      return "모델 제공자 설정 또는 요청이 승인되지 않아 이 Turn의 답변을 완료하지 못했습니다. 저장된 작업과 확인된 결과는 변경하지 않았습니다.";
    }
    return "내부 실행 오류로 이 Turn의 답변을 완료하지 못했습니다. 저장된 작업과 확인된 결과는 변경하지 않았습니다.";
  }
  if (kind === "transient_provider") {
    return "A temporary model connection failure prevented this Turn from completing. Saved work and verified results were not changed.";
  }
  if (kind === "permanent_provider") {
    return "The model provider rejected this Turn because of a configuration or request problem. Saved work and verified results were not changed.";
  }
  return "An internal execution error prevented this Turn from completing. Saved work and verified results were not changed.";
}

export function continuationBudgetTerminalMessage(
  originalMessage: string,
  error: TurnContinuationBudgetExhaustedError,
): string {
  const reason = error.receipt.reason;
  return /[가-힣]/.test(originalMessage)
    ? `이 Turn의 연속 실행 한도(${reason})에 도달해 안전하게 종료했습니다. 저장된 작업과 완료된 결과는 유지됩니다.`
    : `This Turn reached its continuation limit (${reason}) and stopped safely. Saved work and completed results were preserved.`;
}

export function continuationBudgetConfigurationMessage(
  originalMessage: string,
): string {
  return /[가-힣]/.test(originalMessage)
    ? "이 Turn의 연속 실행 한도가 구성되지 않아 모델 요청 전에 안전하게 종료했습니다. 저장된 작업과 결과는 변경하지 않았습니다."
    : "This Turn stopped safely before a model request because explicit continuation limits were not configured. Saved work and results were not changed.";
}

function operationalFailureKind(
  error: unknown,
): "transient_provider" | "permanent_provider" | "internal" {
  if (error instanceof ModelProviderRequestError) {
    return error.retryable ? "transient_provider" : "permanent_provider";
  }
  if (error instanceof ModelRouteRecoveredFailureError) {
    return error.disposition === "retry" ? "transient_provider" : "permanent_provider";
  }
  return "internal";
}
