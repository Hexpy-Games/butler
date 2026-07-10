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
  let contract = contracts.create(input.contract);
  recordTurnContractMetric({
    butlerData: input.butlerData,
    name: "compiled",
    status: "ok",
    contract,
  });
  input.toolSurfaceController.applyTurnMetadata(turnMetadataForContract(contract, input.turnMetadata));
  if (contract.action === "resume_work" || contract.action === "modify_work") {
    const record = requiredTargetRecord(input.butlerData, contract);
    const claim = new WorkStreamClaimStore(input.butlerData).claim({
      contract,
      workstreamId: record.id,
      sessionId: requiredText(input.sessionId, "turn_contract_session_missing"),
      chatId: requiredText(input.chatId ?? record.origin_chat_id, "turn_contract_chat_missing"),
      projectId: requiredText(input.projectId ?? record.project_id, "turn_contract_project_missing"),
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
}): string {
  const { contract, decision } = input.active;
  return [
    input.basePrompt,
    "## Active Typed Turn Contract",
    `Contract ID: ${contract.contract_id}`,
    `Action: ${contract.action}`,
    `Target WorkStream: ${contract.target_workstream_id ?? "none"}`,
    `Tracking Mode: ${contract.tracking_mode}`,
    `Closeout Strategy: ${contract.closeout_strategy}`,
    `Required Deliverables: ${contract.deliverables.join(", ") || "none"}`,
    `Opening Block Title: ${decision.public_title ?? "Current work"}`,
    `Opening Decision: ${decision.public_summary}`,
    `Immediate Next Step: ${decision.immediate_next_step ?? decision.public_summary}`,
    "The typed opening decision already authorizes the first tool batch. Execute only that immediate step without restating or paraphrasing the opening decision protocol.",
    "After observing the first batch, every later tool batch must begin with a fresh visible title, summary, rationale, and next_step for the next small step.",
    "A semantic decision block may contain at most six visible tool calls. Continue with a new decision after observing its results.",
    "Do not report completion until the runtime confirms every typed evidence obligation.",
  ].join("\n\n");
}

function publicDecisionForContract(
  contract: CompiledTurnContract,
  decision: TurnContractDecision,
): PublicWorkDecision {
  const nextStep = decision.immediate_next_step?.trim() || decision.public_summary.trim();
  return {
    decisionId: decision.decision_id,
    usageGroupId: `${decision.decision_id}:0`,
    contractId: contract.contract_id,
    ...(contract.target_workstream_id ? { workstreamId: contract.target_workstream_id } : {}),
    semanticBlockId: `${contract.contract_id}:block:0`,
    blockTitle: decision.public_title?.trim() || nextStep.slice(0, 80),
    summary: decision.public_summary,
    rationale: decision.public_rationale?.trim() || decision.public_summary,
    nextStep,
    expectedEffect: nextStep,
    evidenceRefs: [],
    completionObligations: [],
    source: "model-authored",
    providerRound: 0,
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
