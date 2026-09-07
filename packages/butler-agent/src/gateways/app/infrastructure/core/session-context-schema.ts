import type { Database } from "bun:sqlite";

export function migrateSessionContextSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_session_context_gate (
      session_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('turn','relocate')),
      owner_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_session_relocations (
      operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK(phase IN ('preparing','prepared','bound','committed','aborted')),
      from_json TEXT NOT NULL, to_json TEXT NOT NULL, prepared_json TEXT, error_code TEXT
    );
    INSERT OR IGNORE INTO app_session_context_gate(session_id,owner_kind,owner_id)
      SELECT chat_id,'turn',id FROM turns t WHERE (state NOT IN ('delivered','cancelled','failed','runtime_fault') OR retryable=1)
        AND rowid=(SELECT MAX(rowid) FROM turns WHERE chat_id=t.chat_id);
    CREATE UNIQUE INDEX IF NOT EXISTS app_session_relocation_active
      ON app_session_relocations(session_id) WHERE phase IN ('preparing','prepared','bound');
    CREATE TRIGGER IF NOT EXISTS session_context_queue_guard BEFORE INSERT ON session_queued_messages
      WHEN EXISTS(SELECT 1 FROM app_session_context_gate WHERE session_id=NEW.chat_id AND owner_kind='relocate')
      BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
    CREATE TRIGGER IF NOT EXISTS session_context_turn_guard BEFORE INSERT ON turns
      WHEN EXISTS(SELECT 1 FROM app_session_context_gate WHERE session_id=NEW.chat_id AND owner_kind='relocate')
      BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
    CREATE TRIGGER IF NOT EXISTS session_context_retry_guard BEFORE UPDATE OF state ON turns
      WHEN NEW.state NOT IN ('delivered','cancelled','failed','runtime_fault') AND
        EXISTS(SELECT 1 FROM app_session_context_gate WHERE session_id=NEW.chat_id AND owner_kind='relocate')
      BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
    CREATE TRIGGER IF NOT EXISTS session_context_node_delete_guard BEFORE DELETE ON app_space_nodes
      WHEN EXISTS(SELECT 1 FROM app_session_relocations WHERE phase IN ('preparing','prepared','bound') AND
        (OLD.node_key='s:'||session_id OR OLD.node_key=json_extract(to_json,'$.parentKey') OR
         OLD.node_key=json_extract(to_json,'$.targetKey') OR OLD.node_key=json_extract(from_json,'$.parentKey')))
      BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
    CREATE TRIGGER IF NOT EXISTS session_context_node_move_guard BEFORE UPDATE OF parent_key ON app_space_nodes
      WHEN OLD.parent_key IS NOT NEW.parent_key AND EXISTS(SELECT 1 FROM app_session_relocations
        WHERE phase IN ('preparing','prepared','bound') AND (OLD.node_key='s:'||session_id OR
        OLD.node_key=json_extract(to_json,'$.parentKey') OR OLD.node_key=json_extract(to_json,'$.targetKey')))
      BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
    CREATE TRIGGER IF NOT EXISTS session_context_project_delete_guard BEFORE DELETE ON projects
      WHEN EXISTS(SELECT 1 FROM app_session_relocations WHERE phase IN ('preparing','prepared','bound') AND
        (OLD.id=json_extract(to_json,'$.project.id') OR OLD.id=json_extract(from_json,'$.projectId')))
      BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
    CREATE TRIGGER IF NOT EXISTS session_context_project_update_guard BEFORE UPDATE OF workspace_path,archived ON projects
      WHEN EXISTS(SELECT 1 FROM app_session_relocations WHERE phase IN ('preparing','prepared','bound') AND
        (OLD.id=json_extract(to_json,'$.project.id') OR OLD.id=json_extract(from_json,'$.projectId')))
      BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
  `);
}
