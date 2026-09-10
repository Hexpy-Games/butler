import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("queue SQLite coordination releases a killed holder and never steals a live replacement", async () => {
  const selected = mkdtempSync(join(tmpdir(), "butler-memory-queue-owner-"));
  roots.push(selected);
  const queueFile = memorySyncQueueFile(selected);
  mkdirSync(join(queueFile, ".."), { recursive: true });
  const queueModule = join(import.meta.dir, "../../packages/butler-agent/src/agent/cognition/memory/scripts/queue.ts");
  const runAppend = (jobId: string) => Bun.spawn([
    "bun", "-e",
    `import { appendToQueue } from ${JSON.stringify(queueModule)}; appendToQueue({schema_version:"butler.memory-sync-request.v3",job_id:${JSON.stringify(jobId)},source:{kind:"conversation_message",session_id:"s",message_id:${JSON.stringify(jobId)},source_hash:"h"},created_at:"2026-09-08T00:00:00Z"},${JSON.stringify(selected)});`,
  ], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, BUTLER_DATA: selected }, stdout: "pipe", stderr: "pipe" });
  const runAck = (jobId: string) => Bun.spawn([
    "bun", "-e",
    `import { ack } from ${JSON.stringify(queueModule)}; if (!ack(${JSON.stringify(jobId)},${JSON.stringify(selected)})) process.exit(2);`,
  ], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, BUTLER_DATA: selected }, stdout: "pipe", stderr: "pipe" });
  const startHolder = (readyPath: string) => Bun.spawn([
    "bun", "-e",
    `import { Database } from "bun:sqlite"; import { writeFileSync } from "node:fs"; const db=new Database(${JSON.stringify(`${queueFile}.coord.sqlite`)},{create:true,readwrite:true}); db.exec("PRAGMA busy_timeout=0"); db.exec("BEGIN EXCLUSIVE"); writeFileSync(${JSON.stringify(readyPath)},"ready"); await new Promise(()=>{});`,
  ], { cwd: join(import.meta.dir, "../.."), env: { ...process.env, BUTLER_DATA: selected }, stdout: "pipe", stderr: "pipe" });
  const waitReady = async (readyPath: string): Promise<void> => {
    for (let i = 0; i < 100 && !existsSync(readyPath); i++) await Bun.sleep(10);
    expect(existsSync(readyPath)).toBe(true);
  };

  const firstReady = join(selected, "first-ready");
  const killedHolder = startHolder(firstReady);
  await waitReady(firstReady);
  expect(await runAppend("must-not-steal-dead-holder").exited).not.toBe(0);
  killedHolder.kill();
  await killedHolder.exited;
  expect(await runAppend("after-killed-holder").exited).toBe(0);

  const replacementReady = join(selected, "replacement-ready");
  const replacementHolder = startHolder(replacementReady);
  await waitReady(replacementReady);
  expect(await runAppend("must-not-steal-live-replacement").exited).not.toBe(0);
  expect(await runAck("after-killed-holder").exited).not.toBe(0);
  expect(readFileSync(queueFile, "utf8")).toContain("after-killed-holder");
  replacementHolder.kill();
  await replacementHolder.exited;
  expect(await runAppend("after-live-release").exited).toBe(0);
  expect(await runAck("after-killed-holder").exited).toBe(0);
  expect(readFileSync(queueFile, "utf8").trim().split("\n").map((line) => JSON.parse(line).job_id)).toEqual([
    "after-live-release",
  ]);
});
