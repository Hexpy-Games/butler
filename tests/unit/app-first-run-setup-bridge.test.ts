import { afterEach, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createBundledAgentSupervisor } from "../../packages/butler-app/client/electron/app-agent-supervisor.mjs";
import { createFirstRunSetupBridge } from "../../packages/butler-app/client/electron/setup-bridge.mjs";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

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
  expect(preload).toContain("quitApp");
  expect(preload).toContain("butler:first-run-setup-start");
  expect(preload).toContain("butler:first-run-setup-diagnostics");
  expect(preload).toContain("butler:ensure-server");
  expect(preload).toContain("butler:get-server-url");
  expect(preload).toContain("butler:get-local-auth-headers");
  expect(preload).not.toContain("getLocalAuthHeaders");

  expect(main).not.toContain("async function createWindow() {\n  await ensureServer();");
  expect(main).toContain("function defaultRendererUrl()");
  expect(main).toContain('join(process.resourcesPath, "app-client")');
  expect(main).toContain('ipcMain.handle("butler:ensure-server"');
  expect(main).toContain('ipcMain.handle("butler:get-server-url"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-status"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-start"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-cancel"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-diagnostics"');
  expect(main).toContain('ipcMain.handle("butler:quit-app"');
  expect(main).toContain("isQuitting = true");
  expect(main).toContain('ipcMain.handle("butler:get-local-auth-headers"');
  expect(main).toContain("createFirstRunSetupBridge");
  expect(main).toContain("readRuntimeDiagnostics");
  expect(main).toContain("readLatestAppManagedRuntimeFailure");
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

test("default first-run setup does not run optional external tool preflights", async () => {
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

  await bridge.start();

  const checkIds = bridge.diagnostics().checks.map((check) => check.id);
  expect(checkIds).toEqual([
    "managed_gateway",
    "bundled_agent_version",
    "local_auth",
    "health",
    "protocol",
    "gateway_profile",
  ]);
  expect(checkIds.join(" ")).not.toMatch(
    /git|xcode|docker|mcp|local_model|curl|wget|unzip|brew|apt|dnf|yum|pacman/u,
  );
});

test("default first-run setup exercises bundled supervisor readiness without host tool probes", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-app-supervisor-"));
  const blockedExecutables = new Set([
    "git",
    "xcode-select",
    "docker",
    "curl",
    "wget",
    "unzip",
    "brew",
    "apt",
    "apt-get",
    "dnf",
    "yum",
    "pacman",
    "node",
    "npm",
    "npx",
  ]);
  const spawnedCommands: string[] = [];
  try {
    const supervisor = createBundledAgentSupervisor({
      butlerData,
      resolveGateway: () => ({
        appManaged: true,
        bundledAgentVersion: "0.0.0-test",
        command: "/Applications/Butler.app/Contents/Resources/bundled-agent/runtime/bin/bun",
        args: ["butler-agent", "app-server"],
        env: {},
        commitActivation: () => undefined,
      }),
      spawnProcess: (command: string) => {
        const executable = basename(command);
        if (blockedExecutables.has(executable)) {
          throw new Error(`unexpected host tool probe: ${executable}`);
        }
        spawnedCommands.push(command);
        return {
          pid: 42,
          once: () => undefined,
          kill: () => undefined,
        };
      },
      healthCheck: async () => spawnedCommands.length > 0,
      isPortAvailable: async () => true,
      findAvailablePort: async () => {
        throw new Error("port fallback not expected in this setup path");
      },
      updatePort: () => {
        throw new Error("port update not expected in this setup path");
      },
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765",
      getRendererOrigin: () => "app://butler",
      sleepMs: async () => undefined,
      stdio: "ignore",
    });
    const bridge = createFirstRunSetupBridge({
      ensureReady: () => supervisor.ensureReady(),
      readRuntimeDiagnostics: () => supervisor.diagnostics(),
      readSettings: async () => ({
        gateway_profile: "electron",
      }),
    });

    const status = await bridge.start();

    expect(status.phase).toBe("ready");
    expect(spawnedCommands).toEqual([
      "/Applications/Butler.app/Contents/Resources/bundled-agent/runtime/bin/bun",
    ]);
    expect(bridge.diagnostics().checks.map((check) => check.id)).toEqual([
      "managed_gateway",
      "bundled_agent_version",
      "local_auth",
      "health",
      "protocol",
      "gateway_profile",
    ]);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("optional external tool probes stay behind selected feature actions", () => {
  const setupBridge = readRepoFile(
    "packages/butler-app/client/electron/setup-bridge.mjs",
  );
  const supervisor = readRepoFile(
    "packages/butler-app/client/electron/app-agent-supervisor.mjs",
  );
  const firstRunController = readRepoFile(
    "packages/butler-app/client/ui/src/components/first-run/useFirstRunSetupController.ts",
  );
  const api = readRepoFile("packages/butler-app/client/ui/src/app/api.ts");
  const server = readRepoFile(
    "packages/butler-agent/src/gateways/app/server.ts",
  );
  const mcpSettings = readRepoFile(
    "packages/butler-app/client/ui/src/components/settings/McpSettings.tsx",
  );
  const localModelOperations = readRepoFile(
    "packages/butler-app/client/ui/src/components/settings/hooks/useLocalModelOperations.tsx",
  );

  const defaultSetupSource = `${setupBridge}\n${supervisor}\n${firstRunController}`;
  expect(defaultSetupSource).not.toContain("/mcp-servers");
  expect(defaultSetupSource).not.toContain("/model-catalog/local/discover");
  expect(defaultSetupSource).not.toMatch(
    /spawnSync|execFile|execSync|xcode-select|docker|git branch|curl|wget|unzip|brew|apt-get|dnf|yum|pacman/u,
  );

  expect(api).toContain(
    "url.pathname.match(/^\\/mcp-servers\\/([^/]+)\\/probe$/u)",
  );
  expect(api).toContain("url.pathname === \"/model-catalog/local/discover\"");
  expect(server).toContain(
    "url.pathname.match(/^\\/mcp-servers\\/([^/]+)\\/probe$/u)",
  );
  expect(server).toContain(
    "url.pathname === \"/model-catalog/local/discover\"",
  );
  expect(mcpSettings).toContain("async function probe");
  expect(mcpSettings).toContain("/probe");
  expect(localModelOperations).toContain("async function discover");
  expect(localModelOperations).toContain("discoverLocalModels(platform, serverUrl)");
});

test("Electron bridge calls MCP and local model preflights only for selected endpoints", async () => {
  const calls: Array<{ method: string; input?: unknown }> = [];
  (globalThis as { window?: unknown }).window = {
    location: { origin: "http://127.0.0.1:5173" },
    butlerApp: {
      listNavigation: async () => ({ chats: [], projects: [] }),
      startSetup: async () => ({ phase: "ready" }),
      probeMcpServer: async (input?: unknown) => {
        calls.push({ method: "probeMcpServer", input });
        return { servers: [] };
      },
      discoverLocalModels: async (input?: unknown) => {
        calls.push({ method: "discoverLocalModels", input });
        return { models: [] };
      },
    },
  };

  await api("/navigation");
  await api("/setup/start", {
    method: "POST",
    body: JSON.stringify({ mode: "bundled-agent" }),
  });
  expect(calls).toEqual([]);

  await api("/mcp-servers/server-a/probe", {
    method: "POST",
    body: JSON.stringify({}),
  });
  await api("/model-catalog/local/discover", {
    method: "POST",
    body: JSON.stringify({
      provider_id: "local",
      api_type: "openai_compatible",
      platform: "ollama",
      server_url: "http://127.0.0.1:11434",
    }),
  });

  expect(calls).toEqual([
    {
      method: "probeMcpServer",
      input: { serverId: "server-a" },
    },
    {
      method: "discoverLocalModels",
      input: {
        provider_id: "local",
        api_type: "openai_compatible",
        platform: "ollama",
        server_url: "http://127.0.0.1:11434",
      },
    },
  ]);
});

test("default app session summaries do not execute host git for branch metadata", () => {
  const store = readRepoFile(
    "packages/butler-agent/src/gateways/app/store.ts",
  );
  const branchInfoStart = store.indexOf("private branchInfoForSession");
  const branchInfoEnd = store.indexOf("private getMessageRow", branchInfoStart);
  const branchInfo = store.slice(branchInfoStart, branchInfoEnd);

  expect(branchInfo).toContain('safe_status: "Project workspace"');
  expect(branchInfo).not.toContain("spawnSync");
  expect(branchInfo).not.toContain('"git"');
  expect(branchInfo).not.toContain("branch --show-current");
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
  const gatewayResolveIndex = ensureReady.indexOf("gateway = resolveGateway();");
  const managedHealthIndex = ensureReady.indexOf(
    "if (await healthCheck(localAuth))",
    gatewayResolveIndex,
  );
  expect(gatewayResolveIndex).toBeGreaterThanOrEqual(0);
  expect(managedHealthIndex).toBeGreaterThan(gatewayResolveIndex);
  expect(ensureReady).toContain('recordError("gateway_unavailable"');
  expect(ensureReady).toContain("if (!gateway.commitActivation)");
  expect(ensureReady).toContain("updatePort(await findAvailablePort(getPort() + 1))");
  expect(ensureReady).toContain("startupPromise = start(gateway);");
});

function readRepoFile(path: string): string {
  return readFileSync(path, "utf8");
}
