import { expect, test } from "bun:test";
import {
  classifyRuntimeFailureDelivery,
  deliveredDeliveryState,
  deliveredWithLimitationsState,
  isUserFacingFailureDelivery,
  recoveringInternalDeliveryState,
  waitingUserDeliveryState,
} from "../../packages/butler-agent/src/agent/turn/runtime-delivery-state.ts";
import { recoverableLimitedDeliveryForError } from "../../packages/butler-agent/src/agent/turn/recoverable-delivery.ts";

test("runtime delivery taxonomy maps normal and limited delivery as assistant output", () => {
  expect(deliveredDeliveryState()).toMatchObject({
    delivery_state: "delivered",
    terminal: true,
    issue_kind: "none",
    visibility: "assistant_output",
    failure_notice: false,
  });

  const limited = deliveredWithLimitationsState({
    limitationCodes: ["source_verified_missing"],
    limitations: ["Only candidate evidence was available."],
  });
  expect(limited).toMatchObject({
    delivery_state: "delivered_with_limitations",
    terminal: true,
    issue_kind: "limitation",
    visibility: "assistant_output",
    failure_notice: false,
    limitation_codes: ["source_verified_missing"],
    limitations: ["Only candidate evidence was available."],
  });
  expect(isUserFacingFailureDelivery(limited)).toBe(false);
});

test("runtime delivery taxonomy keeps repairable model and evidence gaps out of failure notices", () => {
  const goalError = new Error("missing public completion obligation: source_verified");
  goalError.name = "GoalCompletionIncompleteError";
  const goalGap = classifyRuntimeFailureDelivery(goalError);
  expect(goalGap).toMatchObject({
    delivery_state: "needs_evidence",
    terminal: false,
    issue_kind: "internal_recovery",
    visibility: "recovery_progress",
    failure_notice: false,
    limitation_codes: ["internal_recovery_required"],
  });

  const toolSurfaceGap = classifyRuntimeFailureDelivery({
    code: "unknown_tool",
    message: "unknown tool web_read; missing tool surface",
  });
  expect(toolSurfaceGap).toMatchObject({
    delivery_state: "needs_tool_surface",
    issue_kind: "internal_recovery",
    visibility: "recovery_progress",
    failure_notice: false,
  });

  const argumentGap = recoveringInternalDeliveryState({
    state: "needs_argument_repair",
    limitationCodes: ["invalid_tool_arguments"],
  });
  expect(argumentGap).toMatchObject({
    delivery_state: "needs_argument_repair",
    terminal: false,
    issue_kind: "internal_recovery",
    failure_notice: false,
    limitation_codes: ["invalid_tool_arguments"],
  });

  const uncertainty = classifyRuntimeFailureDelivery({
    code: "internal_uncertainty",
    message: "uncertain whether the requested goal was completed",
  });
  expect(uncertainty).toMatchObject({
    delivery_state: "recovering_internal",
    terminal: false,
    issue_kind: "internal_recovery",
    visibility: "recovery_progress",
    failure_notice: false,
    limitation_codes: ["internal_uncertainty"],
  });
});

test("runtime delivery taxonomy separates user blockers from system failures", () => {
  const denied = waitingUserDeliveryState({
    safeErrorCode: "permission_denied",
    limitations: ["Permission denied for workspace mutation."],
  });
  expect(denied).toMatchObject({
    delivery_state: "waiting_user",
    terminal: false,
    issue_kind: "user_action_blocker",
    visibility: "user_action_required",
    failure_notice: false,
    safe_error_code: "permission_denied",
  });

  const providerAuth = classifyRuntimeFailureDelivery({
    code: "provider_auth_error",
    message: "OpenAI authentication failed with HTTP 401.",
    statusCode: 401,
  });
  expect(providerAuth).toMatchObject({
    delivery_state: "failed_system",
    terminal: true,
    issue_kind: "system_failure",
    visibility: "failure_notice",
    failure_notice: true,
    safe_error_code: "provider_auth_error",
  });
  expect(isUserFacingFailureDelivery(providerAuth)).toBe(true);
});

test("runtime delivery taxonomy preserves cancellation as terminal cancellation", () => {
  const cancelled = classifyRuntimeFailureDelivery({
    code: "turn_cancelled",
    message: "Butler turn was cancelled.",
  });
  expect(cancelled).toMatchObject({
    delivery_state: "cancelled",
    terminal: true,
    issue_kind: "cancelled",
    visibility: "cancelled_notice",
    failure_notice: false,
    safe_error_code: "turn_cancelled",
  });
});

test("runtime delivery taxonomy redacts unsafe limitation text", () => {
  const limited = deliveredWithLimitationsState({
    limitations: ["raw prompt text token=abc123 <think>hidden</think> /Users/example/.butler/file"],
  });
  expect(JSON.stringify(limited)).not.toContain("abc123");
  expect(JSON.stringify(limited)).not.toContain("<think>");
  expect(JSON.stringify(limited)).not.toContain("/Users/example");
  expect(limited.limitations).toEqual(["A runtime limitation remained."]);

  const quoted = deliveredWithLimitationsState({
    limitations: [
      'Could not inspect path:"/Users/example/.butler/private.json".',
      "Could not inspect (C:\\Users\\example\\.butler\\private.json).",
    ],
  });
  expect(JSON.stringify(quoted)).not.toContain("/Users/example");
  expect(JSON.stringify(quoted)).not.toContain("C:\\Users\\example");
  expect(quoted.limitations).toEqual([
    "A runtime limitation remained.",
    "A runtime limitation remained.",
  ]);
});

test("recoverable delivery redacts unsafe goal completion text", () => {
  const error = new Error(
    "INCOMPLETE: raw prompt text token=abc123 /Users/example/.butler/private.json",
  );
  error.name = "GoalCompletionIncompleteError";

  const recovered = recoverableLimitedDeliveryForError(error);

  expect(recovered).toMatchObject({
    text:
      "Butler could not verify that the requested goal was completed with the available evidence.",
    delivery: {
      delivery_state: "delivered_with_limitations",
      visibility: "assistant_output",
      failure_notice: false,
    },
  });
  expect(JSON.stringify(recovered)).not.toContain("INCOMPLETE");
  expect(JSON.stringify(recovered)).not.toContain("abc123");
  expect(JSON.stringify(recovered)).not.toContain("/Users/example");
});
