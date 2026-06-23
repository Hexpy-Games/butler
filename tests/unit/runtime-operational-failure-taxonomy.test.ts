import { expect, test } from "bun:test";
import { recoverableLimitedDeliveryForError } from "../../packages/butler-agent/src/agent/turn/recoverable-delivery.ts";
import {
  classifyRuntimeFailureDelivery,
  isUserFacingFailureDelivery,
} from "../../packages/butler-agent/src/agent/turn/runtime-delivery-state.ts";
import { appSafeResponderError } from "../../packages/butler-agent/src/gateways/app/failure-ux-contract.ts";
import {
  providerHttpError,
  providerNetworkError,
  safeRuntimeFailure,
} from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";

const codedError = (message: string, code: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });

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

test("runtime delivery taxonomy keeps disabled tools and missing evidence recoverable", () => {
  const cases = [
    {
      label: "disabled tool",
      error: {
        code: "disabled_tool",
        message: "disabled tool web_search; tool is not active in the current surface",
      },
      state: "needs_tool_surface",
      code: "disabled_tool",
    },
    {
      label: "missing evidence",
      error: {
        code: "missing_evidence",
        message: "missing evidence receipt for source_verified",
      },
      state: "needs_evidence",
      code: "missing_evidence",
    },
    {
      label: "disabled tool with storage-like name",
      error: {
        code: "disabled_tool",
        message: "disabled tool storage_search is unavailable in the current surface",
      },
      state: "needs_tool_surface",
      code: "disabled_tool",
    },
    {
      label: "missing evidence with gateway-like name",
      error: {
        code: "missing_evidence",
        message: "missing evidence receipt for gateway_health unavailable",
      },
      state: "needs_evidence",
      code: "missing_evidence",
    },
  ];

  for (const item of cases) {
    const classified = classifyRuntimeFailureDelivery(item.error);
    expect(classified, item.label).toMatchObject({
      delivery_state: item.state,
      terminal: false,
      issue_kind: "internal_recovery",
      visibility: "recovery_progress",
      failure_notice: false,
      limitation_codes: [item.code],
    });
    expect(recoverableLimitedDeliveryForError(item.error), item.label).toMatchObject({
      delivery: {
        delivery_state: "delivered_with_limitations",
        visibility: "assistant_output",
        failure_notice: false,
        limitation_codes: [item.code],
      },
    });
  }
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
    code: "internal_recovery_required",
    retryable: true,
  });
});
