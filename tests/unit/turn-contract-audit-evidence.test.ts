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

test("an open bound plan prevents the final candidate from fabricating final-report evidence", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-turn-audit-"));
  tempDirs.push(butlerData);
  const store = new TurnContractStore(butlerData);
  const contract = store.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-open-plan-report",
      action: "start_work",
      target_project_id: "project-a",
      deliverables: ["code_change", "final_report"],
      public_summary: "Implement every planned item and report.",
    },
  }));
  const recorded = recordTurnContractAuditEvidence({
    butlerData,
    contract,
    finalCandidate: "Only the first implementation item is complete.",
    planClosureSatisfied: false,
    audit: [{
      name: "write_file",
      args: { path: "src/partial.ts" },
      ok: true,
      evidenceCapabilityReceipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "write_file" },
        capability: "workspace_mutated",
        evidence_kind: "mutation_result",
        summary: "Partial workspace change.",
      })],
    }],
  });

  expect(store.evidenceFor(recorded).map((receipt) => receipt.deliverable)).toEqual(["code_change"]);
  expect(recorded.state).not.toBe("satisfied");
});

test("historical duplicate final-report obligations all close from one final candidate", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-turn-audit-duplicate-report-"));
  tempDirs.push(butlerData);
  const store = new TurnContractStore(butlerData);
  const compiled = compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-duplicate-final-report",
      action: "start_work",
      target_project_id: "project-a",
      deliverables: ["code_change", "final_report"],
      public_summary: "Implement and report the complete result.",
    },
  });
  const finalReport = compiled.required_evidence.find((item) => item.deliverable === "final_report")!;
  const contract = store.create({
    ...compiled,
    required_evidence: [...compiled.required_evidence, {
      ...finalReport,
      obligation_id: "obligation-historical-duplicate-final-report",
      generation: finalReport.generation + 1,
    }],
  });

  const recorded = recordTurnContractAuditEvidence({
    butlerData,
    contract,
    finalCandidate: "The implementation is complete.",
    planClosureSatisfied: true,
    audit: [{
      name: "write_file",
      args: { path: "src/complete.ts" },
      ok: true,
      evidenceCapabilityReceipts: [createEvidenceCapabilityReceipt({
        producer: { kind: "tool", name: "write_file" },
        capability: "workspace_mutated",
        evidence_kind: "mutation_result",
        summary: "Workspace file changed.",
      })],
    }],
  });
  const receipts = store.evidenceFor(recorded);

  expect(receipts.filter((receipt) => receipt.deliverable === "final_report")).toHaveLength(2);
  expect(canDeliverTurnContract({ contract: recorded, evidenceReceipts: receipts })).toBe("deliver");
});

test("Ledger integrity checks do not satisfy a project status snapshot", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-turn-audit-"));
  tempDirs.push(butlerData);
  const store = new TurnContractStore(butlerData);
  const contract = store.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-status-evidence",
      action: "inspect",
      target_project_id: "project-a",
      deliverables: ["status_report"],
      public_summary: "Inspect the current project status.",
    },
  }));

  const afterCheck = recordTurnContractAuditEvidence({
    butlerData,
    contract,
    finalCandidate: "The Ledger is structurally valid.",
    audit: [{ name: "project_ledger_check", args: {}, ok: true }],
  });
  expect(store.evidenceFor(afterCheck)).toEqual([]);

  const afterStatus = recordTurnContractAuditEvidence({
    butlerData,
    contract: afterCheck,
    finalCandidate: "The current project status is active.",
    audit: [{ name: "project_ledger_status", args: {}, ok: true }],
  });
  expect(store.evidenceFor(afterStatus).map((receipt) => receipt.deliverable)).toEqual(["status_report"]);
});

test("canonical Project Ledger evidence satisfies inherited resume obligations only", () => {
  const candidate = {
    workstreams: [{
      workstream_id: "ws-resume",
      state: "recoverable" as const,
      unsatisfied_obligations: [
        { deliverable: "ledger_work" as const, target_kind: "project" as const, target_id: "project-a", generation: 7 },
        { deliverable: "code_change" as const, target_kind: "workspace" as const, target_id: "project-a", generation: 7 },
        { deliverable: "validation" as const, target_kind: "workspace" as const, target_id: "project-a", generation: 7 },
        { deliverable: "review" as const, target_kind: "workspace" as const, target_id: "project-a", generation: 7 },
        { deliverable: "final_report" as const, target_kind: "report" as const, target_id: "ws-resume", generation: 7 },
      ],
    }],
  };
  const canonicalReceipts = [
    createEvidenceCapabilityReceipt({
      producer: { kind: "project_ledger", name: "project_ledger_show" },
      capability: "source_verified",
      evidence_kind: "project_state",
      summary: "Canonical work record was inspected.",
      scope: { record_kind: "work", record_id: "W-RESUME", status: "done" },
    }),
    createEvidenceCapabilityReceipt({
      producer: { kind: "project_ledger", name: "project_ledger_show" },
      capability: "workspace_mutated",
      evidence_kind: "mutation_result",
      summary: "Canonical work record contains implementation and commit evidence.",
      scope: { record_kind: "work", record_id: "W-RESUME", status: "done" },
    }),
    createEvidenceCapabilityReceipt({
      producer: { kind: "project_ledger", name: "project_ledger_show" },
      capability: "validation_passed",
      evidence_kind: "execution_result",
      summary: "Canonical work record contains validation evidence.",
      scope: { record_kind: "work", record_id: "W-RESUME", status: "done" },
    }),
    createEvidenceCapabilityReceipt({
      producer: { kind: "project_ledger", name: "project_ledger_show" },
      capability: "review_completed",
      evidence_kind: "review_result",
      summary: "Canonical work record contains review evidence.",
      scope: { record_kind: "work", record_id: "W-RESUME", status: "done" },
    }),
  ];
  const audit = [{
    name: "project_ledger_show",
    args: { kind: "work", id: "W-RESUME" },
    ok: true,
    evidenceCapabilityReceipts: canonicalReceipts,
  }];

  const resumeData = mkdtempSync(join(tmpdir(), "butler-turn-audit-resume-"));
  tempDirs.push(resumeData);
  const resumeStore = new TurnContractStore(resumeData);
  const resume = resumeStore.create(compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "decision-canonical-resume",
      action: "resume_work",
      target_workstream_id: "ws-resume",
      target_project_id: "project-a",
      deliverables: [],
      public_summary: "Resume the evidenced work and report.",
    },
    candidates: candidate,
  }));
  const resumed = recordTurnContractAuditEvidence({
    butlerData: resumeData,
    contract: resume,
    finalCandidate: "The previously implemented and validated work is complete.",
    planClosureSatisfied: true,
    runtimeReviewCompleted: false,
    audit,
  });
  expect(resumeStore.evidenceFor(resumed).map((receipt) => receipt.deliverable).sort()).toEqual([
    "code_change", "final_report", "ledger_work", "review", "validation",
  ]);
  expect(canDeliverTurnContract({
    contract: resumed,
    evidenceReceipts: resumeStore.evidenceFor(resumed),
  })).toBe("deliver");

  for (const action of ["start_work", "modify_work"] as const) {
    const butlerData = mkdtempSync(join(tmpdir(), `butler-turn-audit-${action}-`));
    tempDirs.push(butlerData);
    const store = new TurnContractStore(butlerData);
    const contract = store.create(compileTurnContract({
      decision: {
        schema_version: TURN_CONTRACT_DECISION_SCHEMA,
        decision_id: `decision-canonical-${action}`,
        action,
        ...(action === "modify_work" ? { target_workstream_id: "ws-resume" } : {}),
        target_project_id: "project-a",
        deliverables: action === "start_work"
          ? ["ledger_work", "code_change", "validation", "review"]
          : [],
        public_summary: "Perform new work.",
      },
      ...(action === "modify_work" ? { candidates: candidate } : {}),
    }));
    const recorded = recordTurnContractAuditEvidence({
      butlerData,
      contract,
      finalCandidate: "Candidate final.",
      runtimeReviewCompleted: false,
      audit,
    });
    expect(store.evidenceFor(recorded)).toEqual([]);
  }
});
