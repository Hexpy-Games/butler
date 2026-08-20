import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAgentTurnEvent } from
  "../../packages/butler-agent/src/agent/events/turn-events.ts";
import { projectTurnProgressToEvents } from
  "../../packages/butler-agent/src/agent/btcc/projection/turn-progress.ts";
import { SqliteOperationOutputReader } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/operation-output/sqlite-operation-output-reader.ts";
import {
  cleanupTranscriptProjectionHarnesses,
  createTranscriptProjectionHarness,
  writeTranscript,
} from "./support/transcript-projection-harness.ts";
import { openBtccSqliteStores } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/open-btcc-sqlite-stores.ts";
import { createBtccProgressProjectionHost } from
  "../../packages/butler-agent/src/agent/btcc/projection/btcc-progress-outbox-consumer.ts";
import { createNativeButlerProgressPublisher } from
  "../../packages/butler-agent/src/interfaces/gateway/native-butler/projection-and-lifecycle.ts";
import { DeliveryGuard } from
  "../../packages/butler-agent/src/interfaces/transport/delivery-guard.ts";
import { createAppTransportAdapter } from
  "../../packages/butler-agent/src/interfaces/transport/app/adapter.ts";
import { sessionHintForRow } from
  "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";
import { join } from "node:path";
import { EMPTY_STEWARD_OBSERVER } from "./support/steward-observer.ts";

afterAll(cleanupTranscriptProjectionHarnesses);

test("completed operation emits deterministic bounded content-complete chunks", async () => {
  const projected: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const output = `${"결과🙂".repeat(12_000)}\ncomplete`;
  const resultSha256 = createHash("sha256").update(output).digest("hex");
  const resultId = createHash("sha256")
    .update(`btcc-guided-tool-result.v1\0${resultSha256}`)
    .digest("hex");
  const observer = projectTurnProgressToEvents((event) => {
    projected.push(event);
  });

  await observer.operationChanged?.({
    turnId: "turn-output",
    semanticState: "admitted",
    activityId: "activity-output",
    requestId: "request-output",
    publicTitle: "Output",
    capabilityRef: "run_command",
    status: "completed",
    resultRef: { id: resultId, sha256: resultSha256 },
    byteLength: Buffer.byteLength(output),
    resultJson: output,
  });

  expect(projected[0]?.kind).toBe("tool.completed");
  const chunks = projected.slice(1);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every((event) => event.kind === "operation.output.chunk")).toBe(true);
  const normalized = chunks.map((event, index) => createAgentTurnEvent({
    sessionId: "session-output",
    turnId: "turn-output",
    sessionSequence: index + 1,
    turnSequence: index + 1,
    kind: "operation.output.chunk",
    payload: event.payload,
  }));
  expect(normalized.map((event) => event.payload.chunkIndex)).toEqual(
    normalized.map((_event, index) => index),
  );
  expect(Buffer.concat(normalized.map((event) =>
    Buffer.from(String(event.payload.contentBase64), "base64"),
  )).toString("utf8")).toBe(output);
});

test("App endpoint reader serves only delivered transcript projection and dedupes replay", async () => {
  const harness = createTranscriptProjectionHarness();
  const turnId = "turn-projected-output";
  const requestId = "request-projected-output";
  const output = `${"0123456789🙂".repeat(8_000)}done`;
  const resultSha256 = createHash("sha256").update(output).digest("hex");
  const resultId = createHash("sha256")
    .update(`btcc-guided-tool-result.v1\0${resultSha256}`)
    .digest("hex");
  const events: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgressToEvents((event) => {
    events.push(event);
  });
  const now = new Date().toISOString();
  harness.db.query(`
    INSERT INTO turns (
      id, chat_id, state, safe_status_label, created_at, updated_at
    ) VALUES (?, ?, 'running', 'Running', ?, ?)
  `).run(turnId, harness.chatId, now, now);

  await observer.operationChanged?.({
    turnId,
    semanticState: "admitted",
    activityId: "activity-projected-output",
    requestId,
    publicTitle: "Output",
    capabilityRef: "run_command",
    status: "completed",
    resultRef: { id: resultId, sha256: resultSha256 },
    byteLength: Buffer.byteLength(output),
    resultJson: output,
  });
  const chunks = events.filter((event) => event.kind === "operation.output.chunk");
  const transcript = chunks.flatMap((event, index) => {
    const actionId = `output-action-${index}`;
    return [{
      eventId: `output-event-${index}`,
      sessionId: "runtime-session",
      kind: "outbound",
      timestamp: now,
      transport: "app",
      payload: {
        actionId,
        message: { text: "" },
        metadata: { kind: "turn_event", turnId, event },
      },
    }, {
      eventId: `output-delivery-${index}`,
      sessionId: "runtime-session",
      kind: "delivery",
      timestamp: now,
      transport: "app",
      payload: { actionId, ok: true },
    }];
  });
  writeTranscript(harness, transcript);
  const projection = harness.createProjectionStore();
  drainProjection(projection);

  const reader = new SqliteOperationOutputReader(harness.db, EMPTY_STEWARD_OBSERVER);
  let offset = 0;
  let assembled = "";
  while (true) {
    const page = reader.read({ turnId, requestId, resultId, byteStart: offset });
    expect(page).not.toBeNull();
    assembled += page!.content;
    offset = page!.byte_end;
    if (page!.complete) break;
  }
  expect(assembled).toBe(output);

  writeTranscript(harness, [...transcript, ...transcript]);
  projection.reopenCompletedLiveLanes();
  drainProjection(projection);
  expect(harness.db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM app_operation_output_chunks",
  ).get()?.count).toBe(chunks.length);
  harness.close();
});

test("transcript append is replayed safely when progress outbox ack crashes", async () => {
  const harness = createTranscriptProjectionHarness();
  const turnId = "turn-progress-ack-crash";
  const requestId = "request-progress-ack-crash";
  const output = JSON.stringify({ content: "content-complete operation output" });
  const resultSha256 = createHash("sha256").update(output).digest("hex");
  const resultId = createHash("sha256")
    .update(`btcc-guided-tool-result.v1\0${resultSha256}`)
    .digest("hex");
  const projected: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  const observer = projectTurnProgressToEvents((event) => {
    projected.push(event);
  });
  await observer.operationChanged?.({
    turnId,
    semanticState: "admitted",
    activityId: "activity-progress-ack-crash",
    requestId,
    publicTitle: "Output",
    capabilityRef: "run_command",
    status: "completed",
    resultRef: { id: resultId, sha256: resultSha256 },
    byteLength: Buffer.byteLength(output),
    resultJson: output,
  });
  const chunk = projected.find((event) => event.kind === "operation.output.chunk")!;
  const now = new Date().toISOString();
  harness.db.query(`
    INSERT INTO turns (id, chat_id, state, safe_status_label, created_at, updated_at)
    VALUES (?, ?, 'running', 'Running', ?, ?)
  `).run(turnId, harness.chatId, now, now);
  const stores = openBtccSqliteStores({
    dbPath: join(harness.root, "btcc.sqlite"),
    ownerId: "progress-ack-crash",
    storageProfile: "ephemeral",
  });
  const sessionId = sessionHintForRow(harness.chatId);
  stores.progressEvents.append({
    sessionId,
    turnId,
    destination: {
      transport: "app",
      accountId: "local",
      peer: { kind: "dm", id: harness.chatId },
      replyToMessageId: requestId,
    },
    event: chunk as never,
  });
  const host = createBtccProgressProjectionHost(stores.progressEvents);
  const firstGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: harness.root,
  });
  const firstPublisher = createNativeButlerProgressPublisher({
    deliver: (id, action, metadata) => firstGuard.deliver(id, action, metadata),
  });
  const interrupted = await host.reconcile({
    async publish(event) {
      await firstPublisher.publish(event);
      throw new Error("crash after transcript append before progress ack");
    },
  });
  expect(interrupted).toMatchObject({ published: 0, pending: 1 });

  const replayGuard = new DeliveryGuard({
    adapters: [createAppTransportAdapter()],
    butlerData: harness.root,
  });
  const replayPublisher = createNativeButlerProgressPublisher({
    deliver: (id, action, metadata) => replayGuard.deliver(id, action, metadata),
  });
  expect(await host.reconcile(replayPublisher)).toMatchObject({ published: 1, pending: 0 });
  const projection = harness.createProjectionStore();
  drainProjection(projection);
  expect(new SqliteOperationOutputReader(harness.db, EMPTY_STEWARD_OBSERVER).read({
    turnId,
    requestId,
    resultId,
    byteStart: 0,
  })?.content).toBe(output);
  expect(harness.db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM app_operation_output_chunks",
  ).get()?.count).toBe(1);
  stores.close();
  harness.close();
});

function drainProjection(projection: { syncNextBatch(): boolean }): void {
  while (projection.syncNextBatch()) {
    // Drain bounded projection pages.
  }
}
