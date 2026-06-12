import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createFirstRunSetupBridge } from "../../packages/butler-app/client/electron/setup-bridge.mjs";

test("Electron first-run setup bridge exposes status start cancel and diagnostics", () => {
  const preload = readRepoFile("packages/butler-app/client/electron/preload.cjs");
  const main = readRepoFile("packages/butler-app/client/electron/main.mjs");
  const setupBridge = readRepoFile(
    "packages/butler-app/client/electron/setup-bridge.mjs",
  );
  const api = readRepoFile("packages/butler-app/client/ui/src/app/api.ts");

  expect(preload).toContain("getSetupStatus");
  expect(preload).toContain("startSetup");
  expect(preload).toContain("cancelSetup");
  expect(preload).toContain("exportSetupDiagnostics");
  expect(preload).toContain("butler:first-run-setup-start");
  expect(preload).toContain("butler:first-run-setup-diagnostics");
  expect(preload).toContain("butler:get-local-auth-headers");
  expect(preload).not.toContain("getLocalAuthHeaders");

  expect(main).toContain('ipcMain.handle("butler:first-run-setup-status"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-start"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-cancel"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-diagnostics"');
  expect(main).toContain('ipcMain.handle("butler:get-local-auth-headers"');
  expect(main).toContain("createFirstRunSetupBridge");
  expect(main).toContain("readRuntimeDiagnostics");
  expect(setupBridge).toContain("createFirstRunSetupBridge");
  expect(setupBridge).toContain("bundled_agent_version");
  expect(setupBridge).toContain("local_auth");
  expect(setupBridge).toContain("health");
  expect(setupBridge).toContain("protocol");

  expect(api).toContain('url.pathname === "/setup/status"');
  expect(api).toContain('url.pathname === "/setup/start"');
  expect(api).toContain('url.pathname === "/setup/cancel"');
  expect(api).toContain('url.pathname === "/setup/diagnostics"');
});

test("first-run setup blocks workspace when bundled Agent diagnostics are incomplete", async () => {
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    readRuntimeDiagnostics: () => ({
      phase: "running",
      bundled_agent: {
        source: "app-managed",
        version_configured: false,
      },
      local_auth: {
        required: true,
        token_configured: true,
      },
    }),
    readSettings: async () => ({
      gateway_profile: "electron",
    }),
  });

  const status = await bridge.start();

  expect(status.phase).toBe("failed");
  expect(status.error_code).toBe("bundled_agent_version_missing");
  expect(bridge.diagnostics().checks).toContainEqual({
    id: "bundled_agent_version",
    label: "Agent 버전 확인",
    status: "failed",
  });
});

test("first-run setup passes only after version auth health protocol and profile checks", async () => {
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    readRuntimeDiagnostics: () => ({
      phase: "running",
      bundled_agent: {
        source: "app-managed",
        version_configured: true,
      },
      local_auth: {
        required: true,
        token_configured: true,
      },
    }),
    readSettings: async () => ({
      gateway_profile: "electron",
    }),
  });

  const status = await bridge.start();

  expect(status.phase).toBe("ready");
  expect(bridge.diagnostics().checks.map((check) => check.id)).toEqual([
    "managed_gateway",
    "bundled_agent_version",
    "local_auth",
    "health",
    "protocol",
    "gateway_profile",
  ]);
  expect(
    bridge.diagnostics().checks.every((check) => check.status === "passed"),
  ).toBe(true);
});

test("first-run setup diagnostics are redacted coarse status only", () => {
  const setupBridge = readRepoFile(
    "packages/butler-app/client/electron/setup-bridge.mjs",
  );
  const diagnosticsStart = setupBridge.indexOf(
    "function diagnosticsView",
  );
  const diagnosticsEnd = setupBridge.indexOf(
    "function setupCheck",
    diagnosticsStart,
  );
  const diagnostics = setupBridge.slice(diagnosticsStart, diagnosticsEnd);

  expect(diagnostics).toContain("generated_at");
  expect(diagnostics).toContain("phase");
  expect(diagnostics).toContain("checks");
  expect(diagnostics).toContain("errors");
  expect(diagnostics).not.toContain("serverUrl");
  expect(diagnostics).not.toContain("butlerDataRoot");
  expect(diagnostics).not.toContain("process.env");
  expect(diagnostics).not.toContain("error.message");
  expect(diagnostics).not.toContain("String(error)");
});

test("Electron bundled-Agent setup does not attach to a pre-existing gateway", () => {
  const main = readRepoFile("packages/butler-app/client/electron/main.mjs");
  const supervisor = readRepoFile(
    "packages/butler-app/client/electron/app-agent-supervisor.mjs",
  );
  const ensureStart = supervisor.indexOf("async function ensureReady()");
  const startStart = supervisor.indexOf("async function start", ensureStart);
  const ensureReady = supervisor.slice(ensureStart, startStart);

  expect(main).toContain("createBundledAgentSupervisor");
  expect(main).toContain("resolveGateway: managedGatewayCommand");
  expect(main).toContain("healthCheck: healthOk");
  const gatewayResolveIndex = ensureReady.indexOf("const gateway = resolveGateway();");
  const managedHealthIndex = ensureReady.indexOf(
    "if (await healthCheck(localAuth))",
    gatewayResolveIndex,
  );
  expect(gatewayResolveIndex).toBeGreaterThanOrEqual(0);
  expect(managedHealthIndex).toBeGreaterThan(gatewayResolveIndex);
  expect(ensureReady).toContain("if (!gateway.commitActivation)");
  expect(ensureReady).toContain("updatePort(await findAvailablePort(getPort() + 1))");
  expect(ensureReady).toContain("startupPromise = start(gateway);");
});

function readRepoFile(path: string): string {
  return readFileSync(path, "utf8");
}
