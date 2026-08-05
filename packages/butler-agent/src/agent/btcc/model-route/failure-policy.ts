import { ModelProviderRequestError } from "../../../integrations/providers/provider-errors.ts";
import type { ModelRouteFailureDisposition } from "./contracts.ts";

export function classifyModelRouteFailure(
  error: unknown,
): ModelRouteFailureDisposition {
  if (!(error instanceof ModelProviderRequestError)) return "surface";
  if (error.code === "provider_auth_error" ||
      error.code === "admission_invariant_violation" ||
      error.code === "provider_context_limit_exceeded" ||
      error.code === "provider_invalid_request" ||
      error.code === "provider_permission_error" ||
      error.code === "provider_safety_error") {
    return "surface";
  }
  if (error.code === "provider_protocol_error") return "retry";
  if (error.statusCode === 400 || error.statusCode === 409 || error.statusCode === 422) {
    return "surface";
  }
  if (error.statusCode === 402 || error.statusCode === 404 || error.statusCode === 410) {
    return "advance";
  }
  if (error.statusCode === 429) {
    const cause = error.causeMessage?.toLocaleLowerCase("en-US") ?? "";
    return /(?:insufficient[_ -]?quota|credit|billing|payment)/u.test(cause)
      ? "advance"
      : "retry";
  }
  if ((error.statusCode ?? 0) >= 500) return "retry";
  if (error.retryable) return "retry";
  return "advance";
}
