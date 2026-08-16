import { ModelProviderRequestError } from "../../../integrations/providers/provider-errors.ts";
import type { ModelRouteFailureDisposition } from "./contracts.ts";
import { StableProviderPrefixInvariantError } from "../ports/model-round.ts";

/**
 * Provider codes that represent a permanent model/capacity choice. These
 * consume the current candidate once and advance without same-model retry.
 * Keep this list explicit: a new provider code must not silently become a
 * fallback signal.
 */
const IMMEDIATE_ADVANCE_CODES = new Set([
  "provider_quota_exhausted",
  "provider_model_not_found",
  "provider_model_retired",
  "provider_model_unavailable",
  "provider_unsupported_model",
]);

/** Provider codes whose transport can be retried before route advance. */
const RETRY_CODES = new Set([
  "provider_empty_response",
  "provider_network_error",
  "provider_protocol_error",
  "provider_rate_limited",
  "provider_round_timeout",
  "provider_stream_interrupted",
]);

/** Provider codes that are unsafe to route around. */
const SURFACE_CODES = new Set([
  "admission_invariant_violation",
  "provider_auth_error",
  "provider_context_limit_exceeded",
  "provider_invalid_request",
  "provider_permission_error",
  "provider_safety_error",
]);

/** HTTP responses that identify a request/configuration contract failure. */
const SURFACE_STATUS_CODES = new Set([400, 401, 403, 405, 406, 409, 415, 422]);

export function classifyModelRouteFailure(
  error: unknown,
): ModelRouteFailureDisposition {
  if (error instanceof StableProviderPrefixInvariantError) return "surface";
  if (!(error instanceof ModelProviderRequestError)) return "surface";
  if (SURFACE_CODES.has(error.code)) return "surface";
  if (IMMEDIATE_ADVANCE_CODES.has(error.code)) return "advance";

  const status = error.statusCode;
  if (status !== undefined && SURFACE_STATUS_CODES.has(status)) return "surface";
  // Payment-required, not-found, and gone statuses are ambiguous without a
  // provider-declared model/quota code. A wrong endpoint or base URL must not
  // silently advance the route and hide configuration errors.
  if (status === 408) return "retry";
  if (status === 429 || error.code === "provider_rate_limited") return "retry";
  if (status !== undefined && status >= 500 && status <= 599) return "retry";
  if (RETRY_CODES.has(error.code)) return "retry";

  // Provider errors are an allow-list, not a fallback opt-in. Unknown codes,
  // statuses, and retryable flags must surface until explicitly classified.
  return "surface";
}
