import type { Database } from "bun:sqlite";

export type SubsessionParentInput = {
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
};

export function pendingParentInputCount(db: Database): number {
  return db.query<{ count: number }, []>(`
    SELECT COUNT(*) AS count FROM btcc_subsession_outbox WHERE status = 'pending'
  `).get()?.count ?? 0;
}

export function pendingParentInputs(db: Database): SubsessionParentInput[] {
  return db.query<{ result_id: string; relation_id: string; input_json: string }, []>(`
    SELECT result_id, relation_id, input_json FROM btcc_subsession_outbox
    WHERE status = 'pending' ORDER BY created_at ASC, outbox_id ASC
  `).all().map((row) => ({
    ...(JSON.parse(row.input_json) as Omit<SubsessionParentInput, "result_id">),
    relation_id: row.relation_id,
    result_id: row.result_id,
  }));
}

export function pendingParentInputForResult(
  db: Database,
  resultId: string,
): SubsessionParentInput | null {
  const row = db.query<{ input_json: string }, [string]>(`
    SELECT input_json FROM btcc_subsession_outbox
    WHERE result_id = ? AND status = 'pending'
  `).get(resultId);
  return row ? JSON.parse(row.input_json) as SubsessionParentInput : null;
}

export function markParentInputDelivered(db: Database, resultId: string): void {
  db.query(`
    UPDATE btcc_subsession_outbox
    SET status = 'delivered', delivered_at = ?
    WHERE result_id = ? AND status = 'pending'
  `).run(new Date().toISOString(), resultId);
}
