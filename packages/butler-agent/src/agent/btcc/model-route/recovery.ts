import {
  ModelProviderRequestError,
  normalizeLegacyProviderRequestError,
} from "../../../integrations/providers/provider-errors.ts";
import {
  modelApiRetryDelayMs,
  sleep,
} from "../../../integrations/providers/shared/environment.ts";
import { classifyModelRouteFailure } from "./failure-policy.ts";
import {
  ModelRouteDispatchLimitError,
  type ModelRouteFailureDisposition,
  type ModelRouteRecoveryUpdate,
} from "./contracts.ts";

export type NormalizedModelRouteFailure = {
  error: unknown;
  disposition: ModelRouteFailureDisposition;
  errorCode: string;
};

export function normalizeModelRouteFailure(
  error: unknown,
): NormalizedModelRouteFailure {
  const normalized = normalizeLegacyProviderRequestError(error) ?? error;
  return {
    error: normalized,
    disposition: classifyModelRouteFailure(normalized),
    errorCode: normalized instanceof ModelProviderRequestError
      ? normalized.code
      : normalized instanceof ModelRouteDispatchLimitError
        ? normalized.code
        : "provider_unknown_error",
  };
}

export function createModelRouteRecovery(input: {
  maxAttempts: number;
  signal?: AbortSignal;
  retryDelayMs?: (retryIndex: number) => number;
  onChanged?: (update: ModelRouteRecoveryUpdate) => void | Promise<void>;
}) {
  let active = false;
  const notify = (
    status: ModelRouteRecoveryUpdate["status"],
    attempt: number,
    modelRef: string,
    errorCode?: string,
  ) => input.onChanged?.({
    status,
    attempt,
    maxAttempts: input.maxAttempts,
    modelRef,
    ...(errorCode ? { errorCode } : {}),
  });
  return {
    async wait(attempt: number, modelRef: string, errorCode: string) {
      active = true;
      await notify("recovering", attempt, modelRef, errorCode);
      await sleep(
        input.retryDelayMs?.(attempt - 1) ?? modelApiRetryDelayMs(attempt - 1),
        input.signal,
      );
    },
    async clear(attempt: number, modelRef: string, errorCode?: string) {
      if (!active) return;
      active = false;
      await notify("cleared", attempt, modelRef, errorCode);
    },
    async interrupt(attempt: number, modelRef: string, errorCode: string) {
      active = false;
      await notify("interrupted", attempt, modelRef, errorCode);
    },
  };
}
