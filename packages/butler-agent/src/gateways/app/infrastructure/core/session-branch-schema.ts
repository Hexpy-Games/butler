import type { Database } from "bun:sqlite";

export function migrateSessionBranchSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS app_session_branches (
    request_id TEXT PRIMARY KEY, input_digest TEXT NOT NULL,
    target_session_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
    source_json TEXT NOT NULL, seed_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','ready'))
  );
  CREATE TRIGGER IF NOT EXISTS branch_pending_queue_guard BEFORE INSERT ON session_queued_messages
    WHEN EXISTS(SELECT 1 FROM app_session_branches WHERE target_session_id=NEW.chat_id AND state='prepared')
    BEGIN SELECT RAISE(ABORT,'session_branch_preparing'); END;
  CREATE TRIGGER IF NOT EXISTS branch_pending_turn_guard BEFORE INSERT ON turns
    WHEN EXISTS(SELECT 1 FROM app_session_branches WHERE target_session_id=NEW.chat_id AND state='prepared')
    BEGIN SELECT RAISE(ABORT,'session_branch_preparing'); END;`);
}
