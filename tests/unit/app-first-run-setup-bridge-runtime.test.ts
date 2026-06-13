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
      gateway_profile: "electron",
      server_url: "http://127.0.0.1:18765",
    }),
    readRuntimeDiagnostics: () => ({
      ...okRuntimeDiagnostics(),
      runtime_home: "/Users/example/.butler/app/runtime/agent",
      local_auth: {
        required: true,
        file_configured: true,
        token_configured: true,
        token: "a".repeat(43),
      },
      last_error: {
        code: "settings_unavailable",
        details: {
          message: "raw /Users/example/.butler/private.env",
        },
      },
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
  const jwtHeader = "eyJ" + "hbGciOiJIUzI1NiJ9";
  const jwtPayload = "eyJ" + "zdWIiOiJidXRsZXIifQ";
  const jwtSignatureA = "signature" + "000000";
  const jwtSignatureB = "signature" + "111111";
  const authHeaderFixture = [
    "Bear",
    "er",
    [jwtHeader, jwtPayload, jwtSignatureA].join("."),
  ].join(" ");
  const jwtToken = [jwtHeader, jwtPayload, jwtSignatureB].join(".");
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    readSettings: async () => {
      const privatePath = "/Users/Alice Smith/.butler/private.env";
      const error = new Error(
        ["raw path=/tmp/butler/private.env", privatePath, authHeaderFixture].join(" "),
      );
      (error as Error & { code?: string }).code = "settings_unavailable";
      throw error;
    },
    readRuntimeDiagnostics: () => ({
      ...okRuntimeDiagnostics(),
      runtime_home: "/tmp/butler/app/runtime/agent",
      token: "b".repeat(43),
      last_error: {
        stack: "Error: bad\n    at /tmp/butler/private.env:1:1",
        stderr:
          "raw /tmp/butler/private.env ~/.butler/private.env " +
          "~/Library/Application Support/Butler/private.env " +
          `C:\\Users\\Alice Smith\\.butler\\private.env ${jwtToken}`,
      },
      windows_home: "C:\\Users\\Alice Smith\\.butler\\state",
      shell_home: "~/Library/Application Support/Butler/state",
    }),
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
  expect(serialized).not.toContain("/tmp/butler");
  expect(serialized).not.toContain("/Users/Alice Smith");
  expect(serialized).not.toContain("Alice Smith");
  expect(serialized).not.toContain("~/.butler");
  expect(serialized).not.toContain("~/Library");
  expect(serialized).not.toContain("Application Support");
  expect(serialized).not.toContain("C:\\Users\\Alice");
  expect(serialized).not.toContain("private.env");
  expect(serialized).not.toContain("eyJ" + "hbGci");
  expect(serialized).not.toContain(jwtSignatureA);
  expect(serialized).not.toContain(jwtSignatureB);
  expect(serialized).not.toContain("a".repeat(43));
  expect(serialized).not.toContain("b".repeat(43));
  expect(serialized).toContain("[redacted-path]");
  expect(serialized).not.toContain("stack");
});

test("first-run setup bridge ignores existing-Agent mode requests", async () => {
  let managedReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => {
      managedReadyCalls += 1;
    },
    readSettings: async () => ({
      bridge_mode: "local",
      gateway_profile: "electron",
      server_url: "http://127.0.0.1:18765",
    }),
    readRuntimeDiagnostics: okRuntimeDiagnostics,
  });

  await startWithRawRequest(bridge, { mode: "existing-agent" });
  expect(bridge.status().phase).toBe("ready");
  expect(managedReadyCalls).toBe(1);
  expect(bridge.diagnostics().checks.map((check) => check.id)).toEqual([
    "agent_service",
    "managed_gateway",
    "bundled_agent_version",
    "local_auth",
    "health",
    "protocol",
    "gateway_profile",
  ]);
});

test("first-run setup bridge defaults to bundled-Agent mode", async () => {
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    readSettings: async () => ({
      bridge_mode: "local",
      gateway_profile: "electron",
      server_url: "http://127.0.0.1:18765",
    }),
    readRuntimeDiagnostics: okRuntimeDiagnostics,
  });

  await bridge.start();
  expect(bridge.diagnostics().checks.map((check) => check.id)).toContain(
    "managed_gateway",
  );
});

test("first-run setup bridge ignores standalone installer service fields", async () => {
  let managedReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => {
      managedReadyCalls += 1;
    },
    readSettings: async () => ({
      bridge_mode: "local",
      gateway_profile: "electron",
      server_url: "http://127.0.0.1:18765",
    }),
    readRuntimeDiagnostics: okRuntimeDiagnostics,
  });

  await startWithRawRequest(bridge, {
    mode: "bundled-agent",
    profile: "agent-standalone",
    registerService: true,
    installSource: "source-checkout",
  });
  expect(bridge.status().phase).toBe("ready");
  expect(managedReadyCalls).toBe(1);
  expect(bridge.diagnostics().checks.map((check) => check.id)).toEqual([
    "agent_service",
    "managed_gateway",
    "bundled_agent_version",
    "local_auth",
    "health",
    "protocol",
    "gateway_profile",
  ]);
});

test("first-run setup bridge rejects damaged bundled gateway profile settings", async () => {
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    readSettings: async () => ({
      bridge_mode: "local",
      gateway_profile: "terminal",
      server_url: "http://127.0.0.1:18765",
    }),
    readRuntimeDiagnostics: okRuntimeDiagnostics,
  });

  await startWithRawRequest(bridge, { mode: "bundled-agent" });
  expect(bridge.status()).toMatchObject({
    error_code: "gateway_profile_mismatch",
    phase: "failed",
  });
});

test("first-run setup bridge still verifies electron profile for existing-Agent mode requests", async () => {
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    readSettings: async () => ({
      bridge_mode: "local",
      gateway_profile: "terminal",
      server_url: "http://127.0.0.1:18765",
    }),
    readRuntimeDiagnostics: okRuntimeDiagnostics,
  });

  await startWithRawRequest(bridge, { mode: "existing-agent" });
  expect(bridge.status()).toMatchObject({
    error_code: "gateway_profile_mismatch",
    phase: "failed",
  });
});

test("first-run setup bridge uses managed server for existing-Agent mode requests", async () => {
  let managedReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => {
      managedReadyCalls += 1;
    },
    readSettings: async () => ({
      bridge_mode: "local",
      gateway_profile: "electron",
      server_url: "http://127.0.0.1:18765",
    }),
    readRuntimeDiagnostics: okRuntimeDiagnostics,
  });

  await startWithRawRequest(bridge, { mode: "existing-agent" });
  expect(bridge.status().phase).toBe("ready");
  expect(managedReadyCalls).toBe(1);
});

test("first-run setup bridge does not require existing-Agent endpoint for mode requests", async () => {
  let managedReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => {
      managedReadyCalls += 1;
    },
    readSettings: async () => ({
      bridge_mode: "local",
      gateway_profile: "electron",
      server_url: "http://127.0.0.1:18765",
    }),
    readRuntimeDiagnostics: okRuntimeDiagnostics,
  });

  await startWithRawRequest(bridge, { mode: "existing-agent" });
  expect(bridge.status().phase).toBe("ready");
  expect(managedReadyCalls).toBe(1);
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

async function startWithRawRequest(
  bridge: ReturnType<typeof createFirstRunSetupBridge>,
  request: unknown,
) {
  const start = bridge.start as (request?: unknown) => Promise<unknown>;
  await start(request);
}

function okRuntimeDiagnostics() {
  return {
    phase: "running",
    bundled_agent: {
      source: "app-managed",
      version_configured: true,
    },
    local_auth: {
      required: true,
      token_configured: true,
    },
  };
}
