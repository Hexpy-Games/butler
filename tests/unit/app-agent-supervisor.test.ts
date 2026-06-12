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
    rendererOrigin: "http://127.0.0.1:18888",
    explicitUiUrl: null,
    projectFolderTokenSecret: "folder-secret",
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
    BUTLER_APP_LOCAL_AUTH_REQUIRED: "1",
    BUTLER_APP_LOCAL_AUTH_FILE: "/data/app/runtime/auth/local-agent-auth.json",
    BUTLER_PROJECT_FOLDER_TOKEN_SECRET: "folder-secret",
  });
  expect(JSON.stringify(env)).not.toContain("super-secret-local-auth-token");
});

test("bundled Agent supervisor starts, health-checks, restarts, and stops", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-supervisor-"));
  try {
    const spawned: FakeChildProcess[] = [];
    const killed: string[] = [];
    let healthChecks = 0;
    let committed = 0;
    let port = 18765;
    const healthAuthTokens: string[] = [];
    const supervisor = createBundledAgentSupervisor({
      butlerData: join(tempDir, "data"),
      resolveGateway: () => ({
        command: "/runtime/bun",
        args: ["/runtime/bin/butler.js", "gateway", "app"],
        cwd: "/runtime",
        env: { BUTLER_HOME: "/runtime" },
        appManaged: true,
        bundledAgentVersion: "1.2.3",
        commitActivation: () => {
          committed += 1;
        },
      }),
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
    });

    await supervisor.ensureReady();

    expect(spawned).toHaveLength(1);
    expect(committed).toBe(1);
    expect(healthAuthTokens.every((token) => token.length >= 32)).toBe(true);
    expect(healthAuthTokens).not.toHaveLength(0);
    expect(spawned[0]?.spawn).toMatchObject({
      command: "/runtime/bun",
      args: ["/runtime/bin/butler.js", "gateway", "app"],
      options: {
        cwd: "/runtime",
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

    await supervisor.stop();
    expect(killed.filter((signal) => signal === "SIGTERM")).toHaveLength(2);
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
    return true;
  }
}

function fixedNow(): Date {
  return new Date("2026-06-12T00:00:00.000Z");
}
