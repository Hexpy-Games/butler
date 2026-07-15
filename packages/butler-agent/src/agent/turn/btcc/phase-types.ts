export const BTCC_PHASE_STATE_SCHEMA = "butler.btcc-phase-state.v1" as const;
export const BTCC_PHASE_RECEIPT_SCHEMA = "butler.btcc-phase-receipt.v1" as const;
export const BTCC_PHASE_ARTIFACT_SCHEMA = "butler.btcc-phase-artifact.v1" as const;
export const BTCC_GOAL_CONTRACT_SCHEMA = "butler.btcc-goal-contract.v1" as const;
export const BTCC_CONCEPTION_CHECKPOINT_SCHEMA =
  "butler.btcc-conception-checkpoint.v1" as const;
export const BTCC_RETURN_TICKET_SCHEMA = "butler.btcc-return-ticket.v1" as const;

export const BTCC_PHASES = [
  "conception",
  "planning",
  "execution",
  "review",
  "consolidation",
  "reporting",
] as const;

export const BTCC_PHASE_LIFECYCLE_STATUSES = [
  "active",
  "waiting_user",
  "waiting_external",
  "waiting_runtime",
  "scheduled_continuation",
  "cancelled",
  "delivered",
] as const;

export type BtccPhase = (typeof BTCC_PHASES)[number];
export type BtccPhaseLifecycleStatus =
  (typeof BTCC_PHASE_LIFECYCLE_STATUSES)[number];

export type ProjectPolicy =
  | {
    kind: "project_bound";
    projectId: string;
    ledgerProjectRef: string;
    workspaceRef: string;
  }
  | { kind: "unbound" };

export type TrackingPolicy =
  | { kind: "turn_local" }
  | { kind: "workstream"; workstreamRef: string }
  | {
    kind: "project_ledger";
    projectId: string;
    ledgerProjectRef: string;
    workspaceRef: string;
  };

export interface GoalWorkShapeV1 {
  workDisposition: "direct_answer" | "managed_work";
  custody: "same_turn" | "durable";
  requiredEffects: string[];
  deliverableKinds: string[];
  requiresCurrentState: boolean;
  requiresTools: boolean;
}

export interface GoalContractV1 {
  schemaVersion: typeof BTCC_GOAL_CONTRACT_SCHEMA;
  goalContractRef: string;
  turnRef: string;
  revision: number;
  conceptionModelCallId: string;
  requestedOutcome: string;
  problemFrame: string;
  intentUnderstanding: {
    userRequest: string;
    relatedContextRefs: string[];
    connectedKnowledgeNeeds: string[];
    userPreferenceApplications: Array<{
      hintRef: string;
      application: string;
    }>;
    expertPerspectives: string[];
    requiredResult: string;
  };
  deliverables: Array<{
    key: string;
    kind: string;
    description: string;
    required: boolean;
  }>;
  bindingConstraints: string[];
  nonGoals: string[];
  acceptanceIntents: Array<{
    key: string;
    statement: string;
    evidenceClass:
      | "admitted_context"
      | "current_state"
      | "artifact"
      | "validation"
      | "user_confirmation";
  }>;
  ambiguityDecisions: Array<{
    issue: string;
    decision: string;
    basis:
      | "current_user_message"
      | "canonical_project_contract"
      | "accepted_prior_decision"
      | "fallible_context";
    sourceRefs: string[];
  }>;
  currentStateNeeds: string[];
  evidenceNeeds: string[];
  downstreamAuthorityNeeds: string[];
  applicableAdaptationHints: Array<{
    hintRef: string;
    appliesTo: "response_style" | "collaboration_style";
  }>;
  workShape: GoalWorkShapeV1;
  semanticAuthorityRefs: string[];
}

export interface GoalContractCandidateV1 {
  requestedOutcome: string;
  problemFrame: string;
  intentUnderstanding: GoalContractV1["intentUnderstanding"];
  bindingConstraints: string[];
  nonGoals: string[];
  acceptanceIntents: GoalContractV1["acceptanceIntents"];
  ambiguityDecisions: GoalContractV1["ambiguityDecisions"];
  currentStateNeeds: string[];
  evidenceNeeds: string[];
  downstreamAuthorityNeeds: string[];
  workShape: GoalWorkShapeV1;
  intentGroundingObservation?: {
    evidenceNeedId: string;
    goalField:
      | "referent"
      | "requested_outcome"
      | "scope"
      | "constraint"
      | "authority"
      | "acceptance";
    question: string;
    whyMaterial: string;
    sourceScopeRefs: string[];
    expectedResolution: string;
  };
}

export interface ConceptionCheckpointV1 {
  schemaVersion: typeof BTCC_CONCEPTION_CHECKPOINT_SCHEMA;
  checkpointRef: string;
  turnRef: string;
  attemptRef: string;
  phaseGeneration: number;
  roundIndex: number;
  workingGoalDraft?: Omit<
    GoalContractV1,
    "schemaVersion" | "goalContractRef" | "turnRef" | "revision" |
      "conceptionModelCallId"
  >;
  openEvidenceNeeds: Array<{
    evidenceNeedId: string;
    goalField:
      | "referent"
      | "requested_outcome"
      | "scope"
      | "constraint"
      | "authority"
      | "acceptance";
    question: string;
    whyMaterial: string;
    sourceScopeRefs: string[];
    expectedResolution: string;
  }>;
  observationRefs: string[];
  pendingToolCallRef?: string;
  lastInputFingerprint: string;
  publicProgressRef?: string;
  status: "active" | "superseded" | "finalized" | "aborted";
}

export type BtccPhaseArtifactKind =
  | "accepted_controls"
  | "structural_project_policy"
  | "tracking_policy_candidate"
  | "opening_decision"
  | "continuity_update"
  | "user_blocker"
  | "planning_input"
  | "planning_checkpoint"
  | "planning_validation_gap"
  | "task_graph"
  | "tracking_materialization"
  | "execution_input"
  | "execution_checkpoint"
  | "execution_operation"
  | "execution_candidate"
  | "review_input"
  | "review_checkpoint"
  | "review_candidate"
  | "review_verdict_frontier"
  | "consolidation_input"
  | "consolidation_checkpoint"
  | "consolidation_candidate"
  | "consolidation_finding_frontier"
  | "final_dossier"
  | "reporting_input"
  | "reporting_checkpoint"
  | "report_candidate"
  | "report_validation_receipt"
  | "report_guard_candidate"
  | "report_guard_receipt"
  | "tracking_closeout"
  | "return_ticket"
  | "public_progress";

export interface BtccPhaseArtifactV1<TPayload = unknown> {
  schemaVersion: typeof BTCC_PHASE_ARTIFACT_SCHEMA;
  artifactRef: string;
  turnId: string;
  attemptId: string;
  phase: BtccPhase;
  phaseGeneration: number;
  artifactKind: BtccPhaseArtifactKind;
  artifactSchemaVersion: string;
  taskRef?: string;
  payload: TPayload;
  contentHash: string;
  provenanceRefs: string[];
  createdAt: string;
}

export interface ReturnTicketV1 {
  schemaVersion: typeof BTCC_RETURN_TICKET_SCHEMA;
  ticketId: string;
  turnId: string;
  sourcePhase: "planning" | "review" | "consolidation" | "reporting";
  ownerPhase: "conception" | "planning" | "execution" | "review" | "reporting";
  taskRef?: string;
  criterionId?: string;
  criterionIds?: string[];
  contractFieldRef?: string;
  reasonCode: string;
  authoritativeInputGeneration: number;
  artifactRevisionRefs: string[];
  evidenceRefs: string[];
  requiredChange: string;
  gapFingerprint: string;
  createdAt: string;
}

export type BtccPhaseReceiptNextState =
  | BtccPhase
  | "waiting_user"
  | "waiting_external"
  | "waiting_runtime"
  | "scheduled_continuation"
  | "kernel_delivery";

export interface PhaseReceiptV1<TPayload = unknown> {
  schemaVersion: typeof BTCC_PHASE_RECEIPT_SCHEMA;
  receiptId: string;
  turnId: string;
  attemptId: string;
  phase: BtccPhase;
  phaseGeneration: number;
  taskRef?: string;
  inputFingerprint: string;
  phasePromptId: string;
  phasePromptVersion: number;
  phasePromptHash: string;
  outputArtifactRefs: string[];
  evidenceRefs: string[];
  dependencyReceiptRefs: string[];
  status: "passed";
  nextState: BtccPhaseReceiptNextState;
  payload?: TPayload;
  createdAt: string;
}

export interface BtccPhaseStateV1 {
  schemaVersion: typeof BTCC_PHASE_STATE_SCHEMA;
  turnId: string;
  attemptId: string;
  sessionId: string;
  projectPolicy: ProjectPolicy;
  trackingPolicyCandidate?: TrackingPolicy;
  trackingPolicy?: TrackingPolicy;
  acceptedControlsRef: string;
  lifecycleStatus: BtccPhaseLifecycleStatus;
  currentPhase: BtccPhase;
  phaseGeneration: number;
  rowVersion: number;
  goalContractRef?: string;
  activeConceptionCheckpointRef?: string;
  activePlanningCheckpointRef?: string;
  activeExecutionCheckpointRef?: string;
  activeReviewCheckpointRef?: string;
  activeConsolidationCheckpointRef?: string;
  activeReportingCheckpointRef?: string;
  activeConsolidationTargetRef?: string;
  activeFinalDossierRef?: string;
  activeTrackingAttemptRef?: string;
  activeExecutionOperationRef?: string;
  activeReviewTargetRef?: string;
  openToolCallRef?: string;
  planRevisionRef?: string;
  activeTrackingWorkRef?: string;
  activeTaskRef?: string;
  activeReturnTicketRef?: string;
  pendingCloseoutRef?: string;
  activeContinuationOwnerRef?: string;
  acceptedReceiptRefs: string[];
  invalidatedReceiptRefs: string[];
  lastStableInputFingerprint: string;
  updatedAt: string;
}

export type BtccDependencyAuthority =
  | "goal_contract"
  | "governing_contract"
  | "plan_or_task_graph"
  | "task_artifact_or_evidence"
  | "task_review"
  | "final_dossier";
