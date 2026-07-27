import { expect, test } from "bun:test";
import { recoverableLimitedDeliveryForError } from "../../packages/butler-agent/src/agent/turn/recoverable-delivery.ts";
import {
  classifyRuntimeFailureDelivery,
  isUserFacingFailureDelivery,
} from "../../packages/butler-agent/src/agent/turn/runtime-delivery-state.ts";
import { appSafeResponderError } from "../../packages/butler-agent/src/gateways/app/infrastructure/transport/failure-ux-contract.ts";
import {
  providerHttpError,
  providerNetworkError,
  safeRuntimeFailure,
} from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";

const codedError = (message: string, code: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

test("provider HTTP failures normalize Retry-After and reset headers", () => {
  const before = Date.now();
  const retryAfter = providerHttpError({
    provider: "zai",
    api: "chat_completions",
    statusCode: 429,
    headers: new Headers({ "Retry-After": "60" }),
  });
  expect(Date.parse(retryAfter.retryAt ?? "")).toBeGreaterThanOrEqual(before + 60_000);

  const resetAt = Math.ceil((Date.now() + 90_000) / 1_000);
  const reset = providerHttpError({
    provider: "zai",
    api: "chat_completions",
    statusCode: 429,
    headers: new Headers({ "X-RateLimit-Reset": String(resetAt) }),
  });
  expect(reset.retryAt).toBe(new Date(resetAt * 1_000).toISOString());
});

test("runtime delivery taxonomy preserves operational failures with exact safe codes", () => {
  const cases = [
    {
      label: "provider authentication",
      error: providerHttpError({
        provider: "openai",
        api: "responses",
        statusCode: 401,
      }),
      code: "provider_auth_error",
    },
    {
      label: "provider rate limit",
      error: providerHttpError({
        provider: "openai",
        api: "responses",
        statusCode: 429,
      }),
      code: "provider_rate_limited",
    },
    { label: "provider rate limit status only", error: { message: "Provider returned HTTP 429.", statusCode: 429 }, code: "provider_rate_limited" },
    {
      label: "provider service",
      error: providerHttpError({
        provider: "openai",
        api: "responses",
        statusCode: 503,
      }),
      code: "provider_api_error",
    },
    { label: "provider service status only", error: { message: "Provider returned HTTP 503.", statusCode: 503 }, code: "provider_api_error" },
    {
      label: "provider network",
      error: providerNetworkError({
        provider: "openai",
        api: "responses",
        error: new Error("fetch failed token=secret"),
      }),
      code: "provider_network_error",
    },
    { label: "service communication", error: { code: "service_communication_failed", message: "App service communication failed." }, code: "service_communication_failed" },
    {
      label: "app service communication error",
      error: codedError("App gateway service communication failed.", "service_communication_error"),
      code: "service_communication_error",
    },
    { label: "storage unavailable", error: { code: "gateway_storage_unavailable", message: "Gateway storage unavailable." }, code: "gateway_storage_unavailable" },
    {
      label: "runtime storage unavailable",
      error: codedError("Runtime storage is unavailable.", "runtime_storage_unavailable"),
      code: "runtime_storage_unavailable",
    },
    { label: "hard timeout", error: { code: "hard_timeout", message: "Runtime hit the hard timeout." }, code: "hard_timeout" },
    {
      label: "turn hard timeout",
      error: codedError("Turn hard timeout exceeded.", "turn_hard_timeout"),
      code: "turn_hard_timeout",
    },
    { label: "policy denial", error: { code: "policy_denied", message: "Policy denied this request." }, code: "policy_denied" },
  ];

  for (const item of cases) {
    const classified = classifyRuntimeFailureDelivery(item.error);
    expect(classified, item.label).toMatchObject({
      delivery_state: "failed_system",
      terminal: true,
      issue_kind: "system_failure",
      visibility: "failure_notice",
      failure_notice: true,
      safe_error_code: item.code,
    });
    expect(isUserFacingFailureDelivery(classified), item.label).toBe(true);
    expect(recoverableLimitedDeliveryForError(item.error), item.label).toBeNull();
  }
});

test("runtime delivery taxonomy fails live ownerless gaps without inferring continuation", () => {
  const cases = [
    {
      label: "disabled tool",
      error: {
        code: "disabled_tool",
        message: "disabled tool web_search; tool is not active in the current surface",
      },
      state: "failed_system",
      terminal: true,
      issueKind: "system_failure",
      visibility: "failure_notice",
      failureNotice: true,
    },
    {
      label: "missing evidence",
      error: {
        code: "missing_evidence",
        message: "missing evidence receipt for source_verified",
      },
      state: "failed_system",
      terminal: true,
      issueKind: "system_failure",
      visibility: "failure_notice",
      failureNotice: true,
    },
    {
      label: "disabled tool with storage-like name",
      error: {
        code: "disabled_tool",
        message: "disabled tool storage_search is unavailable in the current surface",
      },
      state: "failed_system",
      terminal: true,
      issueKind: "system_failure",
      visibility: "failure_notice",
      failureNotice: true,
    },
    {
      label: "missing evidence with gateway-like name",
      error: {
        code: "missing_evidence",
        message: "missing evidence receipt for gateway_health unavailable",
      },
      state: "failed_system",
      terminal: true,
      issueKind: "system_failure",
      visibility: "failure_notice",
      failureNotice: true,
    },
  ];

  for (const item of cases) {
    const classified = classifyRuntimeFailureDelivery(item.error);
    expect(classified, item.label).toMatchObject({
      delivery_state: item.state,
      terminal: item.terminal,
      issue_kind: item.issueKind,
      visibility: item.visibility,
      failure_notice: item.failureNotice,
      limitation_codes: [],
      limitations: [],
    });
    expect(recoverableLimitedDeliveryForError(item.error), item.label).toBeNull();
  }

  const promptBudget = {
    code: "prompt_usage_model_call_budget_exhausted",
    message: "Prompt usage model-call budget exhausted before provider request",
  };
  expect(classifyRuntimeFailureDelivery(promptBudget)).toMatchObject({
    delivery_state: "failed_system",
    terminal: true,
    issue_kind: "system_failure",
    visibility: "failure_notice",
    safe_error_code: "prompt_usage_model_call_budget_exhausted",
    limitation_codes: [],
    limitations: [],
  });
  expect(recoverableLimitedDeliveryForError(promptBudget)).toBeNull();
});

test("remote provider abort remains a provider failure, not user cancellation", () => {
  const providerAbort = {
    code: "provider_network_error",
    message: "Provider request aborted by remote connection reset.",
  };

  expect(classifyRuntimeFailureDelivery(providerAbort)).toMatchObject({
    delivery_state: "failed_system",
    terminal: true,
    issue_kind: "system_failure",
    visibility: "failure_notice",
    safe_error_code: "provider_network_error",
  });
  expect(safeRuntimeFailure(new Error(providerAbort.message))).toMatchObject({
    code: "provider_network_error",
    retryable: true,
  });

  const rawAbort = codedError(providerAbort.message, "ABORT_ERR");
  rawAbort.name = "AbortError";
  expect(classifyRuntimeFailureDelivery(rawAbort)).toMatchObject({
    delivery_state: "failed_system",
    safe_error_code: "provider_network_error",
  });
  expect(safeRuntimeFailure(rawAbort)).toMatchObject({
    code: "provider_network_error",
    retryable: true,
  });

  const userCancel = codedError("Runtime turn was cancelled.", "turn_cancelled");
  expect(classifyRuntimeFailureDelivery(userCancel)).toMatchObject({
    delivery_state: "cancelled",
    safe_error_code: "turn_cancelled",
  });
  expect(safeRuntimeFailure(userCancel)).toMatchObject({
    code: "turn_cancelled",
    retryable: false,
  });
});

test("app responder timeout remains a user-visible gateway error", () => {
  const timeout = new Error("timeout token=secret /Users/example/private");
  timeout.name = "AppResponderTimeoutError";
  (timeout as Error & { code?: string }).code = "gateway_timeout";

  const safe = appSafeResponderError(timeout);
  expect(safe).toEqual({
    code: "gateway_timeout",
    message: "Butler did not finish the turn before the app timeout.",
  });

  const classified = classifyRuntimeFailureDelivery(safe);
  expect(classified).toMatchObject({
    delivery_state: "failed_system",
    terminal: true,
    issue_kind: "system_failure",
    visibility: "failure_notice",
    safe_error_code: "gateway_timeout",
  });
});

test("safe runtime failure preserves operational taxonomy without swallowing internal recovery", () => {
  const cases = [
    {
      error: providerHttpError({
        provider: "openai",
        api: "responses",
        statusCode: 429,
      }),
      code: "provider_rate_limited",
      retryable: true,
      statusCode: 429,
    },
    {
      error: codedError("App gateway service communication failed.", "service_communication_error"),
      code: "service_communication_error",
      message: "Butler could not communicate with the app service.",
      retryable: false,
    },
    {
      error: new Error("Runtime storage unavailable while writing outbound event."),
      code: "runtime_storage_unavailable",
      message: "Butler runtime storage is unavailable.",
      retryable: false,
    },
    {
      error: codedError("Turn exceeded the hard timeout.", "turn_hard_timeout"),
      code: "turn_hard_timeout",
      message: "Butler hit the hard timeout before the turn completed.",
      retryable: false,
    },
    {
      error: new Error("Policy denied bridge invocation."),
      code: "policy_denied",
      message: "Butler policy denied this operation.",
      retryable: false,
    },
  ];

  for (const testCase of cases) {
    const { error: _error, ...expected } = testCase;
    expect(safeRuntimeFailure(testCase.error)).toMatchObject(expected);
  }

  const internalFailure = new Error("missing public completion obligation: source_verified");
  internalFailure.name = "GoalCompletionIncompleteError";
  expect(safeRuntimeFailure(internalFailure)).toMatchObject({
    code: "gateway_failed",
    message: "Butler could not complete this turn.",
    cause: "missing public completion obligation: source_verified",
    retryable: true,
  });
});
