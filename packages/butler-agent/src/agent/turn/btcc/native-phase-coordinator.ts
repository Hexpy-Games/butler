import { createHash } from "node:crypto";
import type { ToolAuditEntry } from "../native/output/tool-types.ts";
import type { ActiveTurnContract } from "../native/turn-runner/turn-contract-runtime.ts";
import type { ObligationToolSurfaceState } from "../native/turn-runner/obligation-tool-surface.ts";
import { hashBtccPayload } from "./phase-store.ts";
import {
  BTCC_PHASE_ARTIFACT_SCHEMA,
  BTCC_PHASE_RECEIPT_SCHEMA,
  type BtccPhase,
  type BtccPhaseArtifactKind,
  type BtccPhaseArtifactV1,
  type BtccPhaseStateV1,
  type GoalContractV1,
  type PhaseReceiptV1,
  BTCC_RETURN_TICKET_SCHEMA,
  type ReturnTicketV1,
  type TrackingPolicy,
} from "./phase-types.ts";
import {
  btccPhasePrompt,
  type BtccPhaseInvocationMode,
  type BtccPhasePromptContract,
} from "./phase-prompts.ts";
import type { PreparedBtccTurn } from "./conception-runtime.ts";
import { btccLedgerAuthoringBundle } from "./ledger-authoring-contracts.ts";

export class BtccNativePhaseCoordinator {
  constructor(
    private readonly prepared: PreparedBtccTurn,
    private readonly butlerData: string,
  ) {}

  state(): BtccPhaseStateV1 {
    const state = this.prepared.store.readPhaseState(this.prepared.state.turnId);
    if (!state) throw new Error("btcc_phase_state_missing");
    return state;
  }

  readArtifact(ref: string): BtccPhaseArtifactV1 | null {
    return this.prepared.store.readPhaseArtifact(ref);
  }

  acceptedReceiptRef(phase: BtccPhase): string | null {
    const state = this.state();
    const invalidated = new Set(state.invalidatedReceiptRefs);
    for (const receiptRef of [...state.acceptedReceiptRefs].reverse()) {
      if (invalidated.has(receiptRef)) continue;
      if (this.prepared.store.readPhaseReceipt(receiptRef)?.phase === phase) return receiptRef;
    }
    return null;
  }

  goalContract(): GoalContractV1 {
    const state = this.state();
    const goal = state.goalContractRef
      ? this.prepared.store.readGoalContract(state.goalContractRef)
      : null;
    if (!goal) throw new Error("btcc_goal_contract_missing");
    return goal;
  }

  prompt(mode: BtccPhaseInvocationMode = "task", taskRef?: string): BtccPhasePromptContract {
    const state = this.state();
    return btccPhasePrompt({
      phase: state.currentPhase,
      mode,
      turnId: state.turnId,
      attemptId: state.attemptId,
      phaseGeneration: state.phaseGeneration,
      inputFingerprint: state.lastStableInputFingerprint,
      goalContractRef: state.goalContractRef,
      taskRef: taskRef ?? state.activeTaskRef,
    });
  }

  planningPrompt(active: ActiveTurnContract, frontier: ObligationToolSurfaceState): string {
    const state = this.requirePhase("planning");
    const goal = state.goalContractRef
      ? this.prepared.store.readGoalContract(state.goalContractRef)
      : null;
    if (!goal) throw new Error("btcc_planning_goal_contract_missing");
    const authoringContracts = state.trackingPolicyCandidate?.kind === "project_ledger"
      ? btccLedgerAuthoringBundle()
      : null;
    return [
      this.prompt("task").text,
      "## Immutable Planning Input",
      JSON.stringify({
        goalContract: goal,
        turnContract: active.contract,
        trackingPolicyCandidate: state.trackingPolicyCandidate ?? null,
        capabilityManifestRevision: this.prepared.envelope.capabilityManifestRevision,
        ledgerAuthoringContracts: authoringContracts,
        planningFrontier: frontier,
      }),
      "Create or update the explicit task graph first. For project-bound work, inspect and materialize the canonical Ledger spec, work, and task records before any implementation effect. Use only currently admitted capabilities.",
    ].join("\n\n");
  }

  executionPrompt(active: ActiveTurnContract): string {
    const state = this.requirePhase("execution");
    const goal = state.goalContractRef
      ? this.prepared.store.readGoalContract(state.goalContractRef)
      : null;
    const graph = state.planRevisionRef
      ? this.prepared.store.readPhaseArtifact(state.planRevisionRef)
      : null;
    if (!goal || !graph) throw new Error("btcc_execution_authority_missing");
    return [
      this.prompt("task", state.activeTaskRef).text,
      "## Accepted Execution Input",
      JSON.stringify({
        goalContract: goal,
        taskGraph: graph.payload,
        turnContract: active.contract,
        trackingPolicy: state.trackingPolicy,
      }),
      "Execute the accepted graph to its evidence frontier. Do not re-plan from the raw user message or claim review completion.",
    ].join("\n\n");
  }

  completePlanning(input: {
    active: ActiveTurnContract;
    frontier: ObligationToolSurfaceState;
    audit: ToolAuditEntry[];
    modelCallRefs: string[];
    taskGraph: BtccTaskGraphPayload;
  }): BtccPhaseStateV1 {
    const state = this.requirePhase("planning");
    if (input.frontier.stage === "work_planning" || input.frontier.stage === "ledger") {
      throw new Error("btcc_planning_frontier_incomplete");
    }
    const taskGraph = input.taskGraph;
    assertTaskGraph(taskGraph);
    const tracking = state.trackingPolicyCandidate ?? trackingPolicyFor(input.active);
    const authoringContracts = tracking.kind === "project_ledger"
      ? btccLedgerAuthoringBundle()
      : null;
    const prompt = this.prompt("task");
    const planningInput = this.artifact(state, "planning_input", {
      goalContractRef: state.goalContractRef,
      turnContractId: input.active.contract.contract_id,
      capabilityManifestRevision: this.prepared.envelope.capabilityManifestRevision,
      ledgerAuthoringContractHash: authoringContracts?.contractHash ?? null,
    }, input.modelCallRefs);
    const checkpoint = this.artifact(state, "planning_checkpoint", {
      frontier: input.frontier,
      auditEvidenceRefs: auditEvidenceRefs(input.audit),
    }, input.modelCallRefs);
    const graph = this.artifact(state, "task_graph", taskGraph, input.modelCallRefs);
    const materialization = this.artifact(state, "tracking_materialization", {
      trackingPolicy: tracking,
      evidenceRefs: auditEvidenceRefs(input.audit),
      governingContractRef: state.goalContractRef,
      ledgerAuthoringContractHash: authoringContracts?.contractHash ?? null,
    }, input.modelCallRefs);
    return this.commit({
      state,
      prompt,
      artifacts: [planningInput, checkpoint, graph, materialization],
      nextState: "execution",
      evidenceRefs: nonEmptyEvidence(input.modelCallRefs, input.audit),
      trackingPolicy: tracking,
      refs: {
        activePlanningCheckpointRef: checkpoint.artifactRef,
        planRevisionRef: graph.artifactRef,
        activeTrackingAttemptRef: materialization.artifactRef,
        activeTrackingWorkRef: input.active.contract.target_workstream_id ?? null,
        activeTaskRef: taskGraph.tasks[0]?.taskRef ?? null,
      },
    });
  }

  completeExecution(input: {
    active: ActiveTurnContract;
    candidateText: string;
    audit: ToolAuditEntry[];
    modelCallRefs: string[];
  }): BtccPhaseStateV1 {
    const state = this.requirePhase("execution");
    const prompt = this.prompt("task", state.activeTaskRef);
    const executionInput = this.artifact(state, "execution_input", {
      goalContractRef: state.goalContractRef,
      planRevisionRef: state.planRevisionRef,
      taskRef: state.activeTaskRef,
    }, input.modelCallRefs);
    const checkpoint = this.artifact(state, "execution_checkpoint", {
      taskRef: state.activeTaskRef,
      auditEvidenceRefs: auditEvidenceRefs(input.audit),
      turnContractState: input.active.contract.state,
    }, input.modelCallRefs);
    const candidate = this.artifact(state, "execution_candidate", {
      candidateText: input.candidateText,
      evidenceRefs: auditEvidenceRefs(input.audit),
      turnContractId: input.active.contract.contract_id,
    }, input.modelCallRefs);
    return this.commit({
      state,
      prompt,
      artifacts: [executionInput, checkpoint, candidate],
      nextState: "review",
      evidenceRefs: nonEmptyEvidence(input.modelCallRefs, input.audit),
      refs: {
        activeExecutionCheckpointRef: checkpoint.artifactRef,
        activeReviewTargetRef: candidate.artifactRef,
      },
    });
  }

  completeReview(input: {
    candidateText: string;
    evidenceRefs: string[];
    modelCallRefs: string[];
  }): BtccPhaseStateV1 {
    const state = this.requirePhase("review");
    const prompt = this.prompt("task", state.activeTaskRef);
    const reviewInput = this.artifact(state, "review_input", {
      executionCandidateRef: state.activeReviewTargetRef,
      goalContractRef: state.goalContractRef,
    }, input.modelCallRefs);
    const checkpoint = this.artifact(state, "review_checkpoint", {
      reviewedCandidateRef: state.activeReviewTargetRef,
      evidenceRefs: input.evidenceRefs,
    }, input.modelCallRefs);
    const candidate = this.artifact(state, "review_candidate", {
      acceptedTextHash: contentHash(input.candidateText),
      executionCandidateRef: state.activeReviewTargetRef,
      criterionEvidenceRefs: input.evidenceRefs,
    }, input.modelCallRefs);
    return this.commit({
      state,
      prompt,
      artifacts: [reviewInput, checkpoint, candidate],
      nextState: "consolidation",
      evidenceRefs: unique([...input.evidenceRefs, ...input.modelCallRefs]),
      refs: {
        activeReviewCheckpointRef: checkpoint.artifactRef,
        activeConsolidationTargetRef: candidate.artifactRef,
      },
    });
  }

  returnReview(input: {
    ownerPhase: "planning" | "execution";
    reasonCode: string;
    requiredChange: string;
    criterionId: string;
    criterionIds: string[];
    evidenceRefs: string[];
    gapFingerprint: string;
    modelCallRef: string;
  }): BtccPhaseStateV1 {
    const state = this.requirePhase("review");
    this.assertNovelReturnTicket(
      state,
      "review",
      input.gapFingerprint,
      input.criterionIds,
    );
    const ticket: ReturnTicketV1 = {
      schemaVersion: BTCC_RETURN_TICKET_SCHEMA,
      ticketId: stableRef("return-ticket:review", {
        turnId: state.turnId,
        phaseGeneration: state.phaseGeneration,
        gapFingerprint: input.gapFingerprint,
      }),
      turnId: state.turnId,
      sourcePhase: "review",
      ownerPhase: input.ownerPhase,
      ...(state.activeTaskRef ? { taskRef: state.activeTaskRef } : {}),
      criterionId: input.criterionId,
      criterionIds: input.criterionIds,
      reasonCode: input.reasonCode,
      authoritativeInputGeneration: state.phaseGeneration,
      artifactRevisionRefs: [
        state.activeReviewTargetRef,
        state.planRevisionRef,
      ].filter((ref): ref is string => Boolean(ref)),
      evidenceRefs: unique(input.evidenceRefs),
      requiredChange: input.requiredChange,
      gapFingerprint: input.gapFingerprint,
      createdAt: new Date().toISOString(),
    };
    const artifact = this.artifact(
      state,
      "return_ticket",
      ticket,
      [input.modelCallRef, ...input.evidenceRefs],
    );
    artifact.artifactRef = ticket.ticketId;
    const prompt = this.prompt("task", state.activeTaskRef);
    const receipt: PhaseReceiptV1 = {
      schemaVersion: BTCC_PHASE_RECEIPT_SCHEMA,
      receiptId: stableRef("receipt:review:return", ticket),
      turnId: state.turnId,
      attemptId: state.attemptId,
      phase: "review",
      phaseGeneration: state.phaseGeneration,
      ...(state.activeTaskRef ? { taskRef: state.activeTaskRef } : {}),
      inputFingerprint: state.lastStableInputFingerprint,
      phasePromptId: prompt.promptId,
      phasePromptVersion: prompt.version,
      phasePromptHash: prompt.promptHash,
      outputArtifactRefs: [artifact.artifactRef],
      evidenceRefs: unique([input.modelCallRef, ...input.evidenceRefs]),
      dependencyReceiptRefs: state.acceptedReceiptRefs.filter(
        (ref) => !state.invalidatedReceiptRefs.includes(ref),
      ),
      status: "passed",
      nextState: input.ownerPhase,
      createdAt: new Date().toISOString(),
    };
    return this.prepared.store.commitPhase({
      expectedRowVersion: state.rowVersion,
      receipt,
      artifacts: [artifact],
      returnTicket: {
        ticket,
        invalidatesAuthority: input.ownerPhase === "planning"
          ? "plan_or_task_graph"
          : "task_artifact_or_evidence",
      },
    });
  }

  completeConsolidation(input: {
    finalDossier: unknown;
    evidenceRefs: string[];
    modelCallRefs: string[];
  }): BtccPhaseStateV1 {
    const state = this.requirePhase("consolidation");
    const prompt = this.prompt("task");
    const consolidationInput = this.artifact(state, "consolidation_input", {
      goalContractRef: state.goalContractRef,
      reviewCandidateRef: state.activeConsolidationTargetRef,
    }, input.modelCallRefs);
    const checkpoint = this.artifact(state, "consolidation_checkpoint", {
      reviewCandidateRef: state.activeConsolidationTargetRef,
      evidenceRefs: input.evidenceRefs,
    }, input.modelCallRefs);
    const dossier = this.artifact(state, "final_dossier", input.finalDossier, input.modelCallRefs);
    return this.commit({
      state,
      prompt,
      artifacts: [consolidationInput, checkpoint, dossier],
      nextState: "reporting",
      evidenceRefs: unique([...input.evidenceRefs, ...input.modelCallRefs]),
      refs: {
        activeConsolidationCheckpointRef: checkpoint.artifactRef,
        activeFinalDossierRef: dossier.artifactRef,
      },
    });
  }

  returnConsolidation(input: {
    ownerPhase: "planning" | "execution";
    reasonCode: string;
    requiredChange: string;
    criterionIds: string[];
    evidenceRefs: string[];
    gapFingerprint: string;
    modelCallRef: string;
  }): BtccPhaseStateV1 {
    const state = this.requirePhase("consolidation");
    this.assertNovelReturnTicket(
      state,
      "consolidation",
      input.gapFingerprint,
      input.criterionIds,
    );
    const ticket: ReturnTicketV1 = {
      schemaVersion: BTCC_RETURN_TICKET_SCHEMA,
      ticketId: stableRef("return-ticket:consolidation", {
        turnId: state.turnId,
        phaseGeneration: state.phaseGeneration,
        gapFingerprint: input.gapFingerprint,
      }),
      turnId: state.turnId,
      sourcePhase: "consolidation",
      ownerPhase: input.ownerPhase,
      ...(state.activeTaskRef ? { taskRef: state.activeTaskRef } : {}),
      criterionId: input.criterionIds[0],
      criterionIds: input.criterionIds,
      reasonCode: input.reasonCode,
      authoritativeInputGeneration: state.phaseGeneration,
      artifactRevisionRefs: [
        state.activeConsolidationTargetRef,
        state.planRevisionRef,
      ].filter((ref): ref is string => Boolean(ref)),
      evidenceRefs: unique(input.evidenceRefs),
      requiredChange: input.requiredChange,
      gapFingerprint: input.gapFingerprint,
      createdAt: new Date().toISOString(),
    };
    const artifact = this.artifact(
      state,
      "return_ticket",
      ticket,
      [input.modelCallRef, ...input.evidenceRefs],
    );
    artifact.artifactRef = ticket.ticketId;
    const prompt = this.prompt("task", state.activeTaskRef);
    const receipt: PhaseReceiptV1 = {
      schemaVersion: BTCC_PHASE_RECEIPT_SCHEMA,
      receiptId: stableRef("receipt:consolidation:return", ticket),
      turnId: state.turnId,
      attemptId: state.attemptId,
      phase: "consolidation",
      phaseGeneration: state.phaseGeneration,
      ...(state.activeTaskRef ? { taskRef: state.activeTaskRef } : {}),
      inputFingerprint: state.lastStableInputFingerprint,
      phasePromptId: prompt.promptId,
      phasePromptVersion: prompt.version,
      phasePromptHash: prompt.promptHash,
      outputArtifactRefs: [artifact.artifactRef],
      evidenceRefs: unique([input.modelCallRef, ...input.evidenceRefs]),
      dependencyReceiptRefs: state.acceptedReceiptRefs.filter(
        (ref) => !state.invalidatedReceiptRefs.includes(ref),
      ),
      status: "passed",
      nextState: input.ownerPhase,
      createdAt: new Date().toISOString(),
    };
    return this.prepared.store.commitPhase({
      expectedRowVersion: state.rowVersion,
      receipt,
      artifacts: [artifact],
      returnTicket: {
        ticket,
        invalidatesAuthority: input.ownerPhase === "planning"
          ? "plan_or_task_graph"
          : "task_artifact_or_evidence",
      },
    });
  }

  completeReporting(input: {
    reportText: string;
    validationPayload: unknown;
    guardPayload: unknown;
    evidenceRefs: string[];
    reporterCallRef: string;
    guardCallRef: string;
  }): BtccPhaseStateV1 {
    const state = this.requirePhase("reporting");
    const prompt = this.prompt("task");
    const provenance = [input.reporterCallRef, input.guardCallRef];
    const reportingInput = this.artifact(state, "reporting_input", {
      finalDossierRef: state.activeFinalDossierRef,
    }, provenance);
    const checkpoint = this.artifact(state, "reporting_checkpoint", {
      finalDossierRef: state.activeFinalDossierRef,
      reportHash: contentHash(input.reportText),
    }, provenance);
    const reportCandidate = this.artifact(state, "report_candidate", {
      text: input.reportText,
      finalDossierRef: state.activeFinalDossierRef,
    }, [input.reporterCallRef]);
    const validation = this.artifact(
      state,
      "report_validation_receipt",
      input.validationPayload,
      [input.reporterCallRef],
    );
    const guardCandidate = this.artifact(state, "report_guard_candidate", {
      reportCandidateRef: reportCandidate.artifactRef,
    }, [input.guardCallRef]);
    const guard = this.artifact(
      state,
      "report_guard_receipt",
      input.guardPayload,
      [input.guardCallRef],
    );
    return this.commit({
      state,
      prompt,
      artifacts: [
        reportingInput,
        checkpoint,
        reportCandidate,
        validation,
        guardCandidate,
        guard,
      ],
      nextState: "kernel_delivery",
      evidenceRefs: unique([
        ...input.evidenceRefs,
        input.reporterCallRef,
        input.guardCallRef,
      ]),
      payload: {
        learningProjectionMode: "async_from_terminal_receipt",
        learningSourceGuardReceiptRefs: [guard.artifactRef],
      },
      refs: {
        activeReportingCheckpointRef: checkpoint.artifactRef,
        pendingCloseoutRef: guard.artifactRef,
        activeReturnTicketRef: null,
      },
    });
  }

  returnReporting(input: {
    reasonCode: string;
    requiredChange: string;
    criterionIds: string[];
    gapFingerprint: string;
    modelCallRef: string;
  }): BtccPhaseStateV1 {
    const state = this.requirePhase("reporting");
    this.assertNovelReturnTicket(
      state,
      "reporting",
      input.gapFingerprint,
      input.criterionIds,
    );
    const ticket: ReturnTicketV1 = {
      schemaVersion: BTCC_RETURN_TICKET_SCHEMA,
      ticketId: stableRef("return-ticket:reporting", {
        turnId: state.turnId,
        phaseGeneration: state.phaseGeneration,
        gapFingerprint: input.gapFingerprint,
      }),
      turnId: state.turnId,
      sourcePhase: "reporting",
      ownerPhase: "reporting",
      criterionId: input.criterionIds[0],
      criterionIds: input.criterionIds,
      reasonCode: input.reasonCode,
      authoritativeInputGeneration: state.phaseGeneration,
      artifactRevisionRefs: [state.activeFinalDossierRef]
        .filter((ref): ref is string => Boolean(ref)),
      evidenceRefs: [input.modelCallRef],
      requiredChange: input.requiredChange,
      gapFingerprint: input.gapFingerprint,
      createdAt: new Date().toISOString(),
    };
    const artifact = this.artifact(state, "return_ticket", ticket, [input.modelCallRef]);
    artifact.artifactRef = ticket.ticketId;
    const prompt = this.prompt("task");
    const receipt: PhaseReceiptV1 = {
      schemaVersion: BTCC_PHASE_RECEIPT_SCHEMA,
      receiptId: stableRef("receipt:reporting:return", ticket),
      turnId: state.turnId,
      attemptId: state.attemptId,
      phase: "reporting",
      phaseGeneration: state.phaseGeneration,
      inputFingerprint: state.lastStableInputFingerprint,
      phasePromptId: prompt.promptId,
      phasePromptVersion: prompt.version,
      phasePromptHash: prompt.promptHash,
      outputArtifactRefs: [artifact.artifactRef],
      evidenceRefs: [input.modelCallRef],
      dependencyReceiptRefs: state.acceptedReceiptRefs.filter(
        (ref) => !state.invalidatedReceiptRefs.includes(ref),
      ),
      status: "passed",
      nextState: "reporting",
      createdAt: new Date().toISOString(),
    };
    return this.prepared.store.commitPhase({
      expectedRowVersion: state.rowVersion,
      receipt,
      artifacts: [artifact],
      returnTicket: { ticket, invalidatesAuthority: "final_dossier" },
    });
  }

  private requirePhase(phase: BtccPhase): BtccPhaseStateV1 {
    const state = this.state();
    if (state.lifecycleStatus !== "active" || state.currentPhase !== phase) {
      throw new Error(`btcc_phase_owner_mismatch:${phase}:${state.currentPhase}:${state.lifecycleStatus}`);
    }
    return state;
  }

  private assertNovelReturnTicket(
    state: BtccPhaseStateV1,
    sourcePhase: "review" | "consolidation" | "reporting",
    gapFingerprint: string,
    criterionIds: string[],
  ): void {
    if (criterionIds.length === 0 || new Set(criterionIds).size !== criterionIds.length) {
      throw new Error(`btcc_${sourcePhase}_criterion_frontier_invalid`);
    }
    if (this.prepared.store.hasReturnTicketGap({
      turnId: state.turnId,
      sourcePhase,
      gapFingerprint,
    })) {
      throw new Error(`btcc_${sourcePhase}_same_gap_reentry_blocked`);
    }
    const priorCriteria = this.prepared.store.latestReturnedCriterionIds({
      turnId: state.turnId,
      sourcePhase,
    });
    if (priorCriteria.size > 0 && (
      criterionIds.length >= priorCriteria.size ||
      criterionIds.some((criterionId) => !priorCriteria.has(criterionId))
    )) {
      throw new Error(`btcc_${sourcePhase}_frontier_not_monotonic`);
    }
  }

  private artifact(
    state: BtccPhaseStateV1,
    kind: BtccPhaseArtifactKind,
    payload: unknown,
    provenanceRefs: string[],
  ): BtccPhaseArtifactV1 {
    return {
      schemaVersion: BTCC_PHASE_ARTIFACT_SCHEMA,
      artifactRef: stableRef(`artifact:${kind}`, {
        turnId: state.turnId,
        phaseGeneration: state.phaseGeneration,
        payload,
      }),
      turnId: state.turnId,
      attemptId: state.attemptId,
      phase: state.currentPhase,
      phaseGeneration: state.phaseGeneration,
      artifactKind: kind,
      artifactSchemaVersion: `butler.btcc-${kind.replaceAll("_", "-")}.v1`,
      ...(state.activeTaskRef ? { taskRef: state.activeTaskRef } : {}),
      payload,
      contentHash: hashBtccPayload(payload),
      provenanceRefs: unique(provenanceRefs),
      createdAt: new Date().toISOString(),
    };
  }

  private commit(input: {
    state: BtccPhaseStateV1;
    prompt: BtccPhasePromptContract;
    artifacts: BtccPhaseArtifactV1[];
    nextState: PhaseReceiptV1["nextState"];
    evidenceRefs: string[];
    payload?: unknown;
    trackingPolicy?: TrackingPolicy;
    refs?: Parameters<PreparedBtccTurn["store"]["commitPhase"]>[0]["refs"];
  }): BtccPhaseStateV1 {
    const receipt: PhaseReceiptV1 = {
      schemaVersion: BTCC_PHASE_RECEIPT_SCHEMA,
      receiptId: stableRef(`receipt:${input.state.currentPhase}`, {
        turnId: input.state.turnId,
        phaseGeneration: input.state.phaseGeneration,
        nextState: input.nextState,
        artifacts: input.artifacts.map((artifact) => artifact.artifactRef),
      }),
      turnId: input.state.turnId,
      attemptId: input.state.attemptId,
      phase: input.state.currentPhase,
      phaseGeneration: input.state.phaseGeneration,
      ...(input.state.activeTaskRef ? { taskRef: input.state.activeTaskRef } : {}),
      inputFingerprint: input.state.lastStableInputFingerprint,
      phasePromptId: input.prompt.promptId,
      phasePromptVersion: input.prompt.version,
      phasePromptHash: input.prompt.promptHash,
      outputArtifactRefs: input.artifacts.map((artifact) => artifact.artifactRef),
      evidenceRefs: unique(input.evidenceRefs),
      dependencyReceiptRefs: input.state.acceptedReceiptRefs.filter(
        (ref) => !input.state.invalidatedReceiptRefs.includes(ref),
      ),
      status: "passed",
      nextState: input.nextState,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
      createdAt: new Date().toISOString(),
    };
    return this.prepared.store.commitPhase({
      expectedRowVersion: input.state.rowVersion,
      receipt,
      artifacts: input.artifacts,
      ...(input.trackingPolicy ? { trackingPolicy: input.trackingPolicy } : {}),
      refs: input.refs,
    });
  }
}

export interface BtccTaskGraphPayload {
  schemaVersion: "butler.btcc-task-graph.v1";
  workstreamRef: string | null;
  todoListRef: string | null;
  sourcePlanningItemRefs: string[];
  tasks: Array<{
    taskRef: string;
    objective: string;
    status: string;
    phase: string | null;
    dependencyRefs: string[];
    authorityRefs: string[];
    requiredEffects: string[];
    outputObligationRefs: string[];
    validationEvidenceRefs: string[];
    reviewCriterionIds: string[];
    repairOwner: "planning" | "execution";
  }>;
  acceptanceObligationRefs: string[];
  coverageMatrix: Array<{
    criterionId: string;
    taskRefs: string[];
  }>;
  integratedValidation: {
    required: boolean;
    evidenceObligationRefs: string[];
  };
}

export function assertTaskGraph(graph: BtccTaskGraphPayload): void {
  if (graph.tasks.length === 0) throw new Error("btcc_task_graph_empty");
  const taskIds = new Set(graph.tasks.map((task) => task.taskRef));
  if (taskIds.size !== graph.tasks.length) throw new Error("btcc_task_graph_duplicate_task");
  const accepted = new Set<string>();
  for (const task of graph.tasks) {
    if (!task.objective.trim() || task.reviewCriterionIds.length === 0) {
      throw new Error("btcc_task_graph_task_contract_invalid");
    }
    if (task.dependencyRefs.some((dependency) => !accepted.has(dependency))) {
      throw new Error("btcc_task_graph_dependency_invalid");
    }
    accepted.add(task.taskRef);
  }
  const covered = new Set(graph.coverageMatrix.flatMap((entry) => entry.taskRefs));
  if (graph.coverageMatrix.length === 0 || [...covered].some((task) => !taskIds.has(task))) {
    throw new Error("btcc_task_graph_coverage_invalid");
  }
  if (graph.coverageMatrix.some((entry) => entry.taskRefs.length === 0)) {
    throw new Error("btcc_task_graph_coverage_invalid");
  }
  if (new Set(graph.coverageMatrix.map((entry) => entry.criterionId)).size !==
      graph.coverageMatrix.length) {
    throw new Error("btcc_task_graph_coverage_not_unique");
  }
  const coverageByCriterion = new Map(
    graph.coverageMatrix.map((entry) => [entry.criterionId, new Set(entry.taskRefs)]),
  );
  for (const task of graph.tasks) {
    for (const criterionId of task.reviewCriterionIds) {
      if (!coverageByCriterion.get(criterionId)?.has(task.taskRef)) {
        throw new Error("btcc_task_graph_review_coverage_mismatch");
      }
    }
  }
  for (const entry of graph.coverageMatrix) {
    for (const taskRef of entry.taskRefs) {
      const task = graph.tasks.find((candidate) => candidate.taskRef === taskRef);
      if (!task?.reviewCriterionIds.includes(entry.criterionId)) {
        throw new Error("btcc_task_graph_review_coverage_mismatch");
      }
    }
  }
  const assignedObligations = graph.tasks.flatMap((task) => task.outputObligationRefs);
  if (assignedObligations.length !== graph.acceptanceObligationRefs.length ||
    new Set(assignedObligations).size !== assignedObligations.length ||
    graph.acceptanceObligationRefs.some((ref) => !assignedObligations.includes(ref))) {
    throw new Error("btcc_task_graph_obligation_coverage_invalid");
  }
}

function trackingPolicyFor(active: ActiveTurnContract): TrackingPolicy {
  return active.contract.target_workstream_id
    ? { kind: "workstream", workstreamRef: active.contract.target_workstream_id }
    : { kind: "turn_local" };
}

function auditEvidenceRefs(audit: ToolAuditEntry[]): string[] {
  return unique(audit.flatMap((entry, index) => [
    ...(entry.evidenceReceipts?.map((receipt) => receipt.id) ?? []),
    ...(entry.evidenceCapabilityReceipts?.map((receipt) => receipt.receipt_id) ?? []),
    stableRef("tool-observation", {
      index,
      name: entry.name,
      ok: entry.ok,
      args: entry.args,
    }),
  ]));
}

function nonEmptyEvidence(modelCallRefs: string[], audit: ToolAuditEntry[]): string[] {
  const refs = unique([...modelCallRefs, ...auditEvidenceRefs(audit)]);
  return refs.length > 0 ? refs : [stableRef("runtime-evidence", { empty: true })];
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableRef(prefix: string, value: unknown): string {
  return `${prefix}:${hashBtccPayload(value).slice(0, 24)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
