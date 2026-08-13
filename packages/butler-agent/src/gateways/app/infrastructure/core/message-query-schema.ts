import type { Database } from "bun:sqlite";

export function ensureAppMessageQuerySchema(db: Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS messages_role_created_idx
    ON messages(role, created_at, id);

    CREATE INDEX IF NOT EXISTS messages_chat_role_created_idx
    ON messages(chat_id, role, created_at, id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(text, tokenize = 'unicode61');

    INSERT INTO messages_fts(rowid, text)
    SELECT m.rowid, m.text
    FROM messages m
    WHERE NOT EXISTS (
      SELECT 1 FROM messages_fts f WHERE f.rowid = m.rowid
    );

    CREATE TRIGGER IF NOT EXISTS messages_fts_ai
    AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_ad
    AFTER DELETE ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_au
    AFTER UPDATE OF text ON messages BEGIN
      DELETE FROM messages_fts WHERE rowid = old.rowid;
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
  `);
}
