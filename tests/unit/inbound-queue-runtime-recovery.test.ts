import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundEnvelope } from
  "../../packages/butler-agent/src/gateways/core/contracts.ts";
import { NativeInboundQueue } from
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
