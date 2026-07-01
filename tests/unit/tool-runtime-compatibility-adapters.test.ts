import { expect, test } from "bun:test";
import {
  completionObligationIncompleteReason as completionObligationIncompleteReasonCompat,
  requiredCompletionObligations as requiredCompletionObligationsCompat,
  reviewCompletionObligations as reviewCompletionObligationsCompat,
  unsatisfiedCompletionObligations as unsatisfiedCompletionObligationsCompat,
} from "../../packages/butler-agent/src/agent/output/final-output-contract.ts";
import {
  completionObligationIncompleteReason,
  requiredCompletionObligations,
  reviewCompletionObligations,
  unsatisfiedCompletionObligations,
} from "../../packages/butler-agent/src/agent/output/completion/obligation-review.ts";
import {
  appLimitedDeliveryForError,
  appSafeResponderError,
} from "../../packages/butler-agent/src/gateways/app/infrastructure/transport/failure-ux-contract.ts";
import { recoverableLimitedDeliveryForError } from "../../packages/butler-agent/src/agent/turn/recoverable-delivery.ts";

test("final output contract preserves completion obligation compatibility exports", () => {
  expect(completionObligationIncompleteReasonCompat).toBe(completionObligationIncompleteReason);
  expect(requiredCompletionObligationsCompat).toBe(requiredCompletionObligations);
  expect(reviewCompletionObligationsCompat).toBe(reviewCompletionObligations);
  expect(unsatisfiedCompletionObligationsCompat).toBe(unsatisfiedCompletionObligations);

  const decisions = [{
    decisionId: "compat-source",
    summary: "Read a source.",
    completionObligations: ["source_verified" as const],
    evidenceRefs: [],
    source: "assistant-authored" as const,
  }];

  expect(completionObligationIncompleteReasonCompat({
    audit: [],
    decisions,
  })).toBe("The turn still needs repair for missing public completion obligation(s): source_verified.");
  expect(reviewCompletionObligationsCompat({
    audit: [],
    decisions,
  })).toMatchObject({
    outcome: "repair_request",
    missingCritical: ["source_verified"],
  });
});

test("app failure contract keeps live missing evidence out of public limited delivery", () => {
  const error = {
    code: "missing_evidence",
    message: "missing evidence receipt for source_verified",
  };

  expect(appLimitedDeliveryForError(error)).toBeNull();
  expect(recoverableLimitedDeliveryForError(error)).toBeNull();
  expect(appSafeResponderError(error)).toEqual({
    code: "gateway_failed",
    message: "Butler could not complete this turn.",
  });
});
