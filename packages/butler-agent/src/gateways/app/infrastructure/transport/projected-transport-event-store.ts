import type { Database } from "bun:sqlite";

const LEGACY_RECEIPT_MIGRATION = "projected_transport_events_v1";
const MIGRATION_CLEANING = 1;

export class AppProjectedTransportEventStore {
  constructor(private readonly db: Database) {}

  has(actionId: string): boolean {
    if (this.legacyReceiptsCopied()) {
      return Boolean(this.db.query<{ action_id: string }, [string]>(`
        SELECT action_id FROM app_transport_projection_receipts WHERE action_id = ?
      `).get(actionId));
    }
    return Boolean(this.db.query<{ action_id: string }, [string, string]>(`
      SELECT action_id FROM app_transport_projection_receipts WHERE action_id = ?
      UNION ALL
      SELECT action_id FROM projected_transport_events WHERE action_id = ?
      LIMIT 1
    `).get(actionId, actionId));
  }

  mark(actionId: string, eventId: string, chatId: string): void {
    this.db.query(`
      INSERT OR IGNORE INTO app_transport_projection_receipts (
        action_id, event_id, chat_id, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(actionId, eventId, chatId, new Date().toISOString());
  }

  private legacyReceiptsCopied(): boolean {
    return (this.migrationState()?.completed ?? 0) >= MIGRATION_CLEANING;
  }

  private migrationState(): {
    cursor_action_id: string;
    completed: number;
  } | null {
    return this.db.query<{
      cursor_action_id: string;
      completed: number;
    }, [string]>(`
      SELECT cursor_action_id, completed
      FROM app_transport_projection_migrations
      WHERE name = ?
    `).get(LEGACY_RECEIPT_MIGRATION);
  }
}
