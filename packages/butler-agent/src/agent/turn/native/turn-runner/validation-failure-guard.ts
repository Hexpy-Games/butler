import type { ToolAuditEntry } from "../output/tool-types.ts";
import type { EvidenceCapabilityReceipt } from "../../../output/evidence/types.ts";

export interface UnresolvedValidationFailure {
  suite: string;
  result: string;
  summary: string;
}

export function unresolvedValidationFailureFromAudit(
  audit: ToolAuditEntry[],
): UnresolvedValidationFailure | null {
  const latestBySuite = new Map<string, UnresolvedValidationFailure | null>();
  const orderedSuites: string[] = [];
  for (const entry of audit) {
    for (const receipt of entry.evidenceCapabilityReceipts ?? []) {
      const validation = validationReceiptState(receipt);
      if (!validation) continue;
      if (!latestBySuite.has(validation.suite)) orderedSuites.push(validation.suite);
      latestBySuite.set(validation.suite, validation.passed ? null : {
        suite: validation.suite,
        result: validation.result,
        summary: receipt.summary,
      });
    }
  }
  for (const key of orderedSuites.reverse()) {
    const failure = latestBySuite.get(key);
    if (failure) return failure;
  }
  return null;
}

export function validationFailureContinuationPrompt(input: {
  objective: string;
  previousAnswer: string;
  failure: UnresolvedValidationFailure;
}): string {
  return [
    "## Validation Failure Continuation",
    "A validation receipt reports failure and there is no later passing receipt for the same validation suite.",
    "",
    "Failed validation:",
    `- suite: ${input.failure.suite}`,
    `- result: ${input.failure.result}`,
    `- summary: ${input.failure.summary}`,
    "",
    "Objective:",
    compact(input.objective, 600),
    "",
    "Previous draft:",
    compact(input.previousAnswer, 900),
    "",
    "Next action:",
    "- Do not deliver a final completion report yet.",
    "- Inspect the failed validation evidence using existing artifacts or a small targeted command.",
    "- Fix the cause when it is inside the workspace.",
    "- Re-run the validation and produce a passing validation receipt for the same suite.",
    "- If the blocker is external or cannot be fixed in this turn, leave the WorkStream recoverable and report the exact remaining validation failure.",
  ].join("\n");
}

function validationReceiptState(receipt: EvidenceCapabilityReceipt): {
  suite: string;
  result: string;
  passed: boolean;
} | null {
  if (receipt.capability !== "validation_passed") return null;
  const scope = receipt.scope ?? {};
  const suite = typeof scope.suite === "string" && scope.suite.trim()
    ? scope.suite.trim()
    : "";
  const result = typeof scope.result === "string" && scope.result.trim()
    ? scope.result.trim()
    : receipt.verified ? "passed" : "failed";
  if (!suite) return null;
  return {
    suite,
    result,
    passed: receipt.verified === true && result === "passed",
  };
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}...`;
}
