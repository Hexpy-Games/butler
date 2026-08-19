import type { DurableWorkService } from "../work/index.ts";
import type { SessionBindingStore } from "../../../test-support/harness/session-store.ts";

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

export type DelegationPacket = {
  delegation_id: string;
  task_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  relation_id: string;
  objective: string;
  acceptance_criteria: string[];
  task_or_plan_refs: string[];
  constraints_and_non_goals: string[];
  allowed_tools_and_effects: string[];
  mutation_scope: string[];
  workspace_and_worktree: {
    ownership: "session";
    workspace_label: string;
    repository_anchor_ref: string;
    branch: string;
  };
  expected_result_schema: {
    version: 1;
    status: "success";
    required_fields: ["summary", "acceptance_evidence", "changed_artifacts"];
  };
  work_creation_policy: "one_recoverable_child_work";
  access_and_budget_policy: {
    access_mode: "full_access";
    max_turns: number;
    model_ref: string;
    reasoning_effort: string;
  };
  parent_work_ref?: {
    work_id: string;
    session_id: string;
    turn_id: string;
  };
  model_ref: string;
  reasoning_effort: string;
};

export type StewardResultEnvelope = {
  result_id: string;
  relation_id: string;
  task_id: string;
  child_session_id: string;
  child_turn_id: string;
  status: "success";
  summary: string;
  acceptance_evidence: string[];
  changed_artifacts: string[];
  created_at: string;
};

export type ParentInputSink = (input: {
  relation_id: string;
  result_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  parent_chat_id: string;
  message_id: string;
  text: string;
  model_ref: string;
  reasoning_effort: string;
  access_mode: "full_access";
  timestamp: string;
}) => Promise<void> | void;

export type DelegationRequest = {
  parent_session_id: string;
  parent_turn_id: string;
  anchor_message_id: string;
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
  };
};

export type CreatedDelegation = {
  relation: SessionRelation;
  packet: DelegationPacket;
  child_turn_id: string;
  root_work_id: string;
  child_workspace_path: string;
};

export type CompleteStewardResultInput = {
  childSessionId: string;
  childTurnId: string;
  resultId: string;
  summary: string;
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
  relationByDelegationId(delegationId: string): SessionRelation | null;
  relationByParentSessionId(parentSessionId: string): SessionRelation | null;
  relationByChildSessionId(childSessionId: string): SessionRelation | null;
  packetByRelationId(relationId: string): DelegationPacket | null;
  rootWorkIdByRelationId(relationId: string): string | null;
  resultByRelationId(relationId: string): StewardResultEnvelope | null;
  resultIdForRelation(relationId: string): string | null;
  commitResult(input: {
    relation: SessionRelation;
    packet: DelegationPacket;
    childTurnId: string;
    resultId: string;
    summary: string;
    acceptanceEvidence: string[];
    changedArtifacts: string[];
    parentChatId: string;
  }): { result: StewardResultEnvelope; parentInput: {
    relation_id: string;
    result_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    parent_chat_id: string;
    message_id: string;
    text: string;
    model_ref: string;
    reasoning_effort: string;
    access_mode: "full_access";
    timestamp: string;
  }; inserted: boolean };
  pendingParentInputForResult(resultId: string): {
    relation_id: string;
    result_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    parent_chat_id: string;
    message_id: string;
    text: string;
    model_ref: string;
    reasoning_effort: string;
    access_mode: "full_access";
    timestamp: string;
  } | null;
  pendingParentInputCount(): number;
  markParentInputDelivered(resultId: string): void;
}

export type SubsessionDelegationService = {
  delegate(input: DelegationRequest): Promise<CreatedDelegation>;
  ensureChildRootWork(input: {
    childSessionId: string;
    childTurnId: string;
    objective: string;
  }): Promise<string>;
  completeStewardResult(input: CompleteStewardResultInput): Promise<CompleteStewardResultOutcome>;
  relationForParent(parentSessionId: string): SessionRelation | null;
  resultIdForRelation(relationId: string): string | null;
  pendingParentInputCount(): number;
};

export type SubsessionDelegationDependencies = {
  butlerData: string;
  sessionBindings: SessionBindingStore;
  durableWork: DurableWorkService;
  store: SubsessionDelegationStore;
  parentInputSink: ParentInputSink;
  toolJournal: import("../ports/guided-tool-journal.ts").GuidedToolJournal;
  effectJournal: import("../effects/contracts.ts").GuidedEffectJournal;
};
