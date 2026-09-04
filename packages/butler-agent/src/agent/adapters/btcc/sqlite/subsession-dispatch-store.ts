import type { Database } from "bun:sqlite";
import { stableJson } from "../../../btcc/identity/index.ts";
import type {
  DelegationPacket,
  SessionRelation,
  SubsessionDispatchIntent,
} from "../../../btcc/subsessions/index.ts";

type CreateSubsessionDispatchRecord = {
  relation: SessionRelation;
  packet: DelegationPacket;
  childTurnId: string;
  rootWorkId: string;
  dispatchIntent?: SubsessionDispatchIntent;
};

type DispatchIntentRow = {
  relation_id: string;
  dispatch_intent_json: string | null;
};

export function createSubsessionDispatchRecord(
  db: Database,
  input: CreateSubsessionDispatchRecord,
): void {
  db.transaction(() => insertSubsessionDispatchRecord(db, input)).immediate();
}

export function createWorkerDispatchAssignment(
  db: Database,
  input: CreateSubsessionDispatchRecord & { dispatchIntent: SubsessionDispatchIntent },
): SessionRelation {
  return db.transaction(() => {
    const active = findActiveWorkerDispatchRelation(db, {
      parentSessionId: input.relation.parent_session_id,
      parentWorkId: input.packet.parent_work_ref.work_id,
      actionKey: input.packet.plan_action?.action_key ?? "",
    });
    if (active) return active;
    insertSubsessionDispatchRecord(db, input);
    return input.relation;
  }).immediate();
}

function insertSubsessionDispatchRecord(
  db: Database,
  input: CreateSubsessionDispatchRecord,
): void {
  const existing = db.query<{ present: number }, [string]>(`
    SELECT 1 AS present FROM btcc_subsession_delegations
    WHERE delegation_id = ?
  `).get(input.packet.delegation_id);
  if (existing) return;
  db.query(`
    INSERT INTO btcc_session_relations (
      relation_id, parent_session_id, parent_turn_id, child_session_id,
      anchor_message_id, ordinal, safe_title, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.relation.relation_id,
    input.relation.parent_session_id,
    input.relation.parent_turn_id,
    input.relation.child_session_id,
    input.relation.anchor_message_id,
    input.relation.ordinal,
    input.relation.safe_title,
    input.relation.created_at,
  );
  db.query(`
    INSERT INTO btcc_subsession_delegations (
      delegation_id, relation_id, task_id, child_turn_id, root_work_id,
      packet_json, dispatch_intent_json, dispatch_state, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.packet.delegation_id,
    input.relation.relation_id,
    input.packet.task_id,
    input.childTurnId,
    input.rootWorkId,
    stableJson(input.packet),
    input.dispatchIntent ? stableJson(input.dispatchIntent) : null,
    input.dispatchIntent ? "pending" : null,
    input.relation.created_at,
  );
}

function findActiveWorkerDispatchRelation(
  db: Database,
  input: {
    parentSessionId: string;
    parentWorkId: string;
    actionKey: string;
  },
): SessionRelation | null {
  return db.query<SessionRelation, [string, string, string]>(`
    SELECT relation.relation_id, relation.parent_session_id,
      relation.parent_turn_id, relation.child_session_id,
      relation.anchor_message_id, relation.ordinal, relation.safe_title,
      relation.created_at
    FROM btcc_session_relations AS relation
    JOIN btcc_subsession_delegations AS delegation
      ON delegation.relation_id = relation.relation_id
    LEFT JOIN btcc_steward_results AS result
      ON result.relation_id = relation.relation_id
    WHERE relation.parent_session_id = ? AND result.result_id IS NULL
      AND json_extract(delegation.packet_json, '$.parent_work_ref.work_id') = ?
      AND json_extract(delegation.packet_json, '$.plan_action.action_key') = ?
    ORDER BY relation.ordinal ASC LIMIT 1
  `).get(input.parentSessionId, input.parentWorkId, input.actionKey) ?? null;
}

export function readSubsessionDispatchIntent(
  db: Database,
  relationId: string,
): SubsessionDispatchIntent | null {
  const row = db.query<Pick<DispatchIntentRow, "dispatch_intent_json">, [string]>(`
    SELECT dispatch_intent_json FROM btcc_subsession_delegations
    WHERE relation_id = ?
  `).get(relationId);
  return decodeDispatchIntent(row?.dispatch_intent_json ?? null);
}

export function listPendingSubsessionDispatchIntents(
  db: Database,
): Array<{ relationId: string; intent: SubsessionDispatchIntent }> {
  return db.query<DispatchIntentRow, []>(`
    SELECT delegation.relation_id, delegation.dispatch_intent_json
    FROM btcc_subsession_delegations AS delegation
    LEFT JOIN btcc_steward_results AS result
      ON result.relation_id = delegation.relation_id
    WHERE delegation.dispatch_state = 'pending'
      AND delegation.dispatch_intent_json IS NOT NULL
      AND result.result_id IS NULL
    ORDER BY delegation.created_at, delegation.delegation_id
  `).all().map(({ relation_id, dispatch_intent_json }) => {
    const intent = decodeDispatchIntent(dispatch_intent_json);
    if (!intent) throw new Error("subsession_dispatch_intent_invalid");
    return { relationId: relation_id, intent };
  });
}

export function markSubsessionDispatchEnqueued(
  db: Database,
  relationId: string,
): void {
  db.query(`
    UPDATE btcc_subsession_delegations SET dispatch_state = 'enqueued'
    WHERE relation_id = ? AND dispatch_state = 'pending'
  `).run(relationId);
}

function decodeDispatchIntent(value: string | null): SubsessionDispatchIntent | null {
  if (!value) return null;
  try {
    const intent = JSON.parse(value) as SubsessionDispatchIntent;
    if (!intent || typeof intent !== "object" ||
      !intent.childBinding?.sessionId || !intent.envelope?.eventId ||
      !intent.envelope.routingHints?.turnId ||
      !intent.metadata || typeof intent.metadata !== "object") return null;
    return intent;
  } catch {
    return null;
  }
}
