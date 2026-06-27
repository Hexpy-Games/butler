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
import { progressFinalizationText } from "../../packages/butler-agent/src/agent/output/completion/progress-finalization.ts";

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

  const normalizedRecovery = classifyRuntimeFailureDelivery({
    code: "internal_recovery_required",
    message: "Butler could not verify that the requested goal was completed.",
    retryable: true,
  });
  expect(normalizedRecovery).toMatchObject({
    delivery_state: "needs_evidence",
    terminal: false,
    issue_kind: "internal_recovery",
    visibility: "recovery_progress",
    failure_notice: false,
    limitation_codes: ["internal_recovery_required"],
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

test("recoverable delivery uses progress finalization instead of generic verification failure", () => {
  const error = new Error(
    "INCOMPLETE: raw prompt text token=abc123 /Users/example/.butler/private.json",
  );
  error.name = "GoalCompletionIncompleteError";
  Object.assign(error, {
    progressFinalizationText:
      "진행한 내용은 보존했습니다.\n\n확인된 진행사항:\n- 파일을 작성했습니다.\n\n남은 부분: 최종 보고 정리가 남아 있습니다.",
  });

  const recovered = recoverableLimitedDeliveryForError(error);

  expect(recovered).toMatchObject({
    delivery: {
      delivery_state: "delivered_with_limitations",
      visibility: "assistant_output",
      failure_notice: false,
    },
  });
  expect(recovered?.text).toContain("\n\n확인된 진행사항:\n- 파일을 작성했습니다.");
  expect(recovered?.text).not.toContain("could not verify");
  expect(JSON.stringify(recovered)).not.toContain("INCOMPLETE");
  expect(JSON.stringify(recovered)).not.toContain("abc123");
  expect(JSON.stringify(recovered)).not.toContain("/Users/example");
});

test("recoverable delivery converts normalized internal recovery failures", () => {
  const recovered = recoverableLimitedDeliveryForError({
    code: "internal_recovery_required",
    message: "Butler could not verify that the requested goal was completed.",
    retryable: true,
  });

  expect(recovered).toMatchObject({
    text:
      "진행한 내용은 보존했습니다. 다만 마지막 마무리 단계까지 완전히 닫지는 못했습니다.\n\n남은 부분: 완료 보고에 필요한 마지막 결과 정리가 남아 있습니다.\n다음 진행에서는 이 지점부터 이어가면 됩니다.",
    delivery: {
      delivery_state: "delivered_with_limitations",
      limitation_codes: ["internal_recovery_required"],
      visibility: "assistant_output",
      failure_notice: false,
    },
  });
  expect(JSON.stringify(recovered)).not.toContain("requested goal was completed");
});

test("progress finalization renders public tool labels without protocol names", () => {
  const text = progressFinalizationText({
    language: "ko",
    previousAnswer: "",
    audit: [{
      name: "run_command",
      args: {},
      ok: true,
      result: {
        ok: true,
        written_file: "reports/generated.txt",
      },
    }],
    decisions: [],
    reason: "missing public completion obligation: durable_artifact",
  });

  expect(text).toContain("명령 실행 결과로 reports/generated.txt 상태를 확인했습니다.");
  expect(text).not.toContain("run_command");
  expect(text).not.toContain("durable_artifact");
});
