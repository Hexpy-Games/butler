import type { Database } from "bun:sqlite";

export class SqliteImmutableRecordStore {
  constructor(private readonly db: Database) {}

  insert(id: string, kind: string, sha256: string, json: string): void {
    this.db.query(`
      INSERT OR IGNORE INTO btcc_records (record_id, kind, sha256, content_json)
      VALUES (?, ?, ?, ?)
    `).run(id, kind, sha256, json);
    const stored = this.db.query<{
      kind: string;
      sha256: string;
      content_json: string;
    }, [string]>(`
      SELECT kind, sha256, content_json FROM btcc_records WHERE record_id = ?
    `).get(id);
    if (
      !stored ||
      stored.kind !== kind ||
      stored.sha256 !== sha256 ||
      stored.content_json !== json
    ) {
      throw new Error("BTCC immutable record identity conflict");
    }
  }
}
