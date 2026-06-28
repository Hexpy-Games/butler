import { expect, test } from "bun:test";
import {
  INTERNAL_RECOVERY_REQUIRED_CODE,
  internalRecoveryStateForFailure,
  isCompletionObligationProtocolMessage,
  isGoalCompletionIncompleteFailure,
  isInternalRecoveryFailure,
  isToolCallRepairFailure,
  safeInternalRecoveryMessage,
  toolCallRepairStateForFailure,
} from "../../packages/butler-agent/src/runtime/internal-recovery-failure.ts";
import { appSafeResponderError } from "../../packages/butler-agent/src/gateways/app/failure-ux-contract.ts";
import { safeRuntimeFailure } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";

test("internal recovery classifier centralizes goal completion protocol gaps", () => {
  const error = new Error(
    "The turn still needs repair for missing public completion obligation(s): durable_artifact.",
  );
  error.name = "GoalCompletionIncompleteError";

  expect(isGoalCompletionIncompleteFailure(error)).toBe(true);
  expect(isInternalRecoveryFailure(error)).toBe(true);
  expect(isCompletionObligationProtocolMessage(error.message)).toBe(true);
  expect(internalRecoveryStateForFailure(error)).toBe("needs_evidence");
  expect(safeInternalRecoveryMessage(error.message)).toBe(
    "Butler could not verify that the requested goal was completed.",
  );
  expect(safeRuntimeFailure(error)).toMatchObject({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: "Butler could not verify that the requested goal was completed.",
    retryable: true,
  });
  expect(appSafeResponderError(error)).toEqual({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: "진행한 내용은 보존했습니다. 다만 마지막 마무리 단계까지 완전히 닫지는 못했습니다.",
  });
});

test("runtime continuation classifier separates tool retry from completion continuation", () => {
  const disabledTool = {
    code: "disabled_tool",
    message: "disabled tool web_search; tool is not active in the current surface",
  };
  expect(isInternalRecoveryFailure(disabledTool)).toBe(false);
  expect(isToolCallRepairFailure(disabledTool)).toBe(true);
  expect(toolCallRepairStateForFailure(disabledTool)).toBe("needs_tool_surface");

  const invalidArguments = {
    code: "invalid_tool_arguments",
    message: "tool arguments failed validation",
  };
  expect(isInternalRecoveryFailure(invalidArguments)).toBe(false);
  expect(isToolCallRepairFailure(invalidArguments)).toBe(true);
  expect(toolCallRepairStateForFailure(invalidArguments)).toBe("needs_argument_repair");

  expect(internalRecoveryStateForFailure({
    code: "missing_evidence",
    message: "missing evidence receipt for source_verified",
  })).toBe("needs_evidence");

  expect(internalRecoveryStateForFailure({
    code: "prompt_usage_model_call_budget_exhausted",
    message: "Prompt usage model-call budget exhausted before provider request",
  })).toBe("recovering_internal");
});

test("provider and app projections use the full shared internal recovery classifier", () => {
  const protocolGap = "The turn still needs repair for missing public completion obligation(s): durable_artifact.";
  expect(safeRuntimeFailure(protocolGap)).toMatchObject({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: "Butler could not verify that the requested goal was completed.",
    retryable: true,
  });
  expect(appSafeResponderError(protocolGap)).toEqual({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: "진행한 내용은 보존했습니다. 다만 마지막 마무리 단계까지 완전히 닫지는 못했습니다.",
  });

  const disabledTool = {
    code: "disabled_tool",
    message: "disabled tool web_read; tool is not active in the current surface",
  };
  expect(safeRuntimeFailure(disabledTool)).toMatchObject({
    code: "disabled_tool",
    message: disabledTool.message,
    retryable: true,
  });
  expect(appSafeResponderError(disabledTool)).toEqual({
    code: "disabled_tool",
    message: disabledTool.message,
    cause: disabledTool.message,
  });

  const missingEvidence = {
    code: "missing_evidence",
    message: "missing evidence receipt for source_verified",
  };
  expect(safeRuntimeFailure(missingEvidence)).toMatchObject({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: missingEvidence.message,
    retryable: true,
  });
  expect(appSafeResponderError(missingEvidence)).toEqual({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: missingEvidence.message,
  });

  const promptBudget = {
    code: "prompt_usage_model_call_budget_exhausted",
    message: "Prompt usage model-call budget exhausted before provider request",
  };
  expect(safeRuntimeFailure(promptBudget)).toMatchObject({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: "Butler could not verify that the requested goal was completed.",
    retryable: true,
  });
  expect(appSafeResponderError(promptBudget)).toEqual({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: "진행한 내용은 보존했습니다. 다음 요청에서 남은 작업을 이어갈 수 있습니다.",
  });
});

test("internal recovery safe message redacts secrets before provider and app projection", () => {
  const error = {
    code: "goal_completion_incomplete",
    message: "goal completion failed token=secret /Users/example/private.json",
  };

  expect(isGoalCompletionIncompleteFailure(error)).toBe(true);
  expect(safeInternalRecoveryMessage(error.message)).not.toContain("token=secret");
  expect(safeRuntimeFailure(error)).toMatchObject({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: "Butler could not verify that the requested goal was completed.",
  });
  expect(appSafeResponderError(error)).toEqual({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
    message: "Butler could not verify that the requested goal was completed.",
  });
});
