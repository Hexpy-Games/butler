import { expect, test } from "bun:test";
import { reconcileAgentServiceOnAppLaunch } from "../../packages/butler-app/client/electron/app-agent-launch-reconciler.mjs";
import { createAgentServiceControl } from "../../packages/butler-app/client/electron/service-control.mjs";
import { createFirstRunSetupBridge } from "../../packages/butler-app/client/electron/setup-bridge.mjs";
import { createTrayAgentMenuModel } from "../../packages/butler-app/client/electron/tray-agent-menu.mjs";

const fixedNow = () => new Date("2026-06-13T00:00:00.000Z");

test("App background service first-run installs starts and tray controls service", async () => {
  const calls: string[] = [];
  let status = "not_installed";
  const serviceControl = createAgentServiceControl({
    platform: "darwin",
    now: fixedNow,
    adapter: {
      getStatus: async () => ({ status }),
      install: async () => {
        calls.push("install");
        status = "stopped";
        return { ok: true, status };
      },
      start: async () => {
        calls.push("start");
        status = "ready";
        return { ok: true, status };
      },
      stop: async () => {
        calls.push("stop");
        status = "stopped";
        return { ok: true, status };
      },
      diagnostics: async () => ({ status }),
    },
  });
  const bridge = createFirstRunSetupBridge({
    serviceControl,
    ensureReady: async () => {
      calls.push("ensureReady");
    },
    readSettings: async () => ({ gateway_profile: "electron" }),
    readRuntimeDiagnostics: () => okRuntimeDiagnostics(),
  });

  await expect(bridge.start()).resolves.toMatchObject({ phase: "ready" });
  expect(calls).toEqual(["install", "start", "ensureReady"]);
  const readyStatus = await serviceControl.getAgentServiceStatus();
  expect(readyStatus).toMatchObject({
    status: "ready",
    service_available: true,
  });
  expect(createTrayAgentMenuModel(serviceStatusView(readyStatus))).toMatchObject({
    canStop: true,
    canRestart: true,
  });

  await expect(serviceControl.stopAgentService({ source: "tray" })).resolves.toMatchObject({
    action: "stop",
    ok: true,
    status: "stopped",
  });
  expect(calls).toEqual(["install", "start", "ensureReady", "stop"]);
  const stoppedStatus = await serviceControl.getAgentServiceStatus();
  expect(stoppedStatus).toMatchObject({
    status: "stopped",
    service_available: true,
  });
  expect(createTrayAgentMenuModel(serviceStatusView(stoppedStatus))).toMatchObject({
    canStart: true,
    canStop: false,
    canRestart: true,
  });
});

test("App launch reconciles a stopped App-managed Agent service", async () => {
  const calls: string[] = [];
  let status = "stopped";
  const serviceControl = createAgentServiceControl({
    platform: "darwin",
    now: fixedNow,
    adapter: {
      getStatus: async () => ({ status }),
      install: async (request) => {
        calls.push(`install:${(request as { source?: string }).source}`);
        status = "stopped";
        return { ok: true, status };
      },
      start: async (request) => {
        calls.push(`start:${(request as { source?: string }).source}`);
        status = "ready";
        return { ok: true, status };
      },
    },
  });

  await expect(
    reconcileAgentServiceOnAppLaunch({ serviceControl }),
  ).resolves.toMatchObject({
    attempted: true,
    reason: "started",
    finalStatus: { status: "ready" },
  });
  expect(calls).toEqual(["install:app-launch", "start:app-launch"]);
});

test("App launch does not restart an already ready Agent service", async () => {
  const calls: string[] = [];
  const serviceControl = createAgentServiceControl({
    platform: "darwin",
    now: fixedNow,
    adapter: {
      getStatus: async () => ({ status: "ready" }),
      start: async () => {
        calls.push("start");
        return { ok: true, status: "ready" };
      },
    },
  });

  await expect(
    reconcileAgentServiceOnAppLaunch({ serviceControl }),
  ).resolves.toMatchObject({
    attempted: false,
    reason: "already_ready",
  });
  expect(calls).toEqual([]);
});

test("App launch updates an already ready Agent service when bundled runtime changed", async () => {
  const calls: string[] = [];
  let runtimeCurrent = false;
  const serviceControl = createAgentServiceControl({
    platform: "linux",
    now: fixedNow,
    adapter: {
      getStatus: async () => ({ status: "ready" }),
      install: async (request) => {
        calls.push(`install:${(request as { source?: string }).source}`);
        runtimeCurrent = true;
        return { ok: true, status: "ready" };
      },
      restart: async (request) => {
        calls.push(`restart:${(request as { source?: string }).source}`);
        return { ok: true, status: "ready" };
      },
    },
  });

  await expect(
    reconcileAgentServiceOnAppLaunch({
      serviceControl,
      runtimeCurrent: () => ({
        current: runtimeCurrent,
        expectedVersion: "0.0.13",
        activeVersion: "0.0.8",
      }),
    }),
  ).resolves.toMatchObject({
    attempted: true,
    reason: "runtime_updated",
    runtimeStatus: {
      current: false,
      expectedVersion: "0.0.13",
      activeVersion: "0.0.8",
    },
    finalStatus: { status: "ready" },
  });
  expect(calls).toEqual(["install:app-launch", "restart:app-launch"]);
});

test("App launch restarts failed service projections without waiting for first-run", async () => {
  const calls: string[] = [];
  let status = "failed";
  const serviceControl = createAgentServiceControl({
    platform: "darwin",
    now: fixedNow,
    adapter: {
      getStatus: async () => ({ status }),
      start: async (request) => {
        calls.push(`start:${(request as { source?: string }).source}`);
        status = "ready";
        return { ok: true, status };
      },
    },
  });

  await expect(
    reconcileAgentServiceOnAppLaunch({ serviceControl }),
  ).resolves.toMatchObject({
    attempted: true,
    reason: "started",
    finalStatus: { status: "ready" },
  });
  expect(calls).toEqual(["start:app-launch"]);
});

test("App launch restarts starting service projections that never reached gateway readiness", async () => {
  const calls: string[] = [];
  let status = "starting";
  const serviceControl = createAgentServiceControl({
    platform: "darwin",
    now: fixedNow,
    adapter: {
      getStatus: async () => ({ status }),
      start: async (request) => {
        calls.push(`start:${(request as { source?: string }).source}`);
        status = "ready";
        return { ok: true, status };
      },
    },
  });

  await expect(
    reconcileAgentServiceOnAppLaunch({ serviceControl }),
  ).resolves.toMatchObject({
    attempted: true,
    reason: "started",
    finalStatus: { status: "ready" },
  });
  expect(calls).toEqual(["start:app-launch"]);
});

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

function serviceStatusView(value: unknown): {
  status?: string;
  service_available?: boolean;
} {
  return value && typeof value === "object" ? value : {};
}
