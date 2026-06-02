import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  defaultNativeServiceSpecs,
  listServices,
  projectFolderTokenSecretPath,
  serviceStatePath,
  startService,
  startServices,
  stopServices,
} from "../../packages/butler-agent/src/operations/service/native-service-supervisor.ts";
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
      "/opt/butler/packages/butler-agent/src/gateways/app/cli.ts",
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
