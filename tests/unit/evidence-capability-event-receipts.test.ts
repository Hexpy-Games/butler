import { expect, test } from "bun:test";
import {
  browserObservationCapabilityReceipt,
  commandExecutionCapabilityReceipt,
  reviewCapabilityReceipt,
  validationCapabilityReceipt,
} from "../../packages/butler-agent/src/agent/output/evidence-capability-ledger.ts";

test("command execution receipts record success failure partial and skipped outcomes", () => {
  const receipts = [
    commandExecutionCapabilityReceipt({
      producer: { kind: "tool", name: "run_command" },
      success: true,
      exitCode: 0,
      timedOut: false,
    }),
    commandExecutionCapabilityReceipt({
      producer: { kind: "tool", name: "run_command" },
      success: false,
      exitCode: 2,
      timedOut: false,
    }),
    commandExecutionCapabilityReceipt({
      producer: { kind: "tool", name: "run_command" },
      success: false,
      exitCode: null,
      timedOut: true,
    }),
    commandExecutionCapabilityReceipt({
      producer: { kind: "tool", name: "run_command" },
      success: false,
      exitCode: null,
      timedOut: false,
      skipped: true,
    }),
  ];

  expect(receipts.map((receipt) => receipt.scope?.status)).toEqual([
    "succeeded",
    "failed",
    "timed_out",
    "skipped",
  ]);
  expect(receipts.map((receipt) => receipt.maturity)).toEqual([
    "verified",
    "rejected",
    "candidate",
    "rejected",
  ]);
});

test("validation receipts record success failure partial and skipped outcomes", () => {
  const receipts = [
    validationCapabilityReceipt({
      producer: { kind: "runtime", name: "validation-gate" },
      suite: "unit",
      result: "passed",
    }),
    validationCapabilityReceipt({
      producer: { kind: "runtime", name: "validation-gate" },
      suite: "lint",
      result: "failed",
      failureSummary: "lint exited with status 1",
    }),
    validationCapabilityReceipt({
      producer: { kind: "runtime", name: "validation-gate" },
      suite: "typecheck",
      result: "partial",
      failureSummary: "typecheck output was incomplete",
    }),
    validationCapabilityReceipt({
      producer: { kind: "runtime", name: "validation-gate" },
      suite: "e2e",
      result: "skipped",
      failureSummary: "browser dependency unavailable",
    }),
  ];

  expect(receipts.map((receipt) => receipt.scope?.result)).toEqual([
    "passed",
    "failed",
    "partial",
    "skipped",
  ]);
  expect(receipts[1].scope).toMatchObject({ failure_summary: "lint exited with status 1" });
  expect(receipts.map((receipt) => receipt.maturity)).toEqual([
    "verified",
    "rejected",
    "candidate",
    "rejected",
  ]);
});

test("event receipt limitations are sanitized before becoming public evidence", () => {
  const receipt = browserObservationCapabilityReceipt({
    producer: { kind: "tool", name: "browser" },
    result: "failed",
    observation: "browser failed",
    limitations: [
      "token=secret-value",
      "failed at /Users/example/private/page.html",
    ],
  });

  expect(JSON.stringify(receipt.limitations)).not.toContain("secret-value");
  expect(JSON.stringify(receipt.limitations)).not.toContain("/Users/example");
});

test("browser observation receipts record outcomes and limitations", () => {
  const receipts = [
    browserObservationCapabilityReceipt({
      producer: { kind: "tool", name: "browser" },
      result: "observed",
      observation: "checkout button rendered",
    }),
    browserObservationCapabilityReceipt({
      producer: { kind: "tool", name: "browser" },
      result: "partial",
      observation: "page loaded but screenshot was clipped",
      limitations: ["Viewport only covered the upper panel."],
    }),
    browserObservationCapabilityReceipt({
      producer: { kind: "tool", name: "browser" },
      result: "failed",
      observation: "browser target failed",
      limitations: ["Browser returned an error state."],
    }),
    browserObservationCapabilityReceipt({
      producer: { kind: "tool", name: "browser" },
      result: "skipped",
      observation: "browser validation skipped",
      limitations: ["No browser target was available."],
    }),
  ];

  expect(receipts.map((receipt) => receipt.capability)).toEqual([
    "browser_observed",
    "browser_observed",
    "browser_observed",
    "browser_observed",
  ]);
  expect(receipts[1]).toMatchObject({
    maturity: "candidate",
    limitations: ["Viewport only covered the upper panel."],
  });
  expect(receipts[2]).toMatchObject({ maturity: "rejected", verified: false });
  expect(receipts[3]).toMatchObject({ maturity: "rejected", verified: false });
});

test("review receipts record outcomes and limitations", () => {
  const receipts = [
    reviewCapabilityReceipt({
      producer: { kind: "worker", name: "implementation-review" },
      result: "completed",
      outcome: "no blockers",
    }),
    reviewCapabilityReceipt({
      producer: { kind: "worker", name: "implementation-review" },
      result: "changes_requested",
      outcome: "tests need stronger assertions",
      limitations: ["Review requires remediation before completion."],
    }),
    reviewCapabilityReceipt({
      producer: { kind: "worker", name: "implementation-review" },
      result: "partial",
      outcome: "review could not cover every criterion",
      limitations: ["One criterion had incomplete evidence."],
    }),
    reviewCapabilityReceipt({
      producer: { kind: "worker", name: "implementation-review" },
      result: "blocked",
      outcome: "review blocked",
      limitations: ["Required evidence was unavailable."],
    }),
    reviewCapabilityReceipt({
      producer: { kind: "worker", name: "implementation-review" },
      result: "skipped",
      outcome: "review skipped",
      limitations: ["Reviewer was unavailable."],
    }),
  ];

  expect(receipts.map((receipt) => receipt.scope?.result)).toEqual([
    "completed",
    "changes_requested",
    "partial",
    "blocked",
    "skipped",
  ]);
  expect(receipts[0]).toMatchObject({ maturity: "verified", verified: true });
  expect(receipts[1]).toMatchObject({ maturity: "candidate", verified: false });
  expect(receipts[2]).toMatchObject({ maturity: "candidate", verified: false });
  expect(receipts[3]).toMatchObject({ maturity: "rejected", verified: false });
  expect(receipts[4].limitations).toEqual(["Reviewer was unavailable."]);
});
