import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileQueueButlerServiceClient } from "../../packages/butler-agent/src/gateways/core/client.ts";
import type { InboundEnvelope } from "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { createAppInboundEnvelope } from "../../packages/butler-agent/src/gateways/core/app-transport.ts";
import { NativeInboundQueue } from "../../packages/butler-agent/src/gateways/core/inbound-queue.ts";

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

test("native inbound queue atomically enqueues, claims, completes, and fails events", () => {
  const butlerData = tempRoot();
  try {
    const queue = new NativeInboundQueue(butlerData);
    const queued = queue.enqueue(envelope("automation:test"), { source: "test" }, new Date("2026-04-27T00:00:00.000Z"));
    expect(queued.queueId).toContain("automation:test");

    const [claimed] = queue.claim(1);
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
