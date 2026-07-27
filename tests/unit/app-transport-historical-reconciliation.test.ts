import { afterEach, expect, test } from "bun:test";
import { AppTransportHistoricalReconciliationOwner } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/historical-reconciliation-owner.ts";
import { AppTransportProjectionOwner } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/transport-projection-owner.ts";
import {
  cleanupTranscriptProjectionHarnesses,
  appendTranscript,
  createTranscriptProjectionHarness as createHarness,
  outbound,
  writeTranscript,
} from "./support/transcript-projection-harness.ts";

afterEach(() => cleanupTranscriptProjectionHarnesses());

test("live wait ignores 3,200 turns while maintenance repairs late pages", async () => {
  const harness = createHarness();
  const projection = harness.createProjectionStore();
  seedHistoricalTurns(harness, 3_200);
  writeTranscript(harness, [progressOutbound("new-live-event")]);

  let historicalPages = 0;
  let livePasses = 0;
  const historical = new AppTransportHistoricalReconciliationOwner({
    reconcileNextPage: () => {
      historicalPages += 1;
      return projection.reconcileNextHistoricalPage();
    },
    recordFailure: (error) => {
      throw error;
    },
  });
  const live = new AppTransportProjectionOwner({
    butlerData: harness.root,
    syncNextBatch: () => {
      livePasses += 1;
      return projection.syncNextBatch();
    },
    reopenCompletedLiveLanes: () => projection.reopenCompletedLiveLanes(),
    terminalSettlementWakeOwner: {
      request: () => undefined,
      close: () => undefined,
    },
    recordFailure: (error) => {
      throw error;
    },
    maintenanceOwner: historical,
  });

  live.start();
  await live.syncAndWait();
  expect(harness.projected()).toContain("new-live-event");
  expect(livePasses).toBe(1);
  expect(historicalPages).toBe(0);
  expect(turnState(harness, "late-authority-turn")).toBe("failed");
  expect(canonicalTerminalProjected(harness)).toBe(false);
  appendTranscript(harness, progressOutbound("second-live-event"));
  await live.syncAndWait();
  expect(harness.projected()).toContain("second-live-event");
  expect(livePasses).toBe(2);
  expect(historicalPages).toBe(0);
  live.close();

  const fastHistorical = new AppTransportHistoricalReconciliationOwner({
    reconcileNextPage: () => {
      historicalPages += 1;
      return projection.reconcileNextHistoricalPage();
    },
    recordFailure: (error) => {
      throw error;
    },
  }, 1);
  fastHistorical.start();
  await waitUntil(
    () =>
      turnState(harness, "late-authority-turn") === "running" &&
      canonicalTerminalProjected(harness),
    3_000,
  );
  expect(historicalPages).toBeGreaterThan(100);
  fastHistorical.close();
  harness.close();
});

function seedHistoricalTurns(
  harness: ReturnType<typeof createHarness>,
  count: number,
): void {
  harness.db.exec(`
    CREATE TABLE btcc_turns (
      turn_id TEXT PRIMARY KEY,
      semantic_state TEXT NOT NULL,
      final_disposition TEXT,
      delivery_outbox_id TEXT,
      canonical_assistant_message_id TEXT
    );
    CREATE TABLE btcc_delivery_outbox (
      outbox_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE btcc_messages (
      message_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  const insert = harness.db.query(`
    INSERT INTO turns (
      id, chat_id, state, safe_status_label, retryable, cancellable,
      attempt, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 0, 1, ?, ?)
  `);
  harness.db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      insert.run(
        `historical-${index.toString().padStart(4, "0")}`,
        harness.chatId,
        "delivered",
        "Delivered",
        now,
        now,
      );
    }
    insert.run(
      "late-authority-turn",
      harness.chatId,
      "failed",
      "Failed",
      now,
      now,
    );
    insert.run(
      "late-terminal-turn",
      harness.chatId,
      "running",
      "Working",
      now,
      now,
    );
  })();
  harness.db.exec(`
    INSERT INTO btcc_turns (
      turn_id, semantic_state, final_disposition, delivery_outbox_id,
      canonical_assistant_message_id
    ) VALUES
      ('late-authority-turn', 'planning', NULL, NULL, NULL),
      ('late-terminal-turn', 'delivered', 'completed', 'late-outbox',
        'late-message');
    INSERT INTO btcc_delivery_outbox (outbox_id, status)
    VALUES ('late-outbox', 'observed');
    INSERT INTO btcc_messages (message_id, content, created_at)
    VALUES ('late-message', 'Late canonical final', '${now}')
  `);
}

function progressOutbound(actionId: string) {
  const event = outbound(actionId);
  event.payload.metadata = {
    kind: "tool_progress",
    turnId: `turn-${actionId}`,
    activityKind: "read_file",
    safeLabel: `Read ${actionId}`,
  };
  return event;
}

function turnState(
  harness: ReturnType<typeof createHarness>,
  turnId: string,
): string | null {
  return harness.db.query<{ state: string }, [string]>(
    "SELECT state FROM turns WHERE id = ?",
  ).get(turnId)?.state ?? null;
}

function canonicalTerminalProjected(
  harness: ReturnType<typeof createHarness>,
): boolean {
  return Boolean(harness.db.query<{ action_id: string }, [string]>(`
    SELECT action_id FROM app_transport_projection_receipts
    WHERE action_id = ?
  `).get("btcc-canonical-final:late-outbox"));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
