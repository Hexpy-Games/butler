import type { DurableWorkService } from "../work/index.ts";
import type { BtccFinalArtifact } from "../contracts.ts";
import type { SessionBindingStore } from "../../../test-support/harness/session-store.ts";
import type { WorkerProfile } from "../../../gateways/app/interface/protocol/settings-contract.ts";
import type { ChangedFileDetail } from "../../tools/file-tools/shared/changed-file-detail.ts";
import type {
  DurableWorkActionProgress,
  DurableWorkCheckpoint,
  DurableWorkPlanAction,
} from "../work/index.ts";

/** The only persisted SessionRelation shape for the SS-02 vertical. */
export type SessionRelation = {
  relation_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  child_session_id: string;
  anchor_message_id: string;
  ordinal: number;
  safe_title: string;
  created_at: string;
};

export type SubsessionExecutionMode = "read_only" | "mutation";

export type SubsessionWorkspaceAndWorktree =
  | {
      ownership: "project";
      workspace_label: "Validated project workspace";
      repository_anchor_ref: "parent-session-project";
    }
  | {
      ownership: "parent_session";
      workspace_label: "Inherited parent session workspace";
      repository_anchor_ref: "parent-session-workspace";
    };

export type DelegationProjectContextRef = {
  context_ref: string;
  content_sha256: string;
  source_id: "project-hot-cache" | "project-memory";
  source_revision: string;
  projection_class: "mandatory_hot_cache" | "optional_hot_cache";
};

export type DelegationProjectContextSnapshot = {
  project_id: string;
  required_source_ids: string[];
  missing_source_ids: string[];
  mandatory_refs: DelegationProjectContextRef[];
  optional_refs: DelegationProjectContextRef[];
};

export type DelegationPacket = {
  delegation_id: string;
  /** Compatibility name for the Butler managerial assignment, never a Worker Task. */
  task_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  relation_id: string;
  execution_mode: SubsessionExecutionMode;
  objective: string;
  acceptance_criteria: string[];
  implementation_brief?: string;
  task_or_plan_refs: string[];
  plan_action?: {
    action_key: string;
    description: string;
    dependency_keys: string[];
    effect?: { capability: string; target: string };
    checkpoint_summary?: string;
    next_step?: string;
  };
  project_context?: DelegationProjectContextSnapshot;
  constraints_and_non_goals: string[];
  allowed_tools_and_effects: string[];
  mutation_scope: string[];
  workspace_and_worktree: SubsessionWorkspaceAndWorktree;
  expected_result_schema: {
    version: 1;
    status: "success" | "blocked" | "failed" | "cancelled";
    required_fields: ["summary", "acceptance_evidence", "changed_artifacts"];
  };
  work_creation_policy: "one_recoverable_child_work" | "none";
  access_and_budget_policy: {
    access_mode: "full_access" | "ask_first" | "read_only";
    max_turns: number;
    model_ref: string;
    reasoning_effort: string;
  };
  parent_work_ref: {
    work_id: string;
    session_id: string;
    turn_id: string;
    plan_revision_id: string;
    review_revision_id: string;
  };
  model_ref: string;
  reasoning_effort: string;
};

export type StewardResultStatus = "success" | "blocked" | "failed" | "cancelled";
export type StewardResultCode =
  | "delegation_context_incomplete"
  | "steward_execution_failed"
  | "steward_cancelled"
  | "worker_work_incomplete"
  | "worker_no_progress";

export type StewardResultEnvelope = {
  result_id: string;
  relation_id: string;
  task_id: string;
  child_session_id: string;
  child_turn_id: string;
  status: StewardResultStatus;
  code: StewardResultCode | null;
  summary: string;
  acceptance_evidence: string[];
  changed_artifacts: string[];
  changed_files?: ChangedFileDetail[];
  commits: string[];
  tests: string[];
  remaining_risks: string[];
  follow_up_recommendations: string[];
  detail_refs: string[];
  created_at: string;
};

export type ParentInputSink = (input: {
  relation_id: string;
  result_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  parent_chat_id: string;
  message_id: string;
  safe_title: string;
  text: string;
  model_ref: string;
  reasoning_effort: string;
  access_mode: "full_access" | "ask_first" | "read_only";
  timestamp: string;
}) => Promise<void> | void;

export type DelegationRequest = {
  parent_session_id: string;
  parent_turn_id: string;
  anchor_message_id: string;
  parent_access_mode: "full_access" | "ask_first" | "read_only";
  execution_mode: SubsessionExecutionMode;
  safe_title: string;
  objective: string;
  acceptance_criteria: string[];
  task_or_plan_refs: string[];
  constraints_and_non_goals: string[];
  allowed_tools_and_effects: string[];
  mutation_scope: string[];
  model_ref: string;
  reasoning_effort: string;
  parent_work_ref?: {
    work_id: string;
    session_id: string;
    turn_id: string;
    plan_revision_id: string;
    review_revision_id: string;
  };
};

export type ReviewedDelegationPlan = {
  parent_work_ref: DelegationPacket["parent_work_ref"];
  objective: string;
  acceptance_criteria: string[];
  task_or_plan_refs: string[];
  actions: DurableWorkPlanAction[];
  action_progress: DurableWorkActionProgress[];
  latest_checkpoint?: Pick<DurableWorkCheckpoint, "publicSummary" | "nextStep">;
};

type ReviewedDelegationIdentity = Pick<DelegationRequest,
  | "parent_session_id"
  | "parent_turn_id"
  | "anchor_message_id"
  | "parent_access_mode"
  | "model_ref"
  | "reasoning_effort"
>;

export type ReviewedDelegationRequest = ReviewedDelegationIdentity & {
  request: string;
  safe_title?: string;
};

export type ReviewedWorkerDelegationRequest = ReviewedDelegationIdentity & {
  action_key: string;
  objective: string;
  acceptance_criteria: string[];
  implementation_brief: string;
  safe_title?: string;
  profile_id?: string;
};

export type CreatedDelegation = {
  relation: SessionRelation;
  packet: DelegationPacket;
  child_turn_id: string;
  root_work_id: string;
  child_workspace_path: string;
};

export type StewardDirection = {
  instruction_id: string;
  relation_id: string;
  revision: number;
  source_parent_turn_id: string;
  source_message_id: string;
  instruction: string;
  status: "pending" | "applied";
  created_at: string;
  applied_at: string | null;
  applied_child_turn_id: string | null;
};

export type CreateStewardDirectionInput = Omit<
  StewardDirection,
  "revision" | "status" | "applied_at" | "applied_child_turn_id"
>;

export type CompleteStewardResultInput = {
  childSessionId: string;
  childTurnId: string;
  resultId: string;
  summary?: string;
  changedArtifacts?: string[];
  changedFiles?: ChangedFileDetail[];
  status?: StewardResultStatus;
  code?: StewardResultCode;
};

export type CompleteStewardResultOutcome = {
  status: "committed" | "duplicate";
  result: StewardResultEnvelope;
};

export interface SubsessionDelegationStore {
  create(input: {
    relation: SessionRelation;
    packet: DelegationPacket;
    childTurnId: string;
    rootWorkId: string;
  }): void;
  relationById(relationId: string): SessionRelation | null;
  relationByDelegationId(delegationId: string): SessionRelation | null;
  relationsByParentSessionId(parentSessionId: string): SessionRelation[];
  relationByChildSessionId(childSessionId: string): SessionRelation | null;
  packetByRelationId(relationId: string): DelegationPacket | null;
  rootWorkIdByRelationId(relationId: string): string | null;
  taskIdByRelationId(relationId: string): string | null;
  childTurnIdByRelationId(relationId: string): string | null;
  createDirection(direction: CreateStewardDirectionInput): StewardDirection;
  consumePendingDirection(input: {
    relationId: string;
    childTurnId: string;
  }): StewardDirection | null;
  resultByRelationId(relationId: string): StewardResultEnvelope | null;
  resultIdForRelation(relationId: string): string | null;
  commitResult(input: {
    relation: SessionRelation;
    childTurnId: string;
    resultId: string;
    taskId: string;
    modelRef: string;
    reasoningEffort: string;
    status: StewardResultStatus;
    code: StewardResultCode | null;
    summary: string;
    acceptanceEvidence: string[];
    changedArtifacts: string[];
    changedFiles?: ChangedFileDetail[];
    commits: string[];
    tests: string[];
    remainingRisks: string[];
    followUpRecommendations: string[];
    detailRefs: string[];
    parentChatId: string;
  }): { result: StewardResultEnvelope; parentInput: {
    relation_id: string;
    result_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    parent_chat_id: string;
    message_id: string;
    safe_title: string;
    text: string;
    model_ref: string;
    reasoning_effort: string;
    access_mode: "full_access" | "ask_first" | "read_only";
    timestamp: string;
  }; inserted: boolean };
  pendingParentInputForResult(resultId: string): {
    relation_id: string;
    result_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    parent_chat_id: string;
    message_id: string;
    safe_title: string;
    text: string;
    model_ref: string;
    reasoning_effort: string;
    access_mode: "full_access" | "ask_first" | "read_only";
    timestamp: string;
  } | null;
  pendingParentInputCount(): number;
  markParentInputDelivered(resultId: string): void;
  pendingParentInputs(): Array<{
    result_id: string;
    relation_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    parent_chat_id: string;
    message_id: string;
    safe_title: string;
    text: string;
    model_ref: string;
    reasoning_effort: string;
    access_mode: "full_access" | "ask_first" | "read_only";
    timestamp: string;
  }>;
}

export type SubsessionDelegationService = {
  activeChildCancellationTarget(childSessionId: string): Promise<{
    relation: SessionRelation;
    child_turn_id: string;
  } | null>;
  enabledWorkerProfiles?(): Promise<WorkerProfile[]>;
  activeParentDelegations(input: {
    parentSessionId: string;
  }): Promise<Array<{ relation: SessionRelation; parent_work_ref:
      DelegationPacket["parent_work_ref"]; child_turn_id: string }>>;
  shouldWaitForWorker(input: {
    parentSessionId: string;
    parentTurnId: string;
  }): Promise<boolean>;
  reviewedDelegationPlan(input: {
    parentSessionId: string;
    parentTurnId: string;
  }): Promise<ReviewedDelegationPlan>;
  delegateReviewed(input: ReviewedDelegationRequest): Promise<CreatedDelegation>;
  delegateWorkerReviewed(input: ReviewedWorkerDelegationRequest): Promise<CreatedDelegation>;
  delegate(input: DelegationRequest): Promise<CreatedDelegation>;
  ensureChildRootWork(input: {
    childSessionId: string;
    childTurnId: string;
    objective: string;
  }): Promise<string>;
  completeStewardResult(input: CompleteStewardResultInput): Promise<CompleteStewardResultOutcome>;
  completeWorkerResult(input: CompleteStewardResultInput & {
    changedArtifacts?: string[];
    changedFiles?: ChangedFileDetail[];
  }): Promise<CompleteStewardResultOutcome>;
  recoverPendingParentInputs(): Promise<{ attempted: number; delivered: number }>;
  resolveParentResultEvidence(input: {
    parentSessionId: string;
    parentInputText: string;
  }): Promise<{
    synthesisEvidence: string;
    outcome: StewardResultStatus;
    parentWorkId: string;
    changedFiles: ChangedFileDetail[];
    artifacts: BtccFinalArtifact[];
  } | null>;
  resultIdForRelation(relationId: string): string | null;
  pendingParentInputCount(): number;
  steerSteward(input: {
    parentSessionId: string;
    sourceParentTurnId: string;
    sourceMessageId: string;
    instruction: string;
    relationId?: string;
    safeTitle?: string;
  }): Promise<StewardDirection>;
  cancelSteward(input: {
    parentSessionId: string;
    sourceParentTurnId: string;
    sourceMessageId: string;
    relationId?: string;
    safeTitle?: string;
  }): Promise<{ relation: SessionRelation; child_turn_id: string; status: "cancelling" }>;
  consumeStewardDirection(input: {
    childSessionId: string;
    childTurnId: string;
  }): Promise<StewardDirection | null>;
};

export type SubsessionDelegationDependencies = {
  butlerData: string;
  sessionBindings: SessionBindingStore;
  durableWork: DurableWorkService;
  store: SubsessionDelegationStore;
  parentInputSink: ParentInputSink;
  toolJournal: import("../ports/guided-tool-journal.ts").GuidedToolJournal;
  effectJournal: import("../effects/contracts.ts").GuidedEffectJournal;
  parentTurns: Pick<import("../turn/index.ts").TurnStateRepository, "findTurn"> & {
    findLatestTurnForSession(sessionId: string): Promise<import("../turn/index.ts").TurnRecord | null>;
  };
  contextDocuments: import("../../context/context-projection.ts").ContextDocumentReader;
  conversations: import("../../conversation/index.ts").ConversationContextStoreReader;
  workerProfiles?: {
    list(): Promise<WorkerProfile[]>;
    read(profileId?: string): Promise<WorkerProfile>;
  };
};
