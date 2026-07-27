import { afterEach, describe, expect, test } from "bun:test";
import { AppProjectedTransportEventStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/projected-transport-event-store.ts";
import { IncrementalJsonParser } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/incremental-json-parser.ts";
import { StagedTransportOutboundStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/staged-transport-outbound-store.ts";
import {
  cleanupTranscriptProjectionHarnesses,
  appendTranscript,
  createTranscriptProjectionHarness as createHarness,
  outbound,
  writeTranscript,
} from "./support/transcript-projection-harness.ts";

afterEach(() => cleanupTranscriptProjectionHarnesses());

describe("durable transport projection state", () => {
  test("legacy receipts remain readable without live migration writes", () => {
    const harness = createHarness();
    insertLegacyReceipts(harness, 129, "legacy");
    const receipts = new AppProjectedTransportEventStore(harness.db);

    expect(receipts.has("legacy-128")).toBe(true);
    expect(harness.legacyReceiptCount()).toBe(129);
    expect(harness.durableReceiptCount()).toBe(0);
    harness.close();
  });

  test("new receipts use the durable store without rewriting legacy rows", () => {
    const harness = createHarness();
    insertLegacyReceipts(harness, 100, "old");
    writeTranscript(harness, [progressOutbound("new-live-action")]);

    expect(harness.createProjectionStore().syncNextBatch()).toBe(false);
    expect(harness.projected()).toContain("new-live-action");
    expect(harness.legacyReceiptCount()).toBe(100);
    expect(harness.durableReceiptCount()).toBe(1);
    harness.close();
  });

  test("partially copied receipt state remains idempotent", () => {
    const harness = createHarness();
    insertLegacyReceipts(harness, 1, "copied");
    harness.db.query(`
      INSERT INTO app_transport_projection_receipts (
        action_id, event_id, chat_id, created_at
      ) SELECT action_id, event_id, chat_id, created_at
        FROM projected_transport_events
    `).run();
    harness.db.query(`
      INSERT INTO app_transport_projection_migrations (
        name, cursor_action_id, completed, updated_at
      ) VALUES ('projected_transport_events_v1', 'copied-000', 0, ?)
    `).run(new Date().toISOString());
    const receipts = new AppProjectedTransportEventStore(harness.db);

    expect(receipts.has("copied-000")).toBe(true);
    expect(harness.legacyReceiptCount()).toBe(1);
    expect(harness.durableReceiptCount()).toBe(1);
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
