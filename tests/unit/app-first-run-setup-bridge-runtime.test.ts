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
    readSettings: async () => ({
      bridge_mode: "local",
      server_url: "http://127.0.0.1:18765",
    }),
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

test("first-run setup bridge records existing-Agent compatibility checks", async () => {
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    existingAgentConfigured: true,
    readSettings: async () => ({
      bridge_mode: "external",
      server_url: "http://127.0.0.1:18765",
    }),
  });

  await bridge.start({ mode: "existing-agent" });
  expect(bridge.status().phase).toBe("ready");
  expect(bridge.diagnostics().checks.map((check) => check.id)).toEqual([
    "existing_agent",
    "settings",
    "compatibility",
  ]);
});

test("first-run setup bridge defaults to bundled-Agent mode", async () => {
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    readSettings: async () => ({
      bridge_mode: "local",
      server_url: "http://127.0.0.1:18765",
    }),
  });

  await bridge.start();
  expect(bridge.diagnostics().checks.map((check) => check.id)).toContain(
    "managed_gateway",
  );
});

test("first-run setup bridge rejects incompatible existing-Agent settings", async () => {
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    existingAgentConfigured: true,
    readSettings: async () => ({
      bridge_mode: "local",
      server_url: "",
    }),
  });

  await bridge.start({ mode: "existing-agent" });
  expect(bridge.status()).toMatchObject({
    error_code: "existing_agent_incompatible",
    phase: "failed",
  });
});

test("first-run setup bridge does not start managed server for existing-Agent", async () => {
  let managedReadyCalls = 0;
  let existingReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    checkExistingReady: async () => {
      existingReadyCalls += 1;
    },
    ensureReady: async () => {
      managedReadyCalls += 1;
    },
    existingAgentConfigured: true,
    readSettings: async () => ({
      bridge_mode: "external",
      server_url: "http://127.0.0.1:18765",
    }),
  });

  await bridge.start({ mode: "existing-agent" });
  expect(bridge.status().phase).toBe("ready");
  expect(managedReadyCalls).toBe(0);
  expect(existingReadyCalls).toBe(1);
});

test("first-run setup bridge rejects default existing-Agent without explicit endpoint", async () => {
  let managedReadyCalls = 0;
  let existingReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    checkExistingReady: async () => {
      existingReadyCalls += 1;
    },
    ensureReady: async () => {
      managedReadyCalls += 1;
    },
    readSettings: async () => ({
      bridge_mode: "local",
      server_url: "http://127.0.0.1:18765",
    }),
  });

  await bridge.start({ mode: "existing-agent" });
  expect(bridge.status()).toMatchObject({
    error_code: "existing_agent_incompatible",
    phase: "failed",
  });
  expect(managedReadyCalls).toBe(0);
  expect(existingReadyCalls).toBe(0);
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
