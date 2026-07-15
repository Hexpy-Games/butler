import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BLOCKER_EVIDENCE_RECEIPT_SCHEMA,
  canDeliverTurnContract,
  compileTurnContract,
  TURN_ACTION_DELIVERABLE_MATRIX,
  TURN_CONTRACT_DECISION_SCHEMA,
  TURN_EVIDENCE_RECEIPT_SCHEMA,
  TYPED_BLOCKER_SCHEMA,
  TurnContractStore,
  selectTurnDecisionTransport,
  wrapTextOnlyProviderAnswer,
  validateTurnContractDecision,
  type BlockerEvidenceReceipt,
  type CompiledTurnContract,
  type TurnContractCandidates,
  type TurnContractDecision,
  type TurnContractWorkstreamCandidate,
  type TurnDeliverable,
  type TurnEvidenceReceipt,
} from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import {
  compileStructuredTurnDecision,
  turnDecisionResponseFormat,
  typedTurnDecisionInstructions,
} from "../../packages/butler-agent/src/agent/turn/native/turn-runner/typed-turn-decision.ts";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function tempData(): string {
  const path = mkdtempSync(join(tmpdir(), "butler-turn-contract-"));
  tempDirs.push(path);
  return path;
}

function decision(overrides: Partial<TurnContractDecision> = {}): TurnContractDecision {
  const action = overrides.action ?? "inspect";
  return {
    schema_version: TURN_CONTRACT_DECISION_SCHEMA,
    decision_id: "decision-1",
    action,
    ...(action === "inspect" ? {
      target_project_id: "project-a",
      inspection_scope: "project" as const,
      deliverables: ["status_report" as const],
    } : action === "tool_answer" || action === "answer" || action === "cancel_work"
      ? { deliverables: [] }
      : { target_project_id: "workspace-a", deliverables: [] }),
    public_summary: "Inspect canonical status.",
    ...overrides,
  };
}

test("tool-assisted public answers are distinct from direct answers and inspection", () => {
  const contract = compileTurnContract({
    decision: decision({
      action: "tool_answer",
      target_project_id: undefined,
      inspection_scope: undefined,
      evidence_domain: "public_web",
      deliverables: ["grounded_answer"],
    }),
    obligationRequirements: {
      grounded_answer: {
        deliverable: "grounded_answer",
        target_kind: "public",
        target_id: "public-web",
        generation: 1,
      },
    },
  });

  expect(contract).toMatchObject({
    action: "tool_answer",
    evidence_domain: "public_web",
    tracking_mode: "none",
    closeout_strategy: "noop",
    terminal_rule: "grounded_answer",
    deliverables: ["grounded_answer"],
  });
  expect(contract.required_evidence[0]).toMatchObject({
    target_kind: "public",
    target_id: "public-web",
    evidence_class: "grounded_answer",
    allowed_producers: ["public_web"],
  });
  expect(() => compileTurnContract({
    decision: decision({
      action: "tool_answer",
      target_project_id: undefined,
      inspection_scope: undefined,
      deliverables: ["grounded_answer"],
    }),
  })).toThrow("turn_contract_tool_answer_domain_invalid");
  expect(() => compileTurnContract({
    decision: decision({
      action: "inspect",
      target_project_id: undefined,
      inspection_scope: undefined,
      deliverables: ["status_report"],
    }),
  })).toThrow("turn_contract_inspection_scope_missing");
});

test("structured compilation binds public, project, and workspace targets without sentinels", () => {
  const publicAnswer = compileStructuredTurnDecision({
    decision: decision({
      action: "tool_answer",
      target_project_id: undefined,
      inspection_scope: undefined,
      evidence_domain: "public_web",
      deliverables: ["grounded_answer"],
    }),
    candidates: {},
    workspaceId: "workspace-chat",
    projectId: "butler",
  });
  expect(publicAnswer.target_project_id).toBeUndefined();
  expect(publicAnswer.required_evidence[0]).toMatchObject({
    target_kind: "public",
    target_id: "public-web",
  });

  const workspaceInspect = compileStructuredTurnDecision({
    decision: decision({
      target_project_id: undefined,
      inspection_scope: "workspace",
    }),
    candidates: {},
    workspaceId: "workspace-chat",
    projectId: undefined,
  });
  expect(workspaceInspect.required_evidence[0]).toMatchObject({
    target_kind: "workspace",
    target_id: "workspace-chat",
  });

  const serialized = JSON.stringify([publicAnswer, workspaceInspect]);
  expect(serialized).not.toContain("active-project");
  expect(serialized).not.toContain('"target_id":"active"');
});

function candidate(overrides: Partial<TurnContractWorkstreamCandidate> = {}): TurnContractCandidates {
  return {
    workstreams: [{
      workstream_id: "ws-a",
      state: "recoverable",
      unsatisfied_obligations: [{
        deliverable: "code_change",
        target_kind: "workspace",
        target_id: "workspace-a",
        generation: 4,
      }],
      ...overrides,
    }],
  };
}

function receipt(contract: CompiledTurnContract, deliverable: TurnDeliverable, overrides: Partial<TurnEvidenceReceipt> = {}): TurnEvidenceReceipt {
  const obligation = contract.required_evidence.find((item) => item.deliverable === deliverable)!;
  return {
    schema_version: TURN_EVIDENCE_RECEIPT_SCHEMA,
    receipt_id: `receipt-${deliverable}`,
    contract_id: contract.contract_id,
    obligation_id: obligation.obligation_id,
    deliverable,
    target_kind: obligation.target_kind,
    target_id: obligation.target_id,
    obligation_generation: obligation.generation,
    verified: true,
    item_ids: [],
    producer: obligation.allowed_producers[0]!,
    evidence_class: obligation.evidence_class,
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

test("action matrix rejects every status-only execution action", () => {
  expect(TURN_ACTION_DELIVERABLE_MATRIX.inspect.allowed).toEqual(["status_report"]);
  for (const action of ["start_work", "resume_work", "modify_work"] as const) {
    const input = decision({ action, target_workstream_id: action === "start_work" ? undefined : "ws-a" });
    expect(() => compileTurnContract({ decision: input, candidates: candidate({ unsatisfied_obligations: [] }) }))
      .toThrow(action === "start_work" ? "durable" : "no_unsatisfied");
  }
  expect(() => compileTurnContract({ decision: decision({ action: "answer", deliverables: [], answer_text: "ok" }) })).not.toThrow();
  expect(() => compileTurnContract({ decision: decision({ action: "cancel_work", target_workstream_id: "ws-a", deliverables: [] }), candidates: candidate() })).not.toThrow();
});

test("typed decisions distinguish status snapshots from work validation and final prose", () => {
  const prompt = typedTurnDecisionInstructions({
    decisionId: "decision-status-semantics",
    projectId: "project-a",
    candidateIds: [],
  });

  expect(prompt).toContain("status_report means an explicitly requested read-only status snapshot");
  expect(prompt).toContain("Use tool_answer for a general answer that requires public web evidence");
  expect(prompt).toContain("Do not force a search-then-read sequence");
  expect(prompt).toContain("Post-change verification belongs to validation");
  expect(prompt).toContain("The ordinary user-facing completion answer is the final candidate");
  expect(prompt).not.toContain("For mixed status-and-work instructions include status_report");
});

test("typed decisions distinguish runtime todo plans from canonical Ledger tasks", () => {
  const prompt = typedTurnDecisionInstructions({
    decisionId: "decision-runtime-todo-semantics",
    projectId: "project-a",
    candidateIds: [],
  });
  const responseFormat = turnDecisionResponseFormat({
    decisionId: "decision-runtime-todo-semantics",
    projectId: "project-a",
    candidateIds: [],
    waitingBlockerIds: [],
    continuityCandidates: [{
      continuity_id: "cu-existing",
      scope: "project",
      kind: "instruction",
      summary: "Use the established remote maintenance procedure.",
    }],
  });
  const properties = responseFormat.schema.properties as Record<
    string,
    Record<string, unknown>
  >;
  const deliverables = properties.deliverables!;
  const itemSchema = deliverables.items as Record<string, unknown>;

  expect(prompt).toContain("The bound runtime todo plan is not a ledger_tasks deliverable");
  expect(prompt).toContain("Never add ledger_tasks merely because the user asks for a task list");
  expect(prompt).toContain("Managed work in an active project must use canonical Project Ledger tracking");
  expect(prompt).toContain("with no intended durable diff, select validation");
  expect(prompt).toContain("resume_work, keep execution deliverables within");
  expect(String(deliverables.description)).toContain(
    "ledger_tasks never means the bound runtime todo plan",
  );
  expect(String(itemSchema.description)).toContain(
    "A request for a task list, todo list, work list, checklist",
  );
  expect(String(properties.target_project_id?.description)).toContain(
    "uses canonical Project Ledger tracking",
  );
  expect(prompt).toContain("continuity_updates is the model-owned semantic continuity decision");
  expect(prompt).toContain("absence never implies deletion");
  const continuity = properties.continuity_updates as Record<string, unknown>;
  const continuityItem = continuity.items as { properties: Record<string, { enum?: unknown[] }> };
  expect(continuity.maxItems).toBe(4);
  expect(continuityItem.properties.target_ref.enum).toEqual([null, "cu-existing"]);
});

test("complete action and deliverable matrix is deterministic", () => {
  for (const action of ["answer", "inspect", "cancel_work"] as const) {
    for (const deliverable of ["status_report", "ledger_spec", "ledger_plan", "ledger_work", "ledger_tasks", "code_change", "validation", "review", "final_report"] as const) {
      const allowed = TURN_ACTION_DELIVERABLE_MATRIX[action].allowed.includes(deliverable);
      const input = decision({
        action,
        target_workstream_id: action === "cancel_work" ? "ws-a" : undefined,
        deliverables: [deliverable],
        answer_text: action === "answer" ? "answer" : undefined,
      });
      const invoke = () => validateTurnContractDecision(input, action === "cancel_work" ? candidate() : undefined);
      if (allowed) expect(invoke).not.toThrow();
      else expect(invoke).toThrow();
    }
  }
  for (const action of ["start_work", "resume_work", "modify_work"] as const) {
    for (const deliverable of ["ledger_spec", "ledger_plan", "ledger_work", "ledger_tasks", "code_change", "validation", "review"] as const) {
      const invoke = () => compileTurnContract({
        decision: decision({ action, target_workstream_id: action === "start_work" ? undefined : "ws-a", deliverables: [deliverable] }),
        candidates: action === "start_work" ? undefined : candidate(),
      });
      if (action === "start_work" && deliverable === "review") {
        expect(invoke).toThrow("turn_contract_execution_requires_durable_deliverable");
      } else if (action === "resume_work" && deliverable !== "code_change") {
        expect(invoke).toThrow("turn_contract_resume_deliverable_not_inherited");
      } else {
        expect(invoke).not.toThrow();
      }
    }
  }
  expect(() => compileTurnContract({
    decision: decision({ action: "start_work", deliverables: ["status_report", "review"] }),
  })).toThrow("turn_contract_execution_requires_durable_deliverable");
});

test("text-only provider fallback never parses prose into durable intent", () => {
  expect(selectTurnDecisionTransport({ supportsStructuredDecision: true, compatibleWorkstreamCount: 2, runtimeRequiresTools: true })).toEqual({ kind: "structured" });
  expect(selectTurnDecisionTransport({ supportsStructuredDecision: false, compatibleWorkstreamCount: 1, runtimeRequiresTools: false })).toEqual({ kind: "provider_capability_missing", code: "provider_capability_missing" });
  expect(selectTurnDecisionTransport({ supportsStructuredDecision: false, compatibleWorkstreamCount: 0, runtimeRequiresTools: true })).toEqual({ kind: "provider_capability_missing", code: "provider_capability_missing" });
  expect(selectTurnDecisionTransport({ supportsStructuredDecision: false, compatibleWorkstreamCount: 0, runtimeRequiresTools: false })).toEqual({ kind: "text_answer_wrapper" });
  const wrapped = wrapTextOnlyProviderAnswer({ text: "resume_work code_change and status_report", logicalTurnId: "turn-a" });
  expect(wrapped).toMatchObject({ action: "answer", deliverables: [], answer_text: "resume_work code_change and status_report" });
});

test("resume and modify inherit exact unsatisfied WorkStream obligations", () => {
  for (const action of ["resume_work", "modify_work"] as const) {
    const contract = compileTurnContract({
      decision: decision({ action, target_workstream_id: "ws-a", deliverables: ["status_report"] }),
      candidates: candidate(),
      now: new Date(0),
    });
    expect(contract.deliverables).toEqual(["status_report", "code_change"]);
    expect(contract.required_evidence.find((item) => item.deliverable === "code_change")).toMatchObject({
      target_id: "workspace-a",
      generation: 4,
    });
  }
  expect(() => validateTurnContractDecision(
    decision({ action: "resume_work", target_workstream_id: "ws-a", deliverables: ["code_change"] }),
    candidate({ unsatisfied_obligations: [] }),
  )).toThrow("no_unsatisfied");
});

test("resume cannot add new execution deliverables outside the inherited frontier", () => {
  expect(() => compileTurnContract({
    decision: decision({
      action: "resume_work",
      target_workstream_id: "ws-a",
      deliverables: ["ledger_work"],
    }),
    candidates: candidate(),
  })).toThrow("turn_contract_resume_deliverable_not_inherited");

  expect(() => compileTurnContract({
    decision: decision({
      action: "modify_work",
      target_workstream_id: "ws-a",
      deliverables: ["ledger_work"],
    }),
    candidates: candidate(),
  })).not.toThrow();
});

test("resume preserves the selected WorkStream tracking mode", () => {
  const contract = compileTurnContract({
    decision: decision({
      action: "resume_work",
      target_workstream_id: "ws-a",
      deliverables: ["code_change"],
    }),
    candidates: candidate({ tracking_mode: "ledger" }),
  });

  expect(contract.tracking_mode).toBe("ledger");
  expect(contract.closeout_strategy).toBe("ledger");
});

test("resume redeclaration keeps the exact inherited obligation generation", () => {
  const contract = compileTurnContract({
    decision: decision({
      action: "resume_work",
      target_workstream_id: "ws-a",
      deliverables: ["code_change", "final_report"],
    }),
    candidates: candidate({
      unsatisfied_obligations: [{
        deliverable: "code_change",
        target_kind: "workspace",
        target_id: "workspace-a",
        generation: 4,
      }, {
        deliverable: "final_report",
        target_kind: "report",
        target_id: "ws-a",
        generation: 4,
      }],
    }),
  });

  expect(contract.required_evidence.filter((item) => item.deliverable === "code_change"))
    .toHaveLength(1);
  expect(contract.required_evidence.filter((item) => item.deliverable === "final_report"))
    .toHaveLength(1);
  expect(contract.required_evidence.every((item) => item.generation === 4)).toBe(true);
});

test("contract semantics include the inherited tracking mode", () => {
  const input = decision({
    action: "resume_work",
    target_workstream_id: "ws-a",
    target_project_id: undefined,
    deliverables: ["code_change"],
  });
  const local = compileTurnContract({ decision: input, candidates: candidate({ tracking_mode: "local" }) });
  const ledger = compileTurnContract({ decision: input, candidates: candidate({ tracking_mode: "ledger" }) });

  expect(ledger.decision_semantic_fingerprint).not.toBe(local.decision_semantic_fingerprint);
});

test("inherited and declared obligations normalize before dedupe and identity", () => {
  const inputDecision = decision({ action: "resume_work", target_workstream_id: "ws-a", deliverables: ["code_change"] });
  const requirements = {
    code_change: {
      deliverable: "code_change" as const,
      target_kind: "workspace" as const,
      target_id: "workspace-a",
      generation: 4,
      cardinality: 1,
      expected_item_ids: [],
      evidence_class: "durable_diff" as const,
      allowed_producers: ["workspace" as const],
    },
  };
  const sparse = compileTurnContract({ decision: inputDecision, candidates: candidate(), obligationRequirements: requirements });
  const explicit = compileTurnContract({
    decision: inputDecision,
    candidates: candidate({ unsatisfied_obligations: [{ ...requirements.code_change, expected_item_ids: [], allowed_producers: ["workspace", "workspace"] }] }),
    obligationRequirements: requirements,
  });
  expect(sparse.required_evidence).toHaveLength(1);
  expect(explicit.required_evidence).toHaveLength(1);
  expect(explicit.decision_semantic_fingerprint).toBe(sparse.decision_semantic_fingerprint);
  expect(explicit.required_evidence[0]?.obligation_id).toBe(sparse.required_evidence[0]?.obligation_id);
});

test("contract identity and persisted create are deterministic on replay", () => {
  const input = {
    decision: decision({ action: "start_work" as const, deliverables: ["ledger_spec", "ledger_work"] }),
    now: new Date("2026-07-10T00:00:00.000Z"),
  };
  const first = compileTurnContract(input);
  const replay = compileTurnContract({ ...input, now: new Date("2026-07-11T00:00:00.000Z") });
  expect(replay.contract_id).toBe(first.contract_id);
  expect(replay.required_evidence.map((item) => item.obligation_id)).toEqual(first.required_evidence.map((item) => item.obligation_id));
  const store = new TurnContractStore(tempData());
  expect(store.create(first)).toEqual(first);
  expect(store.create(replay).created_at).toBe(first.created_at);
});

test("decision id is unique by semantic payload while public copy is replay-safe", () => {
  const data = tempData();
  const store = new TurnContractStore(data);
  const first = compileTurnContract({ decision: decision({ decision_id: "durable-decision", public_summary: "First public copy." }) });
  const copyChanged = compileTurnContract({
    decision: decision({ decision_id: "durable-decision", public_summary: "Reworded public copy.", immediate_next_step: "Also reworded." }),
    now: new Date(1),
  });
  expect(copyChanged.contract_id).toBe(first.contract_id);
  expect(copyChanged.decision_semantic_fingerprint).toBe(first.decision_semantic_fingerprint);
  expect(store.create(first)).toEqual(first);
  expect(store.create(copyChanged)).toEqual(first);
  const divergent = compileTurnContract({
    decision: decision({ decision_id: "durable-decision", action: "start_work", deliverables: ["code_change"], public_summary: "Different operation." }),
  });
  expect(() => store.create(divergent)).toThrow("turn_contract_decision_conflict");
  expect(readdirSync(store.contractsDir).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
});

test("receipts are bound to one obligation, target, and generation", () => {
  const contract = compileTurnContract({
    decision: decision({ action: "start_work", deliverables: ["ledger_spec", "ledger_work"] }),
  });
  const specReceipt = receipt(contract, "ledger_spec");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [specReceipt] })).toBe("continue");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [specReceipt, { ...specReceipt, receipt_id: "forged", deliverable: "ledger_work" }] })).toBe("continue");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [specReceipt, receipt(contract, "ledger_work")] })).toBe("deliver");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [specReceipt, receipt(contract, "ledger_work", { obligation_generation: 99 })] })).toBe("continue");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [
    { ...specReceipt, producer: "runtime" },
    receipt(contract, "ledger_work"),
  ] })).toBe("continue");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [specReceipt], continuationCommitted: true })).toBe("yield_continuation");
});

test("cardinality and expected task ids require complete verified coverage", () => {
  const contract = compileTurnContract({
    decision: decision({ action: "start_work", deliverables: ["ledger_tasks"] }),
    obligationRequirements: {
      ledger_tasks: {
        deliverable: "ledger_tasks",
        target_kind: "project",
        target_id: "project-a",
        generation: 3,
        cardinality: 2,
        expected_item_ids: ["T-1", "T-2"],
      },
    },
  });
  const tasks = receipt(contract, "ledger_tasks", { item_ids: ["T-1"] });
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [tasks] })).toBe("continue");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [{ ...tasks, item_ids: ["T-1", "T-2"] }] })).toBe("continue");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [tasks, { ...tasks, receipt_id: "receipt-task-2", item_ids: ["T-2"] }] })).toBe("deliver");
});

test("only runtime-coded user blockers with resolvable receipts may wait", () => {
  const contract = compileTurnContract({ decision: decision({ action: "start_work", deliverables: ["code_change"] }) });
  const blocker = {
    schema_version: TYPED_BLOCKER_SCHEMA,
    blocker_id: "blocker-1",
    owner: "user" as const,
    code: "captcha_required",
    evidence_ref: "blocker-receipt-1",
    requested_action: "Complete the CAPTCHA in the visible browser.",
  };
  const evidence: BlockerEvidenceReceipt = {
    schema_version: BLOCKER_EVIDENCE_RECEIPT_SCHEMA,
    receipt_id: blocker.evidence_ref,
    producer: "runtime",
    contract_id: contract.contract_id,
    workstream_id: "ws-a",
    blocker_id: blocker.blocker_id,
    owner: "user",
    code: "captcha_required",
    requested_action: blocker.requested_action,
    verified: true,
    created_at: new Date(0).toISOString(),
  };
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [], blocker, blockerEvidenceReceipts: [] })).toBe("continue");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [], blocker, blockerEvidenceReceipts: [evidence] })).toBe("waiting_user");
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [], blocker: { ...blocker, code: "tool_failed" }, blockerEvidenceReceipts: [evidence] })).toBe("continue");
});

test("all runtime-owned user blocker codes require matching evidence and concrete action", () => {
  const contract = compileTurnContract({ decision: decision({ action: "start_work", deliverables: ["code_change"] }) });
  for (const code of ["authentication_required", "destructive_confirmation_required", "captcha_required", "payment_required", "product_choice_required"] as const) {
    const blocker = {
      schema_version: TYPED_BLOCKER_SCHEMA,
      blocker_id: `blocker-${code}`,
      owner: "user" as const,
      code,
      evidence_ref: `evidence-${code}`,
      requested_action: `Complete the required ${code} action.`,
    };
    const evidence: BlockerEvidenceReceipt = {
      schema_version: BLOCKER_EVIDENCE_RECEIPT_SCHEMA,
      receipt_id: blocker.evidence_ref,
      producer: "runtime",
      contract_id: contract.contract_id,
      workstream_id: "ws-a",
      blocker_id: blocker.blocker_id,
      owner: "user",
      code,
      requested_action: blocker.requested_action,
      verified: true,
      created_at: new Date(0).toISOString(),
    };
    expect(canDeliverTurnContract({ contract, evidenceReceipts: [], blocker, blockerEvidenceReceipts: [evidence] })).toBe("waiting_user");
  }
  for (const code of ["tool_failed", "ledger_alias_unresolved", "missing_evidence", "model_uncertainty"]) {
    expect(canDeliverTurnContract({
      contract,
      evidenceReceipts: [],
      blocker: { schema_version: TYPED_BLOCKER_SCHEMA, blocker_id: code, owner: "system", code, evidence_ref: `evidence-${code}`, requested_action: "Ask the user for help." },
      blockerEvidenceReceipts: [],
    })).toBe("continue");
  }
});

test("supply_user_action must match the waiting WorkStream blocker", () => {
  const waiting = candidate({ state: "waiting_user", waiting_user_blocker_id: "blocker-1" });
  expect(() => compileTurnContract({
    decision: decision({ action: "supply_user_action", target_workstream_id: "ws-a", blocker_id: "wrong", deliverables: [] }),
    candidates: waiting,
  })).toThrow("blocker_mismatch");
  expect(() => compileTurnContract({
    decision: decision({ action: "supply_user_action", target_workstream_id: "ws-a", blocker_id: "blocker-1", deliverables: [] }),
    candidates: waiting,
  })).not.toThrow();
});

test("contract store replays evidence and terminal delivery without duplication", () => {
  const data = tempData();
  mkdirSync(data, { recursive: true });
  const store = new TurnContractStore(data);
  const contract = store.create(compileTurnContract({ decision: decision() }));
  const withEvidence = store.recordEvidence(receipt(contract, "status_report"));
  expect(store.recordEvidence(receipt(contract, "status_report")).generation).toBe(withEvidence.generation);
  const delivered = store.recordTerminalDelivery({
    contractId: contract.contract_id,
    terminalState: "delivered",
    expectedGeneration: withEvidence.generation,
  });
  expect(delivered.replayed).toBe(false);
  const replay = new TurnContractStore(data).recordTerminalDelivery({
    contractId: contract.contract_id,
    terminalState: "delivered",
    expectedGeneration: withEvidence.generation,
  });
  expect(replay.replayed).toBe(true);
  expect(replay.contract.terminal_delivery_keys).toHaveLength(1);
});

test("contract state requires a durable continuation commit and satisfies from evidence", () => {
  const store = new TurnContractStore(tempData());
  const created = store.create(compileTurnContract({ decision: decision() }));
  const executing = store.transitionState({
    contractId: created.contract_id,
    state: "executing",
    expectedGeneration: created.generation,
  });
  expect(() => store.transitionState({
    contractId: executing.contract_id,
    state: "continuing",
    expectedGeneration: executing.generation,
  })).toThrow("turn_contract_continuation_commit_required");

  const continuing = store.recordContinuationCommit({
    contractId: executing.contract_id,
    commitId: "butler_main-turn_1-continuation.json",
    expectedGeneration: executing.generation,
  });
  expect(continuing).toMatchObject({
    state: "continuing",
    continuation_commit_ids: ["butler_main-turn_1-continuation.json"],
  });
  expect(store.recordContinuationCommit({
    contractId: continuing.contract_id,
    commitId: "butler_main-turn_1-continuation.json",
    expectedGeneration: executing.generation,
  }).generation).toBe(continuing.generation);

  const resumed = store.transitionState({
    contractId: continuing.contract_id,
    state: "executing",
    expectedGeneration: continuing.generation,
  });
  const satisfied = store.recordEvidence(receipt(resumed, "status_report"));
  expect(satisfied.state).toBe("satisfied");
});

test("contract store refuses terminal delivery while an execution obligation is unsatisfied", () => {
  const store = new TurnContractStore(tempData());
  const contract = store.create(compileTurnContract({
    decision: decision({ action: "start_work", deliverables: ["status_report", "code_change"] }),
  }));
  const statusOnly = store.recordEvidence(receipt(contract, "status_report"));
  expect(() => store.recordTerminalDelivery({
    contractId: contract.contract_id,
    terminalState: "delivered",
    expectedGeneration: statusOnly.generation,
  })).toThrow("evidence_incomplete");
});

test("terminal contract outcomes are immutable", () => {
  const store = new TurnContractStore(tempData());
  const contract = store.create(compileTurnContract({ decision: decision() }));
  const evidenced = store.recordEvidence(receipt(contract, "status_report"));
  const delivered = store.recordTerminalDelivery({
    contractId: contract.contract_id,
    terminalState: "delivered",
    expectedGeneration: evidenced.generation,
  });
  expect(() => store.recordTerminalDelivery({
    contractId: contract.contract_id,
    terminalState: "failed_system",
    expectedGeneration: delivered.contract.generation,
  })).toThrow("turn_contract_terminal_immutable");
  expect(store.read(contract.contract_id)?.state).toBe("delivered");
});

test("shared delivery gate requires a matching cancellation receipt", () => {
  const contract = compileTurnContract({
    decision: decision({ action: "cancel_work", target_workstream_id: "ws-a", deliverables: [] }),
    candidates: candidate(),
  });
  expect(canDeliverTurnContract({ contract, evidenceReceipts: [] })).toBe("continue");
  expect(canDeliverTurnContract({
    contract,
    evidenceReceipts: [],
    cancellationReceipt: {
      schema_version: "butler.workstream-claim-receipt.v1",
      receipt_id: "cancel-receipt",
      operation: "cancel",
      outcome: "cancelled",
      workstream_id: "ws-a",
      project_id: contract.target_project_id,
      contract_id: contract.contract_id,
      released_contract_id: "prior-contract",
      before_generation: 4,
      after_generation: 5,
    },
  })).toBe("deliver");
});
