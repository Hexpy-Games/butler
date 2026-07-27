import { afterEach, describe, expect, test } from "bun:test";
import {
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { AppTransportTranscriptSyncStore } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/transcript-sync-store.ts";
import { TRANSCRIPT_BYTE_WINDOW, TRANSCRIPT_EVENT_WINDOW } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/transport/transcript-byte-window.ts";
import {
  addTranscriptChat as addChat,
  appendTranscript,
  cleanupTranscriptProjectionHarnesses,
  createTranscriptProjectionHarness as createHarness,
  outbound,
  transcriptPath as pathFor,
  writeTranscript,
} from "./support/transcript-projection-harness.ts";

afterEach(() => {
  cleanupTranscriptProjectionHarnesses();
});

describe("durable transcript projection checkpoints", () => {
  test("restart reads only transcript bytes appended after the committed checkpoint", () => {
    const harness = createHarness();
    writeTranscript(harness, [outbound("action-1")]);

    expect(harness.createSync().syncChatWindow(harness.chatId).applied).toBe(1);
    expect(harness.projected()).toEqual(["action-1"]);

    expect(harness.createSync().syncChatWindow(harness.chatId).applied).toBe(0);
    expect(harness.projected()).toEqual(["action-1"]);

    appendTranscript(harness, outbound("action-2"));
    expect(harness.createSync().syncChatWindow(harness.chatId).applied).toBe(1);
    expect(harness.projected()).toEqual(["action-1", "action-2"]);
    harness.close();
  });

  test("failed projection does not advance the durable checkpoint", () => {
    const harness = createHarness();
    writeTranscript(harness, [outbound("action-retry")]);

    expect(() => harness.createSync(true).syncChatWindow(harness.chatId)).toThrow(
      "projection failed",
    );
    expect(harness.checkpointCount()).toBe(0);

    expect(harness.createSync().syncChatWindow(harness.chatId).applied).toBe(1);
    expect(harness.projected()).toEqual(["action-retry"]);
    harness.close();
  });

  test("startup projection advances through bounded chat batches", () => {
    const harness = createHarness();
    harness.db.query("UPDATE chats SET archived = 1 WHERE id = ?")
      .run(harness.chatId);
    const chatIds = Array.from({ length: 9 }, (_, index) => `batch-chat-${index}`);
    for (const [index, chatId] of chatIds.entries()) {
      addChat(harness, chatId);
      writeTranscript(harness, [outbound(`batch-action-${index}`)], chatId);
    }
    const sync = harness.createSync();

    expect(sync.syncNextBatch()).toEqual({ applied: 2, pending: true });
    expect(harness.projected()).toHaveLength(2);
    drainPendingSync(sync);
    expect(harness.projected()).toHaveLength(9);
    harness.close();
  });

  test("chat discovery advances through raw ineligible pages", () => {
    const harness = createHarness();
    harness.db.query("UPDATE chats SET archived = 1 WHERE id = ?")
      .run(harness.chatId);
    for (let index = 0; index < 64; index += 1) {
      const chatId = `archived-${index}`;
      addChat(harness, chatId);
      harness.db.query("UPDATE chats SET archived = 1 WHERE id = ?").run(chatId);
    }
    addChat(harness, "eligible-after-raw-pages");
    writeTranscript(harness, [outbound("eligible-action")], "eligible-after-raw-pages");
    const sync = harness.createSync();

    expect(sync.syncNextBatch(1)).toEqual({ applied: 0, pending: true });
    expect(sync.syncNextBatch(1)).toEqual({ applied: 0, pending: true });
    expect(sync.syncNextBatch(1)).toEqual({ applied: 1, pending: false });
    expect(harness.projected()).toEqual(["eligible-action"]);
    harness.close();
  });

  test("one owner invocation bounds bytes and events for a large transcript", () => {
    const harness = createHarness();
    const events = Array.from(
      { length: TRANSCRIPT_EVENT_WINDOW * 3 },
      (_, index) => outbound(`large-${index}`, "x".repeat(1_500)),
    );
    writeTranscript(harness, events);
    const sync = harness.createSync();

    const first = sync.syncNextBatch(1);
    expect(first.pending).toBe(true);
    expect(first.applied).toBeLessThanOrEqual(TRANSCRIPT_EVENT_WINDOW);
    expect(harness.checkpoint()?.projected_bytes).toBeLessThan(
      Buffer.byteLength(events.map((event) => JSON.stringify(event)).join("\n")) + 1,
    );
    drainPendingSync(sync, 1);
    expect(harness.projected()).toHaveLength(events.length);
    harness.close();
  });

  test("large transcripts revisit directly while chat discovery stays fair", () => {
    const harness = createHarness();
    writeTranscript(harness, [
      outbound("very-large-first", "x".repeat(TRANSCRIPT_BYTE_WINDOW * 60)),
    ]);
    const smallChats = Array.from({ length: 40 }, (_, index) => `fair-${index}`);
    for (const [index, chatId] of smallChats.entries()) {
      addChat(harness, chatId);
      writeTranscript(harness, [outbound(`fair-action-${index}`)], chatId);
    }
    const sync = harness.createSync();

    for (let tick = 0; tick < 45; tick += 1) {
      expect(sync.syncNextBatch(2).pending).toBe(true);
    }
    expect(harness.projected()).toContain("fair-action-39");
    expect(harness.projected()).not.toContain("very-large-first");
    drainPendingSync(sync, 2);
    expect(harness.projected()).toContain("very-large-first");
    harness.close();
  });

  test("split multibyte JSON remains byte-exact across windows", () => {
    const harness = createHarness();
    const marker = "__MULTIBYTE__";
    const template = JSON.stringify(outbound("multibyte", marker));
    const markerByte = Buffer.byteLength(template.slice(0, template.indexOf(marker)));
    const padding = "x".repeat(TRANSCRIPT_BYTE_WINDOW - markerByte - 1);
    writeTranscript(harness, [outbound("multibyte", `${padding}한`)]);
    const sync = harness.createSync();

    expect(sync.syncChatWindow(harness.chatId).applied).toBe(0);
    expect(harness.checkpoint()?.projected_bytes).toBe(0);
    let applied = 0;
    while (applied === 0) applied = sync.syncChatWindow(harness.chatId).applied;
    expect(applied).toBe(1);
    expect(harness.projected()).toEqual(["multibyte"]);
    harness.close();
  });

  test("very large record spools durably and projects exactly once after restart", () => {
    const harness = createHarness();
    const largeText = "한".repeat(TRANSCRIPT_BYTE_WINDOW * 3);
    writeTranscript(harness, [
      outbound("spooled-large", largeText),
    ]);
    const accumulating = harness.createSync();
    let priorSpoolBytes = 0;

    while ((harness.checkpoint()?.spool_end_offset ?? 0) === 0) {
      expect(accumulating.syncChatWindow(harness.chatId).applied).toBe(0);
      const checkpoint = harness.checkpoint();
      expect(checkpoint?.trailing_text.length ?? 0).toBeLessThanOrEqual(4);
      expect((checkpoint?.spool_bytes ?? 0) - priorSpoolBytes)
        .toBeLessThanOrEqual(TRANSCRIPT_BYTE_WINDOW);
      priorSpoolBytes = checkpoint?.spool_bytes ?? 0;
    }
    const complete = harness.checkpoint();
    expect(complete?.spool_bytes).toBeGreaterThan(TRANSCRIPT_BYTE_WINDOW * 3);
    expect(statSync(complete!.spool_path).size).toBe(complete!.spool_bytes);

    const restarted = harness.createSync();
    let projected = 0;
    while (projected === 0) {
      projected = restarted.syncChatWindow(harness.chatId).applied;
    }
    expect(projected).toBe(1);
    expect(harness.projected()).toEqual(["spooled-large"]);
    expect(harness.projectedText("spooled-large")).toBe(largeText);
    expect(restarted.syncChatWindow(harness.chatId).applied).toBe(0);
    expect(harness.projected()).toEqual(["spooled-large"]);
    harness.close();
  });

  test("malformed complete record diagnoses and preserves the prior boundary", () => {
    const diagnostics: Array<{ code: string; byteOffset: number }> = [];
    const harness = createHarness(diagnostics);
    const first = `${JSON.stringify(outbound("valid-before"))}\n`;
    writeFileSync(
      pathFor(harness, harness.chatId),
      `${first}{bad-json}\n${JSON.stringify(outbound("must-not-pass"))}\n`,
    );
    const sync = harness.createSync();

    expect(sync.syncChatWindow(harness.chatId).applied).toBe(1);
    expect(harness.projected()).toEqual(["valid-before"]);
    expect(harness.checkpoint()?.projected_bytes).toBe(Buffer.byteLength(first));
    expect(diagnostics).toEqual([{
      code: "invalid_json",
      byteOffset: Buffer.byteLength(first),
    }]);
    expect(sync.syncChatWindow(harness.chatId).applied).toBe(0);
    expect(harness.checkpoint()?.projected_bytes).toBe(Buffer.byteLength(first));
    harness.close();
  });

  test("malformed large spooled record diagnoses without consumption", () => {
    const diagnostics: Array<{ code: string; byteOffset: number }> = [];
    const harness = createHarness(diagnostics);
    const record = JSON.stringify(outbound(
      "malformed-large",
      "x".repeat(TRANSCRIPT_BYTE_WINDOW * 3),
    ));
    writeFileSync(pathFor(harness, harness.chatId), `${record.slice(0, -1)}!}\n`);
    const sync = harness.createSync();

    while (diagnostics.length === 0) sync.syncChatWindow(harness.chatId);
    expect(diagnostics).toEqual([{ code: "invalid_json", byteOffset: 0 }]);
    expect(harness.checkpoint()?.projected_bytes).toBe(0);
    expect(harness.projected()).toEqual([]);
    harness.close();
  });

  test("rotation and same-inode larger rewrite stay idempotent after receipt cleanup", () => {
    const harness = createHarness();
    writeTranscript(harness, [outbound("action-1")]);
    expect(harness.createSync().syncChatWindow(harness.chatId).applied).toBe(1);
    harness.deleteCompatibilityReceipts();

    const path = pathFor(harness, harness.chatId);
    renameSync(path, `${path}.old`);
    writeTranscript(harness, [
      outbound("action-1"),
      outbound("action-2", "x".repeat(4_000)),
    ]);
    expect(harness.createSync().syncChatWindow(harness.chatId).applied).toBe(1);
    expect(harness.projected()).toEqual(["action-1", "action-2"]);

    harness.deleteCompatibilityReceipts();
    writeTranscript(harness, [
      outbound("action-1"),
      outbound("action-2", "y".repeat(8_000)),
      outbound("action-3"),
    ]);
    expect(harness.createSync().syncChatWindow(harness.chatId).applied).toBe(1);
    expect(harness.projected()).toEqual(["action-1", "action-2", "action-3"]);
    harness.close();
  });
});

function drainPendingSync(
  sync: AppTransportTranscriptSyncStore,
  limit?: number,
): void {
  while (sync.syncNextBatch(limit).pending) {
    continue;
  }
}
