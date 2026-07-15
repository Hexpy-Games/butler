import { createHash } from "node:crypto";
import type { PromptUsageSectionAttribution } from "../../../../integrations/providers/provider.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import type { PlannedReviewTurnContext } from "../context/planned-review-context.ts";
import type { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";
import type { WorkStreamResumeCandidate } from "../../workstream-checkpoint-resume-types.ts";
import { emitTurnEventBestEffort } from "../progress/turn-delivery-events.ts";
import { buildThinFirstResponsePrompt, shouldUseThinFirstResponse } from "./thin-first-response.ts";
import {
  activateTurnContract,
  contractExecutionPrompt,
  contractResumePrompt,
  openingDecisionPayload,
  restoreTurnContractExecution,
  type ActiveTurnContract,
} from "./turn-contract-runtime.ts";
import {
  compileStructuredTurnDecision,
  canonicalFunctionDecisionArgs,
  parseStructuredTurnDecision,
  stableTurnDecisionId,
  structuredDecisionRepairPrompt,
  structuredDecisionRepairGuidance,
  TURN_DECISION_REPAIR_LIMIT,
  turnContractCandidates,
  turnDecisionResponseFormat,
  typedTurnDecisionInstructions,
} from "./typed-turn-decision.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import type { ToolAuditEntry } from "../output/tool-types.ts";
import type { NativeStoredSessionConfig } from "./turn-runner-types.ts";
import type { TurnContextAtom } from "../../turn-continuation-context.ts";
import type { ConversationPromptContextPlan } from "../../../context/conversation-context.ts";
import {
  failContractForSurfaceInconsistency,
  isTurnContractSurfaceInconsistentError,
  surfaceRedecisionDiagnostic,
} from "./turn-contract-surface-invariant.ts";
import {
  listContinuityCandidates,
  type ContinuityProvenance,
} from "../../../cognition/continuity/continuity-store.ts";
import {
  checkpointBtccConceptionObservation,
  completeBtccConception,
  readActiveConceptionCheckpoint,
  readBtccActivationSnapshot,
  renderConceptionContextEnvelope,
  type PreparedBtccTurn,
} from "../../btcc/conception-runtime.ts";
import { BtccNativePhaseCoordinator } from "../../btcc/native-phase-coordinator.ts";
import type { ObligationToolSurfaceState } from "./obligation-tool-surface.ts";
import { isToolBatchCompletedHandoffText } from "../../tool-batch-handoff.ts";
import type { BtccToolPromptOptions } from "./turn-prompt-runners.ts";
import type { GoalContractCandidateV1 } from "../../btcc/phase-types.ts";
import { runBtccPlanningSynthesis } from "../../btcc/planning-synthesis.ts";

interface TypedTurnEntryContext {
  turnId: string;
  chatId?: string | null;
  prompt: string;
  userText: string;
  promptSections: PromptUsageSectionAttribution[];
  plannedReview: PlannedReviewTurnContext | null;
  resumeSelection: {
    candidates: WorkStreamResumeCandidate[];
    blockers: WorkStreamResumeCandidate[];
  };
  resumeDecisionEnvelope?: { prompt: string } | null;
  focusedResumeEnvelope?: { prompt: string } | null;
  toolSurfaceController: ToolSurfacePromptController;
  continuationAtom?: TurnContextAtom | null;
  conversationContextPlan: ConversationPromptContextPlan;
  normalizedPrompt: {
    thinContext: {
      activePersona: string;
      personalizationProfile: string;
      runtimePolicy: string;
    };
  };
}

type StructuredResponseFormat = ReturnType<typeof turnDecisionResponseFormat>;

export async function runTypedTurnEntry(input: {
  turnInput: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  butlerData: string;
  projectId?: string;
  context: TypedTurnEntryContext;
  initialPromptPhase: string;
  pendingPublicDecisions: PublicWorkDecision[];
  turnContractContext: { current: ActiveTurnContract | null };
  runPrivateTextPrompt: (
    prompt: string,
    phase: string,
    sections: PromptUsageSectionAttribution[],
    responseFormat: StructuredResponseFormat,
  ) => Promise<string>;
  runPrivateFunctionDecisionPrompt: (
    prompt: string,
    phase: string,
    sections: PromptUsageSectionAttribution[],
    responseFormat: StructuredResponseFormat,
    validateDecision: (args: Record<string, unknown>) =>
      | { ok: true; canonicalArgs: Record<string, unknown> }
      | {
        ok: false;
        errorCode: string;
        correction: string;
        canonicalArgs: Record<string, unknown>;
      },
  ) => Promise<string>;
  runKernelToolPrompt: (
    prompt: string,
    maxToolRounds?: number,
    phase?: string,
    options?: BtccToolPromptOptions,
  ) => Promise<string>;
  obligationToolSurfaceState?: () => ObligationToolSurfaceState;
  audit?: ToolAuditEntry[];
  surfaceRedecisionAttempt?: number;
  surfaceDiagnostic?: string;
  preparedBtccTurn?: PreparedBtccTurn | null;
}): Promise<{ candidateText: string; activeTurnContract: ActiveTurnContract }> {
  const surfaceRedecisionAttempt = input.surfaceRedecisionAttempt ?? 0;
  const resumed = surfaceRedecisionAttempt === 0 ? await resumeTypedTurnEntry(input) : null;
  if (resumed) return resumed;
  const candidates = turnContractCandidates({
    butlerData: input.butlerData,
    candidates: uniqueResumeCandidates([
      ...input.context.resumeSelection.candidates,
      ...input.context.resumeSelection.blockers,
    ]),
  });
  const continuityCandidates = listContinuityCandidates({
    butlerData: input.butlerData,
    projectId: input.projectId,
    sessionId: input.turnInput.handle.sessionId,
  });
  const decisionId = stableTurnDecisionId(
    surfaceRedecisionAttempt === 0
      ? input.context.turnId
      : `${input.context.turnId}:surface-redecision:${surfaceRedecisionAttempt}`,
  );
  const candidateIds = candidates.workstreams?.map((candidate) => candidate.workstream_id) ?? [];
  const typedInstructions = typedTurnDecisionInstructions({
    decisionId,
    projectId: input.projectId,
    candidateIds,
    continuityCandidates,
  });
  const decisionInstructions = input.preparedBtccTurn
    ? [
      input.preparedBtccTurn.phasePrompt.text,
      renderConceptionContextEnvelope(input.preparedBtccTurn.envelope),
      typedInstructions,
    ].join("\n\n")
    : typedInstructions;
  const thin = shouldUseThinFirstResponse({
    turnInput: input.turnInput,
    session: input.session,
    plannedReview: input.context.plannedReview,
  });
  const baseDecisionPrompt = thin
    ? buildThinFirstResponsePrompt({
      userText: input.context.userText,
      decisionInstructions,
      conversationContextPlan: input.context.conversationContextPlan,
      activePersona: input.context.normalizedPrompt.thinContext.activePersona,
      personalizationProfile: input.context.normalizedPrompt.thinContext.personalizationProfile,
      runtimePolicy: input.context.normalizedPrompt.thinContext.runtimePolicy,
      workstreamCapsule: input.context.resumeDecisionEnvelope?.prompt ??
        input.context.focusedResumeEnvelope?.prompt,
      personaFallback: input.session.init.systemPrompt,
    })
    : {
      prompt: [input.context.prompt, decisionInstructions].join("\n\n"),
      promptSections: input.context.promptSections,
    };
  const decisionPrompt = input.surfaceDiagnostic
    ? {
      ...baseDecisionPrompt,
      prompt: [baseDecisionPrompt.prompt, input.surfaceDiagnostic].join("\n\n"),
    }
    : baseDecisionPrompt;
  const responseFormat = turnDecisionResponseFormat({
    decisionId,
    projectId: input.projectId,
    candidateIds,
    waitingBlockerIds: candidates.workstreams
      ?.map((candidate) => candidate.waiting_user_blocker_id)
      .filter((id): id is string => Boolean(id)) ?? [],
    continuityCandidates,
    relatedContextRefs: input.preparedBtccTurn?.envelope.relatedContextAtoms
      .map((atom) => atom.ref),
    adaptationHintRefs: input.preparedBtccTurn?.envelope.adaptationHints
      .map((hint) => hint.hintRef),
  });
  const decisionTransport = input.turnInput.provider.capabilities.structuredDecisionTransport;
  if (!decisionTransport) {
    throw new Error("turn_contract_structured_decision_transport_missing");
  }
  const restoredConceptionCheckpoint = input.preparedBtccTurn
    ? readActiveConceptionCheckpoint(input.preparedBtccTurn)
    : null;
  let decisionBasePrompt = restoredConceptionCheckpoint
    ? [
      decisionPrompt.prompt,
      "## Restored Conception Checkpoint",
      JSON.stringify(restoredConceptionCheckpoint),
      "Continue from this exact typed checkpoint. Re-evaluate its open evidence need from admitted observations; do not restart intent analysis from prose.",
    ].join("\n\n")
    : decisionPrompt.prompt;
  let active: ActiveTurnContract | null = null;
  let lastError: unknown = null;
  const repairLimit = TURN_DECISION_REPAIR_LIMIT;
  let observationRoundIndex = restoredConceptionCheckpoint?.roundIndex ?? 0;
  let observationRefs = [...(restoredConceptionCheckpoint?.observationRefs ?? [])];
  const completedObservationFields = input.preparedBtccTurn
    ? input.preparedBtccTurn.store.completedConceptionObservationGoalFields(
      input.context.turnId,
      input.preparedBtccTurn.state.phaseGeneration,
    )
    : new Set<NonNullable<GoalContractCandidateV1["intentGroundingObservation"]>["goalField"]>();
  const seenObservationFingerprints = new Set<string>();
  if (restoredConceptionCheckpoint && !restoredConceptionCheckpoint.pendingToolCallRef) {
    for (const need of restoredConceptionCheckpoint.openEvidenceNeeds) {
      seenObservationFingerprints.add(hashObservationNeed(need));
    }
  }
  const validateFunctionDecision = (args: Record<string, unknown>) => {
    const canonicalArgs = canonicalFunctionDecisionArgs(args);
    try {
      const decision = parseStructuredTurnDecision(JSON.stringify(canonicalArgs), decisionId);
      compileStructuredTurnDecision({
        decision,
        candidates,
        workspaceId: input.projectId ?? input.turnInput.handle.sessionId,
        projectId: input.projectId,
        continuityCandidates,
        projectLedgerBound: input.preparedBtccTurn?.envelope.projectPolicy.kind === "project_bound",
      });
      return { ok: true, canonicalArgs } as const;
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : "turn_contract_decision_invalid";
      return {
        ok: false,
        errorCode,
        correction: structuredDecisionRepairGuidance(errorCode),
        canonicalArgs,
      } as const;
    }
  };
  while (!active) {
    let decision: ReturnType<typeof parseStructuredTurnDecision> | null = null;
    let contract: ReturnType<typeof compileStructuredTurnDecision> | null = null;
    let currentPrompt = decisionBasePrompt;
    for (let attempt = 0; attempt <= repairLimit; attempt += 1) {
      const phase = attempt === 0 ? "typed_turn_decision" : "typed_turn_decision_repair";
      const raw = decisionTransport === "function_tool"
        ? await input.runPrivateFunctionDecisionPrompt(
          currentPrompt,
          phase,
          decisionPrompt.promptSections,
          responseFormat,
          validateFunctionDecision,
        )
        : await input.runPrivateTextPrompt(
          currentPrompt,
          phase,
          decisionPrompt.promptSections,
          responseFormat,
        );
      try {
        decision = parseStructuredTurnDecision(raw, decisionId);
        contract = compileStructuredTurnDecision({
          decision,
          candidates,
          workspaceId: input.projectId ?? input.turnInput.handle.sessionId,
          projectId: input.projectId,
          continuityCandidates,
          projectLedgerBound: input.preparedBtccTurn?.envelope.projectPolicy.kind === "project_bound",
        });
        break;
      } catch (error) {
        lastError = error;
        if (attempt >= repairLimit) throw error;
        currentPrompt = structuredDecisionRepairPrompt({
          prompt: decisionBasePrompt,
          error,
          transport: decisionTransport,
        });
      }
    }
    if (!decision || !contract) throw lastError ?? new Error("turn_contract_decision_unavailable");
    const observationNeed = decision.goal_contract_candidate?.intentGroundingObservation;
    if (observationNeed) {
      if (!input.preparedBtccTurn || !decision.goal_contract_candidate) {
        throw new Error("btcc_conception_observation_authority_missing");
      }
      if (completedObservationFields.has(observationNeed.goalField)) {
        throw new Error("btcc_conception_goal_field_reentry_blocked");
      }
      const observationFingerprint = hashObservationNeed(observationNeed);
      if (seenObservationFingerprints.has(observationFingerprint)) {
        throw new Error("btcc_conception_same_observation_reentry_blocked");
      }
      seenObservationFingerprints.add(observationFingerprint);
      observationRoundIndex += 1;
      const pendingToolCallRef = `conception-observation:${input.context.turnId}:${observationFingerprint}`;
      checkpointBtccConceptionObservation({
        prepared: input.preparedBtccTurn,
        candidate: decision.goal_contract_candidate,
        roundIndex: observationRoundIndex,
        observationRefs,
        pendingToolCallRef,
      });
      const auditStart = input.audit?.length ?? 0;
      const observationPrompt = [
        input.preparedBtccTurn.phasePrompt.text,
        "## Typed Intent-Grounding Observation",
        JSON.stringify({
          observationNeed,
          workingGoalDraft: decision.goal_contract_candidate,
          admittedCapabilityManifestRevision:
            input.preparedBtccTurn.envelope.capabilityManifestRevision,
        }),
        "Use one or more admitted read-only observations only as needed to resolve this evidence need. Explain visible progress, then hand the observed facts back to Conception. Do not plan, implement, mutate, or validate future work.",
      ].join("\n\n");
      const toolObservations: ConceptionToolObservation[] = [];
      const handoff = await input.runKernelToolPrompt(
        observationPrompt,
        1,
        "btcc_conception_observation",
        {
          handoffAfterToolBatch: true,
          capabilityPolicy: {
            purpose: "intent_grounding",
            effects: ["observe"],
            requireDeclared: true,
          },
          onToolObservation: (observation) => toolObservations.push(observation),
        },
      );
      const observedAudit = (input.audit ?? []).slice(auditStart).filter((entry) => entry.ok);
      const acceptedToolObservations = toolObservations.filter((entry) => entry.ok);
      const newObservationRefs = [...new Set([
        ...conceptionObservationRefs(observedAudit),
        ...conceptionToolObservationRefs(acceptedToolObservations),
      ])];
      if (newObservationRefs.length === 0) {
        throw new Error("btcc_conception_observation_evidence_missing");
      }
      observationRefs = [...new Set([...observationRefs, ...newObservationRefs])];
      completedObservationFields.add(observationNeed.goalField);
      checkpointBtccConceptionObservation({
        prepared: input.preparedBtccTurn,
        candidate: decision.goal_contract_candidate,
        roundIndex: observationRoundIndex,
        observationRefs,
      });
      decisionBasePrompt = [
        decisionPrompt.prompt,
        "## Accepted Intent-Grounding Observations",
        JSON.stringify({
          resolvedNeed: observationNeed,
          observationRefs: newObservationRefs,
          handoff: handoff.trim(),
          observations: [
            ...conceptionObservationSummaries(observedAudit),
            ...conceptionToolObservationSummaries(acceptedToolObservations),
          ],
        }),
        "Revise the same Conception decision from this evidence. Set intent_grounding_observation to null when the GoalContract is ready; request another observation only for a distinct unresolved material fact.",
      ].join("\n\n");
      continue;
    }
    active = activateTurnContract({
      butlerData: input.butlerData,
      contract,
      decision,
      sessionId: input.turnInput.handle.sessionId,
      chatId: input.context.chatId,
      projectId: input.projectId,
      turnId: input.context.turnId,
      turnMetadata: input.turnInput.metadata,
      continuityCandidates,
      continuityProvenance: decision.continuity_updates?.length
        ? continuityProvenance(input)
        : undefined,
      boundWorkspacePath: input.session.init.workspacePath,
      toolSurfaceController: input.context.toolSurfaceController,
    });
  }
  if (!active) throw lastError ?? new Error("turn_contract_decision_unavailable");
  input.turnContractContext.current = active;
  let btccCoordinator: BtccNativePhaseCoordinator | null = null;
  if (input.preparedBtccTurn) {
    completeBtccConception({ prepared: input.preparedBtccTurn, active });
    btccCoordinator = new BtccNativePhaseCoordinator(
      input.preparedBtccTurn,
      input.butlerData,
    );
  }
  if (
    btccCoordinator &&
    input.obligationToolSurfaceState &&
    (active.contract.action === "answer" || active.contract.action === "cancel_work")
  ) {
    await completeBtccPlanningPhase(input, btccCoordinator, active, false);
  }
  if (active.contract.action === "answer") {
    return { candidateText: active.decision.answer_text ?? "", activeTurnContract: active };
  }
  if (active.contract.action === "cancel_work") {
    return { candidateText: active.decision.public_summary, activeTurnContract: active };
  }
  await emitTurnEventBestEffort(input.turnInput, {
    kind: "assistant.decision",
    payload: openingDecisionPayload(active),
  });
  input.pendingPublicDecisions.push(active.publicDecision);
  let candidateText: string;
  try {
    if (btccCoordinator && input.obligationToolSurfaceState) {
      await completeBtccPlanningPhase(input, btccCoordinator, active, true);
      candidateText = await input.runKernelToolPrompt(
        btccCoordinator.executionPrompt(active),
        undefined,
        "btcc_execution",
      );
    } else {
    candidateText = await input.runKernelToolPrompt(
      contractExecutionPrompt({
        basePrompt: input.context.prompt,
        active,
        butlerData: input.butlerData,
      }),
      undefined,
      input.initialPromptPhase,
    );
    }
  } catch (error) {
    if (!isTurnContractSurfaceInconsistentError(error)) throw error;
    active.contract = failContractForSurfaceInconsistency({
      butlerData: input.butlerData,
      contract: active.contract,
      attempt: surfaceRedecisionAttempt,
    });
    input.pendingPublicDecisions.splice(
      0,
      input.pendingPublicDecisions.length,
      ...input.pendingPublicDecisions.filter((decision) => decision.contractId !== active!.contract.contract_id),
    );
    input.turnContractContext.current = null;
    const safeToRedecide = active.contract.action === "tool_answer" || active.contract.action === "inspect";
    if (!safeToRedecide || surfaceRedecisionAttempt >= 1) throw error;
    return await runTypedTurnEntry({
      ...input,
      preparedBtccTurn: null,
      surfaceRedecisionAttempt: surfaceRedecisionAttempt + 1,
      surfaceDiagnostic: surfaceRedecisionDiagnostic(error),
    });
  }
  return { candidateText, activeTurnContract: active };
}

async function resumeTypedTurnEntry(
  input: Parameters<typeof runTypedTurnEntry>[0],
): Promise<{ candidateText: string; activeTurnContract: ActiveTurnContract } | null> {
  const atom = input.context.continuationAtom;
  const btccState = input.preparedBtccTurn?.store.readPhaseState(input.context.turnId) ?? null;
  if (btccState?.currentPhase === "conception") return null;
  if (!atom && !btccState) return null;
  const activation = atom?.contractId && atom.turnDecision
    ? { contractId: atom.contractId, decision: atom.turnDecision }
    : input.preparedBtccTurn
    ? readBtccActivationSnapshot(input.preparedBtccTurn)
    : null;
  if (!activation) throw new Error("btcc_activation_snapshot_missing");
  const nextSemanticBlockSequence = atom?.nextSemanticBlockSequence ?? 1;
  const active = restoreTurnContractExecution({
    butlerData: input.butlerData,
    contractId: activation.contractId,
    decision: activation.decision,
    nextSemanticBlockSequence,
    turnMetadata: input.turnInput.metadata,
    toolSurfaceController: input.context.toolSurfaceController,
    allowBtccOwnedState: Boolean(input.preparedBtccTurn),
  });
  if (atom?.workStreamId && active.contract.target_workstream_id !== atom.workStreamId) {
    throw new Error("turn_continuation_workstream_conflict");
  }
  input.turnContractContext.current = active;
  const coordinator = input.preparedBtccTurn
    ? new BtccNativePhaseCoordinator(input.preparedBtccTurn, input.butlerData)
    : null;
  const candidateText = coordinator
    ? await resumeBtccOwnedPhase(input, coordinator, active)
    : await input.runKernelToolPrompt(
      contractResumePrompt({
        basePrompt: input.context.prompt,
        active,
        nextSemanticBlockSequence,
      }),
      undefined,
      input.initialPromptPhase,
    );
  return { candidateText, activeTurnContract: active };
}

async function resumeBtccOwnedPhase(
  input: Parameters<typeof runTypedTurnEntry>[0],
  coordinator: BtccNativePhaseCoordinator,
  active: ActiveTurnContract,
): Promise<string> {
  const state = coordinator.state();
  if (state.currentPhase === "planning") {
    if (!input.obligationToolSurfaceState) throw new Error("btcc_planning_frontier_missing");
    await completeBtccPlanningPhase(input, coordinator, active, true, true);
    return await input.runKernelToolPrompt(
      coordinator.executionPrompt(active),
      undefined,
      "btcc_execution_resume",
    );
  }
  if (state.currentPhase === "execution") {
    return await input.runKernelToolPrompt(
      coordinator.executionPrompt(active),
      undefined,
      "btcc_execution_resume",
    );
  }
  const candidateRef = state.activeReviewTargetRef;
  const candidate = candidateRef ? coordinator.readArtifact(candidateRef) : null;
  const payload = candidate?.payload as Record<string, unknown> | undefined;
  const candidateText = typeof payload?.candidateText === "string" ? payload.candidateText : "";
  if (!candidateText) throw new Error("btcc_execution_candidate_missing");
  return candidateText;
}

async function completeBtccPlanningPhase(
  input: Parameters<typeof runTypedTurnEntry>[0],
  coordinator: BtccNativePhaseCoordinator,
  active: ActiveTurnContract,
  allowToolPlanning: boolean,
  resume = false,
): Promise<void> {
  if (!input.obligationToolSurfaceState) throw new Error("btcc_planning_frontier_missing");
  if (coordinator.state().currentPhase !== "planning") return;
  const planningCallRefs: string[] = [];
  let frontier = input.obligationToolSurfaceState();
  while (allowToolPlanning && (frontier.stage === "work_planning" || frontier.stage === "ledger")) {
    const before = JSON.stringify(frontier);
    const callRef = `model-call:planning${resume ? "-resume" : ""}:${input.context.turnId}:${planningCallRefs.length + 1}`;
    const handoff = await input.runKernelToolPrompt(
      coordinator.planningPrompt(active, frontier),
      1,
      resume ? "btcc_planning_resume" : "btcc_planning",
      { handoffAfterToolBatch: true },
    );
    planningCallRefs.push(callRef);
    frontier = input.obligationToolSurfaceState();
    if (JSON.stringify(frontier) === before) {
      throw new Error("btcc_planning_same_state_reentry_blocked");
    }
    if (!isToolBatchCompletedHandoffText(handoff) &&
      (frontier.stage === "work_planning" || frontier.stage === "ledger")) {
      throw new Error("btcc_planning_phase_output_incomplete");
    }
  }
  if (frontier.stage === "work_planning" || frontier.stage === "ledger") {
    throw new Error("btcc_planning_frontier_incomplete");
  }
  const synthesis = await runBtccPlanningSynthesis({
    butlerData: input.butlerData,
    coordinator,
    active,
    frontier,
    audit: input.audit ?? [],
    runPrivateTextPrompt: input.runPrivateTextPrompt,
  });
  coordinator.completePlanning({
    active,
    frontier,
    audit: input.audit ?? [],
    modelCallRefs: [...planningCallRefs, synthesis.modelCallRef],
    taskGraph: synthesis.taskGraph,
  });
}

function uniqueResumeCandidates<T extends { id: string }>(candidates: T[]): T[] {
  return [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
}

function continuityProvenance(
  input: Parameters<typeof runTypedTurnEntry>[0],
): ContinuityProvenance {
  const value = input.turnInput.metadata?.conversationProvenance;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("continuity_conversation_provenance_missing");
  }
  const record = value as Record<string, unknown>;
  const conversationSessionId = requiredMetadataString(record.conversationSessionId);
  const turnId = requiredMetadataString(record.turnId);
  const inboundMessageId = requiredMetadataString(record.inboundMessageId);
  if (turnId !== input.context.turnId) throw new Error("continuity_turn_provenance_mismatch");
  return {
    conversation_session_id: conversationSessionId,
    turn_id: turnId,
    inbound_message_id: inboundMessageId,
    runtime_session_id: input.turnInput.handle.sessionId,
    project_id: input.projectId?.trim() || null,
  };
}

function requiredMetadataString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("continuity_conversation_provenance_missing");
  }
  return value.trim();
}

function hashObservationNeed(
  need: NonNullable<GoalContractCandidateV1["intentGroundingObservation"]>,
): string {
  return createHash("sha256").update(JSON.stringify(need)).digest("hex").slice(0, 24);
}

function conceptionObservationRefs(entries: ToolAuditEntry[]): string[] {
  return [...new Set(entries.flatMap((entry, index) => [
    ...(entry.evidenceReceipts?.map((receipt) => receipt.id) ?? []),
    ...(entry.evidenceCapabilityReceipts?.map((receipt) => receipt.receipt_id) ?? []),
    `conception-observation:${createHash("sha256").update(JSON.stringify({
      index,
      name: entry.name,
      args: entry.args,
      observationRefs: entry.observation?.refs ?? [],
    })).digest("hex").slice(0, 24)}`,
  ]))];
}

function conceptionObservationSummaries(entries: ToolAuditEntry[]): Array<{
  observationRef: string;
  summary: string;
}> {
  return entries.map((entry, index) => {
    const content = entry.observation?.modelVisibleContent ??
      entry.observation?.summary ??
      "Observation completed; use the referenced evidence and handoff.";
    return {
      observationRef: conceptionObservationRefs([entry])[0] ?? `observation:${index}`,
      summary: content.slice(0, 6_000),
    };
  });
}

interface ConceptionToolObservation {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  ok: boolean;
}

function conceptionToolObservationRefs(entries: ConceptionToolObservation[]): string[] {
  return [...new Set(entries.flatMap((entry, index) => [
    ...resultReceiptRefs(entry.result),
    `conception-observation:${createHash("sha256").update(JSON.stringify({
      index,
      name: entry.name,
      args: entry.args,
      result: boundedJson(entry.result, 50_000),
    })).digest("hex").slice(0, 24)}`,
  ]))];
}

function conceptionToolObservationSummaries(entries: ConceptionToolObservation[]): Array<{
  observationRef: string;
  summary: string;
}> {
  return entries.map((entry, index) => ({
    observationRef: conceptionToolObservationRefs([entry])[0] ?? `observation:${index}`,
    summary: boundedJson(entry.result, 6_000),
  }));
}

function resultReceiptRefs(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const refs: string[] = [];
  for (const item of Array.isArray(record.evidence_capability_receipts)
    ? record.evidence_capability_receipts
    : []) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const ref = (item as Record<string, unknown>).receipt_id;
      if (typeof ref === "string" && ref.trim()) refs.push(ref.trim());
    }
  }
  for (const item of Array.isArray(record.evidence_receipts) ? record.evidence_receipts : []) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const ref = (item as Record<string, unknown>).id;
      if (typeof ref === "string" && ref.trim()) refs.push(ref.trim());
    }
  }
  return refs;
}

function boundedJson(value: unknown, maxLength: number): string {
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return "Observation completed; inspect its evidence reference.";
  }
}
