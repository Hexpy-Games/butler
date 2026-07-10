import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createEvidenceCapabilityReceipt } from "../../packages/butler-agent/src/agent/output/evidence/parser.ts";
import {
  canDeliverTurnContract,
  compileTurnContract,
  TURN_CONTRACT_DECISION_SCHEMA,
  TurnContractStore,
} from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import { recordTurnContractAuditEvidence } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-audit-evidence.ts";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

test("a performed runtime completion review satisfies review before final reporting", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-turn-audit-"));
  tempDirs.push(butlerData);
  const store = new TurnContractStore(butlerData);
  const contract = store.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-review",
      action: "start_work",
      target_project_id: "project-a",
      deliverables: ["code_change", "validation", "review", "final_report"],
      public_summary: "Implement, validate, review, and report the change.",
    },
  }));

  const recorded = recordTurnContractAuditEvidence({
    butlerData,
    contract,
    finalCandidate: "The implementation and validation are complete.",
    runtimeReviewCompleted: true,
    audit: [{
      name: "write_file",
      args: { path: "src/change.ts" },
      ok: true,
      evidenceCapabilityReceipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "write_file" },
        capability: "workspace_mutated",
        evidence_kind: "mutation_result",
        summary: "Workspace file changed.",
      })],
    }, {
      name: "run_command",
      args: { validation_suite: "unit" },
      ok: true,
      evidenceCapabilityReceipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "run_command" },
        capability: "validation_passed",
        evidence_kind: "execution_result",
        summary: "Validation passed.",
      })],
    }],
  });
  const receipts = store.evidenceFor(recorded);

  expect(receipts.map((receipt) => receipt.deliverable).sort()).toEqual([
    "code_change", "final_report", "review", "validation",
  ]);
  expect(canDeliverTurnContract({ contract: recorded, evidenceReceipts: receipts })).toBe("deliver");
});

test("a skipped runtime completion review does not fabricate review evidence", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-turn-audit-"));
  tempDirs.push(butlerData);
  const store = new TurnContractStore(butlerData);
  const contract = store.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-review-skip",
      action: "start_work",
      target_project_id: "project-a",
      deliverables: ["code_change", "review"],
      public_summary: "Implement and review the change.",
    },
  }));
  const recorded = recordTurnContractAuditEvidence({
    butlerData,
    contract,
    finalCandidate: "Candidate text.",
    runtimeReviewCompleted: false,
    audit: [{ name: "write_file", args: { path: "src/change.ts" }, ok: true }],
  });

  expect(store.evidenceFor(recorded).some((receipt) => receipt.deliverable === "review")).toBe(false);
});
