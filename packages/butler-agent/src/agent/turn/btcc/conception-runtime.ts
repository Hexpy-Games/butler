import { createHash } from "node:crypto";
import type { RuntimeTurnInput } from "../../../test-support/harness/contracts.ts";
import type { ConversationPromptContextPlan } from "../../context/conversation-context.ts";
import { readPersonalizationProfile } from "../../../personalization/profile.ts";
import {
  readRuntimeProfileProjection,
  type RuntimeProfileProjection,
} from "../../../personalization/profiling.ts";
import type { ActiveTurnContract } from "../native/turn-runner/turn-contract-runtime.ts";
import type { TurnContractDecision } from "../turn-contract-types.ts";
import { BtccPhaseStore, hashBtccPayload } from "./phase-store.ts";
import {
  BTCC_CONCEPTION_CHECKPOINT_SCHEMA,
  BTCC_GOAL_CONTRACT_SCHEMA,
  BTCC_PHASE_ARTIFACT_SCHEMA,
  BTCC_PHASE_RECEIPT_SCHEMA,
  type BtccPhaseArtifactV1,
  type BtccPhaseStateV1,
  type ConceptionCheckpointV1,
  type GoalContractCandidateV1,
  type GoalContractV1,
  type ProjectPolicy,
  type TrackingPolicy,
} from "./phase-types.ts";
import {
  btccPhasePrompt,
  type BtccPhasePromptContract,
} from "./phase-prompts.ts";
import { btccCapabilityManifestForTool } from "./capability-manifest.ts";

export const BTCC_CONCEPTION_CONTEXT_SCHEMA =
  "butler.btcc-conception-context.v1" as const;

export interface ConceptionContextEnvelopeV1 {
  schemaVersion: typeof BTCC_CONCEPTION_CONTEXT_SCHEMA;
  turnRef: string;
  inboundMessageRef: string;
  currentRequest: string;
  projectPolicy: ProjectPolicy;
  acceptedControlsRef: string;
  relatedContextAtoms: Array<{
    ref: string;
    kind: "conversation_turn" | "conversation_summary" | "prompt_section";
  }>;
  explicitNaming: {
    principalName?: string;
    preferredAddress?: string;
    butlerNickname?: string;
    sourceRef?: string;
  };
  adaptationHints: Array<{
    hintRef: string;
    appliesTo: "response_style" | "collaboration_style";
    hint: string;
  }>;
  continuity: {
    globalHotCacheRef?: string;
    sessionContinuityRef?: string;
    projectMemoryRef?: string;
    projectHotCacheRef?: string;
    feedbackBufferRef?: string;
  };
  projectContext?: {
    ledgerRuntimeContextRef?: string;
    activeWorkStateRef?: string;
  };
  capabilityManifestRevision: string;
}

export interface PreparedBtccTurn {
  store: BtccPhaseStore;
  state: BtccPhaseStateV1;
  envelope: ConceptionContextEnvelopeV1;
  phasePrompt: BtccPhasePromptContract;
  modelCallRef: string;
  close(): void;
}

export function prepareBtccTurn(input: {
  turnInput: RuntimeTurnInput;
  butlerData: string;
  turnId: string;
  userText: string;
  projectId?: string | null;
  workspacePath: string;
  conversationContextPlan: ConversationPromptContextPlan;
  promptSectionIds: readonly string[];
  capabilityManifest: readonly {
    name: string;
    inputSchema: Record<string, unknown>;
  }[];
}): PreparedBtccTurn | null {
  const provenance = conversationProvenance(input.turnInput, input.turnId);
  if (!provenance) return null;
  const store = new BtccPhaseStore({ butlerData: input.butlerData });
  try {
    const admitted = store.readPhaseState(input.turnId);
    if (!admitted) throw new Error("btcc_phase_state_missing");
    if (admitted.lifecycleStatus === "cancelled" || admitted.lifecycleStatus === "delivered") {
      store.close();
      return null;
    }
    const projectPolicy = admitted.currentPhase === "conception"
      ? projectPolicyFor(input.projectId, input.workspacePath)
      : admitted.projectPolicy;
    const acceptedControlsRef = admitted.currentPhase === "conception"
      ? stableRef("controls", input.turnInput.metadata?.executionControls ?? null)
      : admitted.acceptedControlsRef;
    const inputFingerprint = stableRef("conception-input", {
      turnId: input.turnId,
      inboundMessageRef: provenance.inboundMessageId,
      currentRequest: input.userText,
      projectPolicy,
      acceptedControlsRef,
      selectedContextAtoms: input.conversationContextPlan.selected_atom_ids,
    });
    const state = admitted.currentPhase === "conception"
      ? store.admitPhaseTurn({
        turnId: input.turnId,
        sessionId: provenance.conversationSessionId,
        attemptId: admitted.attemptId,
        projectPolicy,
        acceptedControlsRef,
        inputFingerprint,
      })
      : admitted;
    const envelope = buildConceptionContextEnvelope({
      ...input,
      inboundMessageRef: provenance.inboundMessageId,
      projectPolicy,
      acceptedControlsRef,
    });
    const phasePrompt = btccPhasePrompt({
      phase: state.currentPhase,
      mode: state.currentPhase === "conception" ? "fixed" : "resume",
      turnId: state.turnId,
      attemptId: state.attemptId,
      phaseGeneration: state.phaseGeneration,
      inputFingerprint: state.lastStableInputFingerprint,
      goalContractRef: state.goalContractRef,
      taskRef: state.activeTaskRef,
    });
    const goal = state.goalContractRef ? store.readGoalContract(state.goalContractRef) : null;
    const modelCallRef = goal?.conceptionModelCallId ?? stableRef("model-call:conception", {
      turnId: state.turnId,
      attemptId: state.attemptId,
      phaseGeneration: state.phaseGeneration,
      phasePromptHash: phasePrompt.promptHash,
      inputFingerprint: state.lastStableInputFingerprint,
    });
    return {
      store,
      state,
      envelope,
      phasePrompt,
      modelCallRef,
      close: () => store.close(),
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

export function completeBtccConception(input: {
  prepared: PreparedBtccTurn;
  active: ActiveTurnContract;
}): BtccPhaseStateV1 {
  const { prepared, active } = input;
  const now = new Date().toISOString();
  const candidate = active.decision.goal_contract_candidate ?? fallbackGoalCandidate(active);
  validateCandidateAuthorities(candidate, prepared.envelope);
  const goalContractRef = stableRef("goal-contract", {
    turnId: prepared.state.turnId,
    revision: 1,
    modelCallRef: prepared.modelCallRef,
    candidate,
  });
  const goalContract: GoalContractV1 = {
    schemaVersion: BTCC_GOAL_CONTRACT_SCHEMA,
    goalContractRef,
    turnRef: prepared.state.turnId,
    revision: 1,
    conceptionModelCallId: prepared.modelCallRef,
    requestedOutcome: candidate.requestedOutcome,
    problemFrame: candidate.problemFrame,
    intentUnderstanding: candidate.intentUnderstanding,
    deliverables: goalDeliverables(active),
    bindingConstraints: unique(candidate.bindingConstraints),
    nonGoals: unique(candidate.nonGoals),
    acceptanceIntents: candidate.acceptanceIntents,
    ambiguityDecisions: candidate.ambiguityDecisions,
    currentStateNeeds: unique(candidate.currentStateNeeds),
    evidenceNeeds: unique(candidate.evidenceNeeds),
    downstreamAuthorityNeeds: unique(candidate.downstreamAuthorityNeeds),
    applicableAdaptationHints: candidate.intentUnderstanding.userPreferenceApplications
      .map(({ hintRef }) => prepared.envelope.adaptationHints.find((hint) => hint.hintRef === hintRef))
      .filter((hint): hint is ConceptionContextEnvelopeV1["adaptationHints"][number] => Boolean(hint))
      .map(({ hintRef, appliesTo }) => ({ hintRef, appliesTo })),
    workShape: candidate.workShape,
    semanticAuthorityRefs: unique([
      prepared.state.acceptedControlsRef,
      projectPolicyRef(prepared.state.projectPolicy),
      prepared.envelope.inboundMessageRef,
    ]),
  };
  const checkpoint: ConceptionCheckpointV1 = {
    schemaVersion: BTCC_CONCEPTION_CHECKPOINT_SCHEMA,
    checkpointRef: stableRef("checkpoint:conception", {
      turnId: prepared.state.turnId,
      phaseGeneration: prepared.state.phaseGeneration,
      goalContractRef,
    }),
    turnRef: prepared.state.turnId,
    attemptRef: prepared.state.attemptId,
    phaseGeneration: prepared.state.phaseGeneration,
    roundIndex: 1,
    workingGoalDraft: goalDraft(goalContract),
    openEvidenceNeeds: [],
    observationRefs: unique([
      prepared.envelope.inboundMessageRef,
      ...prepared.envelope.relatedContextAtoms.map((atom) => atom.ref),
    ]),
    lastInputFingerprint: prepared.state.lastStableInputFingerprint,
    status: "finalized",
  };
  const opening = phaseArtifact(prepared.state, {
    artifactRef: stableRef("opening-decision", {
      turnId: prepared.state.turnId,
      decisionId: active.decision.decision_id,
    }),
    artifactKind: "opening_decision",
    artifactSchemaVersion: "butler.btcc-opening-decision.v1",
    payload: {
      decisionId: active.decision.decision_id,
      contractId: active.contract.contract_id,
      decision: active.decision,
      title: active.decision.public_title ?? active.decision.public_summary,
      summary: active.decision.public_summary,
      rationale: active.decision.public_rationale ?? active.decision.public_summary,
      immediateNextStep: active.decision.immediate_next_step ?? null,
      nextPhase: "planning",
    },
    provenanceRefs: [prepared.modelCallRef, prepared.envelope.inboundMessageRef],
    createdAt: now,
  });
  const continuity = active.decision.continuity_updates?.length
    ? phaseArtifact(prepared.state, {
      artifactRef: stableRef("continuity-update", {
        turnId: prepared.state.turnId,
        updates: active.decision.continuity_updates,
      }),
      artifactKind: "continuity_update",
      artifactSchemaVersion: "butler.btcc-continuity-update.v1",
      payload: { updateCount: active.decision.continuity_updates.length },
      provenanceRefs: [prepared.modelCallRef],
      createdAt: now,
    })
    : null;
  const artifacts = [opening, ...(continuity ? [continuity] : [])];
  const outputArtifactRefs = [
    checkpoint.checkpointRef,
    goalContract.goalContractRef,
    ...artifacts.map((artifact) => artifact.artifactRef),
  ];
  return prepared.store.commitPhase({
    expectedRowVersion: prepared.state.rowVersion,
    receipt: {
      schemaVersion: BTCC_PHASE_RECEIPT_SCHEMA,
      receiptId: stableRef("receipt:conception", {
        turnId: prepared.state.turnId,
        phaseGeneration: prepared.state.phaseGeneration,
        outputArtifactRefs,
      }),
      turnId: prepared.state.turnId,
      attemptId: prepared.state.attemptId,
      phase: "conception",
      phaseGeneration: prepared.state.phaseGeneration,
      inputFingerprint: prepared.state.lastStableInputFingerprint,
      phasePromptId: prepared.phasePrompt.promptId,
      phasePromptVersion: prepared.phasePrompt.version,
      phasePromptHash: prepared.phasePrompt.promptHash,
      outputArtifactRefs,
      evidenceRefs: [prepared.modelCallRef, prepared.envelope.inboundMessageRef],
      dependencyReceiptRefs: [],
      status: "passed",
      nextState: "planning",
      payload: { goalContractRef, decisionId: active.decision.decision_id },
      createdAt: now,
    },
    artifacts,
    conceptionCheckpoint: checkpoint,
    goalContract,
    trackingPolicyCandidate: trackingPolicyCandidate(prepared.state.projectPolicy, active),
  });
}

export function readBtccActivationSnapshot(prepared: PreparedBtccTurn): {
  contractId: string;
  decision: TurnContractDecision;
} | null {
  const state = prepared.store.readPhaseState(prepared.state.turnId);
  if (!state) throw new Error("btcc_phase_state_missing");
  for (const receiptRef of state.acceptedReceiptRefs) {
    const receipt = prepared.store.readPhaseReceipt(receiptRef);
    if (!receipt || receipt.phase !== "conception" || receipt.status !== "passed") continue;
    for (const artifactRef of receipt.outputArtifactRefs) {
      const artifact = prepared.store.readPhaseArtifact(artifactRef);
      if (!artifact || artifact.artifactKind !== "opening_decision") continue;
      const payload = artifact.payload as Record<string, unknown>;
      const contractId = typeof payload.contractId === "string" ? payload.contractId.trim() : "";
      const decision = payload.decision;
      if (!contractId || !isTurnContractDecision(decision)) {
        throw new Error("btcc_activation_snapshot_invalid");
      }
      return { contractId, decision };
    }
  }
  return null;
}

function isTurnContractDecision(value: unknown): value is TurnContractDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schema_version === "butler.turn-contract-decision.v1" &&
    typeof record.decision_id === "string" &&
    typeof record.action === "string" &&
    typeof record.public_summary === "string" &&
    Array.isArray(record.deliverables);
}

export function renderConceptionContextEnvelope(envelope: ConceptionContextEnvelopeV1): string {
  return [
    "## Conception Context Envelope",
    "The following JSON is runtime-assembled admitted context. References are authority boundaries, not suggestions.",
    JSON.stringify(envelope),
  ].join("\n");
}

export function buildConceptionContextEnvelope(input: {
  butlerData: string;
  turnId: string;
  userText: string;
  inboundMessageRef: string;
  projectPolicy: ProjectPolicy;
  acceptedControlsRef: string;
  conversationContextPlan: ConversationPromptContextPlan;
  promptSectionIds: readonly string[];
  capabilityManifest: readonly { name: string; inputSchema: Record<string, unknown> }[];
}): ConceptionContextEnvelopeV1 {
  const profile = readPersonalizationProfile(input.butlerData);
  const projection = readRuntimeProfileProjection(input.butlerData);
  return {
    schemaVersion: BTCC_CONCEPTION_CONTEXT_SCHEMA,
    turnRef: input.turnId,
    inboundMessageRef: input.inboundMessageRef,
    currentRequest: input.userText,
    projectPolicy: input.projectPolicy,
    acceptedControlsRef: input.acceptedControlsRef,
    relatedContextAtoms: uniqueContextAtoms([
      ...input.conversationContextPlan.selected_summaries.map((summary) => ({
        ref: summary.id,
        kind: "conversation_summary" as const,
      })),
      ...[
        ...input.conversationContextPlan.selected_optional_turns,
        ...input.conversationContextPlan.required_turns,
      ].map((turn) => ({ ref: turn.id, kind: "conversation_turn" as const })),
      ...input.promptSectionIds.map((id) => ({
        ref: stableRef("prompt-section", id),
        kind: "prompt_section" as const,
      })),
    ]),
    explicitNaming: compactNaming({
      principalName: profile.principal_name,
      preferredAddress: profile.preferred_address,
      butlerNickname: profile.butler_nickname,
      sourceRef: profile.updated_at
        ? stableRef("explicit-naming", { updatedAt: profile.updated_at })
        : undefined,
    }),
    adaptationHints: adaptationHints(projection),
    continuity: compactRefs({
      globalHotCacheRef: promptSectionRef(input.promptSectionIds, "hot_cache"),
      sessionContinuityRef: promptSectionRef(input.promptSectionIds, "session_continuity"),
      projectMemoryRef: promptSectionRef(input.promptSectionIds, "project_memory"),
      projectHotCacheRef: promptSectionRef(input.promptSectionIds, "project_hot_cache"),
      feedbackBufferRef: promptSectionRef(input.promptSectionIds, "feedback_buffer"),
    }),
    ...(input.projectPolicy.kind === "project_bound"
      ? {
        projectContext: compactRefs({
          ledgerRuntimeContextRef: promptSectionRef(
            input.promptSectionIds,
            "project_ledger_runtime_context",
          ),
          activeWorkStateRef: promptSectionRef(input.promptSectionIds, "active_work_state"),
        }),
      }
      : {}),
    capabilityManifestRevision: stableRef(
      "capability-manifest",
      input.capabilityManifest
        .flatMap((tool) => btccCapabilityManifestForTool({
          name: tool.name,
          parameters: tool.inputSchema,
        }))
        .sort((left, right) => left.capabilityRef.localeCompare(right.capabilityRef)),
    ),
  };
}

function fallbackGoalCandidate(active: ActiveTurnContract): GoalContractCandidateV1 {
  const direct = active.contract.action === "answer" || active.contract.action === "cancel_work";
  const requiresCurrentState = !direct;
  return {
    requestedOutcome: active.decision.public_summary,
    problemFrame: active.decision.public_rationale ?? active.decision.public_summary,
    intentUnderstanding: {
      userRequest: active.decision.public_summary,
      relatedContextRefs: [],
      connectedKnowledgeNeeds: requiresCurrentState ? ["current admitted state"] : [],
      userPreferenceApplications: [],
      expertPerspectives: [],
      requiredResult: active.decision.answer_text ?? active.decision.public_summary,
    },
    bindingConstraints: [],
    nonGoals: [],
    acceptanceIntents: goalDeliverables(active).map((deliverable) => ({
      key: deliverable.key,
      statement: `Deliver ${deliverable.description}`,
      evidenceClass: direct ? "admitted_context" : "validation",
    })),
    ambiguityDecisions: [],
    currentStateNeeds: requiresCurrentState ? ["Resolve current state before claiming completion"] : [],
    evidenceNeeds: active.contract.required_evidence.map((item) => item.obligation_id),
    downstreamAuthorityNeeds: requiresCurrentState ? ["planned task authority"] : [],
    workShape: {
      workDisposition: direct ? "direct_answer" : "managed_work",
      custody: active.contract.target_workstream_id ||
          active.contract.action === "start_work" ||
          active.contract.action === "resume_work" ||
          active.contract.action === "modify_work"
        ? "durable"
        : "same_turn",
      requiredEffects: direct ? [] : active.contract.required_evidence.map((item) => item.evidence_class),
      deliverableKinds: active.contract.deliverables,
      requiresCurrentState,
      requiresTools: requiresCurrentState,
    },
  };
}

function goalDeliverables(active: ActiveTurnContract): GoalContractV1["deliverables"] {
  if (active.contract.deliverables.length === 0) {
    return [{
      key: "answer",
      kind: "answer",
      description: "A complete principal-facing answer",
      required: true,
    }];
  }
  return active.contract.deliverables.map((deliverable) => ({
    key: deliverable,
    kind: deliverable,
    description: deliverable.replaceAll("_", " "),
    required: true,
  }));
}

function trackingPolicyCandidate(
  policy: ProjectPolicy,
  active: ActiveTurnContract,
): TrackingPolicy {
  if (active.decision.goal_contract_candidate?.workShape.workDisposition === "direct_answer" ||
    active.contract.action === "answer" || active.contract.action === "cancel_work") {
    return { kind: "turn_local" };
  }
  if (policy.kind === "project_bound") {
    return {
      kind: "project_ledger",
      projectId: policy.projectId,
      ledgerProjectRef: policy.ledgerProjectRef,
      workspaceRef: policy.workspaceRef,
    };
  }
  if (active.contract.target_workstream_id) {
    return { kind: "workstream", workstreamRef: active.contract.target_workstream_id };
  }
  return { kind: "turn_local" };
}

function phaseArtifact(
  state: BtccPhaseStateV1,
  input: Omit<
    BtccPhaseArtifactV1,
    "schemaVersion" | "turnId" | "attemptId" | "phase" | "phaseGeneration" |
      "contentHash"
  >,
): BtccPhaseArtifactV1 {
  return {
    schemaVersion: BTCC_PHASE_ARTIFACT_SCHEMA,
    turnId: state.turnId,
    attemptId: state.attemptId,
    phase: "conception",
    phaseGeneration: state.phaseGeneration,
    ...input,
    contentHash: hashBtccPayload(input.payload),
  };
}

function goalDraft(contract: GoalContractV1): ConceptionCheckpointV1["workingGoalDraft"] {
  const {
    schemaVersion: _schemaVersion,
    goalContractRef: _goalContractRef,
    turnRef: _turnRef,
    revision: _revision,
    conceptionModelCallId: _conceptionModelCallId,
    ...draft
  } = contract;
  return draft;
}

function validateCandidateAuthorities(
  candidate: GoalContractCandidateV1,
  envelope: ConceptionContextEnvelopeV1,
): void {
  const contextRefs = new Set(envelope.relatedContextAtoms.map((atom) => atom.ref));
  if (candidate.intentUnderstanding.relatedContextRefs.some((ref) => !contextRefs.has(ref))) {
    throw new Error("btcc_conception_context_ref_not_admitted");
  }
  const hintRefs = new Set(envelope.adaptationHints.map((hint) => hint.hintRef));
  if (candidate.intentUnderstanding.userPreferenceApplications.some(({ hintRef }) => !hintRefs.has(hintRef))) {
    throw new Error("btcc_conception_adaptation_hint_not_admitted");
  }
}

function adaptationHints(
  projection: RuntimeProfileProjection | null,
): ConceptionContextEnvelopeV1["adaptationHints"] {
  if (!projection) return [];
  const response = [...projection.how_to_answer, ...projection.response_hints];
  const collaboration = [
    ...projection.how_to_collaborate,
    ...projection.caution_hints,
    ...projection.ask_before,
  ];
  return [
    ...response.map((hint) => admittedHint(projection, "response_style", hint)),
    ...collaboration.map((hint) => admittedHint(projection, "collaboration_style", hint)),
  ];
}

function admittedHint(
  projection: RuntimeProfileProjection,
  appliesTo: "response_style" | "collaboration_style",
  hint: string,
): ConceptionContextEnvelopeV1["adaptationHints"][number] {
  return {
    hintRef: stableRef("adaptation-hint", {
      version: projection.version,
      updatedAt: projection.updated_at,
      appliesTo,
      hint,
    }),
    appliesTo,
    hint,
  };
}

function projectPolicyFor(projectId: string | null | undefined, workspacePath: string): ProjectPolicy {
  const project = projectId?.trim();
  if (!project) return { kind: "unbound" };
  return {
    kind: "project_bound",
    projectId: project,
    ledgerProjectRef: `project-ledger:${project}`,
    workspaceRef: workspacePath,
  };
}

function projectPolicyRef(policy: ProjectPolicy): string {
  return stableRef("project-policy", policy);
}

function conversationProvenance(
  input: RuntimeTurnInput,
  expectedTurnId: string,
): { conversationSessionId: string; inboundMessageId: string } | null {
  const value = input.metadata?.conversationProvenance;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const turnId = requiredString(record.turnId);
  if (turnId !== expectedTurnId) throw new Error("btcc_conception_turn_provenance_mismatch");
  return {
    conversationSessionId: requiredString(record.conversationSessionId),
    inboundMessageId: requiredString(record.inboundMessageId),
  };
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("btcc_conception_provenance_missing");
  }
  return value.trim();
}

function stableRef(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(hashBtccPayload(value)).digest("hex").slice(0, 24)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueContextAtoms(
  values: ConceptionContextEnvelopeV1["relatedContextAtoms"],
): ConceptionContextEnvelopeV1["relatedContextAtoms"] {
  return [...new Map(values.map((value) => [value.ref, value])).values()];
}

function compactNaming(
  input: ConceptionContextEnvelopeV1["explicitNaming"],
): ConceptionContextEnvelopeV1["explicitNaming"] {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => typeof value === "string" && value.trim()),
  );
}

function compactRefs<T extends Record<string, string | undefined>>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => typeof value === "string" && value.trim()),
  ) as Partial<T>;
}

function promptSectionRef(sectionIds: readonly string[], id: string): string | undefined {
  return sectionIds.includes(id) ? stableRef("prompt-section", id) : undefined;
}
