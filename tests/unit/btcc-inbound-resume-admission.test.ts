import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueuedInboundEvent } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { createBtccQueueEntryDecider } from
  "../../packages/butler-agent/src/interfaces/gateway/btcc/index.ts";

test("queue entry distinguishes fresh, resumable, and terminal Turns from durable state", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-inbound-resume-admission-"));
  const dbPath = join(butlerData, "app-server", "butler-client.sqlite");
  mkdirSync(join(butlerData, "app-server"), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE turns (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE btcc_turns (turn_id TEXT PRIMARY KEY, semantic_state TEXT NOT NULL);
      INSERT INTO turns VALUES ('turn-active', 'thinking');
      INSERT INTO turns VALUES ('turn-delivered', 'thinking');
      INSERT INTO turns VALUES ('turn-unadmitted', 'thinking');
      INSERT INTO turns VALUES ('turn-app-cancelled', 'cancelled');
      INSERT INTO turns VALUES ('turn-app-delivered', 'delivered');
      INSERT INTO turns VALUES ('turn-app-failed', 'failed');
      INSERT INTO turns VALUES ('turn-app-runtime-fault', 'runtime_fault');
      INSERT INTO turns VALUES ('turn-app-cancelling', 'cancelling');
      INSERT INTO btcc_turns VALUES ('turn-active', 'task_execution');
      INSERT INTO btcc_turns VALUES ('turn-delivered', 'delivered');
    `);
    const decide = createBtccQueueEntryDecider(dbPath);

    expect(decide(queueItem("turn-active", true))).toEqual({ kind: "resume" });
    expect(decide(queueItem("turn-active", false))).toEqual({ kind: "resume" });
    expect(decide(queueItem("turn-delivered", true))).toEqual({ kind: "terminal" });
    expect(decide(queueItem("turn-unadmitted", true))).toEqual({ kind: "fresh" });
    expect(decide(queueItem("turn-unadmitted", false))).toEqual({ kind: "fresh" });
    expect(decide(queueItem("turn-fresh", false))).toEqual({ kind: "fresh" });
    expect(decide(queueItem("turn-app-cancelled", true))).toEqual({ kind: "terminal" });
    expect(decide(queueItem("turn-app-delivered", true))).toEqual({ kind: "terminal" });
    expect(decide(queueItem("turn-app-failed", true))).toEqual({ kind: "terminal" });
    expect(decide(queueItem("turn-app-runtime-fault", true))).toEqual({
      kind: "terminal",
    });
    expect(decide(queueItem("turn-app-cancelling", true))).toEqual({ kind: "terminal" });
  } finally {
    db.close();
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("queue entry remains undecided when durable state cannot be read", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-inbound-state-unavailable-"));
  const dbPath = join(butlerData, "app-server", "butler-client.sqlite");
  mkdirSync(join(butlerData, "app-server"), { recursive: true });
  try {
    writeFileSync(dbPath, "not a sqlite database", "utf8");
    const decide = createBtccQueueEntryDecider(dbPath);

    expect(decide(queueItem("turn-unreadable", true))).toBeUndefined();
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function queueItem(
  turnId: string,
  recoveredFromRuntimeInterruption: boolean,
): QueuedInboundEvent {
  return {
    version: 1,
    queueId: `queue-${turnId}`,
    envelope: {
      eventId: `event-${turnId}`,
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: "general" },
      sender: { id: "app-user" },
      message: {
        id: `message-${turnId}`,
        text: "continue",
        timestamp: "2026-07-28T00:00:00.000Z",
      },
      routingHints: { turnId },
    },
    enqueuedAt: "2026-07-28T00:00:00.000Z",
    attempts: 1,
    metadata: recoveredFromRuntimeInterruption
      ? { recoveredFromRuntimeInterruption: true }
      : {},
  };
}
