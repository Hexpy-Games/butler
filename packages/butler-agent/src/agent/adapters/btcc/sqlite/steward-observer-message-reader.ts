import type { Database } from "bun:sqlite";
import type {
  StewardObserverMessage,
  StewardObserverRelation,
} from "../../../../gateways/app/domain/sessions/steward-observer.ts";

type MessageRow = {
  message_id: string;
  session_id: string;
  turn_id: string;
  role: "user" | "assistant" | string;
  content: string;
  created_at: string;
};

type DelegationRow = {
  child_turn_id: string;
  packet_json: string;
  created_at: string;
};

type DirectionRow = {
  instruction_id: string;
  instruction: string;
  created_at: string;
  applied_child_turn_id: string | null;
};

export function readStewardObserverMessages(
  db: Database,
  relation: StewardObserverRelation,
): StewardObserverMessage[] {
  const delegation = db.query<DelegationRow, [string]>(`
    SELECT child_turn_id, packet_json, created_at
    FROM btcc_subsession_delegations
    WHERE relation_id = ?
  `).get(relation.relation_id);
  const stored = db.query<MessageRow, [string]>(`
    SELECT message_id, session_id, turn_id, role, content, created_at
    FROM btcc_messages
    WHERE session_id = ? AND role IN ('user', 'assistant')
      AND message_id NOT LIKE 'steward-message:%'
      AND idempotency_key NOT LIKE 'inbound:%:steward:%'
      AND message_id NOT LIKE 'worker-result-message:%'
      AND message_id NOT LIKE 'subsession-direction-message:%'
    ORDER BY created_at ASC, message_id ASC
  `).all(relation.child_session_id).map<StewardObserverMessage>((message) => ({
    id: message.message_id,
    session_id: message.session_id,
    turn_id: message.turn_id,
    role: message.role === "user" ? "user" : "assistant",
    text: message.content,
    created_at: message.created_at,
    updated_at: message.created_at,
  }));
  const directions = db.query<DirectionRow, [string]>(`
    SELECT instruction_id, instruction, created_at, applied_child_turn_id
    FROM btcc_subsession_directions
    WHERE relation_id = ?
    ORDER BY revision ASC
  `).all(relation.relation_id).map<StewardObserverMessage>((direction) => ({
    id: `steward-direction:${direction.instruction_id}`,
    session_id: relation.child_session_id,
    turn_id: direction.applied_child_turn_id ?? delegation?.child_turn_id ?? "",
    role: "user",
    text: direction.instruction,
    created_at: direction.created_at,
    updated_at: direction.created_at,
  }));
  const request = delegation
    ? initialRequest(relation, delegation)
    : null;
  return [
    ...(request ? [request] : []),
    ...stored,
    ...directions,
  ].sort((left, right) =>
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

function initialRequest(
  relation: StewardObserverRelation,
  row: DelegationRow,
): StewardObserverMessage | null {
  try {
    const packet = JSON.parse(row.packet_json) as { objective?: unknown };
    if (typeof packet.objective !== "string" || !packet.objective.trim()) return null;
    return {
      id: `steward-request:${relation.relation_id}`,
      session_id: relation.child_session_id,
      turn_id: row.child_turn_id,
      role: "user",
      text: packet.objective.trim(),
      created_at: row.created_at,
      updated_at: row.created_at,
    };
  } catch {
    return null;
  }
}
