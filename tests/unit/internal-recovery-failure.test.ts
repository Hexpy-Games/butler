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
import { appSafeResponderError } from "../../packages/butler-agent/src/gateways/app/infrastructure/transport/failure-ux-contract.ts";
import { safeRuntimeFailure } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";

test("internal recovery classifier centralizes goal completion protocol gaps", () => {
  const error = new Error(
    "The turn still needs repair for missing public completion obligation(s): durable_artifact.",
  );
  error.name = "GoalCompletionIncompleteError";

  expect(isGoalCompletionIncompleteFailure(error)).toBe(true);
  expect(isInternalRecoveryFailure(error)).toBe(false);
  expect(isCompletionObligationProtocolMessage(error.message)).toBe(true);
  expect(internalRecoveryStateForFailure(error)).toBe("needs_evidence");
  expect(safeInternalRecoveryMessage(error.message)).toBe(
    "Butler could not verify that the requested goal was completed.",
  );
  expect(safeRuntimeFailure(error).code).not.toBe(INTERNAL_RECOVERY_REQUIRED_CODE);
});

test("runtime continuation classifier separates tool retry from completion continuation", () => {
  const disabledTool = {
    code: "disabled_tool",
    message: "disabled tool web_search; tool is not active in the current surface",
  };
  expect(isInternalRecoveryFailure(disabledTool)).toBe(false);
  expect(isToolCallRepairFailure(disabledTool)).toBe(false);
  expect(toolCallRepairStateForFailure(disabledTool)).toBe("needs_tool_surface");

  const invalidArguments = {
    code: "invalid_tool_arguments",
    message: "tool arguments failed validation",
  };
  expect(isInternalRecoveryFailure(invalidArguments)).toBe(false);
  expect(isToolCallRepairFailure(invalidArguments)).toBe(false);
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
  expect(safeRuntimeFailure(protocolGap).code).not.toBe(INTERNAL_RECOVERY_REQUIRED_CODE);

  const disabledTool = {
    code: "disabled_tool",
    message: "disabled tool web_read; tool is not active in the current surface",
  };
  expect(safeRuntimeFailure(disabledTool).code).not.toBe("disabled_tool");

  const missingEvidence = {
    code: "missing_evidence",
    message: "missing evidence receipt for source_verified",
  };
  expect(safeRuntimeFailure(missingEvidence).code).not.toBe(INTERNAL_RECOVERY_REQUIRED_CODE);

  const promptBudget = {
    code: "prompt_usage_model_call_budget_exhausted",
    message: "Prompt usage model-call budget exhausted before provider request",
  };
  expect(safeRuntimeFailure(promptBudget).code).not.toBe(INTERNAL_RECOVERY_REQUIRED_CODE);
});

test("internal recovery safe message redacts secrets before provider and app projection", () => {
  const error = {
    code: "goal_completion_incomplete",
    message: "goal completion failed token=secret /Users/example/private.json",
  };

  expect(isGoalCompletionIncompleteFailure(error)).toBe(true);
  expect(safeInternalRecoveryMessage(error.message)).not.toContain("token=secret");
  expect(safeRuntimeFailure(error).message).not.toContain("token=secret");
});

test("legacy recovery classifiers require explicit historical diagnostic input", () => {
  expect(isInternalRecoveryFailure({
    historicalRecoveryState: true,
    code: "missing_evidence",
    message: "missing evidence receipt for source_verified",
  })).toBe(true);
  expect(isToolCallRepairFailure({
    historicalRecoveryState: true,
    code: "invalid_tool_arguments",
    message: "tool arguments failed validation",
  })).toBe(true);
  expect(appSafeResponderError({
    historicalRecoveryState: true,
    code: "goal_completion_incomplete",
    message: "could not verify that the requested goal was completed",
  })).toMatchObject({
    code: INTERNAL_RECOVERY_REQUIRED_CODE,
  });
});
