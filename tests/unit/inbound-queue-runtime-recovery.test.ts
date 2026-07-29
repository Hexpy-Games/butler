import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { NativeInboundQueue, type QueuedInboundEvent } from
  "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";

test("native inbound queue requeues a legacy runtime interruption", () => {
  const butlerData = join(tmpdir(), `butler-inbound-runtime-${Date.now()}`);
  mkdirSync(butlerData, { recursive: true });
  try {
    const queue = new NativeInboundQueue(butlerData);
    const queued = queue.enqueue(envelope());
    const [claimed] = queue.claim(1);
    queue.fail(claimed!, "Project Ledger promoted head is not active", {
      dispatchStatus: "runtime-interrupted",
    });

    expect(queue.recoverRuntimeInterruptions(() => true)).toEqual({
      requeued: 1,
      skipped: 0,
    });
    const [recovered] = queue.claim(1);
    expect(recovered?.queueId).toBe(queued.queueId);
    expect(recovered?.metadata.recoveredFromRuntimeInterruption).toBe(true);
    expect(existsSync(join(
      butlerData,
      "runtime",
      "inbound-events",
      "failed",
      `${queued.queueId}.json.recovered`,
    ))).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("process replacement preserves the interrupted item as the same Turn", () => {
  const butlerData = join(tmpdir(), `butler-inbound-replacement-${Date.now()}`);
  mkdirSync(butlerData, { recursive: true });
  try {
    const queue = new NativeInboundQueue(butlerData);
    const queued = queue.enqueue(envelope());
    const [claimed] = queue.claim(1);

    expect(queue.parkForProcessReplacement(claimed!, "provider unavailable")).toBe(true);
    const pending = JSON.parse(readFileSync(join(
      butlerData,
      "runtime",
      "inbound-events",
      "pending",
      `${queued.queueId}.json`,
    ), "utf8")) as QueuedInboundEvent;
    expect(pending.metadata.recoveredFromRuntimeInterruption).toBe(true);
    expect(pending.metadata.sameLogicalTurnContinuation).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native inbound queue recovers an eligible dead-owner claim before lease expiry", () => {
  const butlerData = join(tmpdir(), `butler-inbound-dead-owner-${Date.now()}`);
  mkdirSync(butlerData, { recursive: true });
  try {
    const queue = new NativeInboundQueue(butlerData);
    const queued = queue.enqueue(envelope());
    const [claimed] = queue.claimEligible(
      1,
      () => true,
      new Date("2026-04-27T00:00:00.000Z"),
      15 * 60_000,
    );
    const record = JSON.parse(readFileSync(claimed!.path, "utf8")) as QueuedInboundEvent;
    record.processing = { ...record.processing!, ownerId: "999999:dead-owner" };
    writeFileSync(claimed!.path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    expect(queue.recoverStaleProcessing({
      staleAfterMs: 15 * 60_000,
      now: new Date("2026-04-27T00:01:00.000Z"),
      shouldRecover: () => true,
    })).toEqual({ requeued: 1, skipped: 0 });
    const [reclaimed] = queue.claim(1);
    expect(reclaimed?.queueId).toBe(queued.queueId);
    expect(readFileSync(reclaimed!.path, "utf8")).toContain("processing_owner_dead");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

function envelope(): InboundEnvelope {
  return {
    eventId: "automation:legacy-runtime-interruption",
    transport: "automation",
    accountId: "local",
    peer: { kind: "dm", id: "butler/main" },
    sender: { id: "automation" },
    message: {
      id: "legacy-runtime-interruption",
      text: "resume the exact Turn",
      timestamp: "2026-07-28T00:00:00.000Z",
    },
    routingHints: {
      sessionId: "butler/main",
      turnId: "turn-legacy-runtime-interruption",
    },
  };
}
