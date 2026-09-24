import {
  ModelRouteRecoveredFailureError,
} from "../model-route/index.ts";
import type { BtccRuntimeFailure } from "../contracts.ts";
import { safeRuntimeFailure } from
  "../../../integrations/providers/provider-errors.ts";

export function runtimeFailureFromError(error: unknown): BtccRuntimeFailure {
  if (error instanceof ModelRouteRecoveredFailureError) {
    return { code: error.failureCode, retryable: error.disposition === "retry" };
  }
  const failure = safeRuntimeFailure(error);
  return { code: failure.code, retryable: failure.retryable === true };
}

export function operationalFailureMessage(
  originalMessage: string,
  error?: unknown,
): string {
  return runtimeFailureMessage(originalMessage, runtimeFailureFromError(error));
}

/** User-facing cause only: no raw errors, progress reconstruction or recovery promise. */
export function runtimeFailureMessage(
  originalMessage: string,
  failure: BtccRuntimeFailure,
  workCompleted = false,
): string {
  const korean = /[가-힣]/.test(originalMessage);
  const cause = failureCause(failure.code, korean);
  if (korean) {
    return workCompleted
      ? `작업은 완료했지만 ${cause} 최종 설명을 작성하지 못했습니다. 작업 결과는 저장되어 있습니다.`
      : `${cause} 작업을 더 진행하지 못했습니다. 진행한 내용은 저장되어 있습니다.`;
  }
  return workCompleted
    ? `The work is complete, but ${cause} prevented the final explanation. The results are saved.`
    : `${cause} prevented further work. Progress is saved.`;
}

function failureCause(code: string, korean: boolean): string {
  switch (code) {
    case "provider_rate_limited":
      return korean ? "모델 제공자의 요청 한도에 걸려" : "The model provider's rate limit";
    case "provider_quota_exhausted":
      return korean ? "모델 제공자의 사용량 한도가 소진되어" : "The model provider's exhausted quota";
    case "provider_auth_error":
      return korean ? "모델 제공자 인증에 실패해" : "A model provider authentication failure";
    case "provider_network_error":
    case "provider_stream_interrupted":
      return korean ? "모델과의 연결이 끊겨" : "An interrupted model connection";
    case "provider_round_timeout":
    case "provider_timeout":
      return korean ? "모델의 응답을 받지 못해" : "A model response timeout";
    case "provider_empty_response":
      return korean ? "모델이 답변을 반환하지 않아" : "An empty model response";
    case "provider_request_rejected":
    case "provider_bad_request":
      return korean ? "모델 제공자가 요청을 거부해" : "The model provider's request rejection";
    case "provider_api_error":
      return korean ? "모델 제공자에서 오류가 발생해" : "A model provider error";
    default:
      return korean ? "실행 중 오류가 발생해" : "An execution error";
  }
}
