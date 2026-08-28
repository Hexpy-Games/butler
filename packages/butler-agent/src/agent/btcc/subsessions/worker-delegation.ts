import { NativeInboundQueue } from "../../../gateways/core/inbound-queue.ts";
import { digest, stableJson } from "../identity/index.ts";
import { loadReviewedDelegationPlan } from "./reviewed-delegation-plan.ts";
import {
  SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS,
  SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS,
} from "./scope.ts";
import { renderWorkerInput } from "./worker-input.ts";
import type {
  CreatedDelegation,
  DelegationPacket,
  ReviewedWorkerDelegationRequest,
  SessionRelation,
  SubsessionDelegationDependencies,
} from "./contracts.ts";

export async function delegateReviewedWorker(
  input: SubsessionDelegationDependencies,
  queue: NativeInboundQueue,
  request: ReviewedWorkerDelegationRequest,
): Promise<CreatedDelegation> {
  const parent = input.sessionBindings.getBySessionId(request.parent_session_id);
  if (!parent || parent.role !== "steward") throw new Error("parent_steward_session_required");
  const parentTurn = await input.parentTurns.findTurn(request.parent_turn_id);
  if (!parentTurn || parentTurn.sessionId !== request.parent_session_id) {
    throw new Error("worker_parent_turn_required");
  }
  const reviewed = await loadReviewedDelegationPlan(input, {
    parentSessionId: request.parent_session_id,
    parentTurnId: request.parent_turn_id,
  });
  if (!input.workerProfiles) throw new Error("worker_profiles_unavailable");
  const profile = await input.workerProfiles.read(request.profile_id);
  const identity = stableJson({
    parent_session_id: request.parent_session_id,
    parent_turn_id: request.parent_turn_id,
    objective: request.objective,
    acceptance_criteria: request.acceptance_criteria,
    profile_id: profile.id,
  });
  const delegationId = `delegation-${digest(`btcc.worker.delegation.v1\0${identity}`)}`;
  const existing = input.store.relationByDelegationId(delegationId);
  if (existing) return existingWorker(input, existing);
  const relationId = `relation-${digest(`btcc.worker.relation.v1\0${delegationId}`).slice(0, 40)}`;
  const taskId = `worker-task-${digest(`btcc.worker.task.v1\0${delegationId}`).slice(0, 40)}`;
  const childSessionId = `worker-${digest(`btcc.worker.session.v1\0${relationId}`).slice(0, 32)}`;
  const childTurnId = `worker-turn-${digest(`btcc.worker.turn.v1\0${relationId}`).slice(0, 32)}`;
  const now = new Date().toISOString();
  const allowedToolsAndEffects = request.parent_access_mode === "read_only"
    ? [...SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS]
    : [...SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS];
  const relation: SessionRelation = {
    relation_id: relationId,
    parent_session_id: request.parent_session_id,
    parent_turn_id: request.parent_turn_id,
    child_session_id: childSessionId,
    anchor_message_id: request.anchor_message_id,
    ordinal: (input.store.relationsByParentSessionId(request.parent_session_id).at(-1)?.ordinal ?? 0) + 1,
    safe_title: request.safe_title ?? "Worker task",
    created_at: now,
  };
  const packet: DelegationPacket = {
    delegation_id: delegationId,
    task_id: taskId,
    parent_session_id: request.parent_session_id,
    parent_turn_id: request.parent_turn_id,
    relation_id: relationId,
    execution_mode: request.parent_access_mode === "read_only" ? "read_only" : "mutation",
    objective: request.objective,
    acceptance_criteria: [...request.acceptance_criteria],
    task_or_plan_refs: [reviewed.parent_work_ref.plan_revision_id],
    constraints_and_non_goals: ["Execute only this bounded Task and report to the Steward."],
    allowed_tools_and_effects: allowedToolsAndEffects,
    mutation_scope: request.parent_access_mode === "read_only" ? [] : ["."],
    workspace_and_worktree: {
      ownership: "parent_session",
      workspace_label: "Inherited parent session workspace",
      repository_anchor_ref: "parent-session-workspace",
    },
    expected_result_schema: {
      version: 1,
      status: "success",
      required_fields: ["summary", "acceptance_evidence", "changed_artifacts"],
    },
    work_creation_policy: "none",
    access_and_budget_policy: {
      access_mode: request.parent_access_mode,
      max_turns: 8,
      model_ref: profile.model,
      reasoning_effort: profile.reasoning_effort,
    },
    parent_work_ref: reviewed.parent_work_ref,
    model_ref: profile.model,
    reasoning_effort: profile.reasoning_effort,
  };
  input.sessionBindings.upsert({
    sessionId: childSessionId,
    role: "worker",
    ...(parent.projectId ? { projectId: parent.projectId } : {}),
    ...(parent.appProjectId ? { appProjectId: parent.appProjectId } : {}),
    ...(parent.ledgerProjectId ? { ledgerProjectId: parent.ledgerProjectId } : {}),
    workspacePath: parent.workspacePath,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: profile.model.split("/", 1)[0] || parent.modelProviderId,
    modelRef: profile.model as `${string}/${string}`,
    transportBindings: [],
    metadata: {
      source: "btcc-worker",
      reasoning_effort: profile.reasoning_effort,
      subsession: {
        relation_id: relationId,
        delegation_id: delegationId,
        task_id: taskId,
        parent_session_id: request.parent_session_id,
        execution_mode: packet.execution_mode,
        mutation_scope: [...packet.mutation_scope],
        allowed_tools_and_effects: allowedToolsAndEffects,
      },
      runtimePolicy: {
        accessMode: request.parent_access_mode,
        trackingMode: "none",
        tracking_mode: "none",
        requiredNativeTools: [],
        required_tools: [],
        requiredNativeToolProfiles: request.parent_access_mode === "full_access" ? ["workspace"] : [],
        authoritySource: "parent_session",
        authority_source: "parent_session",
      },
    },
  });
  input.store.create({ relation, packet, childTurnId, rootWorkId: taskId });
  queue.enqueueIdempotent({
    eventId: `worker:${delegationId}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: childSessionId, parentId: request.parent_session_id },
    sender: { id: "butler-worker-dispatch", displayName: "Butler Worker" },
    message: {
      id: `worker-message:${delegationId}`,
      text: renderWorkerInput(packet, profile.prompt),
      timestamp: now,
    },
    routingHints: { sessionId: childSessionId, turnId: childTurnId },
    nativeStewardContext: {
      version: 1,
      role: "worker",
      projectName: parent.projectId ?? "",
      workspacePath: parent.workspacePath,
      modelRef: profile.model as `${string}/${string}`,
      reasoningEffort: profile.reasoning_effort,
    },
    raw: { source: "btcc-worker-delegation" },
  });
  return {
    relation,
    packet,
    child_turn_id: childTurnId,
    root_work_id: taskId,
    child_workspace_path: parent.workspacePath,
  };
}

function existingWorker(
  input: SubsessionDelegationDependencies,
  relation: SessionRelation,
): CreatedDelegation {
  const packet = input.store.packetByRelationId(relation.relation_id);
  const childTurnId = input.store.childTurnIdByRelationId(relation.relation_id);
  const child = input.sessionBindings.getBySessionId(relation.child_session_id);
  if (!packet || !childTurnId || !child) throw new Error("worker_existing_identity_incomplete");
  return {
    relation,
    packet,
    child_turn_id: childTurnId,
    root_work_id: packet.task_id,
    child_workspace_path: child.workspacePath,
  };
}
