import { NativeInboundQueue } from "../../../gateways/core/inbound-queue.ts";
import { shortStewardWorktreeBranch } from "../../session-workspaces/index.ts";
import { digest } from "../identity/index.ts";
import { subsessionChildTurnId, subsessionDelegationId, subsessionResultId, subsessionRootWorkId } from "./identities.ts";
import { recoverPendingParentInputs } from "./outbox-recovery.ts";
import { completeStewardResultForDependencies } from "./terminal-result-service.ts";
import { resolveParentResultEvidence } from "./accepted-terminal-report.ts";
import { createStewardWorktree } from "./worktree.ts";
import { assertExactChildLedgerProjectIdentity, childProjectContextBinding, delegationProjectContextReady, snapshotChildProjectContext } from "./project-context.ts";
import {
  normalizeSubsessionAllowedToolsAndEffects,
  normalizeSubsessionMutationScopeForEffects,
} from "./scope.ts";
import { completePacketContext } from "./terminal-results.ts";
import { renderDelegatedParentConversationContext } from "./parent-conversation-context.ts";
import { renderStewardInput } from "./steward-input.ts";
import {
  assertReviewedDelegationRequest,
  loadReviewedDelegationPlan,
} from "./reviewed-delegation-plan.ts";
import {
  admittedParentTurnAccessMode,
  inheritedStewardRuntimePolicy,
  normalizeStewardAccessMode,
  reviewedStewardDelegationRequest,
  stewardRootWorkScope,
} from "./runtime-policy.ts";
import { createSubsessionControlService } from "./control.ts";
import type {
  CreatedDelegation, DelegationPacket, DelegationRequest, ParentInputSink,
  SessionRelation, SubsessionExecutionMode, SubsessionDelegationDependencies,
  SubsessionDelegationService,
} from "./contracts.ts";
import type { StoredSessionBinding } from "../../../test-support/harness/contracts.ts";
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
    const expectedRootWorkId = input.store.rootWorkIdByRelationId(relation.relation_id);
    if (!expectedRootWorkId) throw new Error("subsession_root_work_identity_missing");
    const packet = input.store.packetByRelationId(relation.relation_id);
    if (!packet || !completePacketContext(packet) || !await delegationProjectContextReady(packet.project_context, { sessionId: child.childSessionId, turnId: child.childTurnId }, input)) {
      await completeResult({
        childSessionId: child.childSessionId,
        childTurnId: child.childTurnId,
        resultId: subsessionResultId(relation.child_session_id, child.childTurnId),
        status: "blocked",
        code: "delegation_context_incomplete",
      });
      throw new Error("delegation_context_incomplete");
    }
    const childBinding = input.sessionBindings.getBySessionId(child.childSessionId);
    if (!childBinding || childBinding.role !== "steward") {
      throw new Error("subsession_child_binding_missing");
    }
    assertExactChildLedgerProjectIdentity(childBinding);
    const rootWorkScope = stewardRootWorkScope(childBinding);
    const existing = await input.durableWork.boundWorkForTurn(child.childTurnId);
    if (existing) {
      if (existing.workId !== expectedRootWorkId || existing.sessionId !== child.childSessionId) {
        throw new Error("subsession_root_work_identity_mismatch");
      }
      return existing.workId;
    }
    const work = await input.durableWork.startWork({
      sessionId: child.childSessionId,
      turnId: child.childTurnId,
      ...rootWorkScope,
      mutationCallId: `subsession-root-work:${packet.delegation_id}:${packet.task_id}:${child.childSessionId}`,
      objective: child.objective,
    });
    if (work.workId !== expectedRootWorkId) throw new Error("subsession_root_work_identity_mismatch");
    return work.workId;
  };
  const service: SubsessionDelegationService = {
    async reviewedDelegationPlan(parentInput) {
      return loadReviewedDelegationPlan(input, parentInput);
    },
    async delegateReviewed(request) {
      const reviewed = await loadReviewedDelegationPlan(input, {
        parentSessionId: request.parent_session_id,
        parentTurnId: request.parent_turn_id,
      });
      return service.delegate(reviewedStewardDelegationRequest(request, reviewed));
    },
    async delegate(request) {
      const normalizedRequest = normalizeDelegationRequest(request);
      const parent = input.sessionBindings.getBySessionId(normalizedRequest.parent_session_id);
      if (!parent || parent.role !== "butler") throw new Error("parent_butler_session_required");
      const parentTurn = await input.parentTurns.findTurn(normalizedRequest.parent_turn_id);
      if (!parentTurn || parentTurn.sessionId !== normalizedRequest.parent_session_id) {
        throw new Error("subsession_parent_turn_required");
      }
      if (normalizedRequest.parent_access_mode !== admittedParentTurnAccessMode(parentTurn)) {
        throw new Error("subsession_parent_access_mode_mismatch");
      }
      if (normalizedRequest.model_ref !== parent.modelRef) throw new Error("subsession_parent_model_mismatch");
      const parentReasoning = parent.metadata?.reasoning_effort;
      if (typeof parentReasoning === "string" && parentReasoning !== normalizedRequest.reasoning_effort) throw new Error("subsession_parent_reasoning_mismatch");
      const { projectContext, inheritedProject } = await snapshotChildProjectContext({
        parentSessionId: normalizedRequest.parent_session_id, parentTurnId: normalizedRequest.parent_turn_id, parent,
        turns: input.parentTurns, documents: input.contextDocuments,
      });
      const reviewed = await loadReviewedDelegationPlan(input, {
        parentSessionId: normalizedRequest.parent_session_id,
        parentTurnId: normalizedRequest.parent_turn_id,
      });
      assertReviewedDelegationRequest(normalizedRequest, reviewed);
      const delegationId = subsessionDelegationId(normalizedRequest);
      const existing = input.store.relationByDelegationId(delegationId); if (existing) return recoverExistingDelegation(input, existing);
      const relationId = `relation-${digest(`btcc.subsession.relation.v1\0${delegationId}`).slice(0, 40)}`;
      // Persisted task_id is the managerial assignment, never a Worker Task.
      const managerialAssignmentId = `task-${digest(`btcc.subsession.task.v1\0${delegationId}`).slice(0, 40)}`;
      const childSessionId = `steward-${digest(`btcc.subsession.child-session.v1\0${relationId}`).slice(0, 32)}`;
      const childTurnId = `steward-turn-${digest(`btcc.subsession.child-turn.v1\0${relationId}`).slice(0, 32)}`;
      const rootWorkId = subsessionRootWorkId(delegationId, managerialAssignmentId, childSessionId);
      const branch = shortStewardWorktreeBranch(relationId);
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
        delegationId, relationId, taskId: managerialAssignmentId,
        parentWorkRef: reviewed.parent_work_ref,
        branch,
      }, projectContext);
      const parentConversationContext = renderDelegatedParentConversationContext({
        conversations: input.conversations,
        parentSessionId: normalizedRequest.parent_session_id,
        parentTurnId: normalizedRequest.parent_turn_id,
        modelRef: normalizedRequest.model_ref,
      });
      registerChildSession(input, parent, normalizedRequest, packet, childSessionId, inheritedProject);
      const childWorkspacePath = normalizedRequest.execution_mode === "read_only"
        ? parent.workspacePath
        : await createStewardWorktree(input, parent.workspacePath, branch, childSessionId);
      const storedChild = input.sessionBindings.getBySessionId(childSessionId);
      if (!storedChild || (normalizedRequest.execution_mode === "mutation" &&
        storedChild.workspacePath === parent.workspacePath)) {
        throw new Error("steward_isolated_workspace_missing");
      }
      input.store.create({ relation, packet, childTurnId, rootWorkId });
      enqueueChild(childQueue, packet, normalizedRequest.parent_session_id, childSessionId,
        childTurnId, childWorkspacePath, now, parentConversationContext);
      return { relation, packet, child_turn_id: childTurnId, root_work_id: rootWorkId,
        child_workspace_path: childWorkspacePath } satisfies CreatedDelegation;
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
    async resolveParentResultEvidence(parentInput) {
      return resolveParentResultEvidence({ ...parentInput, store: input.store, turns: input.parentTurns });
    },
    resultIdForRelation(relationId) {
      return input.store.resultIdForRelation(relationId);
    },
    pendingParentInputCount() {
      return input.store.pendingParentInputCount();
    },
    ...createSubsessionControlService(input, childQueue),
  };
  return service;
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
  ids: { delegationId: string; relationId: string; taskId: string; parentWorkRef: DelegationPacket["parent_work_ref"]; branch: string },
  projectContext: DelegationPacket["project_context"],
): DelegationPacket {
  return {
    delegation_id: ids.delegationId,
    task_id: ids.taskId,
    parent_session_id: request.parent_session_id,
    parent_turn_id: request.parent_turn_id,
    relation_id: ids.relationId,
    execution_mode: request.execution_mode,
    objective: request.objective,
    acceptance_criteria: [...request.acceptance_criteria],
    task_or_plan_refs: [...request.task_or_plan_refs],
    ...(projectContext ? { project_context: projectContext } : {}),
    constraints_and_non_goals: [...request.constraints_and_non_goals],
    allowed_tools_and_effects: [...request.allowed_tools_and_effects],
    mutation_scope: [...request.mutation_scope],
    workspace_and_worktree: request.execution_mode === "read_only"
      ? {
          ownership: "project",
          workspace_label: "Validated project workspace",
          repository_anchor_ref: "parent-session-project",
        }
      : {
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
      access_mode: request.parent_access_mode,
      max_turns: 12,
      model_ref: request.model_ref,
      reasoning_effort: request.reasoning_effort,
    },
    parent_work_ref: ids.parentWorkRef,
    model_ref: request.model_ref,
    reasoning_effort: request.reasoning_effort,
  };
}
function registerChildSession(
  input: SubsessionDelegationDependencies,
  parent: StoredSessionBinding,
  request: DelegationRequest,
  packet: DelegationPacket,
  childSessionId: string,
  inheritedProject: ReturnType<typeof childProjectContextBinding>,
): void {
  input.sessionBindings.upsert({
    sessionId: childSessionId,
    role: "steward",
    ...(inheritedProject?.sessionBinding ?? {}),
    workspacePath: parent.workspacePath,
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: parent.modelProviderId,
    modelRef: packet.model_ref as `${string}/${string}`,
    transportBindings: [],
    metadata: {
      source: "btcc-subsession",
      subsession: {
        relation_id: packet.relation_id,
        delegation_id: packet.delegation_id,
        task_id: packet.task_id,
        parent_session_id: request.parent_session_id,
        execution_mode: packet.execution_mode,
        mutation_scope: [...packet.mutation_scope],
        allowed_tools_and_effects: [...packet.allowed_tools_and_effects],
        ...(inheritedProject ? { project_context: inheritedProject.metadata } : {}),
      },
      runtimePolicy: inheritedStewardRuntimePolicy(parent, request.parent_access_mode),
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
  parentConversationContext: string,
): void {
  childQueue.enqueueIdempotent({
    eventId: `steward:${packet.delegation_id}`,
    transport: "app",
    accountId: "local",
    peer: { kind: "dm", id: childSessionId, parentId: parentSessionId },
    sender: { id: "butler-steward-dispatch", displayName: "Butler Steward" },
    message: {
      id: `steward-message:${packet.delegation_id}`,
      text: renderStewardInput(packet, parentConversationContext),
      timestamp,
    },
    routingHints: { stewardId: childSessionId, turnId: childTurnId },
    nativeStewardContext: {
      version: 1,
      projectName: packet.project_context?.project_id ?? "",
      workspacePath,
      modelRef: packet.model_ref as `${string}/${string}`,
      reasoningEffort: packet.reasoning_effort,
    },
    raw: { source: "btcc-subsession-delegation" },
  });
}
function nextOrdinal(input: SubsessionDelegationDependencies, parentSessionId: string): number {
  return (input.store.relationsByParentSessionId(parentSessionId).at(-1)?.ordinal ?? 0) + 1;
}
function normalizeDelegationRequest(input: DelegationRequest): DelegationRequest {
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && !value.trim()) throw new Error(`delegation_${key}_required`);
  }
  if (!input.parent_work_ref) throw new Error("subsession_parent_work_ref_required");
  const parentAccessMode = normalizeStewardAccessMode(input.parent_access_mode);
  const executionMode = normalizeExecutionMode(input.execution_mode);
  const allowedToolsAndEffects = normalizeSubsessionAllowedToolsAndEffects(
    input.allowed_tools_and_effects,
    executionMode,
  );
  const mutationScope = executionMode === "mutation"
    ? normalizeSubsessionMutationScopeForEffects(
        input.mutation_scope,
        allowedToolsAndEffects,
      )
    : [];
  return {
    ...input,
    parent_access_mode: parentAccessMode,
    execution_mode: executionMode,
    allowed_tools_and_effects: allowedToolsAndEffects,
    mutation_scope: mutationScope,
  };
}

function normalizeExecutionMode(value: unknown): SubsessionExecutionMode {
  if (value === "read_only" || value === "mutation") return value;
  throw new Error("delegation_execution_mode_invalid");
}
