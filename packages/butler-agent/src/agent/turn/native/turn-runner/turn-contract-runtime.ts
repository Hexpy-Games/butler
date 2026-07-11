import type { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";
import {
  TurnContractStore,
  type CompiledTurnContract,
  type TurnContractDecision,
} from "../../turn-contract.ts";
import { WorkStreamClaimStore } from "../../../work/work-stream-claim-store.ts";
import { WorkStreamStore } from "../../../work/work-stream.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import { turnMetadataForContract } from "./turn-contract-tool-policy.ts";
import { recordTurnContractMetric } from "./turn-contract-metrics.ts";
import { prepareStartWorkStreamBinding } from "./start-workstream-binding.ts";

export interface ActiveTurnContract {
  contract: CompiledTurnContract;
  decision: TurnContractDecision;
  publicDecision: PublicWorkDecision;
}

export function openingDecisionPayload(active: ActiveTurnContract): Record<string, unknown> {
  const decision = active.publicDecision;
  return {
    decisionId: decision.decisionId,
    contractId: decision.contractId,
    workstreamId: decision.workstreamId,
    semanticBlockId: decision.semanticBlockId,
    blockTitle: decision.blockTitle,
    role: "opening",
    summary: decision.summary,
    rationale: decision.rationale,
    nextStep: decision.nextStep,
    source: "model-authored",
    firstVisible: true,
    evidenceRefs: decision.evidenceRefs,
  };
}

export function completeTurnContractDelivery(input: {
  butlerData: string;
  active: ActiveTurnContract;
  turnId?: string;
}): CompiledTurnContract {
  const store = new TurnContractStore(input.butlerData);
  const contract = store.read(input.active.contract.contract_id) ?? input.active.contract;
  const terminalState = contract.action === "cancel_work" ? "cancelled" : "delivered";
  const delivered = store.recordTerminalDelivery({
    contractId: contract.contract_id,
    terminalState,
    expectedGeneration: contract.generation,
  }).contract;
  recordTurnContractMetric({
    butlerData: input.butlerData,
    name: "terminal",
    status: "ok",
    contract: delivered,
  });
  if (delivered.target_workstream_id && delivered.action !== "cancel_work") {
    const streams = new WorkStreamStore(input.butlerData);
    const record = streams.read(delivered.target_workstream_id);
    if (record?.active_contract_id === delivered.contract_id) {
      const released = new WorkStreamClaimStore(input.butlerData).release({
        contractId: delivered.contract_id,
        workstreamId: record.id,
        expectedGeneration: record.record_generation ?? 1,
        turnId: input.turnId ?? record.last_user_turn_id ?? delivered.contract_id,
      });
      if (!released.ok) throw new Error(released.code);
    }
  }
  return delivered;
}

export function resumeTurnContractExecution(input: {
  butlerData: string;
  active: ActiveTurnContract;
}): CompiledTurnContract {
  const store = new TurnContractStore(input.butlerData);
  const contract = store.read(input.active.contract.contract_id) ?? input.active.contract;
  if (contract.state === "executing") return contract;
  return store.transitionState({
    contractId: contract.contract_id,
    state: "executing",
    expectedGeneration: contract.generation,
  });
}

export function commitTurnContractContinuation(input: {
  butlerData: string;
  contractId: string;
  commitId: string;
}): CompiledTurnContract {
  const store = new TurnContractStore(input.butlerData);
  const contract = store.read(input.contractId);
  if (!contract) throw new Error("turn_contract_not_found");
  const continuing = store.recordContinuationCommit({
    contractId: contract.contract_id,
    commitId: input.commitId,
    expectedGeneration: contract.generation,
  });
  recordTurnContractMetric({
    butlerData: input.butlerData,
    name: "continuation",
    status: "ok",
    contract: continuing,
  });
  return continuing;
}

export function activateTurnContract(input: {
  butlerData: string;
  contract: CompiledTurnContract;
  decision: TurnContractDecision;
  sessionId: string;
  chatId?: string | null;
  projectId?: string | null;
  turnId: string;
  turnMetadata?: Record<string, unknown>;
  toolSurfaceController: ToolSurfacePromptController;
}): ActiveTurnContract {
  const contracts = new TurnContractStore(input.butlerData);
  const existing = contracts.read(input.contract.contract_id);
  let contract = contracts.create(existing ?? prepareStartWorkStreamBinding({
    butlerData: input.butlerData,
    contract: input.contract,
    decision: input.decision,
    sessionId: input.sessionId,
    chatId: requiredText(input.chatId ?? input.sessionId, "turn_contract_chat_missing"),
    projectId: input.projectId,
    turnId: input.turnId,
  }));
  recordTurnContractMetric({
    butlerData: input.butlerData,
    name: "compiled",
    status: "ok",
    contract,
  });
  input.toolSurfaceController.applyTurnMetadata(turnMetadataForContract(contract, input.turnMetadata));
  if (
    contract.action === "start_work" ||
    contract.action === "resume_work" ||
    contract.action === "modify_work"
  ) {
    const record = requiredTargetRecord(input.butlerData, contract);
    const claim = new WorkStreamClaimStore(input.butlerData).claim({
      contract,
      workstreamId: record.id,
      sessionId: requiredText(input.sessionId, "turn_contract_session_missing"),
      chatId: requiredText(input.chatId ?? record.origin_chat_id, "turn_contract_chat_missing"),
      projectId: input.projectId ?? record.project_id ?? null,
      turnId: input.turnId,
      expectedGeneration: record.record_generation ?? 1,
    });
    if (!claim.ok) {
      recordTurnContractMetric({
        butlerData: input.butlerData,
        name: "claim",
        status: "error",
        contract,
        claimCode: claim.code,
      });
      throw new Error(claim.code);
    }
    recordTurnContractMetric({
      butlerData: input.butlerData,
      name: "claim",
      status: "ok",
      contract,
      claimCode: claim.receipt.outcome,
    });
    contract = contracts.transitionState({
      contractId: contract.contract_id,
      state: "claimed",
      expectedGeneration: contract.generation,
    });
    contract = contracts.transitionState({
      contractId: contract.contract_id,
      state: "executing",
      expectedGeneration: contract.generation,
    });
  } else if (contract.action === "supply_user_action") {
    const record = requiredTargetRecord(input.butlerData, contract);
    const supplied = new WorkStreamClaimStore(input.butlerData).supplyUserAction({
      contract,
      blockerId: requiredText(contract.blocker_id, "turn_contract_blocker_missing"),
      workstreamId: record.id,
      sessionId: requiredText(input.sessionId, "turn_contract_session_missing"),
      chatId: requiredText(input.chatId ?? record.origin_chat_id, "turn_contract_chat_missing"),
      projectId: requiredText(input.projectId ?? record.project_id, "turn_contract_project_missing"),
      turnId: input.turnId,
      expectedGeneration: record.record_generation ?? 1,
    });
    if (!supplied.ok) {
      recordTurnContractMetric({
        butlerData: input.butlerData,
        name: "claim",
        status: "error",
        contract,
        claimCode: supplied.code,
      });
      throw new Error(supplied.code);
    }
    recordTurnContractMetric({
      butlerData: input.butlerData,
      name: "claim",
      status: "ok",
      contract,
      claimCode: supplied.receipt.outcome,
    });
    contract = contracts.transitionState({
      contractId: contract.contract_id,
      state: "claimed",
      expectedGeneration: contract.generation,
    });
    contract = contracts.transitionState({
      contractId: contract.contract_id,
      state: "executing",
      expectedGeneration: contract.generation,
    });
  } else if (contract.action === "cancel_work") {
    const record = requiredTargetRecord(input.butlerData, contract);
    const cancelled = new WorkStreamClaimStore(input.butlerData).cancel({
      contract,
      workstreamId: record.id,
      expectedGeneration: record.record_generation ?? 1,
      turnId: input.turnId,
    });
    if (!cancelled.ok) throw new Error(cancelled.code);
    contract = contracts.recordCancellationReceipt({
      contractId: contract.contract_id,
      receiptId: cancelled.receipt.receipt_id,
      expectedGeneration: contract.generation,
    });
  } else if (contract.action !== "answer") {
    contract = contracts.transitionState({
      contractId: contract.contract_id,
      state: "executing",
      expectedGeneration: contract.generation,
    });
  }
  return {
    contract,
    decision: input.decision,
    publicDecision: publicDecisionForContract(contract, input.decision),
  };
}

export function contractExecutionPrompt(input: {
  basePrompt: string;
  active: ActiveTurnContract;
  butlerData: string;
}): string {
  const { contract, decision } = input.active;
  const activeTodoListId = contract.target_workstream_id
    ? new WorkStreamStore(input.butlerData).read(contract.target_workstream_id)?.todo_list_id
    : null;
  const requiresExplicitPlan = ["start_work", "resume_work", "modify_work"]
    .includes(contract.action);
  return [
    input.basePrompt,
    "## Active Typed Turn Contract",
    `Contract ID: ${contract.contract_id}`,
    `Action: ${contract.action}`,
    `Target WorkStream: ${contract.target_workstream_id ?? "none"}`,
    `Active Todo List: ${activeTodoListId ?? "none"}`,
    `Tracking Mode: ${contract.tracking_mode}`,
    `Closeout Strategy: ${contract.closeout_strategy}`,
    `Required Deliverables: ${contract.deliverables.join(", ") || "none"}`,
    `Opening Block Title: ${decision.public_title ?? "Current work"}`,
    `Opening Decision: ${decision.public_summary}`,
    `Immediate Next Step: ${decision.immediate_next_step ?? decision.public_summary}`,
    requiresExplicitPlan
      ? "The typed opening decision admits the contract. Before ordinary tools, replace the runtime opening placeholder with an explicit bound todo plan using the focused plan surface."
      : "The typed opening decision already authorizes the first tool batch. Execute only that immediate step without restating or paraphrasing the opening decision protocol.",
    activeTodoListId
      ? `When calling update_todo_list, use list_id ${activeTodoListId} or omit list_id so the active contract binds it automatically.`
      : "Do not invent a todo-list id.",
    "After observing the first batch, every later tool batch must begin with one fresh visible title, summary, rationale, next_step, and expected_effect for the next small step.",
    "When run_work_block is available, place one fresh decision and one to six explicit ordinary calls inside that single wrapper. Do not duplicate the protocol in prose.",
    "Batch independent inspection calls whose selection does not depend on one another. When a focused implementation and its directly derived tests are both determined by the observed context, author both in one block and validate them in the next block.",
    "Choose the smallest coherent implementation slice that satisfies the active deliverables; preserve observed interfaces instead of expanding a next-step request into an unrelated subsystem.",
    "If run_work_block returns decision_feedback, none of its embedded calls ran. Correct the decision fields and resubmit only the still-needed calls in the next response.",
    "When a selected run_command is the contract's actual validation, include a stable validation_suite label on that first run so its structured receipt can satisfy validation immediately.",
    "A semantic decision block may contain at most six visible tool calls. Continue with a new decision after observing its results.",
    "The final_report deliverable is the user-facing final candidate unless the user explicitly requested a durable report artifact. Once execution and validation are complete, stop calling tools and emit that final candidate; do not invent a Ledger report record or report file.",
    "The active typed contract owns its WorkStream lifecycle. Do not call update_work_stream_state for this WorkStream; the runtime completes it after accepting the final candidate.",
    "After the requested workspace mutation and passing validation are observed, emit the final candidate unless a named contract deliverable remains unsatisfied. Reserve Project Ledger task or Work status transitions for an explicit requested or acceptance-bound lifecycle change.",
    requiresExplicitPlan
      ? "Keep every retained non-reporting plan item current and mark it completed only after its work is actually done. Remove obsolete items only through an explicit plan amendment; a final candidate does not cancel open plan work."
      : "If an explicit todo plan exists, keep every retained non-reporting item current and complete only work that actually finished.",
    "Do not report completion until the runtime confirms every typed evidence obligation.",
  ].join("\n\n");
}

export function restoreTurnContractExecution(input: {
  butlerData: string;
  contractId: string;
  decision: TurnContractDecision;
  nextSemanticBlockSequence: number;
  turnMetadata?: Record<string, unknown>;
  toolSurfaceController: ToolSurfacePromptController;
}): ActiveTurnContract {
  const contracts = new TurnContractStore(input.butlerData);
  let contract = contracts.read(input.contractId);
  if (!contract) throw new Error("turn_contract_not_found");
  if (contract.decision_id !== input.decision.decision_id) {
    throw new Error("turn_contract_decision_conflict");
  }
  if (contract.state === "continuing") {
    contract = contracts.transitionState({
      contractId: contract.contract_id,
      state: "executing",
      expectedGeneration: contract.generation,
    });
  } else if (contract.state !== "executing" && contract.state !== "reviewing") {
    throw new Error(`turn_contract_resume_state_invalid:${contract.state}`);
  }
  if (contract.target_workstream_id) {
    const stream = new WorkStreamStore(input.butlerData).read(contract.target_workstream_id);
    if (!stream || stream.active_contract_id !== contract.contract_id) {
      throw new Error("workstream_contract_claim_missing");
    }
  }
  input.toolSurfaceController.applyTurnMetadata(
    turnMetadataForContract(contract, input.turnMetadata),
  );
  return {
    contract,
    decision: input.decision,
    publicDecision: publicDecisionForContract(
      contract,
      input.decision,
      Math.max(1, Math.floor(input.nextSemanticBlockSequence)),
    ),
  };
}

export function contractResumePrompt(input: {
  basePrompt: string;
  active: ActiveTurnContract;
  nextSemanticBlockSequence: number;
}): string {
  return [
    input.basePrompt,
    "## Resumed Typed Turn Contract",
    `Contract ID: ${input.active.contract.contract_id}`,
    `Action: ${input.active.contract.action}`,
    `Target WorkStream: ${input.active.contract.target_workstream_id ?? "none"}`,
    `Next Semantic Block: ${Math.max(1, Math.floor(input.nextSemanticBlockSequence))}`,
    "The typed opening decision was already emitted before the durable yield. Do not emit or paraphrase it again.",
    "Use the persisted round journal and unresolved obligations to author one fresh title, summary, rationale, and next_step for the next small tool batch.",
    "When only the user-facing final report remains, emit the final candidate directly instead of creating a report record or file.",
    "Continue the same contract and WorkStream. Do not restart discovery or create a replacement plan.",
    "If the restored frontier is work_planning, restore or create the explicit bound plan before any ordinary tool call.",
  ].join("\n\n");
}

function publicDecisionForContract(
  contract: CompiledTurnContract,
  decision: TurnContractDecision,
  sequence = 0,
): PublicWorkDecision {
  const nextStep = decision.immediate_next_step?.trim() || decision.public_summary.trim();
  return {
    decisionId: decision.decision_id,
    usageGroupId: `${decision.decision_id}:${sequence}`,
    contractId: contract.contract_id,
    ...(contract.target_workstream_id ? { workstreamId: contract.target_workstream_id } : {}),
    semanticBlockId: `${contract.contract_id}:block:${sequence}`,
    blockTitle: decision.public_title?.trim() || nextStep.slice(0, 80),
    summary: decision.public_summary,
    rationale: decision.public_rationale?.trim() || decision.public_summary,
    nextStep,
    expectedEffect: nextStep,
    evidenceRefs: [],
    completionObligations: [],
    source: "model-authored",
    providerRound: sequence,
  };
}

function requiredTargetRecord(butlerData: string, contract: CompiledTurnContract) {
  const id = requiredText(contract.target_workstream_id, "turn_contract_target_missing");
  const record = new WorkStreamStore(butlerData).read(id);
  if (!record) throw new Error("workstream_not_found");
  return record;
}

function requiredText(value: string | null | undefined, code: string): string {
  const text = value?.trim();
  if (!text) throw new Error(code);
  return text;
}
