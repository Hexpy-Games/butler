import { digest, stableJson } from "../identity/index.ts";
import type { DelegationRequest } from "./contracts.ts";

export function subsessionDelegationId(request: DelegationRequest): string {
  const identity = stableJson({
    parent_session_id: request.parent_session_id,
    parent_turn_id: request.parent_turn_id,
    anchor_message_id: request.anchor_message_id,
    parent_access_mode: request.parent_access_mode,
    execution_mode: request.execution_mode,
    objective: request.objective,
    acceptance_criteria: request.acceptance_criteria,
    task_or_plan_refs: request.task_or_plan_refs,
    constraints_and_non_goals: request.constraints_and_non_goals,
    allowed_tools_and_effects: request.allowed_tools_and_effects,
    mutation_scope: request.mutation_scope,
    parent_work_ref: request.parent_work_ref,
  });
  return `delegation-${digest(`btcc.subsession.delegation.v1\0${identity}`)}`;
}

export function subsessionRootWorkId(
  delegationId: string,
  taskId: string,
  childSessionId: string,
): string {
  return `guided-work-${digest(`btcc-guided-work.v1\0work\0subsession-root-work:${delegationId}:${taskId}:${childSessionId}`).slice(0, 64)}`;
}

export function subsessionResultId(childSessionId: string, childTurnId: string): string {
  return `steward-result-${digest(`btcc.subsession.result.v1\0${childSessionId}\0${childTurnId}`).slice(0, 40)}`;
}

export function subsessionChildTurnId(relationId: string): string {
  return `steward-turn-${digest(`btcc.subsession.child-turn.v1\0${relationId}`).slice(0, 32)}`;
}

export function stewardResumeRequestId(
  relationId: string,
  recoveryId: string,
): string {
  return `app-steward-resume:${relationId}:${recoveryId}`;
}
