import { Database } from "bun:sqlite";

export class AppProjectedTransportEventStore {
  constructor(private readonly db: Database) {}

  has(actionId: string): boolean {
    const row = this.db
      .query<
        { action_id: string },
        [string]
      >("SELECT action_id FROM projected_transport_events WHERE action_id = ?")
      .get(actionId);
    return Boolean(row);
  }

  mark(actionId: string, eventId: string, chatId: string): void {
    this.db
      .query(
        `
      INSERT OR IGNORE INTO projected_transport_events (action_id, event_id, chat_id, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(actionId, eventId, chatId, new Date().toISOString());
  }
}
