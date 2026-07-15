import { createHash } from "node:crypto";

export const BTCC_LEDGER_AUTHORING_CONTRACT_VERSION = 1;

export interface BtccLedgerAuthoringContract {
  recordKind: "spec" | "plan" | "work" | "task" | "attempt";
  purpose: string;
  requiredSections: string[];
  invariants: string[];
  completionEvidence: string[];
}

export interface BtccLedgerAuthoringBundle {
  version: number;
  contractHash: string;
  dependencyOrder: Array<"spec" | "plan" | "work" | "task" | "attempt">;
  contracts: BtccLedgerAuthoringContract[];
}

const CONTRACTS: BtccLedgerAuthoringContract[] = [
  {
    recordKind: "spec",
    purpose: "Define the stable product and behavioral contract before implementation choices.",
    requiredSections: [
      "problem and intended outcome",
      "in-scope and explicit non-goals",
      "normative behavioral contract and state transitions",
      "acceptance scenarios including negative and recovery cases",
      "evidence and validation method",
    ],
    invariants: [
      "Describe observable behavior and authority boundaries, not a transcript of implementation steps.",
      "Every normative requirement must be reviewable against an acceptance scenario.",
      "Do not specialize the contract to one phrase, tool name, provider response, or previously seen failure instance.",
    ],
    completionEvidence: [
      "canonical spec record exists",
      "acceptance scenarios cover the declared contract",
      "Project Ledger check passes",
    ],
  },
  {
    recordKind: "plan",
    purpose: "Translate one accepted spec into an ordered, evidence-producing delivery strategy.",
    requiredSections: [
      "governing spec and GoalContract references",
      "task graph, dependencies, and accepted authority",
      "coverage of every goal and governing-contract obligation",
      "validation, review, recovery, and closeout strategy",
    ],
    invariants: [
      "Planning may not reinterpret the goal or perform deliverable work.",
      "Every task must be dependency-ready, bounded, and independently reviewable.",
      "Evidence gaps and authority waits have exact owners; retry counts are never plan semantics.",
    ],
    completionEvidence: [
      "coverage matrix is complete",
      "task graph is acyclic and capability-feasible",
      "tracking materialization and Project Ledger check pass",
    ],
  },
  {
    recordKind: "work",
    purpose: "Create one outcome-oriented delivery slice governed by a spec.",
    requiredSections: [
      "governing spec reference",
      "bounded outcome and scope",
      "dependencies and sequencing constraints",
      "work-level acceptance and validation evidence",
    ],
    invariants: [
      "A work item is a coherent deliverable, not a catch-all project or a single mechanical command.",
      "Split independently reviewable or independently releasable outcomes into separate work items.",
      "Do not duplicate the full spec; reference it and record only delivery-specific decisions.",
    ],
    completionEvidence: [
      "all owned tasks are terminal with accepted evidence",
      "work-level review and validation are recorded",
      "implementation and Ledger commit evidence are linked when required",
    ],
  },
  {
    recordKind: "task",
    purpose: "Assign one atomic, executable, independently reviewable unit of work.",
    requiredSections: [
      "parent work and governing spec references",
      "single objective and admitted scope",
      "inputs, outputs, dependencies, and authority",
      "acceptance criteria and exact evidence to collect",
      "review criteria and rollback or continuation owner",
    ],
    invariants: [
      "One task has one primary objective and one evidence boundary.",
      "A task must be executable without rediscovering product intent from the raw user message.",
      "Do not mark completion from model prose; attach current artifact or validation evidence.",
    ],
    completionEvidence: [
      "task acceptance is satisfied",
      "independent review evidence is attached",
      "the parent work state is reconciled",
    ],
  },
  {
    recordKind: "attempt",
    purpose: "Record one concrete execution try for a task without changing the task contract.",
    requiredSections: [
      "parent task reference",
      "starting authority and input revision",
      "execution result and produced evidence",
      "interruption, wait, or ReturnTicket reason when not yet complete",
    ],
    invariants: [
      "An attempt is append-only execution history, not a replacement task or hidden plan revision.",
      "Runtime interruption preserves task ownership and records resumable state; it does not imply task failure.",
      "A semantic gap returns to its owning phase instead of being converted into repeated attempts.",
    ],
    completionEvidence: [
      "attempt state matches its recorded result",
      "produced evidence refs are durable",
      "the task remains active, completed, waiting, or cancelled according to authoritative state",
    ],
  },
];

export function btccLedgerAuthoringBundle(): BtccLedgerAuthoringBundle {
  const dependencyOrder = ["spec", "plan", "work", "task", "attempt"] as const;
  const payload = {
    version: BTCC_LEDGER_AUTHORING_CONTRACT_VERSION,
    dependencyOrder,
    contracts: CONTRACTS,
  };
  return {
    ...payload,
    dependencyOrder: [...dependencyOrder],
    contracts: CONTRACTS.map((contract) => ({
      ...contract,
      requiredSections: [...contract.requiredSections],
      invariants: [...contract.invariants],
      completionEvidence: [...contract.completionEvidence],
    })),
    contractHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}
