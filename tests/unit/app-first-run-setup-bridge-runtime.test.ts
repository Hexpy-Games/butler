import { expect, test } from "bun:test";
import { createFirstRunSetupBridge } from "../../packages/butler-app/client/electron/setup-bridge.mjs";

test("first-run setup bridge prevents stale start from overwriting retry", async () => {
  const firstReady = deferred<void>();
  const secondReady = deferred<void>();
  let startCount = 0;
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => {
      startCount += 1;
      const invocation = startCount;
      if (invocation === 1) await firstReady.promise;
      if (invocation === 2) await secondReady.promise;
    },
    readSettings: async () => ({ bridge_mode: "electron" }),
  });

  const staleStart = bridge.start();
  expect(bridge.status().phase).toBe("checking");

  bridge.cancel();
  expect(bridge.status().phase).toBe("cancelled");

  const retryStart = bridge.start();
  expect(bridge.status().phase).toBe("checking");

  firstReady.resolve();
  await staleStart;
  expect(bridge.status().phase).toBe("checking");

  secondReady.resolve();
  await retryStart;
  expect(bridge.status().phase).toBe("ready");
});

test("first-run setup bridge diagnostics expose redacted shape only", async () => {
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    readSettings: async () => {
      const error = new Error("raw /Users/example/.butler/private.env");
      (error as Error & { code?: string }).code = "settings_unavailable";
      throw error;
    },
  });

  await bridge.start();
  const diagnostics = bridge.diagnostics();
  expect(diagnostics).toMatchObject({
    phase: "failed",
    errors: [
      {
        code: "setup_failed",
        message: "Butler Agent를 준비하지 못했습니다.",
      },
    ],
  });
  const serialized = JSON.stringify(diagnostics);
  expect(serialized).not.toContain("/Users/example/.butler");
  expect(serialized).not.toContain("private.env");
  expect(serialized).not.toContain("stack");
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
