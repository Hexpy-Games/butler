import type { Database } from "bun:sqlite";

export function ensureTerminalRetentionSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_terminal_turn_projections (
      turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      terminal_state TEXT NOT NULL,
      progress_rows_json TEXT NOT NULL,
      delivery_metadata_json TEXT,
      source_event_high_water INTEGER NOT NULL,
      compacted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_terminal_turn_progress_rows (
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      source_event_id INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY (turn_id, source_event_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS app_terminal_turn_snapshot_state (
      turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
      target_event_id INTEGER NOT NULL,
      cursor_event_id INTEGER NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS app_progress_row_identities (
      turn_id TEXT NOT NULL,
      row_json TEXT NOT NULL,
      PRIMARY KEY (turn_id, row_json)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS app_internal_continuation_progress_events (
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL,
      source_event_id INTEGER,
      PRIMARY KEY (turn_id, event_id)
    ) WITHOUT ROWID;
  `);
}
