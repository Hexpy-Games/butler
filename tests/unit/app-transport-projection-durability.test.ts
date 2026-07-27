import { afterEach, describe, expect, test } from "bun:test";
import { AppProjectedTransportEventStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/projected-transport-event-store.ts";
import { IncrementalJsonParser } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/incremental-json-parser.ts";
import { StagedTransportOutboundStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/staged-transport-outbound-store.ts";
import { AppTransportReceiptMigrationOwner } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/receipt-migration-owner.ts";
import {
  cleanupTranscriptProjectionHarnesses,
  appendTranscript,
  createTranscriptProjectionHarness as createHarness,
  outbound,
  writeTranscript,
} from "./support/transcript-projection-harness.ts";

afterEach(() => cleanupTranscriptProjectionHarnesses());

describe("durable transport projection state", () => {
  test("legacy receipts migrate in bounded durable batches", () => {
    const harness = createHarness();
    insertLegacyReceipts(harness, 129, "legacy");
    writeTranscript(harness, [outbound("after-legacy-migration")]);
    const receipts = new AppProjectedTransportEventStore(harness.db);

    expect(receipts.migrateLegacyBatch()).toBe(true);
    expect(harness.durableReceiptCount()).toBe(32);
    while (receipts.migrateLegacyBatch()) continue;
    expect(harness.durableReceiptCount()).toBe(129);
    expect(harness.legacyReceiptCount()).toBe(0);
    expect(harness.createSync().syncChatWindow(harness.chatId).applied).toBe(1);
    expect(harness.durableReceiptCount()).toBe(130);
    harness.close();
  });

  test("legacy receipts remain authoritative until their copy completes", () => {
    const harness = createHarness();
    insertLegacyReceipts(harness, 40, "legacy");
    const receipts = new AppProjectedTransportEventStore(harness.db);

    expect(receipts.migrateLegacyBatch()).toBe(true);
    expect(receipts.has("legacy-039")).toBe(true);
    while (receipts.migrateLegacyBatch()) continue;
    expect(receipts.has("legacy-039")).toBe(true);
    expect(harness.legacyReceiptCount()).toBe(0);
    harness.close();
  });

  test("live projection completes independently of receipt migration", () => {
    const harness = createHarness();
    insertLegacyReceipts(harness, 100, "old");
    const liveEvent = outbound("new-live-action");
    liveEvent.payload.metadata = {
      kind: "tool_progress",
      turnId: "turn-live",
      activityKind: "read_file",
      safeLabel: "Read live output",
    };
    writeTranscript(harness, [liveEvent]);

    const projection = harness.createProjectionStore();
    expect(projection.migrateLegacyReceiptsNextBatch()).toBe(true);
    expect(projection.syncNextBatch()).toBe(false);
    expect(harness.projected()).toContain("new-live-action");
    expect(harness.legacyReceiptCount()).toBeGreaterThan(0);
    harness.close();
  });

  test("pending receipt maintenance never keeps a live cycle pending", () => {
    const harness = createHarness();
    insertLegacyReceipts(harness, 512, "old");
    const first = progressOutbound("live-before-migration-round");
    writeTranscript(harness, [first]);
    const projection = harness.createProjectionStore();

    expect(projection.migrateLegacyReceiptsNextBatch()).toBe(true);
    expect(projection.syncNextBatch()).toBe(false);
    expect(harness.projected()).toContain("live-before-migration-round");

    appendTranscript(harness, progressOutbound("live-during-migration"));
    expect(projection.syncNextBatch()).toBe(false);
    expect(harness.projected()).toContain("live-during-migration");
    expect(harness.legacyReceiptCount()).toBeGreaterThan(0);
    harness.close();
  });

  test("a live wake reopens transcript work without restarting 3,200 deferred finals", () => {
    const harness = createHarness();
    const projection = harness.createProjectionStore();
    const now = new Date().toISOString();
    const insert = harness.db.query(`
      INSERT INTO app_transport_projection_staged_outbounds (
        action_id, chat_id, event_json, state, created_at, updated_at
      ) VALUES (?, ?, ?, 'deferred_final', ?, ?)
    `);
    harness.db.transaction(() => {
      for (let index = 0; index < 3_200; index += 1) {
        const actionId = `deferred-${index.toString().padStart(4, "0")}`;
        const event = outbound(actionId);
        event.payload.metadata = {
          kind: "final_result",
          turnId: `turn-${actionId}`,
          queueId: `queue-${actionId}`,
          dispatchClaimId: `claim-${actionId}`,
        };
        insert.run(
          actionId,
          harness.chatId,
          JSON.stringify(event),
          now,
          now,
        );
      }
    })();

    expect(projection.syncNextBatch()).toBe(true);
    appendTranscript(harness, progressOutbound("live-during-deferred-sweep"));
    projection.reopenCompletedLiveLanes();
    let passes = 0;
    while (!harness.projected().includes("live-during-deferred-sweep")) {
      expect(passes).toBeLessThan(3);
      projection.syncNextBatch();
      passes += 1;
    }
    expect(passes).toBe(1);
    harness.close();
  });

  test("receipt identity conflict records failure and preserves legacy source", async () => {
    const harness = createHarness();
    insertLegacyReceipts(harness, 1, "conflict");
    harness.db.query(`
      INSERT INTO app_transport_projection_receipts (
        action_id, event_id, chat_id, created_at
      ) VALUES ('conflict-000', 'wrong-event', 'wrong-chat', ?)
    `).run(new Date().toISOString());
    const receipts = new AppProjectedTransportEventStore(harness.db);
    const failures: unknown[] = [];
    const owner = new AppTransportReceiptMigrationOwner({
      migrateNextBatch: () => receipts.migrateLegacyBatch(),
      recordFailure: (error) => failures.push(error),
    });

    owner.start();
    await waitUntil(() => failures.length === 1);
    owner.close();
    expect((failures[0] as Error).message).toContain("identity conflict");
    expect(harness.legacyReceiptCount()).toBe(1);
    expect(harness.durableReceiptCount()).toBe(1);
    expect(harness.db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM app_transport_projection_migrations
    `).get()?.count).toBe(0);
    harness.close();
  });

  test("staged outbound identity cannot be overwritten", () => {
    const harness = createHarness();
    const staged = new StagedTransportOutboundStore(harness.db);
    staged.stage({
      actionId: "stable-stage",
      chatId: harness.chatId,
      event: outbound("stable-stage", "first"),
      state: "deferred_final",
    });

    expect(() => staged.stage({
      actionId: "stable-stage",
      chatId: harness.chatId,
      event: outbound("stable-stage", "changed"),
      state: "deferred_final",
    })).toThrow("identity conflict");
    expect(staged.load("stable-stage")?.event.payload.message).toEqual({
      text: "first",
    });
    harness.close();
  });

  test("streaming parser accepts exactly JSON whitespace", () => {
    for (const source of ["\v{}", "\f[]", "\u00a0true", "\ufeffnull"]) {
      expect(() => JSON.parse(source)).toThrow();
      const parser = new IncrementalJsonParser();
      expect(() => parser.push(Buffer.from(source), true)).toThrow();
    }
    for (const source of [" {}", "\t[]", "\rtrue", "\nnull"]) {
      const parser = new IncrementalJsonParser();
      parser.push(Buffer.from(source), true);
      expect(parser.value()).toEqual(JSON.parse(source));
    }
  });
});

function insertLegacyReceipts(
  harness: ReturnType<typeof createHarness>,
  count: number,
  prefix: string,
): void {
  const insert = harness.db.query(`
    INSERT INTO projected_transport_events (
      action_id, event_id, chat_id, created_at
    ) VALUES (?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (let index = 0; index < count; index += 1) {
    insert.run(
      `${prefix}-${index.toString().padStart(3, "0")}`,
      `event-${index}`,
      harness.chatId,
      now,
    );
  }
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
