import { expect, test } from "bun:test";
import {
  ModelProviderRequestError,
  type RuntimeFailureDiagnostic,
} from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { classifyModelRouteFailure } from "../../packages/butler-agent/src/agent/btcc/model-route/failure-policy.ts";

function providerFailure(
  input: Pick<RuntimeFailureDiagnostic, "code"> &
    Partial<
      Pick<RuntimeFailureDiagnostic, "statusCode" | "retryable" | "cause">
    >,
): ModelProviderRequestError {
  return new ModelProviderRequestError({
    provider: "test-provider",
    api: "responses",
    message: input.code,
    ...input,
  });
}

test("classifies provider HTTP failures with an explicit safe allow-list", () => {
  const cases: Array<{
    label: string;
    statusCode: number;
    expected: "retry" | "advance" | "surface";
  }> = [
    { label: "bad request", statusCode: 400, expected: "surface" },
    { label: "unauthorized", statusCode: 401, expected: "surface" },
    { label: "forbidden", statusCode: 403, expected: "surface" },
    { label: "method not allowed", statusCode: 405, expected: "surface" },
    { label: "not acceptable", statusCode: 406, expected: "surface" },
    { label: "conflict", statusCode: 409, expected: "surface" },
    { label: "unsupported media type", statusCode: 415, expected: "surface" },
    { label: "unprocessable entity", statusCode: 422, expected: "surface" },
    { label: "payment required", statusCode: 402, expected: "advance" },
    { label: "not found", statusCode: 404, expected: "advance" },
    { label: "gone", statusCode: 410, expected: "advance" },
    { label: "request timeout", statusCode: 408, expected: "retry" },
    { label: "rate limit", statusCode: 429, expected: "retry" },
    { label: "server error", statusCode: 500, expected: "retry" },
    { label: "bad gateway", statusCode: 502, expected: "retry" },
    { label: "service unavailable", statusCode: 503, expected: "retry" },
    { label: "gateway timeout", statusCode: 504, expected: "retry" },
    { label: "unknown server error", statusCode: 599, expected: "retry" },
    { label: "unknown client error", statusCode: 418, expected: "surface" },
  ];

  for (const testCase of cases) {
    expect(
      classifyModelRouteFailure(
        providerFailure({
          code: "provider_api_error",
          statusCode: testCase.statusCode,
          retryable: testCase.expected === "retry",
        }),
      ),
      testCase.label,
    ).toBe(testCase.expected);
  }
});

test("advances permanently unavailable model and quota signals", () => {
  const codes = [
    "provider_quota_exhausted",
    "provider_model_not_found",
    "provider_model_retired",
    "provider_model_unavailable",
    "provider_unsupported_model",
  ];

  for (const code of codes) {
    expect(classifyModelRouteFailure(providerFailure({ code })), code).toBe(
      "advance",
    );
  }

  expect(
    classifyModelRouteFailure(
      providerFailure({
        code: "provider_api_error",
        statusCode: 429,
        cause: "insufficient quota for this account",
      }),
    ),
  ).toBe("advance");
});

test("retries explicitly classified transport and rate-limit failures", () => {
  const codes = [
    "provider_empty_response",
    "provider_network_error",
    "provider_protocol_error",
    "provider_rate_limited",
    "provider_round_timeout",
  ];

  for (const code of codes) {
    expect(
      classifyModelRouteFailure(providerFailure({ code, retryable: false })),
      code,
    ).toBe("retry");
  }
});

test("surfaces auth, request, safety, and unknown provider failures", () => {
  const surfaceCodes = [
    "admission_invariant_violation",
    "provider_auth_error",
    "provider_context_limit_exceeded",
    "provider_invalid_request",
    "provider_permission_error",
    "provider_safety_error",
  ];

  for (const code of surfaceCodes) {
    expect(classifyModelRouteFailure(providerFailure({ code })), code).toBe(
      "surface",
    );
  }

  expect(
    classifyModelRouteFailure(
      providerFailure({
        code: "provider_future_error",
        retryable: true,
      }),
    ),
  ).toBe("surface");
  expect(
    classifyModelRouteFailure(
      providerFailure({
        code: "provider_api_error",
        retryable: true,
      }),
    ),
  ).toBe("surface");
  expect(classifyModelRouteFailure(new Error("not a provider failure"))).toBe(
    "surface",
  );
});
