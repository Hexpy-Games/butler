import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from
  "../../packages/butler-agent/src/gateways/app/interface/server/create-app-server.ts";

test("App Gateway startup does not migrate legacy projection receipts", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-live-migration-isolation-"));
  const dbPath = join(root, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: root, port: 0 });
  server.stop();

  const db = new Database(dbPath);
  const insert = db.query(`
    INSERT INTO projected_transport_events (
      action_id, event_id, chat_id, created_at
    ) VALUES (?, ?, 'general', ?)
  `);
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let index = 0; index < 256; index += 1) {
      const id = index.toString().padStart(3, "0");
      insert.run(`legacy-${id}`, `event-${id}`, now);
    }
  })();
  db.close();

  server = createAppServer({ dbPath, butlerData: root, port: 0 });
  try {
    await Bun.sleep(600);
    const health = await fetch(`${server.url}health`);
    expect(health.status).toBe(200);
    expect(receiptCounts(server.store.db)).toEqual({ legacy: 256, durable: 0 });
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

function receiptCounts(db: Database): { legacy: number; durable: number } {
  return db.query<{ legacy: number; durable: number }, []>(`
    SELECT
      (SELECT COUNT(*) FROM projected_transport_events) AS legacy,
      (SELECT COUNT(*) FROM app_transport_projection_receipts) AS durable
  `).get()!;
}
