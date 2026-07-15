import { expect, test } from "bun:test";
import { drainAppForegroundActiveWork } from "../../packages/butler-app/client/electron/app-foreground-drain.mjs";

test("foreground drain cancels exact turns and workers then proves settlement", async () => {
  const turns: string[] = [];
  const workers: string[] = [];
  let reads = 0;
  const result = await drainAppForegroundActiveWork({
    snapshot: {
      classification: "active_work_detected",
      turn_ids: ["turn-active", "turn-active"],
      worker_ids: ["worker-active"],
    },
    cancelTurn: async (turnId) => turns.push(turnId),
    cancelWorker: async (workerId) => workers.push(workerId),
    readSnapshot: async () => ({
      classification: reads++ > 0 ? "no_active_work" : "active_work_detected",
    }),
    sleepMs: async () => undefined,
  });

  expect(turns).toEqual(["turn-active"]);
  expect(workers).toEqual(["worker-active"]);
  expect(result).toEqual({
    status: "settled",
    cancellation_requests: 2,
    cancellation_failures: 0,
    settled: true,
    raw_text_included: false,
  });
});

test("foreground drain is bounded and reports unknown work without leaking ids", async () => {
  const result = await drainAppForegroundActiveWork({
    snapshot: {
      classification: "active_work_unknown",
      turn_ids: ["invalid id with spaces"],
    },
    cancelTurn: async () => {
      throw new Error("must not receive invalid ids");
    },
    cancelWorker: async () => undefined,
    readSnapshot: async () => ({ classification: "active_work_unknown" }),
    attempts: 2,
    sleepMs: async () => undefined,
  });
  expect(result).toEqual({
    status: "deadline_exceeded",
    cancellation_requests: 0,
    cancellation_failures: 0,
    settled: false,
    raw_text_included: false,
  });
  expect(JSON.stringify(result)).not.toContain("invalid id");
});
