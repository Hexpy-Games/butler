import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileQueueButlerServiceClient } from "../../packages/butler-agent/src/gateways/core/client.ts";
import type { InboundEnvelope } from "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { createAppInboundEnvelope } from "../../packages/butler-agent/src/gateways/core/app-transport.ts";
import { NativeInboundQueue, type QueuedInboundEvent } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-inbound-queue-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function envelope(id: string): InboundEnvelope {
  return {
    eventId: id,
    transport: "automation",
    accountId: "local",
    peer: { kind: "dm", id: "butler/main" },
    sender: { id: "automation", displayName: "Automation" },
    message: {
      id,
      text: "scheduled check",
      timestamp: "2026-04-27T00:00:00.000Z",
    },
    routingHints: {
      sessionId: "butler/main",
    },
    raw: {},
  };
}

class CountingInboundQueue extends NativeInboundQueue {
  readCount = 0;

  protected override readQueuedRecord(path: string): QueuedInboundEvent | null {
    this.readCount += 1;
    return super.readQueuedRecord(path);
  }
}

test("native inbound queue atomically enqueues, claims, completes, and fails events", () => {
  const butlerData = tempRoot();
  try {
    const queue = new NativeInboundQueue(butlerData);
    const queued = queue.enqueue(envelope("automation:test"), { source: "test" }, new Date("2026-04-27T00:00:00.000Z"));
    expect(queued.queueId).toContain("automation:test");

    const [claimed] = queue.claimEligible(
      1,
      () => true,
      new Date("2026-04-27T00:00:00.000Z"),
      60_000,
    );
    expect(claimed).toBeDefined();
    expect(claimed!.attempts).toBe(1);
    expect(queue.claim(1)).toEqual([]);
    queue.complete(claimed!, { dispatchStatus: "handled" }, new Date("2026-04-27T00:01:00.000Z"));
    const processed = join(butlerData, "runtime", "inbound-events", "processed", `${queued.queueId}.json`);
    expect(existsSync(processed)).toBe(true);
    expect(readFileSync(processed, "utf8")).toContain("\"dispatchStatus\": \"handled\"");

    const failedRecord = queue.enqueue(envelope("automation:fail"));
    const [failed] = queue.claim(1);
    expect(failed?.queueId).toBe(failedRecord.queueId);
    queue.fail(failed!, "provider unavailable");
    const failedPath = join(butlerData, "runtime", "inbound-events", "failed", `${failedRecord.queueId}.json`);
    expect(readFileSync(failedPath, "utf8")).toContain("provider unavailable");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native inbound queue claims early without parsing the whole pending directory", () => {
  const butlerData = tempRoot();
  try {
    const queue = new CountingInboundQueue(butlerData);
    const now = new Date("2026-06-11T00:00:00.000Z");
    const first = queue.enqueue(envelope("automation:first"), { source: "test" }, now);
    for (let index = 0; index < 25; index += 1) {
      queue.enqueue(envelope(`automation:later-${index}`), { source: "test" }, now);
    }

    const claimed = queue.claimEligible(1, () => true);

    expect(claimed.map((item) => item.queueId)).toEqual([first.queueId]);
    expect(queue.readCount).toBe(1);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native inbound queue does not claim a continuation before its durable backoff expires", () => {
  const butlerData = tempRoot();
  try {
    const queue = new NativeInboundQueue(butlerData);
    const queued = queue.enqueue(envelope("automation:backoff"), {
      source: "scheduler-continuation",
      notBefore: "2026-06-11T00:01:00.000Z",
    }, new Date("2026-06-11T00:00:00.000Z"));

    expect(queue.claimEligible(1, () => true, new Date("2026-06-11T00:00:59.999Z"))).toEqual([]);
    const [claimed] = queue.claimEligible(1, () => true, new Date("2026-06-11T00:01:00.000Z"));
    expect(claimed?.queueId).toBe(queued.queueId);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native inbound queue recovers stale processing records back to pending", () => {
  const butlerData = tempRoot();
  try {
    const queue = new NativeInboundQueue(butlerData);
    const queued = queue.enqueue(envelope("automation:stale-processing"));
    const [claimed] = queue.claimEligible(
      1,
      () => true,
      new Date("2026-04-27T00:00:00.000Z"),
      60_000,
    );
    expect(claimed?.queueId).toBe(queued.queueId);
    const recovered = queue.recoverStaleProcessing({
      staleAfterMs: 60_000,
      now: new Date("2026-04-27T00:02:00.000Z"),
    });

    expect(recovered).toEqual({ requeued: 1, skipped: 0 });
    expect(existsSync(claimed!.path)).toBe(false);
    const [reclaimed] = queue.claim(1);
    expect(reclaimed?.queueId).toBe(queued.queueId);
    expect(reclaimed?.attempts).toBe(2);
    expect(readFileSync(reclaimed!.path, "utf8")).toContain(
      "processing_lease_expired",
    );
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native inbound queue recovers a definitely dead owner before lease expiry", () => {
  const butlerData = tempRoot();
  try {
    const queue = new NativeInboundQueue(butlerData);
    const queued = queue.enqueue(envelope("automation:dead-owner"), {
      sameLogicalTurnContinuation: true,
    });
    const [claimed] = queue.claimEligible(
      1,
      () => true,
      new Date("2026-04-27T00:00:00.000Z"),
      15 * 60_000,
    );
    expect(claimed?.queueId).toBe(queued.queueId);
    const record = JSON.parse(readFileSync(claimed!.path, "utf8")) as QueuedInboundEvent;
    record.processing = {
      ...record.processing!,
      ownerId: "999999:dead-owner",
    };
    writeFileSync(claimed!.path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const recovered = queue.recoverStaleProcessing({
      staleAfterMs: 15 * 60_000,
      now: new Date("2026-04-27T00:01:00.000Z"),
    });

    expect(recovered).toEqual({ requeued: 1, skipped: 0 });
    const [reclaimed] = queue.claim(1);
    expect(reclaimed?.queueId).toBe(queued.queueId);
    expect(reclaimed?.attempts).toBe(2);
    expect(readFileSync(reclaimed!.path, "utf8")).toContain(
      "processing_owner_dead",
    );
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native inbound queue keeps ordinary dead-owner claims behind the lease fence", () => {
  const butlerData = tempRoot();
  try {
    const queue = new NativeInboundQueue(butlerData);
    queue.enqueue(envelope("automation:ordinary-dead-owner"));
    const [claimed] = queue.claimEligible(
      1,
      () => true,
      new Date("2026-04-27T00:00:00.000Z"),
      15 * 60_000,
    );
    const record = JSON.parse(readFileSync(claimed!.path, "utf8")) as QueuedInboundEvent;
    record.processing = {
      ...record.processing!,
      ownerId: "999999:dead-owner",
    };
    writeFileSync(claimed!.path, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    expect(queue.recoverStaleProcessing({
      staleAfterMs: 15 * 60_000,
      now: new Date("2026-04-27T00:01:00.000Z"),
    })).toEqual({ requeued: 0, skipped: 1 });
    expect(existsSync(claimed!.path)).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native inbound queue protects live and unknown owners before lease expiry", () => {
  const butlerData = tempRoot();
  try {
    const queue = new NativeInboundQueue(butlerData);
    queue.enqueue(envelope("automation:protected-owner"));
    const [claimed] = queue.claimEligible(
      1,
      () => true,
      new Date("2026-04-27T00:00:00.000Z"),
      15 * 60_000,
    );
    expect(queue.recoverStaleProcessing({
      staleAfterMs: 15 * 60_000,
      now: new Date("2026-04-27T00:01:00.000Z"),
    })).toEqual({ requeued: 0, skipped: 1 });

    const record = JSON.parse(readFileSync(claimed!.path, "utf8")) as QueuedInboundEvent;
    record.processing = {
      ...record.processing!,
      ownerId: "unknown-owner",
    };
    writeFileSync(claimed!.path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    expect(queue.recoverStaleProcessing({
      staleAfterMs: 15 * 60_000,
      now: new Date("2026-04-27T00:02:00.000Z"),
    })).toEqual({ requeued: 0, skipped: 1 });
    expect(existsSync(claimed!.path)).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native inbound queue does not recover processing records with terminal outcomes", () => {
  const butlerData = tempRoot();
  try {
    const queue = new NativeInboundQueue(butlerData);
    const queued = queue.enqueue(envelope("automation:terminal-processing"));
    const [claimed] = queue.claim(1);
    expect(claimed?.queueId).toBe(queued.queueId);
    expect(
      queue.fail(
        claimed!,
        "already terminal",
        {},
        new Date("2026-04-27T00:00:00.000Z"),
      ),
    ).toBe(true);

    const recovered = queue.recoverStaleProcessing({
      staleAfterMs: 60_000,
      now: new Date("2026-04-27T00:02:00.000Z"),
    });

    expect(recovered).toEqual({ requeued: 0, skipped: 0 });
    expect(queue.claim(1)).toEqual([]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("file queue service client enqueues app turns through public gateway protocol", () => {
  const butlerData = tempRoot();
  try {
    const client = new FileQueueButlerServiceClient({ butlerData });
    const queued = client.enqueueAppTurn({
      chatId: "general",
      messageId: "msg-1",
      turnId: "turn-1",
      text: "hello",
      timestamp: "2026-05-27T00:00:00.000Z",
      sessionId: "butler/app-general",
    }, { source: "app-server" });

    expect(queued.envelope.transport).toBe("app");
    expect(queued.envelope.peer.kind).toBe("dm");
    expect(queued.envelope.sender.displayName).toBe("Butler App");
    expect(queued.envelope.routingHints?.turnId).toBe("turn-1");
    expect(readFileSync(join(
      butlerData,
      "runtime",
      "inbound-events",
      "pending",
      `${queued.queueId}.json`,
    ), "utf8")).toContain("\"source\": \"app-server\"");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native inbound queue claims app turns by enqueue order instead of event id order", () => {
  const butlerData = tempRoot();
  try {
    const queue = new NativeInboundQueue(butlerData);
    const now = new Date("2026-06-11T00:00:00.000Z");
    queue.enqueue(createAppInboundEnvelope({
      chatId: "general",
      messageId: "msg-z0000000-0000-4000-8000-000000000000",
      turnId: "turn-first",
      text: "first",
      timestamp: now.toISOString(),
      sessionId: "butler/app-general",
    }), { source: "app-server" }, now);
    queue.enqueue(createAppInboundEnvelope({
      chatId: "general",
      messageId: "msg-a0000000-0000-4000-8000-000000000000",
      turnId: "turn-second",
      text: "second",
      timestamp: now.toISOString(),
      sessionId: "butler/app-general",
    }), { source: "app-server" }, now);

    const claimed = queue.claim(2);
    expect(claimed.map((item) => item.envelope.message.id)).toEqual([
      "msg-z0000000-0000-4000-8000-000000000000",
      "msg-a0000000-0000-4000-8000-000000000000",
    ]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("app inbound envelope preserves explicit gateway peer metadata", () => {
  const envelope = createAppInboundEnvelope({
    chatId: "thread-42",
    messageId: "msg-2",
    turnId: "turn-2",
    text: "hello group",
    timestamp: "2026-05-27T00:00:00.000Z",
    sessionId: "butler/group-general",
    accountId: "workspace-a",
    peerKind: "thread",
    peerParentId: "general",
    senderId: "gateway-user",
    senderDisplayName: "External Gateway",
    rawSource: "discord-gateway",
  });

  expect(envelope.transport).toBe("app");
  expect(envelope.accountId).toBe("workspace-a");
  expect(envelope.peer).toEqual({
    kind: "thread",
    id: "thread-42",
    parentId: "general",
  });
  expect(envelope.sender).toEqual({
    id: "gateway-user",
    displayName: "External Gateway",
  });
  expect(envelope.raw).toEqual({ source: "discord-gateway" });
});
