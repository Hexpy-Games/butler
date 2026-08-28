import type {
  DelegationPacket,
  SessionRelation,
  SubsessionDelegationDependencies,
} from "./contracts.ts";

type ActiveParentDelegation = {
  relation: SessionRelation;
  parent_work_ref: DelegationPacket["parent_work_ref"];
  child_turn_id: string;
};

export async function activeParentDelegations(
  dependencies: SubsessionDelegationDependencies,
  input: { parentSessionId: string },
): Promise<ActiveParentDelegation[]> {
  const matches: ActiveParentDelegation[] = [];
  for (const relation of dependencies.store.relationsByParentSessionId(
    input.parentSessionId,
  )) {
    if (relation.parent_session_id !== input.parentSessionId) {
      throw new Error("active_parent_delegation_parent_session_mismatch");
    }
    const packet = dependencies.store.packetByRelationId(relation.relation_id);
    if (!packet || !sameRelationPacket(relation, packet)) {
      throw new Error("active_parent_delegation_packet_mismatch");
    }
    const taskId = dependencies.store.taskIdByRelationId(relation.relation_id);
    if (taskId !== packet.task_id) {
      throw new Error("active_parent_delegation_task_mismatch");
    }
    const childTurnId = dependencies.store.childTurnIdByRelationId(
      relation.relation_id,
    );
    if (!childTurnId) throw new Error("active_parent_delegation_child_turn_missing");
    const result = dependencies.store.resultByRelationId(relation.relation_id);
    if (result) continue;
    const childTurn = await dependencies.parentTurns.findTurn(childTurnId);
    if (childTurn && (childTurn.turnId !== childTurnId ||
      childTurn.sessionId !== relation.child_session_id)) {
      throw new Error("active_parent_delegation_child_turn_mismatch");
    }
    if (!isControllableStewardTurn(childTurn)) continue;
    matches.push({
      relation,
      parent_work_ref: packet.parent_work_ref,
      child_turn_id: childTurnId,
    });
  }
  return matches;
}

function isControllableStewardTurn(
  turn: Awaited<ReturnType<
    SubsessionDelegationDependencies["parentTurns"]["findTurn"]
  >>,
): boolean {
  return !turn || turn.semanticState === "admitted";
}

function sameRelationPacket(
  relation: SessionRelation,
  packet: DelegationPacket,
): boolean {
  return packet.relation_id === relation.relation_id &&
    packet.parent_session_id === relation.parent_session_id &&
    packet.parent_turn_id === relation.parent_turn_id &&
    packet.parent_work_ref.session_id === relation.parent_session_id &&
    packet.parent_work_ref.turn_id === relation.parent_turn_id;
}
