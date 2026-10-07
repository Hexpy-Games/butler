import { seedP0BtccScale } from "./browser-p0-btcc-scale.ts";
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { statSync } from "node:fs";
import { join } from "node:path";

/** Mirrors monitoring_scale.rs, enlarged to the standing owner-scale contract. */
export function seedP0OwnerScale(data: string) {
  const path = join(data, "app-server/butler-client.sqlite");
  const db = new Database(path);
  db.exec(`PRAGMA busy_timeout=10000; BEGIN;
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<599)
    INSERT INTO chats(id,title,kind,pinned,archived,created_at,updated_at)
      SELECT 'p0-c'||i,'P0 대화 '||i,'chat',CASE WHEN i=599 THEN 1 ELSE 0 END,0,'2026-01-01','2026-01-01' FROM n;
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<4999)
    INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at)
      SELECT 'p0-t'||i,'p0-c'||(i%600),'delivered','Delivered','2026-01-01','2026-01-01' FROM n;
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<299999)
    INSERT INTO events(type,turn_id,payload_json,created_at)
      SELECT 'agent.turn_event','p0-t'||(i%5000),json_object('text',hex(zeroblob(2200))),'2026-01-01' FROM n;
    WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<2999)
    INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at)
      SELECT 'p0-m'||i,'p0-c599',CASE WHEN i%2=0 THEN 'user' ELSE 'assistant' END,
        '메시지 '||i||char(10)||replace(hex(zeroblob(16200)),'00','한글'),
        'delivered','2026-01-01','2026-01-01' FROM n;
    COMMIT; PRAGMA wal_checkpoint(TRUNCATE);`);
  const counts = db.query("SELECT (SELECT COUNT(*) FROM chats WHERE id LIKE 'p0-c%') chats,(SELECT COUNT(*) FROM events WHERE turn_id LIKE 'p0-t%') events,(SELECT COUNT(*) FROM messages WHERE chat_id='p0-c599') messages,(SELECT SUM(length(CAST(text AS BLOB))) FROM messages WHERE chat_id='p0-c599') transcriptBytes").get() as { chats: number; events: number; messages: number; transcriptBytes: number };
  for (const [order, id] of [["ASC", "p0-m0"], ["DESC", "p0-m2999"]]) {
    const row = db.query(`SELECT id FROM messages WHERE chat_id='p0-c599' ORDER BY rowid ${order} LIMIT 1`).get() as { id: string };
    assert.equal(row.id, id, "Transcript order and latest state retained");
  }
  db.close();
  const appBytes = statSync(path).size;
  assert.equal(counts.chats, 600); assert.equal(counts.events, 300000); assert.equal(counts.messages, 3000);
  assert(appBytes >= 1_300_000_000); assert(counts.transcriptBytes >= 290_000_000);
  const btcc = seedP0BtccScale(data);
  return { btcc, ...counts, appBytes, chatId: "p0-c599" };
}
