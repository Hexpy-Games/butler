import { afterEach, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createBundledAgentSupervisor } from "../../packages/butler-app/client/electron/app-agent-supervisor.mjs";
import { createFirstRunSetupBridge } from "../../packages/butler-app/client/electron/setup-bridge.mjs";
import {
  DISABLED_CACHE_BUDGET,
  cacheBudgetAdditionalArgument,
  cacheBudgetFromArguments,
  normalizeCacheBudget,
} from "../../packages/butler-app/client/electron/cache-budget-runtime.mjs";
import {
  api,
  subscribeLiveEvents,
} from "../../packages/butler-app/client/ui/src/app/api.ts";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { EventSource?: unknown }).EventSource;
});

test("Electron first-run setup bridge exposes status start cancel and diagnostics", () => {
  const preload = readRepoFile("packages/butler-app/client/electron/preload.cjs");
  const main = readRepoFile("packages/butler-app/client/electron/main.mjs");
  const setupBridge = readRepoFile(
    "packages/butler-app/client/electron/setup-bridge.mjs",
  );
  const oauthHelper = readRepoFile(
    "packages/butler-app/client/electron/openai-oauth-login-helper.mjs",
  );
  const api = readRepoFile("packages/butler-app/client/ui/src/app/api.ts");

  expect(preload).toContain("getSetupStatus");
  expect(preload).toContain("startSetup");
  expect(preload).toContain("cancelSetup");
  expect(preload).toContain("exportSetupDiagnostics");
  expect(preload).toContain("quitApp");
  expect(preload).toContain("butler:first-run-setup-start");
  expect(preload).toContain("butler:first-run-setup-diagnostics");
  expect(preload).toContain("getAgentServiceStatus");
  expect(preload).toContain("installAgentService");
  expect(preload).toContain("startAgentService");
  expect(preload).toContain("stopAgentService");
  expect(preload).toContain("restartAgentService");
  expect(preload).toContain("prepareAgentRuntimeUpdate");
  expect(preload).toContain("applyAgentRuntimeUpdate");
  expect(preload).toContain("rollbackAgentRuntimeUpdate");
  expect(preload).toContain("exportAgentServiceDiagnostics");
  expect(preload).toContain("butler:agent-service-status");
  expect(preload).toContain("butler:agent-service-diagnostics");
  expect(preload).toContain("butler:agent-runtime-update-prepare");
  expect(preload).toContain("butler:agent-runtime-update-apply");
  expect(preload).toContain("butler:agent-runtime-update-rollback");
  expect(preload).toContain("butler:ensure-server");
  expect(preload).toContain("butler:get-server-url");
  expect(preload).toContain("butler:get-local-auth-headers");
  expect(preload).toContain("startOpenAIOAuthLogin");
  expect(preload).toContain("butler:start-openai-oauth-login");
  expect(preload).toContain("restartOpenAIOAuthLogin");
  expect(preload).toContain("getOpenAIOAuthLoginStatus");
  expect(preload).toContain("submitOpenAIOAuthCallback");
  expect(preload).not.toContain("getLocalAuthHeaders");

  expect(main).not.toContain("async function createWindow() {\n  await ensureServer();");
  expect(main).not.toContain("if (rendererUrl === serverUrl) {\n    await ensureServer();");
  expect(main).toContain("rendererUrl === serverUrl || usesAppForegroundLifecycle");
  expect(main).toContain("let appAgentLaunchReconcilePromise = null");
  expect(main).toContain("const launchReconcile = reconcileAppAgentServiceForLaunch();");
  expect(main).toContain("await launchReconcile;");
  expect(main).toContain("function defaultRendererUrl()");
  expect(main).toContain('join(process.resourcesPath, "app-client")');
  expect(main).toContain("app.requestSingleInstanceLock()");
  expect(main).toContain('app.on("second-instance"');
  expect(main).toContain('ipcMain.handle("butler:ensure-server"');
  expect(main).toContain('ipcMain.handle("butler:get-server-url"');
  expect(main).toContain("waitForNativeServiceGatewayReady");
  expect(main).toContain("nativeServiceGatewayReadyPollAttempts");
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-status"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-start"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-cancel"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-diagnostics"');
  expect(main).toContain("createAgentServiceControl");
  expect(main).toContain('ipcMain.handle("butler:agent-service-status"');
  expect(main).toContain('ipcMain.handle("butler:agent-service-install"');
  expect(main).toContain('ipcMain.handle("butler:agent-service-start"');
  expect(main).toContain('ipcMain.handle("butler:agent-service-stop"');
  expect(main).toContain('ipcMain.handle("butler:agent-service-restart"');
  expect(main).toContain('ipcMain.handle("butler:agent-runtime-update-prepare"');
  expect(main).toContain('ipcMain.handle("butler:agent-runtime-update-apply"');
  expect(main).toContain('ipcMain.handle("butler:agent-runtime-update-rollback"');
  expect(main).toContain('ipcMain.handle("butler:agent-service-diagnostics"');
  expect(main).toContain('ipcMain.handle("butler:quit-app"');
  expect(main).toContain("isQuitting = true");
  expect(main).toContain('ipcMain.handle("butler:get-local-auth-headers"');
  expect(main).toContain('ipcMain.handle("butler:start-openai-oauth-login"');
  expect(main).toContain('ipcMain.handle("butler:restart-openai-oauth-login"');
  expect(main).toContain('ipcMain.handle("butler:get-openai-oauth-login-status"');
  expect(main).toContain('ipcMain.handle("butler:submit-openai-oauth-callback"');
  expect(main).toContain("resolveOpenAIOAuthLoginHelper");
  expect(oauthHelper).toContain("openai-oauth-login.ts");
  expect(oauthHelper).toContain("appManagedAgentPointerPath");
  expect(oauthHelper).toContain("resources");
  expect(oauthHelper).toContain("runtime");
  expect(oauthHelper).toContain("bin");
  expect(oauthHelper).toContain("bun");
  expect(main).toContain("BUTLER_CODEX_OAUTH_CLIENT_ID");
  expect(main).toContain("BUTLER_CODEX_OAUTH_NO_BROWSER");
  expect(main).toContain("OAuth login is not pending.");
  expect(main).toContain("OAuth callback state mismatch.");
  expect(main).toContain("waitForOAuthCompletion");
  expect(main).toContain("createFirstRunSetupBridge");
  expect(main).toContain(
    "serviceControl: usesAppForegroundLifecycle ? null : agentServiceControl",
  );
  expect(main).toContain("readRuntimeDiagnostics");
  expect(main).toContain("readLatestAppManagedRuntimeFailure");
  expect(setupBridge).toContain("createFirstRunSetupBridge");
  expect(setupBridge).toContain("serviceControl");
  expect(setupBridge).toContain("agent_service");
  expect(setupBridge).toContain("agent_runtime");
  expect(setupBridge).toContain('request?.mode === "repair"');
  expect(setupBridge).toContain("service_registration_unavailable");
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
    "agent_runtime",
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
    "agent_runtime",
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

test("foreground first-run repair revalidates runtime without service UX", async () => {
  let repairs = 0;
  const bridge = createFirstRunSetupBridge({
    ensureReady: async () => undefined,
    repairRuntime: async () => {
      repairs += 1;
    },
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
    readSettings: async () => ({ gateway_profile: "electron" }),
  });

  await expect(bridge.start({ mode: "repair" })).resolves.toMatchObject({
    phase: "ready",
  });
  expect(repairs).toBe(1);
  expect(bridge.diagnostics().checks[0]).toEqual({
    id: "agent_runtime",
    label: "Butler Agent 실행",
    status: "passed",
  });
  expect(JSON.stringify(bridge.diagnostics())).not.toContain("Agent 서비스");
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
      "agent_runtime",
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

test("first-run setup uses service-control before managed gateway readiness", async () => {
  const calls: string[] = [];
  const bridge = createFirstRunSetupBridge({
    serviceControl: {
      getAgentServiceStatus: async () => {
        calls.push("status");
        return { status: calls.length > 1 ? "ready" : "not_installed" };
      },
      installAgentService: async () => {
        calls.push("install");
        return { ok: true, status: "starting" };
      },
      startAgentService: async () => {
        calls.push("start");
        return { ok: true, status: "ready" };
      },
      readAgentServiceDiagnostics: async () => ({
        status: "ready",
        raw_text_included: false,
      }),
    },
    ensureReady: async () => {
      calls.push("ensure-ready");
    },
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
  expect(calls).toEqual(["status", "install", "start", "status", "ensure-ready"]);
  expect(bridge.diagnostics().checks[0]).toEqual({
    id: "agent_service",
    label: "Butler Agent 서비스",
    status: "passed",
  });
});

test("first-run setup waits for service readiness after start", async () => {
  const calls: string[] = [];
  let statusChecks = 0;
  const bridge = createFirstRunSetupBridge({
    serviceReadyPollAttempts: 4,
    serviceReadyPollDelayMs: 1,
    sleepMs: async () => {
      calls.push("sleep");
    },
    serviceControl: {
      getAgentServiceStatus: async () => {
        statusChecks += 1;
        calls.push(`status:${statusChecks}`);
        if (statusChecks === 1) return { status: "stopped" };
        return { status: statusChecks >= 3 ? "ready" : "starting" };
      },
      startAgentService: async () => {
        calls.push("start");
        return { ok: true, status: "starting" };
      },
      readAgentServiceDiagnostics: async () => ({
        status: "ready",
        raw_text_included: false,
      }),
    },
    ensureReady: async () => {
      calls.push("ensure-ready");
    },
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

  await expect(bridge.start()).resolves.toMatchObject({ phase: "ready" });
  expect(calls).toEqual([
    "status:1",
    "start",
    "status:2",
    "sleep",
    "status:3",
    "ensure-ready",
  ]);
});

test("first-run setup waits for native gateway readiness after service is ready", async () => {
  const calls: string[] = [];
  let ensureReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    gatewayReadyPollAttempts: 4,
    gatewayReadyPollDelayMs: 1,
    sleepMs: async () => {
      calls.push("sleep");
    },
    serviceControl: {
      getAgentServiceStatus: async () => {
        calls.push("status");
        return { status: "ready" };
      },
      readAgentServiceDiagnostics: async () => ({
        status: "ready",
        raw_text_included: false,
      }),
    },
    ensureReady: async () => {
      ensureReadyCalls += 1;
      calls.push(`ensure-ready:${ensureReadyCalls}`);
      if (ensureReadyCalls < 3) {
        const error = new Error("Butler Agent service gateway is not ready.");
        (error as Error & { code?: string }).code = "service_gateway_unhealthy";
        throw error;
      }
    },
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

  await expect(bridge.start()).resolves.toMatchObject({ phase: "ready" });
  expect(calls).toEqual([
    "status",
    "status",
    "ensure-ready:1",
    "sleep",
    "ensure-ready:2",
    "sleep",
    "ensure-ready:3",
  ]);
});

test("first-run setup accepts healthy gateway when service state files lag", async () => {
  const calls: string[] = [];
  const bridge = createFirstRunSetupBridge({
    serviceReadyPollAttempts: 3,
    serviceReadyPollDelayMs: 1,
    gatewayReadyPollAttempts: 2,
    gatewayReadyPollDelayMs: 1,
    sleepMs: async () => {
      calls.push("sleep");
    },
    serviceControl: {
      getAgentServiceStatus: async () => {
        calls.push("status");
        return { status: "stopped" };
      },
      installAgentService: async () => {
        calls.push("install");
        return { ok: true, status: "stopped" };
      },
      startAgentService: async () => {
        calls.push("start");
        return { ok: true, status: "starting" };
      },
      readAgentServiceDiagnostics: async () => ({
        status: "stopped",
        raw_text_included: false,
      }),
    },
    ensureReady: async () => {
      calls.push("ensure-ready");
    },
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

  await expect(bridge.start()).resolves.toMatchObject({ phase: "ready" });
  expect(bridge.diagnostics().checks[0]).toEqual({
    id: "agent_service",
    label: "Butler Agent 서비스",
    status: "passed",
  });
  expect(calls).toContain("ensure-ready");
});

test("first-run setup accepts healthy gateway when optional service projections lag", async () => {
  let ensureReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    serviceReadyPollAttempts: 2,
    serviceReadyPollDelayMs: 1,
    gatewayReadyPollAttempts: 2,
    gatewayReadyPollDelayMs: 1,
    sleepMs: async () => {},
    serviceControl: {
      getAgentServiceStatus: async () => ({
        status: "failed",
      }),
      startAgentService: async () => ({
        ok: true,
        status: "failed",
      }),
      readAgentServiceDiagnostics: async () => ({
        status: "failed",
        service_count: 6,
        online_count: 5,
        stale_count: 1,
        raw_text_included: false,
      }),
    },
    ensureReady: async () => {
      ensureReadyCalls += 1;
    },
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

  await expect(bridge.start()).resolves.toMatchObject({ phase: "ready" });
  expect(ensureReadyCalls).toBe(1);
});

test("first-run setup fails closed when service registration is unavailable", async () => {
  let ensureReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    serviceControl: {
      getAgentServiceStatus: async () => ({
        status: "not_installed",
      }),
      installAgentService: async () => ({
        ok: false,
        status: "needs_permission",
        error_code: "service_registration_unavailable",
      }),
      readAgentServiceDiagnostics: async () => ({
        private_path: "/Users/alice/.butler/secret",
        status: "needs_permission",
      }),
    },
    ensureReady: async () => {
      ensureReadyCalls += 1;
      const error = new Error("Butler Agent service gateway is not ready.");
      (error as Error & { code?: string }).code = "service_gateway_unhealthy";
      throw error;
    },
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
  const diagnostics = bridge.diagnostics();

  expect(status).toMatchObject({
    phase: "failed",
    error_code: "service_registration_unavailable",
  });
  expect(ensureReadyCalls).toBe(0);
  expect(diagnostics.checks[0]).toEqual({
    id: "agent_service",
    label: "Butler Agent 서비스",
    status: "failed",
  });
  expect(JSON.stringify(diagnostics)).not.toContain("/Users/alice");
  expect(JSON.stringify(diagnostics)).not.toContain(".butler/secret");
});

test("first-run setup fails closed when service start fails", async () => {
  let ensureReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    gatewayReadyPollAttempts: 2,
    gatewayReadyPollDelayMs: 1,
    serviceReadyPollAttempts: 2,
    serviceReadyPollDelayMs: 1,
    serviceControl: {
      getAgentServiceStatus: async () => ({
        status: "stopped",
      }),
      installAgentService: async () => ({
        ok: true,
        status: "stopped",
      }),
      startAgentService: async () => ({
        ok: false,
        status: "failed",
        error_code: "service_start_failed",
      }),
      readAgentServiceDiagnostics: async () => ({
        status: "failed",
        raw_text_included: false,
      }),
    },
    ensureReady: async () => {
      ensureReadyCalls += 1;
      const error = new Error("Butler Agent service gateway is not ready.");
      (error as Error & { code?: string }).code = "service_gateway_unhealthy";
      throw error;
    },
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

  expect(status).toMatchObject({
    phase: "failed",
    error_code: "setup_failed",
  });
  expect(ensureReadyCalls).toBe(0);
  expect(bridge.diagnostics().errors[0]?.details).toMatchObject({
    exception_code: "service_start_failed",
  });
});

test("first-run setup installs before start when a service is stopped", async () => {
  const calls: string[] = [];
  const bridge = createFirstRunSetupBridge({
    serviceControl: {
      getAgentServiceStatus: async () => {
        calls.push("status");
        return { status: calls.includes("start") ? "ready" : "stopped" };
      },
      installAgentService: async () => {
        calls.push("install");
        return { ok: true, status: "stopped" };
      },
      startAgentService: async () => {
        calls.push("start");
        return { ok: true, status: "ready" };
      },
      readAgentServiceDiagnostics: async () => ({
        status: "ready",
        raw_text_included: false,
      }),
    },
    ensureReady: async () => {
      calls.push("ensure-ready");
    },
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

  await expect(bridge.start()).resolves.toMatchObject({ phase: "ready" });
  expect(calls).toEqual(["status", "install", "start", "status", "ensure-ready"]);
});

test("first-run setup fails closed when service remains not ready after start", async () => {
  let ensureReadyCalls = 0;
  const bridge = createFirstRunSetupBridge({
    gatewayReadyPollAttempts: 2,
    gatewayReadyPollDelayMs: 1,
    serviceReadyPollAttempts: 2,
    serviceReadyPollDelayMs: 1,
    serviceControl: {
      getAgentServiceStatus: async () => ({
        status: "stopped",
      }),
      installAgentService: async () => ({
        ok: true,
        status: "stopped",
      }),
      startAgentService: async () => ({
        ok: true,
        status: "starting",
      }),
      readAgentServiceDiagnostics: async () => ({
        status: "starting",
        raw_text_included: false,
      }),
    },
    ensureReady: async () => {
      ensureReadyCalls += 1;
      const error = new Error("Butler Agent service gateway is not ready.");
      (error as Error & { code?: string }).code = "service_gateway_unhealthy";
      throw error;
    },
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

  expect(status).toMatchObject({
    phase: "failed",
    error_code: "agent_service_not_ready",
  });
  expect(ensureReadyCalls).toBeGreaterThan(0);
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
  const settingsRoutes = readRepoFile(
    "packages/butler-agent/src/gateways/app/interface/server/routes/settings-routes.ts",
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
  expect(settingsRoutes).toContain(
    "url.pathname.match(/^\\/mcp-servers\\/([^/]+)\\/probe$/u)",
  );
  expect(settingsRoutes).toContain(
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

test("Electron bridge live events subscribe through preload instead of renderer EventSource", () => {
  const calls: Array<unknown> = [];
  let capturedHandlers:
    | {
        onEvent?: (event: unknown) => void;
        onError?: (error: unknown) => void;
      }
    | undefined;
  (globalThis as { window?: unknown }).window = {
    location: { origin: "http://127.0.0.1:5173" },
    butlerApp: {
      subscribeLiveEvents: (input?: unknown, handlers?: unknown) => {
        calls.push(input);
        capturedHandlers = handlers as typeof capturedHandlers;
        return () => calls.push({ unsubscribed: true });
      },
    },
  };
  (globalThis as { EventSource?: unknown }).EventSource = class {
    constructor() {
      throw new Error("renderer EventSource should not be constructed");
    }
  };
  const events: unknown[] = [];

  const unsubscribe = subscribeLiveEvents(
    42,
    (event) => events.push(event),
    (error) => {
      throw error;
    },
  );
  capturedHandlers?.onEvent?.({
    id: 43,
    type: "turn.state_changed",
    created_at: "2026-06-27T00:00:00.000Z",
    payload: {},
  });
  unsubscribe();

  expect(calls).toEqual([{ cursor: 42 }, { unsubscribed: true }]);
  expect(events).toEqual([
    {
      id: 43,
      type: "turn.state_changed",
      created_at: "2026-06-27T00:00:00.000Z",
      payload: {},
    },
  ]);
});

test("preload live-event teardown releases the reader lock on EOF, error, and abort", () => {
  const preload = readRepoFile("packages/butler-app/client/electron/preload.cjs");
  expect(preload).toContain("const activeReader = reader;");
  expect(preload).toContain("activeReader?.releaseLock();");
  expect(preload).toContain("if (!closed) {");
  expect(preload).toContain("Live event stream ended before it was cancelled.");
  expect(preload).toContain('error?.name !== "AbortError"');
  expect(preload).toContain("abortController.abort();");
});

test("Electron preload CJS loads with the shared cache-budget artifact", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const Module = require("node:module");
    const load = Module._load;
    Module._load = (request, parent, isMain) => request === "electron"
      ? {
          contextBridge: { exposeInMainWorld(name) {
            if (name !== "butlerApp") process.exitCode = 2;
          } },
          ipcRenderer: {
            invoke: async () => null,
            on() {},
            removeListener() {},
          },
        }
      : load(request, parent, isMain);
    require("./packages/butler-app/client/electron/preload.cjs");
  `], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
});

test("sandbox cache budget uses main-process arguments and fails closed when invalid", () => {
  const main = readRepoFile("packages/butler-app/client/electron/main.mjs");
  const preload = readRepoFile("packages/butler-app/client/electron/preload.cjs");
  const budget = normalizeCacheBudget({
    schema: "butler.app.cache-budget.v1",
    maxEntries: 8,
    maxBytes: 4 * 1024 * 1024,
    maxSnapshotBytes: 512 * 1024,
    maxMessages: 200,
    maxComposerDraftBytes: 64 * 1024,
    maxComposerDraftEntries: 8,
    maxComposerDraftAggregateBytes: 512 * 1024,
  });
  const argument = cacheBudgetAdditionalArgument(budget);

  expect(cacheBudgetFromArguments(["preload", argument])).toEqual(budget);
  expect(cacheBudgetFromArguments(["preload", "--butler-cache-budget=broken"])).toEqual(
    DISABLED_CACHE_BUDGET,
  );
  expect(normalizeCacheBudget({ schema: "butler.app.cache-budget.v1", maxEntries: 999_999 }))
    .toEqual(DISABLED_CACHE_BUDGET);
  expect(main).toContain('resolve(__dirname, "../shared/cache-budget.json")');
  expect(main).toContain("cacheBudgetAdditionalArgument");
  expect(main).toContain("additionalArguments: [appCacheBudgetArgument]");
  expect(preload).toContain("cacheBudgetFromArguments(process.argv)");
  expect(preload).not.toContain('require("../shared/cache-budget.json")');
});

test("getSessionView preload bridge returns a serializable resync envelope", () => {
  const preloadPath = resolve(import.meta.dir, "../../packages/butler-app/client/electron/preload.cjs");
  const result = spawnSync("node", ["-e", `
    const Module = require("node:module");
    const load = Module._load;
    let bridge;
    Module._load = (request, parent, isMain) => request === "electron"
      ? {
          contextBridge: { exposeInMainWorld(name, value) {
            if (name === "butlerApp") bridge = value;
          } },
          ipcRenderer: {
            invoke: async (channel) => {
              if (channel === "butler:get-server-url") return null;
              if (channel === "butler:get-local-auth-headers") return {};
              return null;
            },
            on() {},
            removeListener() {},
          },
        }
      : load(request, parent, isMain);
    global.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({
        protocol_version: "butler.app.v1",
        error: {
          code: "session_cursor_resync_required",
          message: "Session view cursor is invalid or expired; reload the session.",
        },
      }),
    });
    require(${JSON.stringify(preloadPath)});
    (async () => {
      const value = await bridge.getSessionView({ sessionId: "session-a", cursorToken: "expired" });
      process.stdout.write(JSON.stringify(value));
    })();
  `], { cwd: process.cwd(), encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    ok: false,
    error: {
      schema: "butler.app.bridge-error.v1",
      code: "session_cursor_resync_required",
      status: 409,
      resync: {
        required: true,
        resource: "session-view",
        reason: "cursor-expired",
      },
    },
  });
});

test("renderer API resynchronizes an expired opaque session-view cursor once", async () => {
  const calls: unknown[] = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://butler.local" },
      butlerApp: {
        getSessionView: async (input: unknown) => {
          calls.push(input);
          if (calls.length === 1) {
            return {
              ok: false,
              error: {
                schema: "butler.app.bridge-error.v1",
                code: "session_cursor_resync_required",
                status: 409,
                resync: {
                  required: true,
                  resource: "session-view",
                  reason: "cursor-expired",
                },
              },
            };
          }
          return {
            ok: true,
            data: {
              protocol_version: "butler.app.v1",
              session_id: "session-a",
              status: "idle",
              messages: [],
              message_window: {
                next_cursor: 0,
                previous_cursor: null,
                complete: true,
              },
              active_turn: null,
              latest_turn: null,
              branch: null,
              context: null,
              artifacts: [],
              automations: [],
              skills_used: [],
              workers: [],
              work_streams: [],
              updated_at: "2026-08-15T00:00:00.000Z",
            },
          };
        },
      },
    },
    writable: true,
  });
  await expect(api("/session-view?session_id=session-a&cursor_token=expired"))
    .resolves.toMatchObject({ session_id: "session-a" });
  expect(calls).toEqual([
    {
      sessionId: "session-a",
      cursorToken: "expired",
      beforeCursorToken: undefined,
      limit: undefined,
    },
    {
      sessionId: "session-a",
      cursorToken: undefined,
      beforeCursorToken: undefined,
      limit: undefined,
    },
  ]);
});

test("App session summaries delegate bounded Git inspection outside React", () => {
  const sessionContextHost = readRepoFile(
    "packages/butler-agent/src/gateways/app/application/kernel-host/session-context-host.ts",
  );
  const resolver = readRepoFile(
    "packages/butler-agent/src/gateways/app/domain/sessions/git-workspace-status.ts",
  );
  const notice = readRepoFile(
    "packages/butler-app/client/ui/src/components/conversation/GitDependencyNotice.tsx",
  );

  expect(sessionContextHost).toContain("resolveSessionWorkspaceAuthority({");
  expect(sessionContextHost).toContain(
    "expectedRepositoryAnchorPath: authority.marker.repositoryAnchorPath",
  );
  expect(sessionContextHost).toContain("resolveGitWorkspaceSummary(");
  expect(resolver).toContain("spawnSync");
  expect(resolver).toContain("GIT_INSPECTION_TIMEOUT_MS");
  expect(resolver).toContain("windowsHide: true");
  expect(notice).toContain('safe_error_code === "git_not_installed"');
  expect(notice).not.toContain("spawnSync");
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
  expect(main).toContain("createAppAgentNativeServiceBridge");
  expect(main).toContain("createAppAgentServiceAdapter");
  expect(main).toContain("shouldUseAppAgentNativeServiceBridge()");
  expect(main).toContain("BUTLER_APP_FORCE_NATIVE_SERVICE_BRIDGE");
  expect(main).toContain("assertNativeServiceTestBridgeEnvironment");
  expect(main).toContain("Native service bridge test mode requires a non-production service label");
  expect(main).toContain("Native service bridge test mode requires a non-production app server port");
  expect(main).toContain("serviceLabel: appAgentServiceLabel()");
  expect(main).toContain("systemdUnit: appAgentSystemdUnit()");
  expect(main).toContain("ensureRuntimePointer: ensureAppManagedAgentRuntimePointer");
  expect(main).toContain("adapter: appAgentServiceAdapter");
  expect(main).toContain("healthCheck: healthOk");
  expect(main).toContain("readinessCheck: gatewayReady");
  const gatewayResolveIndex = ensureReady.indexOf(
    "gateway = readyGateway ?? resolveGateway();",
  );
  const managedHealthIndex = ensureReady.indexOf(
    "if ((await checkGatewayReadiness()).ready)",
    gatewayResolveIndex,
  );
  expect(gatewayResolveIndex).toBeGreaterThanOrEqual(0);
  expect(managedHealthIndex).toBeGreaterThan(gatewayResolveIndex);
  expect(ensureReady).toContain('recordError("gateway_unavailable"');
  expect(ensureReady).toContain("if (!gateway.commitActivation)");
  expect(ensureReady).toContain("updatePort(await findAvailablePort(getPort() + 1))");
  expect(ensureReady).toContain("const operation = ensureReadyOnce();");
  expect(ensureReady).toContain("startupPromise = operation;");
  expect(ensureReady).toContain("await start(gateway);");
  expect(main).toContain("function ensureAppManagedAgentRuntimePointer");
  expect(main).toContain("appManagedGateway.commitActivation?.()");
  const ensureServerStart = main.indexOf("async function ensureServer()");
  const diagnosticsStart = main.indexOf("function readFirstRunRuntimeDiagnostics", ensureServerStart);
  const ensureServer = main.slice(ensureServerStart, diagnosticsStart);
  const nativeGatewayReadyStart = main.indexOf("async function waitForNativeServiceGatewayReady");
  const nativeGatewayReadyEnd = main.indexOf("function sleep", nativeGatewayReadyStart);
  const nativeGatewayReady = main.slice(nativeGatewayReadyStart, nativeGatewayReadyEnd);
  expect(ensureServer).toContain("if (shouldUseAppAgentNativeServiceBridge())");
  expect(ensureServer).toContain("await waitForNativeServiceGatewayReady()");
  expect(ensureServer).toContain("await bundledAgentSupervisor.ensureReady()");
  expect(ensureServer.indexOf("waitForNativeServiceGatewayReady")).toBeLessThan(
    ensureServer.indexOf("await bundledAgentSupervisor.ensureReady()"),
  );
  expect(nativeGatewayReady).toContain("service_gateway_unhealthy");
  expect(nativeGatewayReady).toContain("service_gateway_not_ready");
  expect(nativeGatewayReady).toContain("throw error");
  expect(nativeGatewayReady).toContain("await sleep(delayMs)");
});

function readRepoFile(path: string): string {
  return readFileSync(path, "utf8");
}
