import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { publishConversationCompletionObservation } from "../../packages/butler-agent/src/agent/cognition/continuity/completion-observation.ts";
import {
  memorySyncQueueFile,
  type SyncRequest,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/queue.ts";

const roots: string[] = [];
const originalData = process.env.BUTLER_DATA;

afterEach(() => {
  if (originalData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalData;
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});

test("consumer binds idle, queue, error, and due state to one selected data root", async () => {
  const sentinel = mkdtempSync(join(tmpdir(), "butler-memory-sentinel-"));
  const selected = mkdtempSync(join(tmpdir(), "butler-memory-selected-"));
  roots.push(sentinel, selected);
  process.env.BUTLER_DATA = sentinel;
  initializeEmptyMemoryGeneration(selected);

  const { pollIteration, processEntry } =
    await import("../../packages/butler-agent/src/agent/cognition/memory/scripts/sync-consumer.ts");
  let advancedRoot: string | null = null;
  const idle = await pollIteration({
    butlerData: selected,
    advance: async ({ context }) => {
      advancedRoot = context.butlerData;
      return null;
    },
  });
  expect(idle.action).toBe("idle");
  expect(advancedRoot as string | null).toBe(selected);

  const observation = publishConversationCompletionObservation({
    butlerData: selected,
    projectId: "project-a",
    runtimeSessionId: "session-a",
    conversationSessionId: "session-a",
    conversationTurnId: "turn-a",
    inboundMessageId: "message-in",
    outboundMessageId: "message-out",
    outcomeGeneration: 1,
    completedAt: "2026-09-08T00:00:00.000Z",
  });
  const entry = JSON.parse(
    readFileSync(memorySyncQueueFile(selected), "utf8"),
  ) as SyncRequest;
  const failed = await processEntry(entry, {
    butlerData: selected,
    ingest: async () => {
      throw new Error("controlled_registration_failure");
    },
  });
  expect(failed).toMatchObject({
    dequeue: false,
    reason: "memory_source_registration_failed",
  });
  expect(observation.job_id).toBe(
    entry.schema_version === "butler.memory-sync-request.v3"
      ? entry.job_id
      : "",
  );
  expect(
    existsSync(
      join(selected, "cognition", "memory", "queue", "dead-letter.jsonl"),
    ),
  ).toBe(true);
  expect(existsSync(join(sentinel, "cognition"))).toBe(false);
});
