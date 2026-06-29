import type { RuntimeDeliveryFailureInput } from "./runtime-delivery-state.ts";

export function isOperationalFailure(failure: RuntimeDeliveryFailureInput): boolean {
  const message = failure.message ?? "";
  return (
    isExactOrStatusOperationalFailure(failure) ||
    /(?:HTTP\s+)?(?:401|403|429|504)\b/iu.test(message) ||
    /(?:provider|model|service|gateway|storage).*(?:failed|unavailable|timeout|timed out|connection|network)/iu
      .test(message) ||
    /policy (?:denied|denial|blocked|rejected)|hard timeout/iu.test(message)
  );
}

export function isExactOrStatusOperationalFailure(failure: RuntimeDeliveryFailureInput): boolean {
  const code = failure.code ?? "";
  return (
    failure.statusCode === 401 ||
    failure.statusCode === 403 ||
    failure.statusCode === 429 ||
    failure.statusCode === 408 ||
    failure.statusCode === 504 ||
    (typeof failure.statusCode === "number" && failure.statusCode >= 500) ||
    /^provider_(?:auth_error|rate_limited|api_error|network_error|empty_response|context_limit_exceeded)$/u.test(code) ||
    /^gateway_(?:failed|timeout|storage_unavailable|service_unavailable|service_communication_failed|service_communication_error)$/u.test(code) ||
    /^service_(?:communication_failed|communication_error|unavailable|storage_unavailable|auth_error)$/u.test(code) ||
    /^runtime_storage_(?:unavailable|corrupt)$/u.test(code) ||
    code === "policy_denied" ||
    code === "policy_denial" ||
    code === "hard_timeout" ||
    code === "turn_hard_timeout"
  );
}

export function operationalSafeErrorCode(failure: RuntimeDeliveryFailureInput): string {
  const message = failure.message ?? "";
  if (isNetworkFailureMessage(message)) return "provider_network_error";
  if (failure.code) return failure.code;
  if (failure.statusCode === 401 || failure.statusCode === 403) return "provider_auth_error";
  if (failure.statusCode === 429) return "provider_rate_limited";
  if (failure.statusCode === 408 || failure.statusCode === 504) return "gateway_timeout";
  if (typeof failure.statusCode === "number" && failure.statusCode >= 500) return "provider_api_error";
  if (/policy (?:denied|denial|blocked|rejected)/iu.test(message)) return "policy_denied";
  if (/hard timeout/iu.test(message)) return "hard_timeout";
  if (/runtime storage|storage (?:is )?(?:unavailable|corrupt)|database unavailable|sqlite/iu.test(message)) {
    return "runtime_storage_unavailable";
  }
  if (/app gateway service|service communication|service unavailable|gateway service unavailable/iu.test(message)) {
    return "service_communication_error";
  }
  if (/(?:HTTP\s+)?(?:401|403)\b/iu.test(message)) return "provider_auth_error";
  if (/(?:HTTP\s+)?429\b/iu.test(message)) return "provider_rate_limited";
  if (/(?:HTTP\s+)?(?:500|502|503|504)\b/iu.test(message)) return "provider_api_error";
  return "gateway_failed";
}

function isNetworkFailureMessage(message: string): boolean {
  return /Unable to connect|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network|connection termination|connection reset|disconnect\/reset|remote connection reset/iu
    .test(message);
}
