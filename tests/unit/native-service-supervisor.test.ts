import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  appManagedNativeServiceSpecs,
  appManagedRuntimePointerPath,
  defaultNativeServiceSpecs,
  listServices,
  projectFolderTokenSecretPath,
  resolveAppManagedNativeSupervisorPaths,
  serviceStatePath,
  startService,
  startServices,
  stopServiceBounded,
  stopServices,
} from "../../packages/butler-agent/src/operations/service/native-service-supervisor.ts";
import { APP_BACKGROUND_SERVICE_RUNTIME_FIELDS } from "../../packages/butler-app/scripts/background-service-contract.ts";
import {
  readAppGatewayPid,
  writeAppGatewayPid,
  writeGatewaySettings,
} from "../../packages/butler-agent/src/operations/gateway/registry.ts";

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-native-services-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeValidAppLocalAuth(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      schema: "butler.app-local-agent-auth.v1",
      token: "abcdefghijklmnopqrstuvwxyz123456",
    }, null, 2)}\n`,
  );
}

test("native service manifest defines Butler-owned default services", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  try {
    const specs = defaultNativeServiceSpecs({ butlerHome, butlerData });
    expect(specs.map((spec) => spec.id)).toEqual([
      "embed-server",
      "butler-sync-consumer",
      "butler-scheduler",
      "butler-watchdog",
      "butler-main",
      "app-gateway",
    ]);
    expect(specs.find((spec) => spec.id === "butler-main")?.args[0]).toBe("/opt/butler/packages/butler-agent/scripts/start-butler.sh");
    const appGateway = specs.find((spec) => spec.id === "app-gateway");
    expect(appGateway?.args).toEqual([
      "run",
      "/opt/butler/packages/butler-agent/src/gateways/app/interface/cli/app-gateway-cli.ts",
      "--port=18765",
    ]);
    expect(appGateway?.env).toMatchObject({
      BUTLER_APP_SERVER_HOST: "127.0.0.1",
      BUTLER_APP_SERVER_PORT: "18765",
    });
    const appGatewaySecret = appGateway?.env?.BUTLER_PROJECT_FOLDER_TOKEN_SECRET;
    expect(appGatewaySecret).toBeTruthy();
    if (!appGatewaySecret) throw new Error("missing app gateway folder token secret");
    expect(readFileSync(projectFolderTokenSecretPath(butlerData), "utf8").trim()).toBe(
      appGatewaySecret,
    );
    expect(specs.every((spec) => spec.stdoutFile.startsWith(`${butlerData}/logs/`))).toBe(true);
    expect(specs.every((spec) => spec.env?.BUTLER_DATA === butlerData)).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("native service manifest follows app gateway enabled settings", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  try {
    const dbPath = join(butlerData, "private", "app.sqlite");
    writeGatewaySettings(butlerData, "app", {
      enabled: true,
      config: {
        host: "127.0.0.1",
        port: 19001,
        dbPath,
      },
    });

    const enabledSpecs = defaultNativeServiceSpecs({ butlerHome, butlerData });
    const appGateway = enabledSpecs.find((spec) => spec.id === "app-gateway");
    expect(appGateway).toBeDefined();
    expect(appGateway?.args).toContain("--port=19001");
    expect(appGateway?.env).toMatchObject({
      BUTLER_APP_SERVER_HOST: "127.0.0.1",
      BUTLER_APP_SERVER_PORT: "19001",
      BUTLER_APP_SERVER_DB: dbPath,
    });

    writeGatewaySettings(butlerData, "app", {
      enabled: false,
      config: {
        host: "127.0.0.1",
        port: 19001,
        dbPath,
      },
    });

    const disabledSpecs = defaultNativeServiceSpecs({ butlerHome, butlerData });
    expect(disabledSpecs.map((spec) => spec.id)).not.toContain("app-gateway");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("App-managed native service manifest resolves from active runtime pointer", () => {
  const butlerData = tempRoot();
  try {
    const runtimeHomeLabel = join("app", "runtime", "agent", "versions", "9.9.9");
    const runtimeHome = join(butlerData, runtimeHomeLabel);
    const pointerPath = appManagedRuntimePointerPath(butlerData);
    const localAuthFile = join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
    mkdirSync(join(runtimeHome, "packages", "butler-agent", "resources", "runtime", "bin"), {
      recursive: true,
    });
    mkdirSync(join(runtimeHome, "bin"), { recursive: true });
    mkdirSync(join(butlerData, "app", "runtime", "auth"), { recursive: true });
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(join(runtimeHome, "bin", "butler.js"), "");
    writeFileSync(
      join(runtimeHome, "packages", "butler-agent", "resources", "runtime", "bin", "bun"),
      "",
    );
    writeValidAppLocalAuth(localAuthFile);
    writeFileSync(
      pointerPath,
      `${JSON.stringify({
        schema: "butler.app-managed-agent-runtime-pointer.v1",
        product: "butler-app",
        gateway_profile: "electron",
        version: "9.9.9",
        runtime_home: runtimeHomeLabel,
      }, null, 2)}\n`,
    );

    const specs = appManagedNativeServiceSpecs({
      butlerData,
      localAuthFile,
    }, {
      appVersion: "2.3.4",
      gatewayPort: 19123,
      createProjectFolderTokenSecret: false,
    });
    const serviceBun = join(
      runtimeHome,
      "packages",
      "butler-agent",
      "resources",
      "runtime",
      "bin",
      "bun",
    );

    expect(specs.map((spec) => spec.id)).toEqual([
      "embed-server",
      "butler-sync-consumer",
      "butler-scheduler",
      "butler-watchdog",
      "butler-main",
      "app-gateway",
    ]);
    expect(specs.every((spec) => spec.cwd === runtimeHome)).toBe(true);
    expect(specs.every((spec) => spec.env?.BUTLER_HOME === runtimeHome)).toBe(true);
    expect(specs.every((spec) => spec.env?.BUTLER_DATA === butlerData)).toBe(true);
    expect(specs.every((spec) => spec.env?.BUTLER_BUN === serviceBun)).toBe(true);
    expect(specs.find((spec) => spec.id === "embed-server")?.command).toBe("bash");
    expect(specs.find((spec) => spec.id === "embed-server")?.args[0]?.endsWith("start-embed-server.sh"))
      .toBeTrue();
    expect(specs.find((spec) => spec.id === "butler-main")?.command).toBe("bash");
    expect(specs.find((spec) => spec.id === "butler-main")?.args[0]?.endsWith("start-butler.sh"))
      .toBeTrue();
    expect(specs.every((spec) => spec.env?.BUTLER_APP_MANAGED_RUNTIME_POINTER === pointerPath))
      .toBe(true);
    expect(specs.every((spec) => spec.env?.BUTLER_APP_MANAGED_RUNTIME_HOME === runtimeHome))
      .toBe(true);
    expect(specs.every((spec) =>
      spec.runtime?.managedBy === "butler-app" &&
      spec.runtime.runtimePointerPath === pointerPath &&
      spec.runtime.runtimeHome === runtimeHome &&
      spec.runtime.version === "9.9.9",
    )).toBe(true);

    const appGateway = specs.find((spec) => spec.id === "app-gateway");
    expect(appGateway?.command).toBe(serviceBun);
    expect(appGateway?.args).toEqual([
      "run",
      join(runtimeHome, "packages", "butler-agent", "src", "gateways", "app", "interface", "cli", "app-gateway-cli.ts"),
      "--port=19123",
    ]);
    expect(appGateway?.env).toMatchObject({
      BUTLER_APP_SERVER_HOST: "127.0.0.1",
      BUTLER_APP_SERVER_PORT: "19123",
      BUTLER_APP_GATEWAY_PID_FILE: "off",
      BUTLER_APP_LOCAL_AUTH_REQUIRED: "1",
      BUTLER_APP_LOCAL_AUTH_FILE: localAuthFile,
      BUTLER_APP_VERSION: "2.3.4",
    });
    expect(APP_BACKGROUND_SERVICE_RUNTIME_FIELDS.every((field) => field in (appGateway?.env ?? {})))
      .toBe(true);
    expect(appGateway?.env?.BUTLER_PROJECT_FOLDER_TOKEN_SECRET).toBeUndefined();

    const projected = startService(butlerData, appGateway!, {
      now: () => new Date("2026-06-13T00:00:00.000Z"),
      spawnDetached: () => ({ pid: 41_123 }),
      isPidRunning: () => false,
    });
    expect(projected.runtime).toMatchObject({
      managedBy: "butler-app",
      runtimePointerPath: pointerPath,
      runtimeHome,
      version: "9.9.9",
    });
    const state = JSON.parse(readFileSync(serviceStatePath(butlerData, "app-gateway"), "utf8"));
    expect(state.runtime).toMatchObject({
      managedBy: "butler-app",
      runtimePointerPath: pointerPath,
      runtimeHome,
      version: "9.9.9",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("Windows App-managed native service manifest uses bun.exe and direct TypeScript entrypoints", () => {
  const butlerData = tempRoot();
  try {
    const runtimeHomeLabel = join("app", "runtime", "agent", "versions", "9.9.9");
    const runtimeHome = join(butlerData, runtimeHomeLabel);
    const pointerPath = appManagedRuntimePointerPath(butlerData);
    const localAuthFile = join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
    mkdirSync(join(runtimeHome, "packages", "butler-agent", "resources", "runtime", "bin"), {
      recursive: true,
    });
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeValidAppLocalAuth(localAuthFile);
    writeFileSync(pointerPath, `${JSON.stringify({
      schema: "butler.app-managed-agent-runtime-pointer.v1",
      product: "butler-app",
      gateway_profile: "electron",
      version: "9.9.9",
      runtime_home: runtimeHomeLabel,
    })}\n`);

    const specs = appManagedNativeServiceSpecs({ butlerData, localAuthFile }, {
      platform: "win32",
      createProjectFolderTokenSecret: false,
    });
    const bun = join(
      runtimeHome,
      "packages",
      "butler-agent",
      "resources",
      "runtime",
      "bin",
      "bun.exe",
    );
    expect(specs.every((spec) => spec.command === bun)).toBeTrue();
    expect(specs.find((spec) => spec.id === "embed-server")?.args).toEqual([
      "run",
      join(runtimeHome, "packages", "butler-agent", "src", "agent", "cognition", "memory", "scripts", "embed-server.ts"),
    ]);
    expect(specs.find((spec) => spec.id === "butler-main")?.args).toEqual([
      "run",
      join(runtimeHome, "packages", "butler-agent", "scripts", "native-butler-main.ts"),
    ]);
    expect(specs.flatMap((spec) => [spec.command, ...spec.args]).some((part) => part === "bash" || part.endsWith(".sh")))
      .toBeFalse();
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("App-managed native service manifest fails closed on invalid pointer", () => {
  const butlerData = tempRoot();
  try {
    const pointerPath = appManagedRuntimePointerPath(butlerData);
    const localAuthFile = join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeValidAppLocalAuth(localAuthFile);
    writeFileSync(
      pointerPath,
      `${JSON.stringify({
        schema: "butler.app-managed-agent-runtime-pointer.v1",
        product: "butler-app",
        gateway_profile: "terminal",
        runtime_home: "app/runtime/agent/versions/9.9.9",
      }, null, 2)}\n`,
    );

    expect(() =>
      resolveAppManagedNativeSupervisorPaths({
        butlerData,
        localAuthFile,
      }),
    ).toThrow("invalid App-managed Agent runtime pointer");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("App-managed native service manifest fails closed on invalid local auth", () => {
  const butlerData = tempRoot();
  try {
    const runtimeHomeLabel = join("app", "runtime", "agent", "versions", "9.9.9");
    const pointerPath = appManagedRuntimePointerPath(butlerData);
    const localAuthFile = join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    mkdirSync(join(butlerData, "app", "runtime", "auth"), { recursive: true });
    writeFileSync(
      pointerPath,
      `${JSON.stringify({
        schema: "butler.app-managed-agent-runtime-pointer.v1",
        product: "butler-app",
        gateway_profile: "electron",
        runtime_home: runtimeHomeLabel,
      }, null, 2)}\n`,
    );
    writeFileSync(localAuthFile, "{}\n");

    expect(() =>
      appManagedNativeServiceSpecs({
        butlerData,
        localAuthFile,
      }),
    ).toThrow("invalid App-managed local auth file");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("startServices writes durable native state and skips already running pids", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  let nextPid = 9000;
  try {
    const started = startServices({ butlerHome, butlerData }, {
      now: () => new Date("2026-04-27T00:00:00.000Z"),
      isPidRunning: (pid) => pid >= 9000,
      spawnDetached: () => ({ pid: nextPid++ }),
    });
    expect(started).toHaveLength(6);
    expect(started[0]).toMatchObject({
      serviceId: "embed-server",
      pid: 9000,
      status: "online",
      supervisor: "native-supervisor",
    });
    const state = JSON.parse(readFileSync(serviceStatePath(butlerData, "butler-main"), "utf8"));
    expect(state).toMatchObject({
      supervisor: "native-supervisor",
      serviceId: "butler-main",
      startedAt: "2026-04-27T00:00:00.000Z",
    });

    const skipped = startServices({ butlerHome, butlerData }, {
      isPidRunning: (pid) => pid >= 9000,
      spawnDetached: () => {
        throw new Error("should not respawn online service");
      },
    });
    expect(skipped.map((service) => service.pid)).toEqual(started.map((service) => service.pid));
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("listServices marks stale state without shelling out to an external process manager", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  try {
    startService(butlerData, defaultNativeServiceSpecs({ butlerHome, butlerData })[0]!, {
      spawnDetached: () => ({ pid: 12345 }),
      isPidRunning: () => false,
    });
    const services = listServices({ butlerHome, butlerData }, {
      isPidRunning: () => false,
    });
    expect(services.find((service) => service.serviceId === "embed-server")).toMatchObject({
      status: "stale",
      pid: 12345,
    });
    expect(services.find((service) => service.serviceId === "butler-main")).toMatchObject({
      status: "offline",
      pid: null,
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("listServices is read-only for app gateway token secrets", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  try {
    const services = listServices({ butlerHome, butlerData }, {
      isPidRunning: () => false,
    });

    expect(services.find((service) => service.serviceId === "app-gateway")).toMatchObject({
      status: "offline",
      pid: null,
    });
    expect(existsSync(projectFolderTokenSecretPath(butlerData))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("listServices projects legacy process-owned app gateway pid", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  try {
    writeAppGatewayPid(butlerData, 34_001);

    const online = listServices({ butlerHome, butlerData }, {
      isPidRunning: (pid) => pid === 34_001,
    });
    expect(online.find((service) => service.serviceId === "app-gateway")).toMatchObject({
      status: "online",
      pid: 34_001,
      mode: "detached",
    });

    const stale = listServices({ butlerHome, butlerData }, {
      isPidRunning: () => false,
    });
    expect(stale.find((service) => service.serviceId === "app-gateway")).toMatchObject({
      status: "stale",
      pid: 34_001,
      mode: "detached",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("stopServices terminates services in reverse order", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const killed: string[] = [];
  let nextPid = 10_000;
  try {
    startServices({ butlerHome, butlerData }, {
      spawnDetached: () => ({ pid: nextPid++ }),
      isPidRunning: () => false,
    });
    const states = listServices({ butlerHome, butlerData }, { isPidRunning: () => true });
    const pidToService = new Map(states.map((service) => [service.pid, service.serviceId]));
    const stopped = stopServices({ butlerHome, butlerData }, {
      isPidRunning: () => true,
      killPid: (pid) => {
        const target = pidToService.get(Math.abs(pid)) ?? `pid:${pid}`;
        killed.push(pid < 0 ? `group:${target}` : target);
      },
    });
    expect(stopped.map((service) => service.serviceId)).toEqual([
      "app-gateway",
      "butler-main",
      "butler-watchdog",
      "butler-scheduler",
      "butler-sync-consumer",
      "embed-server",
    ]);
    expect(killed).toEqual(stopped.map((service) => `group:${service.serviceId}`));
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("stopServiceBounded waits for process exit and app gateway port release", async () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const killed: Array<{ pid: number; signal: string }> = [];
  let aliveChecks = 0;
  let portChecks = 0;
  try {
    const appGateway = defaultNativeServiceSpecs({ butlerHome, butlerData }).find(
      (spec) => spec.id === "app-gateway",
    );
    if (!appGateway) throw new Error("missing app-gateway spec");
    startService(butlerData, appGateway, {
      spawnDetached: () => ({ pid: 41_000 }),
      isPidRunning: () => false,
    });

    const stopped = await stopServiceBounded(butlerData, appGateway, {
      isPidRunning: (pid) => {
        if (pid !== 41_000) return false;
        aliveChecks += 1;
        return aliveChecks <= 2;
      },
      isPortAvailable: (port) => {
        expect(port).toBe(18765);
        portChecks += 1;
        return portChecks >= 3;
      },
      killPid: (pid, signal) => killed.push({ pid, signal }),
      sleepMs: async () => {},
      waitIntervalMs: 1,
      terminateTimeoutMs: 10,
      killTimeoutMs: 5,
    });

    expect(stopped).toMatchObject({
      serviceId: "app-gateway",
      status: "offline",
      pid: 41_000,
    });
    expect(killed).toEqual([{ pid: -41_000, signal: "SIGTERM" }]);
    expect(portChecks).toBe(3);
    expect(existsSync(serviceStatePath(butlerData, "app-gateway"))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("stopServiceBounded escalates and preserves state when process group survives", async () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const killed: Array<{ pid: number; signal: string }> = [];
  try {
    const main = defaultNativeServiceSpecs({ butlerHome, butlerData }).find(
      (spec) => spec.id === "butler-main",
    );
    if (!main) throw new Error("missing butler-main spec");
    startService(butlerData, main, {
      spawnDetached: () => ({ pid: 42_000 }),
      isPidRunning: () => false,
    });

    await expect(
      stopServiceBounded(butlerData, main, {
        isPidRunning: (pid) => pid === 42_000,
        killPid: (pid, signal) => killed.push({ pid, signal }),
        sleepMs: async () => {},
        waitIntervalMs: 1,
        terminateTimeoutMs: 1,
        killTimeoutMs: 1,
      }),
    ).rejects.toThrow("failed to stop butler-main: process group still running");

    expect(killed).toEqual([
      { pid: -42_000, signal: "SIGTERM" },
      { pid: -42_000, signal: "SIGKILL" },
    ]);
    expect(existsSync(serviceStatePath(butlerData, "butler-main"))).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("stopServiceBounded waits on process group even after leader exits", async () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const killed: Array<{ pid: number; signal: string }> = [];
  let groupChecks = 0;
  try {
    const main = defaultNativeServiceSpecs({ butlerHome, butlerData }).find(
      (spec) => spec.id === "butler-main",
    );
    if (!main) throw new Error("missing butler-main spec");
    startService(butlerData, main, {
      spawnDetached: () => ({ pid: 43_000 }),
      isPidRunning: () => false,
    });

    const stopped = await stopServiceBounded(butlerData, main, {
      isPidRunning: () => false,
      isProcessGroupRunning: (processGroupId) => {
        expect(processGroupId).toBe(43_000);
        groupChecks += 1;
        return groupChecks <= 2;
      },
      killPid: (pid, signal) => killed.push({ pid, signal }),
      sleepMs: async () => {},
      waitIntervalMs: 1,
      terminateTimeoutMs: 10,
      killTimeoutMs: 5,
    });

    expect(stopped.status).toBe("offline");
    expect(groupChecks).toBe(3);
    expect(killed).toEqual([{ pid: -43_000, signal: "SIGTERM" }]);
    expect(existsSync(serviceStatePath(butlerData, "butler-main"))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("stopServices terminates legacy process-owned app gateway pid", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const killed: Array<{ pid: number; signal: string }> = [];
  try {
    writeAppGatewayPid(butlerData, 23_001);

    const stopped = stopServices({ butlerHome, butlerData }, {
      isPidRunning: (pid) => pid === 23_001,
      killPid: (pid, signal) => killed.push({ pid, signal }),
    });

    expect(stopped.map((service) => service.serviceId)).toContain("app-gateway");
    expect(killed).toEqual([{ pid: -23_001, signal: "SIGTERM" }]);
    expect(readAppGatewayPid(butlerData)).toBeNull();
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
