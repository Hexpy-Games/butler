import type { Database } from "bun:sqlite";

export type SubsessionParentInput = {
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
  access_mode: "full_access";
  timestamp: string;
};

export function pendingParentInputCount(db: Database): number {
  return db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM btcc_subsession_outbox WHERE status = 'pending'
  `).get()?.count ?? 0;
}

export function pendingParentInputs(db: Database): SubsessionParentInput[] {
  return db.query<{ result_id: string; relation_id: string; input_json: string; safe_title: string }, []>(`
    SELECT outbox.result_id, outbox.relation_id, outbox.input_json, relation.safe_title
    FROM btcc_subsession_outbox AS outbox
    JOIN btcc_session_relations AS relation ON relation.relation_id = outbox.relation_id
    WHERE outbox.status = 'pending' ORDER BY outbox.created_at ASC, outbox.outbox_id ASC
  `).all().map((row) => ({
    ...(JSON.parse(row.input_json) as Omit<SubsessionParentInput, "result_id">),
    relation_id: row.relation_id,
    result_id: row.result_id,
    safe_title: row.safe_title,
  }));
}

export function pendingParentInputForResult(
  db: Database,
  resultId: string,
): SubsessionParentInput | null {
  const row = db.query<{ input_json: string; safe_title: string }, [string]>(`
    SELECT outbox.input_json, relation.safe_title
    FROM btcc_subsession_outbox AS outbox
    JOIN btcc_session_relations AS relation ON relation.relation_id = outbox.relation_id
    WHERE outbox.result_id = ? AND outbox.status = 'pending'
  `).get(resultId);
  return row ? {
    ...(JSON.parse(row.input_json) as SubsessionParentInput),
    safe_title: row.safe_title,
  } : null;
}

export function markParentInputDelivered(db: Database, resultId: string): void {
  db.query(`
    UPDATE btcc_subsession_outbox
    SET status = 'delivered', delivered_at = ?
    WHERE result_id = ? AND status = 'pending'
  `).run(new Date().toISOString(), resultId);
}
