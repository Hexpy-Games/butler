import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ManagedServiceDaemon,
  defaultDaemonServiceSpecs,
} from "../../packages/butler-agent/src/operations/service/native-service-daemon.ts";
import {
  readAppGatewayPid,
  writeAppGatewayPid,
} from "../../packages/butler-agent/src/operations/gateway/registry.ts";
import {
  NATIVE_SUPERVISOR_ID,
  appManagedRuntimePointerPath,
  defaultNativeServiceSpecs,
  serviceStatePath,
  writeServiceState,
  type NativeServiceId,
  type NativeServiceSpec,
} from "../../packages/butler-agent/src/operations/service/native-service-supervisor.ts";

function tempRoot(): string {
  const dir = join(tmpdir(), `butler-service-daemon-${Date.now()}-${Math.random()}`);
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

function smallSpecs(butlerHome: string, butlerData: string): NativeServiceSpec[] {
  return defaultNativeServiceSpecs({ butlerHome, butlerData })
    .filter((spec) => ["embed-server", "butler-main"].includes(spec.id));
}

function appGatewaySpecs(butlerHome: string, butlerData: string): NativeServiceSpec[] {
  return defaultNativeServiceSpecs({ butlerHome, butlerData })
    .filter((spec) => spec.id === "app-gateway");
}

function watchdogSpecs(butlerHome: string, butlerData: string): NativeServiceSpec[] {
  return defaultNativeServiceSpecs({ butlerHome, butlerData })
    .filter((spec) => spec.id === "butler-watchdog");
}

test("foreground daemon starts manifest children and writes native state", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  let nextPid = 4100;
  const spawned: NativeServiceId[] = [];

  try {
    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs: smallSpecs(butlerHome, butlerData),
      parentPid: 4000,
      now: () => new Date("2026-04-28T00:00:00.000Z"),
      spawnChild: (spec) => {
        spawned.push(spec.id);
        return { pid: nextPid++ };
      },
    });

    daemon.startAll();

    expect(spawned).toEqual(["embed-server", "butler-main"]);
    const state = JSON.parse(readFileSync(serviceStatePath(butlerData, "butler-main"), "utf8"));
    expect(state).toMatchObject({
      serviceId: "butler-main",
      pid: 4101,
      parentPid: 4000,
      processGroupId: 4101,
      mode: "daemon-child",
      startedAt: "2026-04-28T00:00:00.000Z",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon delegates watchdog singleton ownership to the native service", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  let spawnedEnv: Record<string, string> | null = null;

  try {
    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs: watchdogSpecs(butlerHome, butlerData),
      parentPid: 4300,
      spawnChild: (_spec, env) => {
        spawnedEnv = env;
        return { pid: 4301 };
      },
    });

    daemon.startAll();

    expect(spawnedEnv).toMatchObject({
      BUTLER_SUPERVISOR_MODE: "foreground-daemon",
      BUTLER_WATCHDOG_DISABLE_SINGLETON: "true",
      BUTLER_WATCHDOG_DISABLE_SERVICE_LIVENESS: "true",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon uses App-managed specs when runtime pointer env is present", () => {
  const butlerData = tempRoot();
  const previousPointer = process.env.BUTLER_APP_MANAGED_RUNTIME_POINTER;
  const previousAuth = process.env.BUTLER_APP_LOCAL_AUTH_FILE;
  const previousPort = process.env.BUTLER_APP_SERVER_PORT;
  let spawnedEnv: Record<string, string> | null = null;
  try {
    const runtimeHomeLabel = join("app", "runtime", "agent", "versions", "9.9.9");
    const runtimeHome = join(butlerData, runtimeHomeLabel);
    const pointerPath = appManagedRuntimePointerPath(butlerData);
    const localAuthFile = join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
    mkdirSync(join(runtimeHome, "packages", "butler-agent", "resources", "runtime", "bin"), {
      recursive: true,
    });
    mkdirSync(join(runtimeHome, "bin"), { recursive: true });
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
    process.env.BUTLER_APP_MANAGED_RUNTIME_POINTER = pointerPath;
    process.env.BUTLER_APP_LOCAL_AUTH_FILE = localAuthFile;
    process.env.BUTLER_APP_SERVER_PORT = "19123";

    const specs = defaultDaemonServiceSpecs({
      butlerHome: "/standalone/ignored",
      butlerData,
    });
    const appGateway = specs.find((spec) => spec.id === "app-gateway");
    expect(specs.every((spec) => spec.cwd === runtimeHome)).toBe(true);
    expect(appGateway?.env).toMatchObject({
      BUTLER_APP_MANAGED_RUNTIME_POINTER: pointerPath,
      BUTLER_APP_LOCAL_AUTH_FILE: localAuthFile,
      BUTLER_APP_SERVER_PORT: "19123",
    });

    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs: [appGateway!],
      parentPid: 11_000,
      spawnChild: (_spec, env) => {
        spawnedEnv = env;
        return { pid: 11_100 };
      },
    });
    daemon.startAll();
    expect(spawnedEnv).toMatchObject({
      BUTLER_APP_MANAGED_RUNTIME_POINTER: pointerPath,
      BUTLER_APP_LOCAL_AUTH_FILE: localAuthFile,
      BUTLER_APP_SERVER_PORT: "19123",
    });
    const state = JSON.parse(readFileSync(serviceStatePath(butlerData, "app-gateway"), "utf8"));
    expect(state.runtime).toMatchObject({
      managedBy: "butler-app",
      runtimePointerPath: pointerPath,
      runtimeHome,
      version: "9.9.9",
    });
  } finally {
    if (previousPointer === undefined) delete process.env.BUTLER_APP_MANAGED_RUNTIME_POINTER;
    else process.env.BUTLER_APP_MANAGED_RUNTIME_POINTER = previousPointer;
    if (previousAuth === undefined) delete process.env.BUTLER_APP_LOCAL_AUTH_FILE;
    else process.env.BUTLER_APP_LOCAL_AUTH_FILE = previousAuth;
    if (previousPort === undefined) delete process.env.BUTLER_APP_SERVER_PORT;
    else process.env.BUTLER_APP_SERVER_PORT = previousPort;
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon rejects invalid App-managed gateway port env", () => {
  const butlerData = tempRoot();
  const previousPointer = process.env.BUTLER_APP_MANAGED_RUNTIME_POINTER;
  const previousAuth = process.env.BUTLER_APP_LOCAL_AUTH_FILE;
  const previousPort = process.env.BUTLER_APP_SERVER_PORT;
  try {
    const runtimeHomeLabel = join("app", "runtime", "agent", "versions", "9.9.9");
    const runtimeHome = join(butlerData, runtimeHomeLabel);
    const pointerPath = appManagedRuntimePointerPath(butlerData);
    const localAuthFile = join(butlerData, "app", "runtime", "auth", "local-agent-auth.json");
    mkdirSync(join(runtimeHome, "packages", "butler-agent", "resources", "runtime", "bin"), {
      recursive: true,
    });
    mkdirSync(join(runtimeHome, "bin"), { recursive: true });
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
    process.env.BUTLER_APP_MANAGED_RUNTIME_POINTER = pointerPath;
    process.env.BUTLER_APP_LOCAL_AUTH_FILE = localAuthFile;
    process.env.BUTLER_APP_SERVER_PORT = "not-a-port";

    expect(() =>
      defaultDaemonServiceSpecs({
        butlerHome: "/standalone/ignored",
        butlerData,
      }),
    ).toThrow("invalid App-managed gateway port");
  } finally {
    if (previousPointer === undefined) delete process.env.BUTLER_APP_MANAGED_RUNTIME_POINTER;
    else process.env.BUTLER_APP_MANAGED_RUNTIME_POINTER = previousPointer;
    if (previousAuth === undefined) delete process.env.BUTLER_APP_LOCAL_AUTH_FILE;
    else process.env.BUTLER_APP_LOCAL_AUTH_FILE = previousAuth;
    if (previousPort === undefined) delete process.env.BUTLER_APP_SERVER_PORT;
    else process.env.BUTLER_APP_SERVER_PORT = previousPort;
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon stops child process groups in reverse order", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const killed: Array<{ pid: number; signal: string }> = [];
  let nextPid = 5100;

  try {
    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs: smallSpecs(butlerHome, butlerData),
      parentPid: 5000,
      spawnChild: () => ({ pid: nextPid++ }),
      killPid: (pid, signal) => killed.push({ pid, signal }),
    });

    daemon.startAll();
    daemon.stopAll();

    expect(killed).toEqual([
      { pid: -5101, signal: "SIGTERM" },
      { pid: -5100, signal: "SIGTERM" },
    ]);
    expect(existsSync(serviceStatePath(butlerData, "butler-main"))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon restarts watchdog-policy child exits", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  let nextPid = 6100;
  const spawned: number[] = [];

  try {
    const specs = smallSpecs(butlerHome, butlerData);
    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs,
      parentPid: 6000,
      now: () => new Date("2026-04-28T00:00:00.000Z"),
      spawnChild: () => {
        const pid = nextPid++;
        spawned.push(pid);
        return { pid };
      },
    });

    daemon.startAll();
    daemon.handleChildExit("embed-server", 1, null);

    expect(spawned).toEqual([6100, 6101, 6102]);
    const state = JSON.parse(readFileSync(serviceStatePath(butlerData, "embed-server"), "utf8"));
    expect(state).toMatchObject({
      serviceId: "embed-server",
      pid: 6102,
      mode: "daemon-child",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon refuses to duplicate an already running detached service", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const specs = smallSpecs(butlerHome, butlerData);
  let spawned = 0;

  try {
    writeServiceState(butlerData, {
      version: 1,
      supervisor: NATIVE_SUPERVISOR_ID,
      serviceId: "embed-server",
      pid: 7100,
      processGroupId: 7100,
      mode: "detached",
      startedAt: "2026-04-28T00:00:00.000Z",
      command: specs[0].command,
      args: specs[0].args,
      cwd: specs[0].cwd,
      stdoutFile: specs[0].stdoutFile,
      stderrFile: specs[0].stderrFile,
      restartPolicy: specs[0].restartPolicy,
    });

    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs,
      parentPid: 7000,
      isPidRunning: (pid) => pid === 7100,
      spawnChild: () => {
        spawned += 1;
        return { pid: 7200 + spawned };
      },
    });

    expect(() => daemon.startAll()).toThrow(/already running/);
    expect(spawned).toBe(0);
    expect(existsSync(serviceStatePath(butlerData, "embed-server"))).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon replaces a legacy process-owned app gateway pid", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const killed: Array<{ pid: number; signal: string }> = [];
  const spawned: NativeServiceId[] = [];

  try {
    writeAppGatewayPid(butlerData, 12_300);
    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs: appGatewaySpecs(butlerHome, butlerData),
      parentPid: 12_000,
      now: () => new Date("2026-04-28T00:00:00.000Z"),
      isPidRunning: (pid) => pid === 12_300,
      killPid: (pid, signal) => killed.push({ pid, signal }),
      spawnChild: (spec) => {
        spawned.push(spec.id);
        return { pid: 12_301 };
      },
    });

    daemon.startAll();

    expect(killed).toEqual([{ pid: -12_300, signal: "SIGTERM" }]);
    expect(spawned).toEqual(["app-gateway"]);
    expect(readAppGatewayPid(butlerData)).toBeNull();
    const state = JSON.parse(readFileSync(serviceStatePath(butlerData, "app-gateway"), "utf8"));
    expect(state).toMatchObject({
      serviceId: "app-gateway",
      pid: 12_301,
      parentPid: 12_000,
      mode: "daemon-child",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon adopts state owned by the same foreground parent", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const specs = smallSpecs(butlerHome, butlerData);
  let spawned = 0;

  try {
    writeServiceState(butlerData, {
      version: 1,
      supervisor: NATIVE_SUPERVISOR_ID,
      serviceId: "embed-server",
      pid: 8100,
      parentPid: 8000,
      processGroupId: 8100,
      mode: "daemon-child",
      startedAt: "2026-04-28T00:00:00.000Z",
      command: specs[0].command,
      args: specs[0].args,
      cwd: specs[0].cwd,
      stdoutFile: specs[0].stdoutFile,
      stderrFile: specs[0].stderrFile,
      restartPolicy: specs[0].restartPolicy,
    });

    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs: [specs[0]],
      parentPid: 8000,
      isPidRunning: (pid) => pid === 8100,
      spawnChild: () => {
        spawned += 1;
        return { pid: 8200 + spawned };
      },
    });

    daemon.startAll();

    expect(spawned).toBe(0);
    const state = JSON.parse(readFileSync(serviceStatePath(butlerData, "embed-server"), "utf8"));
    expect(state).toMatchObject({
      serviceId: "embed-server",
      pid: 8100,
      parentPid: 8000,
      mode: "daemon-child",
    });
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon refuses same-parent state when command identity does not match", () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const specs = smallSpecs(butlerHome, butlerData);
  let spawned = 0;

  try {
    writeServiceState(butlerData, {
      version: 1,
      supervisor: NATIVE_SUPERVISOR_ID,
      serviceId: "embed-server",
      pid: 9100,
      parentPid: 9000,
      processGroupId: 9100,
      mode: "daemon-child",
      startedAt: "2026-04-28T00:00:00.000Z",
      command: "bash",
      args: ["/unexpected/script.sh"],
      cwd: specs[0].cwd,
      stdoutFile: specs[0].stdoutFile,
      stderrFile: specs[0].stderrFile,
      restartPolicy: specs[0].restartPolicy,
    });

    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs: [specs[0]],
      parentPid: 9000,
      isPidRunning: (pid) => pid === 9100,
      spawnChild: () => {
        spawned += 1;
        return { pid: 9200 + spawned };
      },
    });

    expect(() => daemon.startAll()).toThrow(/mismatched command/);
    expect(spawned).toBe(0);
    expect(existsSync(serviceStatePath(butlerData, "embed-server"))).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("foreground daemon escalates shutdown to SIGKILL when a child ignores SIGTERM", async () => {
  const butlerHome = "/opt/butler";
  const butlerData = tempRoot();
  const killed: Array<{ pid: number; signal: string }> = [];

  try {
    const daemon = new ManagedServiceDaemon({
      butlerData,
      specs: [smallSpecs(butlerHome, butlerData)[0]],
      parentPid: 10_000,
      killGraceMs: 1,
      sleep: async () => {},
      isPidRunning: (pid) => pid === 10_100,
      spawnChild: () => ({ pid: 10_100 }),
      killPid: (pid, signal) => killed.push({ pid, signal }),
    });

    daemon.startAll();
    await daemon.shutdownAll();

    expect(killed).toEqual([
      { pid: -10_100, signal: "SIGTERM" },
      { pid: -10_100, signal: "SIGKILL" },
    ]);
    expect(existsSync(serviceStatePath(butlerData, "embed-server"))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
