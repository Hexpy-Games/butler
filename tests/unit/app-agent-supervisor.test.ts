import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  APP_LOCAL_AUTH_SCHEMA,
  appLocalAuthPath,
  buildBundledAgentSupervisorEnv,
  createBundledAgentSupervisor,
  prepareAppLocalAuth,
} from "../../packages/butler-app/client/electron/app-agent-supervisor.mjs";

test("App local auth is generated under App runtime state and reused", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-auth-"));
  try {
    const butlerData = join(tempDir, "data");
    const first = prepareAppLocalAuth({
      butlerData,
      generateToken: () => "a".repeat(43),
      now: fixedNow,
    });
    expect(first).toMatchObject({
      filePath: appLocalAuthPath(butlerData),
      created: true,
      token: "a".repeat(43),
    });
    const stored = JSON.parse(readFileSync(first.filePath, "utf8"));
    expect(stored).toMatchObject({
      schema: APP_LOCAL_AUTH_SCHEMA,
      product: "butler-app",
      purpose: "bundled-agent-local-auth",
      token: "a".repeat(43),
      created_at: "2026-06-12T00:00:00.000Z",
      raw_text_included: false,
    });
    expect(statSync(first.filePath).mode & 0o777).toBe(0o600);

    const second = prepareAppLocalAuth({
      butlerData,
      generateToken: () => "b".repeat(43),
      now: fixedNow,
    });
    expect(second).toMatchObject({
      created: false,
      token: "a".repeat(43),
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor env binds bundled Agent to localhost and keeps auth token out of env", () => {
  const env = buildBundledAgentSupervisorEnv({
    baseEnv: { PATH: "/bin", BUTLER_HOME: "/standalone" },
    gatewayEnv: { BUTLER_HOME: "/app-runtime", BUTLER_DATA: "/data" },
    port: 18888,
    serverUrl: "http://127.0.0.1:18888/",
    appVersion: "1.2.3",
    rendererOrigin: "http://127.0.0.1:18888",
    explicitUiUrl: null,
    projectFolderTokenSecret: "folder-secret",
    localPagePreviewUrl: "http://127.0.0.1:29991/v1/preview",
    localAuth: {
      filePath: "/data/app/runtime/auth/local-agent-auth.json",
      token: "super-secret-local-auth-token",
    },
  });

  expect(env).toMatchObject({
    BUTLER_HOME: "/app-runtime",
    BUTLER_DATA: "/data",
    BUTLER_APP_SERVER_HOST: "127.0.0.1",
    BUTLER_APP_SERVER_PORT: "18888",
    BUTLER_APP_SERVER_URL: "http://127.0.0.1:18888/",
    BUTLER_APP_GATEWAY_PID_FILE: "off",
    BUTLER_APP_BUNDLED_SUPERVISOR: "1",
    BUTLER_APP_VERSION: "1.2.3",
    BUTLER_APP_LOCAL_AUTH_REQUIRED: "1",
    BUTLER_APP_LOCAL_AUTH_FILE: "/data/app/runtime/auth/local-agent-auth.json",
    BUTLER_PROJECT_FOLDER_TOKEN_SECRET: "folder-secret",
    BUTLER_APP_LOCAL_PAGE_PREVIEW_URL:
      "http://127.0.0.1:29991/v1/preview",
  });
  expect(JSON.stringify(env)).not.toContain("super-secret-local-auth-token");
});

test("supervisor env carries the injected Windows manifest source", () => {
  const env = buildBundledAgentSupervisorEnv({
    baseEnv: {
      BUTLER_APP_UPDATE_MANIFEST:
        "https://github.com/Hexpy-Games/butler/releases/latest/download/windows-app-update-manifest.json",
    },
    gatewayEnv: {},
    port: 18888,
    serverUrl: "http://127.0.0.1:18888/",
    appVersion: "1.2.3",
    rendererOrigin: "http://127.0.0.1:18888",
    projectFolderTokenSecret: null,
    localPagePreviewUrl: null,
    localAuth: {
      filePath: "/data/app/runtime/auth/local-agent-auth.json",
      token: "super-secret-local-auth-token",
    },
  });
  expect(env.BUTLER_APP_UPDATE_MANIFEST).toBe(
    "https://github.com/Hexpy-Games/butler/releases/latest/download/windows-app-update-manifest.json",
  );
});

test("bundled Agent supervisor starts, health-checks, restarts, and stops", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-"));
  try {
    const spawned: FakeChildProcess[] = [];
    const killed: string[] = [];
    let healthChecks = 0;
    let committed = 0;
    let resolved = 0;
    let gatewayStarts = 0;
    let port = 18765;
    let readinessGateway: Record<string, unknown> | null = null;
    const healthAuthTokens: string[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => {
        resolved += 1;
        return {
          command: "/runtime/bun",
          args: ["/runtime/bin/butler.js", "gateway", "app"],
          cwd: "/runtime",
          env: { BUTLER_HOME: "/runtime" },
          appManaged: true,
          foregroundHost: true,
          bundledAgentVersion: "1.2.3",
          containmentKind: "windows_job_object",
          containmentVerified: true,
          ownerDeathGuaranteed: true,
          recordsProcessGroupId: false,
          commitActivation: () => {
            committed += 1;
          },
        };
      },
      spawnProcess: (command, args, options) => {
        const child = new FakeChildProcess(9000 + spawned.length, killed);
        child.spawn = { command, args, options };
        spawned.push(child);
        return child;
      },
      healthCheck: (localAuth) => {
        healthChecks += 1;
        if (localAuth?.token) healthAuthTokens.push(localAuth.token);
        return healthChecks >= 2;
      },
      readinessCheck: (_localAuth, activeGateway) => {
        readinessGateway = activeGateway ?? null;
        return true;
      },
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: (nextPort) => {
        port = nextPort;
      },
      getPort: () => port,
      getServerUrl: () => `http://127.0.0.1:${port}/`,
      getRendererOrigin: () => `http://127.0.0.1:${port}`,
      projectFolderTokenSecret: "folder-secret",
      sleepMs: async () => undefined,
      setKillTimer: (fn) => {
        fn();
        return "timer";
      },
      clearKillTimer: () => undefined,
      startupAttempts: 3,
      onGatewayStarting: () => {
        gatewayStarts += 1;
      },
    });

    await supervisor.ensureReady();

    expect(spawned).toHaveLength(1);
    expect(committed).toBe(1);
    expect(healthAuthTokens.every((token) => token.length >= 32)).toBe(true);
    expect(healthAuthTokens).not.toHaveLength(0);
    expect(readinessGateway).toMatchObject({
      appManaged: true,
      foregroundHost: true,
    });
    expect(spawned[0]?.spawn).toMatchObject({
      command: "/runtime/bun",
      args: ["/runtime/bin/butler.js", "gateway", "app"],
      options: {
        cwd: "/runtime",
        detached: false,
        shell: false,
        windowsHide: true,
        env: {
          BUTLER_APP_SERVER_HOST: "127.0.0.1",
          BUTLER_APP_SERVER_PORT: "18765",
          BUTLER_APP_BUNDLED_SUPERVISOR: "1",
          BUTLER_APP_LOCAL_AUTH_REQUIRED: "1",
          BUTLER_PROJECT_FOLDER_TOKEN_SECRET: "folder-secret",
        },
      },
    });
    const authFile = spawned[0]?.spawn?.options.env.BUTLER_APP_LOCAL_AUTH_FILE;
    expect(typeof authFile).toBe("string");
    expect(JSON.stringify(spawned[0]?.spawn?.options.env)).not.toContain(
      JSON.parse(readFileSync(String(authFile), "utf8")).token,
    );
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "running",
      pid: 9000,
      binding: { host: "127.0.0.1", port: 18765 },
      containment: {
        kind: "windows_job_object",
        verified: true,
        owner_death_guaranteed: true,
        raw_text_included: false,
      },
      lifecycle_patch: {
        agent_host_pid: 9000,
        process_group_id: null,
        containment_kind: "windows_job_object",
        containment_verified: true,
        owner_death_guaranteed: true,
      },
      bundled_agent: {
        source: "app-managed",
        version: "1.2.3",
        version_configured: true,
      },
      local_auth: {
        required: true,
        file_configured: true,
        token_configured: true,
        raw_text_included: false,
      },
      raw_text_included: false,
    });

    healthChecks = 0;
    const restarting = supervisor.restart();
    expect(killed).toContain("SIGTERM");
    expect(killed).toContain("SIGKILL");
    spawned[0]?.emit("exit", 0, null);
    await restarting;
    expect(spawned).toHaveLength(2);
    expect(resolved).toBe(1);
    expect(gatewayStarts).toBe(2);

    const stopped = await supervisor.stop({ wait: true });
    expect(stopped).toMatchObject({
      stopped: true,
      containment_released: true,
      raw_text_included: false,
    });
    expect(killed.filter((signal) => signal === "SIGTERM")).toHaveLength(2);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bundled Agent supervisor shares one startup operation across concurrent ensureReady calls", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-single-flight-"));
  try {
    const spawned: FakeChildProcess[] = [];
    let resolved = 0;
    let healthChecks = 0;
    let releasePreflight: (() => void) | undefined;
    const preflight = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => {
        resolved += 1;
        return {
          command: "/runtime/bun",
          args: ["gateway"],
          env: {},
          commitActivation: () => undefined,
        };
      },
      spawnProcess: () => {
        const child = new FakeChildProcess(9050 + spawned.length, []);
        spawned.push(child);
        return child;
      },
      healthCheck: async () => {
        healthChecks += 1;
        if (healthChecks === 1) {
          await preflight;
          return false;
        }
        return true;
      },
      readinessCheck: () => true,
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      sleepMs: async () => undefined,
      startupAttempts: 1,
    });

    const first = supervisor.ensureReady();
    await Promise.resolve();
    const second = supervisor.ensureReady();

    expect(resolved).toBe(1);
    expect(spawned).toHaveLength(0);
    releasePreflight?.();
    await Promise.all([first, second]);

    expect(resolved).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "running",
      pid: 9050,
    });
    await supervisor.stop({ wait: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bundled Agent supervisor does not overclaim unverified tree containment", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-supervisor-unverified-"));
  try {
    const child = new FakeChildProcess(9001, []);
    let invalidated = 0;
    let resolved = 0;
    const supervisor = createBundledAgentSupervisor({
      butlerData: root,
      resolveGateway: () => {
        resolved += 1;
        return {
          command: "bun",
          args: ["gateway"],
          env: {},
          commitActivation: () => {},
          invalidateRuntimeReceipt: () => { invalidated += 1; },
        };
      },
      spawnProcess: () => child,
      healthCheck: async () => true,
      isPortAvailable: async () => true,
      findAvailablePort: async () => 18766,
      updatePort: () => {},
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765",
      getRendererOrigin: () => "http://127.0.0.1:5173",
    });

    await supervisor.ensureReady();
    child.emit("exit", 1, null);
    expect(invalidated).toBe(1);
    await supervisor.ensureReady();
    expect(resolved).toBe(2);
    await expect(supervisor.stop({ wait: true })).resolves.toEqual({
      stopped: true,
      containment_released: false,
      raw_text_included: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor repair discards the cached gateway and resolves a fresh runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-supervisor-repair-"));
  try {
    let resolved = 0;
    let invalidated = 0;
    const children: FakeChildProcess[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: root,
      resolveGateway: () => {
        resolved += 1;
        return {
          command: `bun-${resolved}`,
          args: ["gateway"],
          env: {},
          commitActivation: () => {},
          invalidateRuntimeReceipt: () => { invalidated += 1; },
          containmentVerified: true,
        };
      },
      spawnProcess: () => {
        const child = new FakeChildProcess(9100 + children.length, []);
        children.push(child);
        return child;
      },
      healthCheck: async () => children.length > 0,
      isPortAvailable: async () => true,
      findAvailablePort: async (port) => port + 1,
      updatePort: () => {},
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765",
      getRendererOrigin: () => "http://127.0.0.1:5173",
      sleepMs: async () => undefined,
      startupAttempts: 1,
    });

    await supervisor.ensureReady();
    await supervisor.repair();

    expect(resolved).toBe(2);
    expect(invalidated).toBe(1);
    expect(children).toHaveLength(2);
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "running",
      pid: 9101,
    });
    await supervisor.stop({ wait: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("supervisor retries explicit app server readiness before failing", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-explicit-"));
  try {
    let healthChecks = 0;
    let readinessChecks = 0;
    let sleeps = 0;
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      explicitServerUrl: "http://127.0.0.1:19999/",
      resolveGateway: () => {
        throw new Error("explicit server should not resolve bundled gateway");
      },
      spawnProcess: () => {
        throw new Error("explicit server should not spawn bundled gateway");
      },
      healthCheck: () => {
        healthChecks += 1;
        return healthChecks >= 2;
      },
      readinessCheck: () => {
        readinessChecks += 1;
        return readinessChecks >= 2;
      },
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 19999,
      getServerUrl: () => "http://127.0.0.1:19999/",
      getRendererOrigin: () => "http://127.0.0.1:19999",
      sleepMs: async () => {
        sleeps += 1;
      },
      startupAttempts: 4,
    });

    await supervisor.ensureReady();

    expect(healthChecks).toBe(3);
    expect(readinessChecks).toBe(2);
    expect(sleeps).toBe(2);
    expect(supervisor.diagnostics().phase).toBe("running");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor relocates App-managed runtime when a healthy listener already exists", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-port-"));
  try {
    let port = 18765;
    let committed = 0;
    const spawned: FakeChildProcess[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["gateway"],
        commitActivation: () => {
          committed += 1;
        },
      }),
      spawnProcess: (_command, _args, _options) => {
        const child = new FakeChildProcess(9100 + spawned.length, []);
        spawned.push(child);
        return child;
      },
      healthCheck: () => spawned.length === 0 || spawned.length > 0,
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort + 10,
      updatePort: (nextPort) => {
        port = nextPort;
      },
      getPort: () => port,
      getServerUrl: () => `http://127.0.0.1:${port}/`,
      getRendererOrigin: () => `http://127.0.0.1:${port}`,
      sleepMs: async () => undefined,
      startupAttempts: 1,
    });

    await supervisor.ensureReady();

    expect(port).toBe(18776);
    expect(spawned).toHaveLength(1);
    expect(committed).toBe(1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor diagnostics redact startup error text and local auth token", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-redact-"));
  try {
    const localToken = "c".repeat(43);
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["gateway"],
      }),
      spawnProcess: () => {
        const child = new FakeChildProcess(9200, []);
        queueMicrotask(() =>
          child.emit("error", new Error(`secret ${localToken} /Users/private`)),
        );
        return child;
      },
      healthCheck: () => false,
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      sleepMs: async () => undefined,
      startupAttempts: 2,
      baseEnv: {},
    });

    await expect(supervisor.start()).rejects.toThrow("Failed to start");
    const serialized = JSON.stringify(supervisor.diagnostics());
    expect(serialized).toContain("spawn_failed");
    expect(serialized).not.toContain(localToken);
    expect(serialized).not.toContain("/Users/private");
    expect(serialized).not.toContain("secret");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor rolls back prepared App-managed runtime on health timeout", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-health-rollback-"));
  try {
    let rolledBack = 0;
    let committed = 0;
    const killed: string[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["/runtime/bin/butler.js", "gateway", "app"],
        cwd: "/runtime",
        env: { BUTLER_HOME: "/runtime" },
        appManaged: true,
        bundledAgentVersion: "2.0.0",
        commitActivation: () => {
          committed += 1;
        },
        rollbackActivation: (error: Error) => {
          rolledBack += 1;
          expect(error.message).toContain("Timed out waiting");
        },
      }),
      spawnProcess: () => new FakeChildProcess(9300, killed),
      healthCheck: () => false,
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      sleepMs: async () => undefined,
      startupAttempts: 1,
      baseEnv: {},
    });

    await expect(supervisor.ensureReady()).rejects.toThrow("Timed out waiting");
    expect(committed).toBe(0);
    expect(rolledBack).toBe(1);
    expect(killed).toContain("SIGTERM");
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "failed",
      last_error_code: "health_timeout",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor publishes the candidate runtime pointer before spawning its host", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-pointer-order-"));
  try {
    let pointerPublished = false;
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["/runtime/native-service-daemon.ts"],
        publishLaunchPointer: () => { pointerPublished = true; },
        commitActivation: () => undefined,
      }),
      spawnProcess: () => {
        expect(pointerPublished).toBe(true);
        return new FakeChildProcess(9350, []);
      },
      healthCheck: () => true,
      readinessCheck: () => true,
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      sleepMs: async () => undefined,
      startupAttempts: 1,
      baseEnv: {},
    });

    await supervisor.ensureReady();
    expect(pointerPublished).toBe(true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor startup deadline overrides a shorter attempt count", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-deadline-"));
  try {
    let now = 0;
    let healthChecks = 0;
    const killed: string[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["/runtime/bin/butler.js", "gateway", "app"],
      }),
      spawnProcess: () => new FakeChildProcess(9350, killed),
      healthCheck: () => {
        healthChecks += 1;
        return false;
      },
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      nowMs: () => now,
      sleepMs: async (ms) => {
        now += ms;
      },
      startupAttempts: 1,
      startupDelayMs: 100,
      startupTimeoutMs: 250,
      baseEnv: {},
    });

    await expect(supervisor.ensureReady()).rejects.toThrow("Timed out waiting");
    expect(healthChecks).toBe(4);
    expect(killed).toContain("SIGTERM");
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "failed",
      last_error_code: "health_timeout",
      last_error: {
        details: { attempts: 3 },
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor rolls back prepared App-managed runtime when readiness never passes", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-ready-rollback-"));
  try {
    let rolledBack = 0;
    let committed = 0;
    let readinessChecks = 0;
    const killed: string[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["/runtime/bin/butler.js", "gateway", "app"],
        cwd: "/runtime",
        env: { BUTLER_HOME: "/runtime" },
        appManaged: true,
        bundledAgentVersion: "2.0.0",
        commitActivation: () => {
          committed += 1;
        },
        rollbackActivation: (error: Error) => {
          rolledBack += 1;
          expect(error.message).toContain("Timed out waiting");
        },
      }),
      spawnProcess: () => new FakeChildProcess(9400, killed),
      healthCheck: () => true,
      readinessCheck: () => {
        readinessChecks += 1;
        return false;
      },
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      sleepMs: async () => undefined,
      startupAttempts: 2,
      baseEnv: {},
    });

    await expect(supervisor.ensureReady()).rejects.toThrow("Timed out waiting");
    expect(committed).toBe(0);
    expect(rolledBack).toBe(1);
    expect(readinessChecks).toBeGreaterThanOrEqual(2);
    expect(killed).toContain("SIGTERM");
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "failed",
      last_error_code: "readiness_timeout",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor stops candidate and rolls back when activation commit fails", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-commit-rollback-"));
  try {
    let rolledBack = 0;
    let committed = 0;
    const killed: string[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["/runtime/bin/butler.js", "gateway", "app"],
        cwd: "/runtime",
        env: { BUTLER_HOME: "/runtime" },
        appManaged: true,
        bundledAgentVersion: "2.0.0",
        commitActivation: () => {
          committed += 1;
          throw new Error("pointer write failed");
        },
        rollbackActivation: (error: Error) => {
          rolledBack += 1;
          expect(error.message).toContain("pointer write failed");
        },
      }),
      spawnProcess: () => new FakeChildProcess(9500, killed),
      healthCheck: () => true,
      readinessCheck: () => true,
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      sleepMs: async () => undefined,
      startupAttempts: 1,
      baseEnv: {},
    });

    await expect(supervisor.ensureReady()).rejects.toThrow("pointer write failed");
    expect(committed).toBe(1);
    expect(rolledBack).toBe(1);
    expect(killed).toContain("SIGTERM");
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "failed",
      last_error_code: "activation_commit_failed",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor probe timeout rolls back when health check hangs", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-health-hang-"));
  try {
    let rolledBack = 0;
    let committed = 0;
    const killed: string[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["/runtime/bin/butler.js", "gateway", "app"],
        cwd: "/runtime",
        env: { BUTLER_HOME: "/runtime" },
        appManaged: true,
        bundledAgentVersion: "2.0.0",
        commitActivation: () => {
          committed += 1;
        },
        rollbackActivation: (error: Error) => {
          rolledBack += 1;
          expect(error.message).toContain("Timed out waiting");
        },
      }),
      spawnProcess: () => new FakeChildProcess(9600, killed),
      healthCheck: () => new Promise(() => undefined),
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      sleepMs: async () => undefined,
      startupAttempts: 1,
      probeTimeoutMs: 1,
      baseEnv: {},
    });

    await expect(supervisor.ensureReady()).rejects.toThrow("Timed out waiting");
    expect(committed).toBe(0);
    expect(rolledBack).toBe(1);
    expect(killed).toContain("SIGTERM");
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "failed",
      last_error_code: "health_timeout",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor probe timeout rolls back when readiness check hangs", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-ready-hang-"));
  try {
    let rolledBack = 0;
    let committed = 0;
    const killed: string[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["/runtime/bin/butler.js", "gateway", "app"],
        cwd: "/runtime",
        env: { BUTLER_HOME: "/runtime" },
        appManaged: true,
        bundledAgentVersion: "2.0.0",
        commitActivation: () => {
          committed += 1;
        },
        rollbackActivation: (error: Error) => {
          rolledBack += 1;
          expect(error.message).toContain("Timed out waiting");
        },
      }),
      spawnProcess: () => new FakeChildProcess(9700, killed),
      healthCheck: () => true,
      readinessCheck: () => new Promise(() => undefined),
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      sleepMs: async () => undefined,
      startupAttempts: 1,
      probeTimeoutMs: 1,
      baseEnv: {},
    });

    await expect(supervisor.ensureReady()).rejects.toThrow("Timed out waiting");
    expect(committed).toBe(0);
    expect(rolledBack).toBe(1);
    expect(killed).toContain("SIGTERM");
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "failed",
      last_error_code: "readiness_timeout",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("supervisor records gateway resolution failures for setup diagnostics", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-gateway-"));
  try {
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => {
        const error = new Error("missing resource at /Users/example/.butler/private.env");
        (error as Error & { code?: string }).code = "resource_missing";
        throw error;
      },
      spawnProcess: () => {
        throw new Error("spawn should not run after gateway resolution failure");
      },
      healthCheck: () => false,
      isPortAvailable: () => true,
      findAvailablePort: (startPort) => startPort,
      updatePort: () => undefined,
      getPort: () => 18765,
      getServerUrl: () => "http://127.0.0.1:18765/",
      getRendererOrigin: () => "http://127.0.0.1:18765",
      sleepMs: async () => undefined,
      startupAttempts: 1,
      baseEnv: {},
    });

    await expect(supervisor.ensureReady()).rejects.toThrow("missing resource");
    expect(supervisor.diagnostics()).toMatchObject({
      phase: "failed",
      last_error_code: "gateway_unavailable",
      last_error: {
        code: "gateway_unavailable",
        details: {
          reason: "resolve_gateway_failed",
          error_code: "resource_missing",
        },
        raw_text_included: false,
      },
    });
    const serialized = JSON.stringify(supervisor.diagnostics());
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("private.env");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

class FakeChildProcess extends EventEmitter {
  spawn?: {
    command: string;
    args: string[];
    options: {
      cwd?: string;
      env: Record<string, string | undefined>;
      stdio: string;
    };
  };

  constructor(
    readonly pid: number,
    private readonly killed: string[],
  ) {
    super();
  }

  kill(signal: string) {
    this.killed.push(signal);
    queueMicrotask(() => {
      this.emit("exit", null, signal);
    });
    return true;
  }
}

function fixedNow(): Date {
  return new Date("2026-06-12T00:00:00.000Z");
}
