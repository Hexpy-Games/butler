import type { Database } from "bun:sqlite";

const LEGACY_RECEIPT_MIGRATION = "projected_transport_events_v1";
const LEGACY_RECEIPT_BATCH = 32;
const MIGRATION_COPYING = 0;
const MIGRATION_CLEANING = 1;
const MIGRATION_COMPLETE = 2;

export class AppProjectedTransportEventStore {
  constructor(private readonly db: Database) {}

  migrateLegacyBatch(): boolean {
    const state = this.migrationState();
    if ((state?.completed ?? MIGRATION_COPYING) >= MIGRATION_COMPLETE) return false;
    if (state?.completed === MIGRATION_CLEANING) return this.deleteLegacyBatch();
    return this.copyLegacyBatch(state?.cursor_action_id ?? "");
  }

  legacyCopyComplete(): boolean {
    return (this.migrationState()?.completed ?? MIGRATION_COPYING) >=
      MIGRATION_CLEANING;
  }

  has(actionId: string): boolean {
    if (this.legacyCopyComplete()) {
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

  private copyLegacyBatch(cursor: string): boolean {
    const rows = this.db.query<{ action_id: string }, [string, number]>(`
      SELECT action_id FROM projected_transport_events
      WHERE action_id > ?
      ORDER BY action_id
      LIMIT ?
    `).all(cursor, LEGACY_RECEIPT_BATCH + 1);
    const batch = rows.slice(0, LEGACY_RECEIPT_BATCH);
    const nextCursor = batch.at(-1)?.action_id ?? cursor;
    const copied = rows.length <= LEGACY_RECEIPT_BATCH;
    this.db.transaction(() => {
      if (batch.length > 0) {
        this.db.query(`
          INSERT OR IGNORE INTO app_transport_projection_receipts (
            action_id, event_id, chat_id, created_at
          )
          SELECT action_id, event_id, chat_id, created_at
          FROM projected_transport_events
          WHERE action_id > ? AND action_id <= ?
        `).run(cursor, nextCursor);
        const conflict = this.db.query<{ action_id: string }, [string, string]>(`
          SELECT legacy.action_id
          FROM projected_transport_events AS legacy
          JOIN app_transport_projection_receipts AS durable
            ON durable.action_id = legacy.action_id
          WHERE legacy.action_id > ? AND legacy.action_id <= ?
            AND (
              durable.event_id <> legacy.event_id OR
              durable.chat_id <> legacy.chat_id
            )
          LIMIT 1
        `).get(cursor, nextCursor);
        if (conflict) {
          throw new Error(
            `Transport receipt identity conflict: ${conflict.action_id}`,
          );
        }
      }
      this.saveMigration(nextCursor, copied ? MIGRATION_CLEANING : MIGRATION_COPYING);
    })();
    return true;
  }

  private deleteLegacyBatch(): boolean {
    const rows = this.db.query<{ action_id: string }, [number]>(`
      SELECT action_id FROM projected_transport_events
      ORDER BY action_id
      LIMIT ?
    `).all(LEGACY_RECEIPT_BATCH + 1);
    const batch = rows.slice(0, LEGACY_RECEIPT_BATCH);
    const complete = rows.length <= LEGACY_RECEIPT_BATCH;
    this.db.transaction(() => {
      if (batch.length > 0) {
        this.db.query(`
          DELETE FROM projected_transport_events WHERE action_id IN (
            SELECT action_id FROM projected_transport_events
            ORDER BY action_id
            LIMIT ?
          )
        `).run(LEGACY_RECEIPT_BATCH);
      }
      if (complete) this.saveMigration("", MIGRATION_COMPLETE);
    })();
    return !complete;
  }

  private saveMigration(cursor: string, completed: number): void {
    this.db.query(`
      INSERT INTO app_transport_projection_migrations (
        name, cursor_action_id, completed, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        cursor_action_id = excluded.cursor_action_id,
        completed = excluded.completed,
        updated_at = excluded.updated_at
    `).run(
      LEGACY_RECEIPT_MIGRATION,
      cursor,
      completed,
      new Date().toISOString(),
    );
  }
}
