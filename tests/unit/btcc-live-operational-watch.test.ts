import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  LiveOperationalStallError,
  observeLiveOperationalStall,
} from "../e2e/btcc/runtime/live-operational-watch.ts";

describe("live operational observation", () => {
  test("stops a test-owned Turn when an interruption has no checkpoint progress", async () => {
    const dbPath = temporaryDatabase("stalled");
    seedCheckpoint(dbPath, 1);
    let observed: Error | undefined;
    const watch = observeLiveOperationalStall({
      dbPath,
      turnId: "turn-1",
      observationMs: 10,
      onStalled(error) {
        observed = error;
      },
    });

    await watch.observer.operationalNoticeChanged?.(recoveringNotice());
    await waitUntil(() => Boolean(observed));

    expect(observed).toBeInstanceOf(LiveOperationalStallError);
    watch.close();
  });

  test("resets its observation window when the durable checkpoint advances", async () => {
    const dbPath = temporaryDatabase("progress");
    seedCheckpoint(dbPath, 1);
    let stalled = false;
    const watch = observeLiveOperationalStall({
      dbPath,
      turnId: "turn-1",
      observationMs: 40,
      onStalled() {
        stalled = true;
      },
    });

    await watch.observer.operationalNoticeChanged?.(recoveringNotice());
    await delay(20);
    seedCheckpoint(dbPath, 2);
    await delay(25);

    expect(stalled).toBe(false);
    watch.close();
  });
});

function seedCheckpoint(path: string, revision: number) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS btcc_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      turn_revision INTEGER NOT NULL,
      checkpoint_revision INTEGER NOT NULL,
      is_active INTEGER NOT NULL
    );
  `);
  db.query("UPDATE btcc_checkpoints SET is_active = 0 WHERE turn_id = ?").run(
    "turn-1",
  );
  db.query(
    `
    INSERT INTO btcc_checkpoints VALUES (?, ?, ?, ?, 1)
  `,
  ).run(`checkpoint-${revision}`, "turn-1", revision, revision);
  db.close();
}

function recoveringNotice() {
  return {
    turnId: "turn-1",
    status: "recovering" as const,
    code: "provider_api_error",
    activationKind: "automatic_provider_recovery" as const,
  };
}

function temporaryDatabase(label: string): string {
  return `/tmp/btcc-live-operational-${label}-${crypto.randomUUID()}.sqlite`;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20 && !predicate(); index += 1) await delay(5);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
