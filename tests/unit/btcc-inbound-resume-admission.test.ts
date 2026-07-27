import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueuedInboundEvent } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";
import { shouldEnterBtcc } from
  "../../packages/butler-agent/src/interfaces/gateway/native-butler/runtime-identity.ts";

test("runtime interruption recovery admits only resumable BTCC Turns", () => {
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
      INSERT INTO btcc_turns VALUES ('turn-active', 'task_execution');
      INSERT INTO btcc_turns VALUES ('turn-delivered', 'delivered');
    `);
    const shouldEnter = shouldEnterBtcc(butlerData);

    expect(shouldEnter(queueItem("turn-active", true))).toBe(true);
    expect(shouldEnter(queueItem("turn-delivered", true))).toBe(false);
    expect(shouldEnter(queueItem("turn-unadmitted", true))).toBe(false);
    expect(shouldEnter(queueItem("turn-fresh", false))).toBe(true);
  } finally {
    db.close();
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
