import { expect, test } from "bun:test";
import { runtimeInterruption } from
  "../../packages/butler-agent/src/agent/btcc/recovery/index.ts";

const anchor = {
  turnId: "turn-storage-contention",
  turnRevision: 22,
  semanticState: "work_frontier",
  checkpointId: "checkpoint-storage-contention",
  checkpointRevision: 1,
  claimId: "claim-storage-contention",
  executionFence: 0,
};

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

test("an untyped message cannot impersonate SQLite contention", () => {
  const error = new Error("database is locked");

  expect(runtimeInterruption(error, anchor)).toMatchObject({
    code: "runtime_unclassified_interruption",
    activation: { kind: "runtime_remediation" },
    cause: error,
  });
});
