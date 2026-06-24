import { expect, test } from "bun:test";
import {
  completionObligationIncompleteReason,
  renderCompletionEvidenceForReview,
  requiredCompletionObligations,
  reviewCompletionObligations,
  unsatisfiedCompletionObligations,
} from "../../packages/butler-agent/src/agent/output/completion/obligation-review.ts";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/ledger.ts";
import type {
  PublicWorkDecision,
  ToolAuditEntry,
} from "../../packages/butler-agent/src/agent/turn/native/output/tool-types.ts";

test("completion obligation review collects unique obligations from public decisions", () => {
  expect(requiredCompletionObligations([
    decision("first", ["source_verified", "command_executed"]),
    decision("second", ["source_verified", "durable_artifact"]),
  ])).toEqual(["source_verified", "command_executed", "durable_artifact"]);
});

test("completion obligation review reports repair needs from capability ledger evidence", () => {
  const audit: ToolAuditEntry[] = [{
    name: "web_read",
    args: { url: "https://example.test/source" },
    ok: true,
    result: {
      ok: true,
      evidence_capability_receipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "web_read" },
        capability: "source_verified",
        evidence_kind: "source_page",
        summary: "The source page was read.",
        references: [{ url: "https://example.test/source" }],
        satisfies: ["source_verified"],
        created_at: "2026-06-23T09:00:00.000Z",
      })],
    },
  }];
  const decisions = [decision("chart", ["source_verified", "chart_rendered"])];

  expect(unsatisfiedCompletionObligations(audit, decisions)).toEqual(["chart_rendered"]);
  expect(completionObligationIncompleteReason({ audit, decisions }))
    .toBe("The turn still needs repair for missing public completion obligation(s): chart_rendered.");
});

test("completion obligation review distinguishes verified blockers from repairable missing evidence", () => {
  const audit: ToolAuditEntry[] = [{
    name: "web_read",
    args: { url: "https://example.test/private" },
    ok: true,
    result: {
      ok: false,
      evidence_capability_receipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "runtime", name: "completion_guard" },
        capability: "explicit_blocker",
        evidence_kind: "blocker",
        maturity: "verified",
        verified: true,
        confidence: 1,
        summary: "A private credential is required.",
        limitations: ["A user-owned credential is required."],
        created_at: "2026-06-23T09:01:00.000Z",
      })],
    },
  }];

  expect(completionObligationIncompleteReason({
    audit,
    decisions: [decision("private-source", ["source_verified"])],
  })).toBe("The turn is blocked by unresolved public completion obligation(s): source_verified.");
});

test("completion obligation review preserves limitation summaries from audit receipts", () => {
  const audit: ToolAuditEntry[] = [{
    name: "web_read",
    args: { url: "https://example.test/bounded" },
    ok: true,
    result: {
      ok: true,
      evidence_capability_receipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "web_read" },
        capability: "limitation_recorded",
        evidence_kind: "limitation",
        summary: "Only a bounded excerpt was retained.",
        limitations: ["Only a bounded excerpt was retained."],
        created_at: "2026-06-23T09:02:00.000Z",
      })],
    },
  }];

  const decisions = [decision("bounded-source", ["source_verified"])];
  const review = reviewCompletionObligations({
    audit,
    decisions,
  });

  expect(review.outcome).toBe("repair_request");
  expect(review.missingCritical).toEqual(["source_verified"]);
  expect(review.limitations).toEqual([
    "Only a bounded excerpt was retained.",
  ]);
  expect(renderCompletionEvidenceForReview(audit, decisions)).toContain(
    "  - Only a bounded excerpt was retained.",
  );
  expect(completionObligationIncompleteReason({
    audit,
    decisions,
  })).toBe("The turn still needs repair for missing public completion obligation(s): source_verified.");
});

function decision(
  decisionId: string,
  completionObligations: PublicWorkDecision["completionObligations"],
): PublicWorkDecision {
  return {
    decisionId,
    summary: "Review the required evidence.",
    completionObligations,
    evidenceRefs: [],
    source: "assistant-authored",
  };
}
