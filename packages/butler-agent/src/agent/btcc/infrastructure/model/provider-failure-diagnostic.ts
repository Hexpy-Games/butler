import type { ModelProviderRequestError } from
  "../../../../integrations/providers/provider-errors.ts";
import {
  decodeOperationalDiagnostic,
  type OperationalDiagnostic,
} from "../../recovery/index.ts";

export function providerFailureDiagnostic(
  error: ModelProviderRequestError,
): OperationalDiagnostic {
  const diagnostic = error.diagnostic();
  const safe = decodeOperationalDiagnostic({
    schema: "btcc.operational-diagnostic.v1",
    kind: "provider_request",
    provider: diagnostic.provider ?? error.provider,
    api: diagnostic.api ?? error.api,
    retryable: diagnostic.retryable ?? error.retryable,
    ...(diagnostic.statusCode === undefined ? {} : { statusCode: diagnostic.statusCode }),
    ...(diagnostic.endpoint ? { endpoint: diagnostic.endpoint } : {}),
    ...(diagnostic.model ? { model: diagnostic.model } : {}),
    ...(diagnostic.retryAt ? { retryAt: diagnostic.retryAt } : {}),
    ...(diagnostic.providerRequestId
      ? { providerRequestId: diagnostic.providerRequestId }
      : {}),
    ...(diagnostic.requestGeneration === undefined
      ? {}
      : { requestGeneration: diagnostic.requestGeneration }),
    ...(diagnostic.measuredInputTokens === undefined
      ? {}
      : { measuredInputTokens: diagnostic.measuredInputTokens }),
    ...(diagnostic.registeredInputCapacity === undefined
      ? {}
      : { registeredInputCapacity: diagnostic.registeredInputCapacity }),
    ...(diagnostic.requestHash ? { requestHash: diagnostic.requestHash } : {}),
    ...(diagnostic.rateLimit ? { rateLimit: diagnostic.rateLimit } : {}),
  });
  return safe ?? {
    schema: "btcc.operational-diagnostic.v1",
    kind: "provider_request",
    provider: "model-provider",
    api: "model-api",
    retryable: error.retryable,
  };
}
