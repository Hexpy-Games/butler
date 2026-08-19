import { NativeInboundQueue } from "../../../gateways/core/inbound-queue.ts";
import {
  bindSessionGitWorktree,
  createWorkspaceReference,
} from "../../session-workspaces/index.ts";
import { digest, stableJson } from "../identity/index.ts";
import { subsessionChildTurnId, subsessionResultId, subsessionRootWorkId } from "./identities.ts";
import { recoverPendingParentInputs } from "./outbox-recovery.ts";
import { completeStewardResultForDependencies } from "./terminal-result-service.ts";
import {
  normalizeSubsessionAllowedToolsAndEffects,
  normalizeSubsessionMutationScope,
} from "./scope.ts";
import {
  completePacketContext,
} from "./terminal-results.ts";
import type {
  CreatedDelegation,
  DelegationPacket,
  DelegationRequest,
  ParentInputSink,
  SessionRelation,
  SubsessionDelegationDependencies,
  SubsessionDelegationService,
} from "./contracts.ts";
export function createSubsessionDelegationService(
  input: SubsessionDelegationDependencies,
): SubsessionDelegationService {
  const childQueue = new NativeInboundQueue(input.butlerData);
  const parentInputSink: ParentInputSink = input.parentInputSink;
  const completeResult = (resultInput: Parameters<SubsessionDelegationService["completeStewardResult"]>[0]) =>
    completeStewardResultForDependencies(input, parentInputSink, resultInput);
  const ensureRootWork = async (child: Parameters<SubsessionDelegationService["ensureChildRootWork"]>[0]): Promise<string> => {
    const relation = input.store.relationByChildSessionId(child.childSessionId);
    if (!relation) throw new Error("subsession_relation_missing");
    const existing = await input.durableWork.boundWorkForTurn(child.childTurnId);
    const expectedRootWorkId = input.store.rootWorkIdByRelationId(relation.relation_id);
    if (!expectedRootWorkId) throw new Error("subsession_root_work_identity_missing");
    if (existing) {
      if (existing.workId !== expectedRootWorkId || existing.sessionId !== child.childSessionId) {
        throw new Error("subsession_root_work_identity_mismatch");
      }
      return existing.workId;
    }
    const packet = input.store.packetByRelationId(relation.relation_id);
    if (!packet || !completePacketContext(packet)) {
      await completeResult({
        childSessionId: child.childSessionId,
        childTurnId: child.childTurnId,
        resultId: subsessionResultId(relation.child_session_id, child.childTurnId),
        status: "blocked",
        code: "delegation_context_incomplete",
      });
      throw new Error("delegation_context_incomplete");
    }
    const work = await input.durableWork.startWork({
      sessionId: child.childSessionId,
      turnId: child.childTurnId,
      mutationCallId: `subsession-root-work:${packet.delegation_id}:${packet.task_id}:${child.childSessionId}`,
      objective: child.objective,
    });
    if (work.workId !== expectedRootWorkId) throw new Error("subsession_root_work_identity_mismatch");
    return work.workId;
  };
  return {
    async delegate(request) {
      const normalizedRequest = normalizeDelegationRequest(request);
      const parent = input.sessionBindings.getBySessionId(normalizedRequest.parent_session_id);
      if (!parent || parent.role !== "butler") throw new Error("parent_butler_session_required");
      if (normalizedRequest.model_ref !== parent.modelRef) throw new Error("subsession_parent_model_mismatch");
      const parentReasoning = parent.metadata?.reasoning_effort;
      if (typeof parentReasoning === "string" && parentReasoning !== normalizedRequest.reasoning_effort) throw new Error("subsession_parent_reasoning_mismatch");
      const delegationId = delegationIdentity(normalizedRequest);
      const existing = input.store.relationByDelegationId(delegationId); if (existing) return recoverExistingDelegation(input, existing);
      if (input.store.relationByParentSessionId(normalizedRequest.parent_session_id)) throw new Error("subsession_parent_relation_exists");
      const relationId = `relation-${digest(`btcc.subsession.relation.v1\0${delegationId}`).slice(0, 40)}`;
      const taskId = `task-${digest(`btcc.subsession.task.v1\0${delegationId}`).slice(0, 40)}`;
      const childSessionId = `steward-${digest(`btcc.subsession.child-session.v1\0${relationId}`).slice(0, 32)}`;
      const childTurnId = `steward-turn-${digest(`btcc.subsession.child-turn.v1\0${relationId}`).slice(0, 32)}`;
      const rootWorkId = subsessionRootWorkId(delegationId, taskId, childSessionId);
      const branch = `butler/steward/${relationId.slice(-20)}`;
      const parentWork = await input.durableWork.boundWorkForTurn(normalizedRequest.parent_turn_id);
      if (normalizedRequest.parent_work_ref && (!parentWork ||
        parentWork.workId !== normalizedRequest.parent_work_ref.work_id ||
        parentWork.sessionId !== normalizedRequest.parent_work_ref.session_id ||
        normalizedRequest.parent_turn_id !== normalizedRequest.parent_work_ref.turn_id)) {
        throw new Error("subsession_parent_work_ref_mismatch");
      }
      const parentChatId = parent.transportBindings.find((binding) =>
        binding.transport === "app" && binding.peerId.trim(),
      )?.peerId;
      if (!parentChatId) throw new Error("parent_app_binding_required");
      const now = new Date().toISOString();
      const relation: SessionRelation = {
        relation_id: relationId,
        parent_session_id: normalizedRequest.parent_session_id,
        parent_turn_id: normalizedRequest.parent_turn_id,
        child_session_id: childSessionId,
        anchor_message_id: normalizedRequest.anchor_message_id,
        ordinal: nextOrdinal(input, normalizedRequest.parent_session_id),
        safe_title: normalizedRequest.safe_title,
        created_at: now,
      };
      const packet = createPacket(normalizedRequest, {
        delegationId,
        relationId,
        taskId,
        parentWorkRef: parentWork
          ? { work_id: parentWork.workId, session_id: parentWork.sessionId, turn_id: normalizedRequest.parent_turn_id }
          : undefined,
        branch,
      });
      registerChildSession(input, parent.workspacePath, normalizedRequest, packet, childSessionId);
      const worktree = await bindSessionGitWorktree({
        action: "create",
        branch,
        sessionId: childSessionId,
        butlerData: input.butlerData,
        bindingStore: input.sessionBindings,
        workspaceReference: createWorkspaceReference(parent.workspacePath),
      });
      if (!worktree.ok) {
        input.sessionBindings.deleteSession(childSessionId);
        throw new Error(`steward_worktree_unavailable:${worktree.error.code}`);
      }
      const storedChild = input.sessionBindings.getBySessionId(childSessionId);
      if (!storedChild || storedChild.workspacePath === parent.workspacePath) {
        throw new Error("steward_isolated_workspace_missing");
      }
      input.store.create({ relation, packet, childTurnId, rootWorkId });
      enqueueChild(childQueue, packet, normalizedRequest.parent_session_id, childSessionId,
        childTurnId, storedChild.workspacePath, now);
      return { relation, packet, child_turn_id: childTurnId, root_work_id: rootWorkId,
        child_workspace_path: storedChild.workspacePath } satisfies CreatedDelegation;
    },
    async ensureChildRootWork(child) {
      return ensureRootWork(child);
    },
    async completeStewardResult(resultInput) {
      return completeResult(resultInput);
    },
    async recoverPendingParentInputs() {
      return recoverPendingParentInputs({ store: input.store, sink: parentInputSink });
    },
    relationForParent(parentSessionId) {
      return input.store.relationByParentSessionId(parentSessionId);
    },
    resultIdForRelation(relationId) {
      return input.store.resultIdForRelation(relationId);
    },
    pendingParentInputCount() {
      return input.store.pendingParentInputCount();
    },
  };
}

function delegationIdentity(request: DelegationRequest): string {
  const identity = stableJson({
    parent_session_id: request.parent_session_id,
    parent_turn_id: request.parent_turn_id,
    anchor_message_id: request.anchor_message_id,
    objective: request.objective,
    acceptance_criteria: request.acceptance_criteria,
    task_or_plan_refs: request.task_or_plan_refs,
    constraints_and_non_goals: request.constraints_and_non_goals,
    allowed_tools_and_effects: request.allowed_tools_and_effects,
    mutation_scope: request.mutation_scope,
  });
  return `delegation-${digest(`btcc.subsession.delegation.v1\0${identity}`)}`;
}
function recoverExistingDelegation(
  input: SubsessionDelegationDependencies,
  relation: SessionRelation,
): CreatedDelegation {
  const packet = input.store.packetByRelationId(relation.relation_id);
  const child = input.sessionBindings.getBySessionId(relation.child_session_id);
  if (!packet || !child) throw new Error("subsession_existing_identity_incomplete");
  return {
    relation,
    packet,
    child_turn_id: subsessionChildTurnId(relation.relation_id),
    root_work_id: subsessionRootWorkId(packet.delegation_id, packet.task_id, relation.child_session_id),
    child_workspace_path: child.workspacePath,
  };
}
function createPacket(
  request: DelegationRequest,
  ids: { delegationId: string; relationId: string; taskId: string; parentWorkRef?: DelegationPacket["parent_work_ref"]; branch: string },
): DelegationPacket {
  return {
    delegation_id: ids.delegationId,
    task_id: ids.taskId,
    parent_session_id: request.parent_session_id,
    parent_turn_id: request.parent_turn_id,
    relation_id: ids.relationId,
    objective: request.objective,
    acceptance_criteria: [...request.acceptance_criteria],
    task_or_plan_refs: [...request.task_or_plan_refs],
    constraints_and_non_goals: [...request.constraints_and_non_goals],
    allowed_tools_and_effects: [...request.allowed_tools_and_effects],
    mutation_scope: [...request.mutation_scope],
    workspace_and_worktree: {
      ownership: "session",
      workspace_label: "Steward session worktree",
      repository_anchor_ref: "parent-session-repository",
      branch: ids.branch,
    },
    expected_result_schema: {
      version: 1,
      status: "success",
      required_fields: ["summary", "acceptance_evidence", "changed_artifacts"],
    },
    work_creation_policy: "one_recoverable_child_work",
    access_and_budget_policy: {
      access_mode: "full_access",
      max_turns: 12,
      model_ref: request.model_ref,
      reasoning_effort: request.reasoning_effort,
    },
    ...(ids.parentWorkRef ? { parent_work_ref: ids.parentWorkRef } : {}),
    model_ref: request.model_ref,
    reasoning_effort: request.reasoning_effort,
  };
}
function registerChildSession(
  input: SubsessionDelegationDependencies,
  parentWorkspacePath: string,
  request: DelegationRequest,
  packet: DelegationPacket,
  childSessionId: string,
): void {
  input.sessionBindings.upsert({
    sessionId: childSessionId,
    role: "steward",
    workspacePath: parentWorkspacePath,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: input.sessionBindings.getBySessionId(request.parent_session_id)!.modelProviderId,
    modelRef: packet.model_ref as `${string}/${string}`,
    transportBindings: [],
    metadata: {
      source: "btcc-subsession",
      subsession: {
        relation_id: packet.relation_id,
        delegation_id: packet.delegation_id,
        task_id: packet.task_id,
        parent_session_id: request.parent_session_id,
        mutation_scope: [...packet.mutation_scope],
        allowed_tools_and_effects: [...packet.allowed_tools_and_effects],
      },
      runtimePolicy: {
        accessMode: "full_access",
        trackingMode: "local",
        requiredNativeToolProfiles: ["workspace"],
        requiredNativeTools: [],
      },
      reasoning_effort: packet.reasoning_effort,
    },
  });
}
function enqueueChild(
  childQueue: NativeInboundQueue,
  packet: DelegationPacket,
  parentSessionId: string,
  childSessionId: string,
  childTurnId: string,
  workspacePath: string,
  timestamp: string,
): void {
  childQueue.enqueueIdempotent({
    eventId: `steward:${packet.delegation_id}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: childSessionId, parentId: parentSessionId },
    sender: { id: "butler-steward-dispatch", displayName: "Butler Steward" },
    message: {
      id: `steward-message:${packet.delegation_id}`,
      text: renderStewardInput(packet),
      timestamp,
    },
    routingHints: { stewardId: childSessionId, turnId: childTurnId },
    nativeStewardContext: {
      version: 1,
      projectName: "",
      workspacePath,
      modelRef: packet.model_ref as `${string}/${string}`,
      reasoningEffort: packet.reasoning_effort,
    },
    raw: { source: "btcc-subsession-delegation" },
  });
}
function nextOrdinal(input: SubsessionDelegationDependencies, parentSessionId: string): number {
  const existing = input.store.relationByParentSessionId(parentSessionId);
  return existing ? existing.ordinal + 1 : 1;
}
function renderStewardInput(packet: DelegationPacket): string {
  return [
    "Steward role contract: execute exactly one bounded mutation and verify it in the session-owned worktree.",
    `delegation_id: ${packet.delegation_id}`,
    `task_id: ${packet.task_id}`,
    `relation_id: ${packet.relation_id}`,
    `parent_session_id: ${packet.parent_session_id}`,
    `parent_turn_id: ${packet.parent_turn_id}`,
    `objective: ${packet.objective}`,
    `acceptance_criteria: ${packet.acceptance_criteria.join("; ")}`,
    `task_or_plan_refs: ${packet.task_or_plan_refs.join("; ") || "none"}`,
    `constraints: ${packet.constraints_and_non_goals.join("; ")}`,
    `allowed_tools_and_effects: ${packet.allowed_tools_and_effects.join("; ")}`,
    `mutation_scope: ${packet.mutation_scope.join("; ")}`,
    `workspace_and_worktree: ${stableJson(packet.workspace_and_worktree)}`,
    `expected_result_schema: ${stableJson(packet.expected_result_schema)}`,
    `work_creation_policy: ${packet.work_creation_policy}`,
    `access_and_budget_policy: ${stableJson(packet.access_and_budget_policy)}`,
    ...(packet.parent_work_ref ? [`parent_work_ref: ${stableJson(packet.parent_work_ref)}`] : []),
  ].join("\n");
}
function normalizeDelegationRequest(input: DelegationRequest): DelegationRequest {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && !value.trim()) throw new Error(`delegation_${key}_required`);
  }
  if (!input.acceptance_criteria.length) throw new Error("delegation_acceptance_criteria_required");
  return {
    ...input,
    allowed_tools_and_effects: normalizeSubsessionAllowedToolsAndEffects(input.allowed_tools_and_effects),
    mutation_scope: normalizeSubsessionMutationScope(input.mutation_scope),
  };
}
