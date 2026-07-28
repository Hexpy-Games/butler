import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteWriteReadiness } from
  "../../packages/butler-agent/src/agent/adapters/btcc/sqlite/sqlite-write-readiness.ts";
import {
  objectSchema,
  runPhaseConversation,
} from "../../packages/butler-agent/src/agent/btcc/core/index.ts";
import { runtimeInterruption } from
  "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";

const anchor = {
  turnId: "turn-storage-contention",
  turnRevision: 22,
  semanticState: "planning",
  checkpointId: "checkpoint-storage-contention",
  checkpointRevision: 1,
  claimId: "claim-storage-contention",
  executionFence: 0,
} as const;

test("typed SQLite writer contention is automatically recoverable", () => {
  const error = Object.assign(new Error("database is locked"), {
    code: "SQLITE_BUSY",
    errno: 5,
  });

  expect(runtimeInterruption(error, anchor)).toMatchObject({
    code: "sqlite_write_contention",
    activation: { kind: "automatic_storage_recovery" },
    cause: error,
  });
});

test("Bun SQLite driver identity survives missing enumerable codes", () => {
  const error = Object.assign(new Error("database is locked"), {
    name: "SQLiteError",
  });

  expect(runtimeInterruption(error, anchor)).toMatchObject({
    code: "sqlite_write_contention",
    activation: { kind: "automatic_storage_recovery" },
    cause: error,
  });
});

test("wrapped SQLite contention preserves automatic recovery semantics", () => {
  const sqliteError = Object.assign(new Error("database table is locked"), {
    name: "SQLiteError",
  });
  const error = new Error("phase repository write failed", {
    cause: sqliteError,
  });

  expect(runtimeInterruption(error, anchor)).toMatchObject({
    code: "sqlite_write_contention",
    activation: { kind: "automatic_storage_recovery" },
    cause: error,
  });
});

test("storage recovery waits for actual SQLite writer readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-sqlite-readiness-"));
  const dbPath = join(root, "butler.sqlite");
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.close();
  const holder = Bun.spawn([
    "bun",
    "-e",
    [
      'import { Database } from "bun:sqlite";',
      "const db = new Database(process.argv[1]);",
      'db.exec("BEGIN IMMEDIATE");',
      'console.log("locked");',
      "setTimeout(() => { db.exec(\"ROLLBACK\"); db.close(); }, 700);",
    ].join(" "),
    dbPath,
  ], { stdout: "pipe", stderr: "pipe" });

  try {
    const reader = holder.stdout.getReader();
    const firstOutput = await reader.read();
    expect(new TextDecoder().decode(firstOutput.value)).toContain("locked");
    reader.releaseLock();

    const readiness = createSqliteWriteReadiness(dbPath, {
      async wait() { throw new Error("provider fallback must not run"); },
    });
    await readiness.wait({
      interruption: runtimeInterruption(
        Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY",
          errno: 5,
        }),
        anchor,
      ),
      receipt: { interruptionId: "sqlite-lock", activationCount: 1 },
      signal: new AbortController().signal,
    });

    expect(await holder.exited).toBe(0);
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test("an untyped message cannot impersonate SQLite contention", () => {
  const error = new Error("database is locked");

  expect(runtimeInterruption(error, anchor)).toMatchObject({
    code: "runtime_unclassified_interruption",
    activation: { kind: "runtime_remediation" },
    cause: error,
  });
});

test("phase orchestration preserves typed SQLite contention for automatic recovery", async () => {
  const error = Object.assign(new Error("database is locked"), {
    code: "SQLITE_BUSY",
    errno: 5,
  });
  const run = runPhaseConversation({
    binding: anchor,
    modelSelection: {
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      controls: { reasoningEffort: "low" },
      controlsHash: "controls-sha",
    },
    context: {
      originalMessageId: "message-storage-contention",
      originalMessage: "continue the current work",
      sessionId: "session-storage-contention",
      userRef: "user-storage-contention",
      profileRefs: [],
      recentFeedbackRefs: [],
      mandatoryHotCacheRefs: [],
      optionalHotCacheRefs: [],
      baselineObservationScopeRefs: [],
    },
    phaseContract: {
      phase: "planning",
      operationSurface: "authorized",
      objective: "plan_the_work",
      duties: [],
      prohibitions: [],
    },
    codec: {
      submissionSchema: objectSchema({}),
      decode: () => ({}),
    },
    store: {
      async restore() { throw error; },
      async appendOperationRound() { throw new Error("unexpected operation round"); },
      async appendOperationResults() { throw new Error("unexpected operation result"); },
      async appendProviderProductRejection() {
        throw new Error("unexpected provider product rejection");
      },
      async appendPhaseSubmission() { throw new Error("unexpected phase submission"); },
      async acceptPhaseProduct() { throw new Error("unexpected accepted product"); },
    },
    model: {
      async runRound() { throw new Error("model must not run"); },
    },
    operations: {
      async perform() { throw new Error("operation must not run"); },
    },
    operationAuthority: {
      observationScopeRefs: [],
      mutation: { kind: "forbidden" },
    },
    executionPermit: {
      signal: new AbortController().signal,
      assertActive() {},
      close() {},
    },
  });

  await expect(run).rejects.toMatchObject({
    code: "sqlite_write_contention",
    activation: { kind: "automatic_storage_recovery" },
    cause: error,
  });
});
