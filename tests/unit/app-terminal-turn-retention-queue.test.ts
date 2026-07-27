import { expect, test } from "bun:test";
import { TerminalTurnRetentionQueue } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/retention/terminal-turn-retention-queue.ts";

test("not-ready work sleeps while one failed compaction recovers once", async () => {
  const attempts = new Map<string, number>();
  const failures: string[] = [];
  let settled = false;
  let failureCleared = false;
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: emptyPage,
    compactTurn: (turnId) => {
      attempts.set(turnId, (attempts.get(turnId) ?? 0) + 1);
      if (turnId === "unsettled" && !settled) return "not_ready";
      if (turnId === "failed" && !failureCleared) throw new Error("busy");
      return "complete";
    },
    recordFailure: (error) => failures.push(String(error)),
  }, { semanticSettleMs: 10, maintenanceSettleMs: 10 });

  queue.schedule("unsettled");
  queue.schedule("ready");
  queue.schedule("failed");
  await waitUntil(() => attempts.has("ready") && failures.length === 1);
  expect(attempts.get("unsettled")).toBe(1);
  expect(attempts.get("ready")).toBe(1);
  expect(attempts.get("failed")).toBe(1);
  failureCleared = true;
  await waitUntil(() => attempts.get("failed") === 2);
  await Bun.sleep(30);
  expect(attempts.get("unsettled")).toBe(1);
  expect(attempts.get("failed")).toBe(2);

  settled = true;
  queue.schedule("unsettled");
  await waitUntil(() => attempts.get("unsettled") === 2);
  queue.close();
});

test("persistent compaction failure stops after one delayed recovery", async () => {
  let attempts = 0;
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: emptyPage,
    compactTurn: () => {
      attempts += 1;
      throw new Error("busy");
    },
    recordFailure: () => undefined,
  }, { semanticSettleMs: 10, maintenanceSettleMs: 10 });

  queue.schedule("failed");
  await waitUntil(() => attempts === 2);
  await Bun.sleep(50);
  expect(attempts).toBe(2);
  queue.close();
});

test("startup discovery receives one delayed recovery", async () => {
  let pageAttempts = 0;
  const compacted: string[] = [];
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: () => {
      pageAttempts += 1;
      if (pageAttempts === 1) throw new Error("busy");
      return {
        turns: [{ turnId: "recovered", rowId: 1 }],
        nextCursor: 1,
        hasMore: false,
      };
    },
    compactTurn: (turnId) => {
      compacted.push(turnId);
      return "complete";
    },
    recordFailure: () => undefined,
  }, { semanticSettleMs: 10, maintenanceSettleMs: 10 });

  queue.sweep();
  await waitUntil(() => compacted.includes("recovered"));
  expect(pageAttempts).toBe(2);
  queue.close();
});

test("startup sweep reads bounded cursor pages and drains every terminal turn", async () => {
  const turns = Array.from({ length: 70 }, (_, index) => ({
    turnId: `turn-${index + 1}`,
    rowId: index + 1,
  }));
  const pageRequests: Array<{ cursor: number; limit: number }> = [];
  const compacted: string[] = [];
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: (cursor, limit) => {
      pageRequests.push({ cursor, limit });
      const candidates = turns.filter((turn) => turn.rowId > cursor);
      const page = candidates.slice(0, limit);
      return {
        turns: page,
        nextCursor: page.at(-1)?.rowId ?? cursor,
        hasMore: candidates.length > limit,
      };
    },
    compactTurn: (turnId) => {
      compacted.push(turnId);
      return "complete";
    },
    recordFailure: (error) => {
      throw error;
    },
  }, { semanticSettleMs: 10, maintenanceSettleMs: 10 });

  queue.sweep();
  await waitUntil(() => compacted.length === turns.length);
  expect(pageRequests).toEqual([
    { cursor: 0, limit: 32 },
    { cursor: 32, limit: 32 },
    { cursor: 64, limit: 32 },
  ]);
  expect(new Set(compacted).size).toBe(turns.length);
  queue.close();
});

test("replay-tail work sleeps until the exact global event cursor", async () => {
  let attempts = 0;
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: emptyPage,
    compactTurn: () => {
      attempts += 1;
      return attempts === 1
        ? { status: "waiting_for_event_cursor", eventCursor: 240 }
        : "complete";
    },
    recordFailure: (error) => {
      throw error;
    },
  }, { semanticSettleMs: 10, maintenanceSettleMs: 10 });

  queue.schedule("tail-protected");
  await waitUntil(() => attempts === 1);
  queue.sweep();
  await Bun.sleep(50);
  expect(attempts).toBe(1);
  queue.advanceEventCursor(239);
  await Bun.sleep(75);
  expect(attempts).toBe(1);
  queue.advanceEventCursor(240);
  await waitUntil(() => attempts === 2);
  queue.close();
});

test("completed scheduled turns release all sweep preemptions", async () => {
  const turns = Array.from({ length: 100 }, (_, index) => ({
    turnId: `scheduled-${index + 1}`,
    rowId: index + 1,
  }));
  const attempts = new Map<string, number>();
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: (cursor, limit) => {
      const candidates = turns.filter((turn) => turn.rowId > cursor);
      const page = candidates.slice(0, limit);
      return {
        turns: page,
        nextCursor: page.at(-1)?.rowId ?? cursor,
        hasMore: candidates.length > limit,
      };
    },
    compactTurn: (turnId) => {
      attempts.set(turnId, (attempts.get(turnId) ?? 0) + 1);
      return "complete";
    },
    recordFailure: (error) => {
      throw error;
    },
  }, { semanticSettleMs: 1, maintenanceSettleMs: 1 });

  for (const turn of turns) queue.schedule(turn.turnId);
  await waitUntil(() => totalAttempts(attempts) === turns.length);
  expect(retainedPreemptionIds(queue)).toEqual([]);
  queue.sweep();
  await waitUntil(() => totalAttempts(attempts) === turns.length * 2);
  expect([...attempts.values()].every((count) => count === 2)).toBe(true);
  queue.close();
});

test("pending work retains preemption only until continuation completes", async () => {
  let attempts = 0;
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: emptyPage,
    compactTurn: () => ++attempts === 1 ? "pending" : "complete",
    recordFailure: (error) => {
      throw error;
    },
  }, { semanticSettleMs: 1, maintenanceSettleMs: 100 });

  queue.schedule("pending-turn");
  await waitUntil(() => attempts === 1);
  expect(retainedPreemptionIds(queue)).toEqual(["pending-turn"]);
  await waitUntil(() => attempts === 2);
  expect(retainedPreemptionIds(queue)).toEqual([]);
  queue.close();
});

test("startup sweep does not release semantic work preemption", async () => {
  let pageRequests = 0;
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: (cursor) => {
      pageRequests += 1;
      return emptyPage(cursor);
    },
    compactTurn: () => "complete",
    recordFailure: (error) => {
      throw error;
    },
  }, { semanticSettleMs: 100, maintenanceSettleMs: 1 });

  queue.schedule("semantic-pending");
  queue.sweep();
  await waitUntil(() => pageRequests === 1);
  expect(retainedPreemptionIds(queue)).toEqual(["semantic-pending"]);
  queue.close();
});

test("live work runs once promptly and continuation yields to maintenance", async () => {
  const calls: number[] = [];
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: emptyPage,
    compactTurn: () => {
      calls.push(Date.now());
      return calls.length === 1 ? "pending" : "complete";
    },
    recordFailure: (error) => {
      throw error;
    },
  });

  queue.sweep();
  await Bun.sleep(150);
  const startedAt = Date.now();
  queue.schedule("turn-live");
  await waitUntil(() => calls.length === 1);
  expect(calls[0]! - startedAt).toBeLessThan(150);
  await Bun.sleep(100);
  expect(calls).toHaveLength(1);
  await waitUntil(() => calls.length === 2);
  expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(200);
  queue.close();
});

test("startup discovery waits for the cooperative maintenance lane", async () => {
  let attempts = 0;
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: (cursor) => ({
      turns: cursor === 0 ? [{ turnId: "historical", rowId: 1 }] : [],
      nextCursor: 1,
      hasMore: false,
    }),
    compactTurn: () => {
      attempts += 1;
      return "complete";
    },
    recordFailure: (error) => {
      throw error;
    },
  });

  queue.sweep();
  await Bun.sleep(100);
  expect(attempts).toBe(0);
  await waitUntil(() => attempts === 1);
  queue.close();
});

test("each maintenance tick compacts at most one historical App turn", async () => {
  const calls: Array<{ turnId: string; at: number }> = [];
  const queue = new TerminalTurnRetentionQueue({
    terminalTurnPage: (cursor) => ({
      turns: cursor === 0
        ? [
            { turnId: "historical-1", rowId: 1 },
            { turnId: "historical-2", rowId: 2 },
            { turnId: "historical-3", rowId: 3 },
          ]
        : [],
      nextCursor: 3,
      hasMore: false,
    }),
    compactTurn: (turnId) => {
      calls.push({ turnId, at: Date.now() });
      return "complete";
    },
    recordFailure: (error) => {
      throw error;
    },
  });

  queue.sweep();
  await waitUntil(() => calls.length === 1);
  await Bun.sleep(100);
  expect(calls).toHaveLength(1);
  await waitUntil(() => calls.length === 2);
  expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(200);
  queue.close();
});

function emptyPage(afterRowId: number) {
  return { turns: [], nextCursor: afterRowId, hasMore: false };
}

function totalAttempts(attempts: Map<string, number>): number {
  return [...attempts.values()].reduce((sum, count) => sum + count, 0);
}

function retainedPreemptionIds(queue: TerminalTurnRetentionQueue): string[] {
  return [...(queue as unknown as {
    maintenancePreemptions: Set<string>;
  }).maintenancePreemptions];
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
