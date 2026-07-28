import { expect, test } from "bun:test";

import { recoverBootstrapResource } from "../../packages/butler-app/client/ui/src/hooks/bootstrapResource.ts";

test("bootstrap metadata retries transient failures without latching an error", async () => {
  let attempts = 0;
  const ready: string[] = [];
  let unavailable = 0;

  const result = await recoverBootstrapResource({
    load: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("transient startup failure");
      return "model-catalog-ready";
    },
    onReady: (value) => ready.push(value),
    onUnavailable: () => {
      unavailable += 1;
    },
    isCancelled: () => false,
    initialFailureThreshold: 3,
    retryDelaysMs: [0],
    sleep: async () => {},
  });

  expect(result).toBe("ready");
  expect(attempts).toBe(3);
  expect(ready).toEqual(["model-catalog-ready"]);
  expect(unavailable).toBe(0);
});

test("bootstrap metadata recovers after exposing a bounded unavailable state", async () => {
  let attempts = 0;
  const transitions: string[] = [];

  const result = await recoverBootstrapResource({
    load: async () => {
      attempts += 1;
      if (attempts < 5) throw new Error("gateway not ready");
      return "settings-ready";
    },
    onReady: (value) => transitions.push(value),
    onUnavailable: () => transitions.push("unavailable"),
    isCancelled: () => false,
    initialFailureThreshold: 3,
    retryDelaysMs: [0],
    sleep: async () => {},
  });

  expect(result).toBe("ready");
  expect(transitions).toEqual(["unavailable", "settings-ready"]);
});

test("bootstrap metadata stops retrying when its renderer effect is cancelled", async () => {
  let attempts = 0;
  const abortController = new AbortController();

  const result = await recoverBootstrapResource({
    load: async () => {
      attempts += 1;
      throw new Error("still unavailable");
    },
    onReady: () => {
      throw new Error("cancelled recovery must not become ready");
    },
    onUnavailable: () => {},
    isCancelled: () => abortController.signal.aborted,
    signal: abortController.signal,
    initialFailureThreshold: 2,
    retryDelaysMs: [0],
    sleep: async (_delayMs, signal) => {
      expect(signal).toBe(abortController.signal);
      abortController.abort();
    },
  });

  expect(result).toBe("cancelled");
  expect(attempts).toBe(1);
});

test("bootstrap metadata stops after its finite startup recovery budget", async () => {
  let attempts = 0;
  let unavailable = 0;
  const delays: number[] = [];

  const result = await recoverBootstrapResource({
    load: async () => {
      attempts += 1;
      throw new Error("gateway remains unavailable");
    },
    onReady: () => {
      throw new Error("exhausted recovery must not become ready");
    },
    onUnavailable: () => {
      unavailable += 1;
    },
    isCancelled: () => false,
    initialFailureThreshold: 3,
    maxAttempts: 4,
    retryDelaysMs: [10, 20],
    sleep: async (delayMs) => {
      delays.push(delayMs);
    },
  });

  expect(result).toBe("unavailable");
  expect(attempts).toBe(4);
  expect(unavailable).toBe(1);
  expect(delays).toEqual([10, 20, 20]);
});
