import type { SessionRelation, SubsessionDelegationDependencies, SubsessionDelegationService } from "./contracts.ts";
import { admittedParentTurnAccessMode } from "./runtime-policy.ts";

/** Resolve an exact existing Work; authority stays with its original child session. */
export async function resolveStewardFollowup(
  input: SubsessionDelegationDependencies,
  selector: Parameters<SubsessionDelegationService["steerSteward"]>[0],
): Promise<{ relation: SessionRelation; child_turn_id: string } | null> {
  if (!selector.workId && !selector.relationId) return null;
  const relation = selector.workId
    ? input.store.relationByRootWorkId(selector.workId)
    : input.store.relationById(selector.relationId!);
  if (!relation || (selector.relationId && selector.relationId !== relation.relation_id)) {
    throw new Error("steward_followup_target_not_found");
  }
  const previous = input.store.resultByRelationId(relation.relation_id);
  if (!previous && !selector.workId) return null;
  const child = input.sessionBindings.getBySessionId(relation.child_session_id);
  const source = input.sessionBindings.getBySessionId(selector.parentSessionId);
  const sourceTurn = await input.parentTurns.findTurn(selector.sourceParentTurnId);
  if (source?.role !== "butler" || child?.role !== "steward" ||
      sourceTurn?.sessionId !== selector.parentSessionId ||
      sourceTurn.originalMessageId !== selector.sourceMessageId ||
      admittedParentTurnAccessMode(sourceTurn) === "read_only") {
    throw new Error("steward_followup_authority_mismatch");
  }
  if (relation.parent_session_id !== selector.parentSessionId &&
      (!selector.workId || !source.ledgerProjectId ||
       source.ledgerProjectId !== child.ledgerProjectId ||
       !(source.appProjectId ?? source.projectId) ||
       (source.appProjectId ?? source.projectId) !== (child.appProjectId ?? child.projectId))) {
    throw new Error("steward_followup_project_mismatch");
  }
  const rootWorkId = input.store.rootWorkIdByRelationId(relation.relation_id);
  const childTurn = await input.parentTurns.findLatestTurnForSession(relation.child_session_id);
  const childTurnId = childTurn?.turnId ?? input.store.childTurnIdByRelationId(relation.relation_id);
  const work = childTurnId ? await input.durableWork.boundWorkForTurn(childTurnId) : null;
  if (!work || !rootWorkId || work.workId !== rootWorkId ||
      work.sessionId !== relation.child_session_id ||
      (work.status !== "open" && work.status !== "blocked")) {
    throw new Error("steward_followup_open_work_required");
  }
  return { relation, child_turn_id: childTurnId! };
}
