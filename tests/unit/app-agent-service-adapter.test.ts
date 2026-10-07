// test-category: pure-logic
import { describe, expect, test } from "bun:test";
import { createAppAgentServiceAdapter } from "../../packages/butler-app/client/electron/app-agent-service-adapter.mjs";
import { APP_AGENT_SERVICE_CONTROL_SCHEMA, createAgentServiceControl } from "../../packages/butler-app/client/electron/service-control.mjs";

describe("app-agent-service-adapter.test.ts", () => {
test("App Agent service adapter reports readiness from native service projections", async () => {
  const adapter = createAppAgentServiceAdapter({
    nativeServices: {
      list: async () => [
        projection("embed-server", "online"),
        projection("butler-main", "online"),
        projection("app-gateway", "online"),
      ],
    },
  });

  await expect(adapter.getStatus()).resolves.toEqual({
    status: "ready",
    service_available: true,
    raw_text_included: false,
  });
  await expect(adapter.diagnostics()).resolves.toEqual({
    status: "ready",
    service_available: true,
    service_count: 3,
    online_count: 3,
    stale_count: 0,
    raw_text_included: false,
  });
});

test("App Agent service adapter distinguishes stopped starting and failed projections", async () => {
  const stopped = createAppAgentServiceAdapter({
    nativeServices: {
      list: async () => [
        projection("butler-main", "offline"),
        projection("app-gateway", "offline"),
      ],
    },
  });
  await expect(stopped.getStatus()).resolves.toMatchObject({
    status: "stopped",
    service_available: true,
  });

  const starting = createAppAgentServiceAdapter({
    nativeServices: {
      list: async () => [
        projection("butler-main", "online"),
        projection("app-gateway", "offline"),
      ],
    },
  });
  await expect(starting.getStatus()).resolves.toMatchObject({
    status: "starting",
    service_available: true,
  });

  const failed = createAppAgentServiceAdapter({
    nativeServices: {
      list: async () => [
        projection("butler-main", "online"),
        projection("app-gateway", "stale"),
      ],
    },
  });
  await expect(failed.getStatus()).resolves.toMatchObject({
    status: "failed",
    service_available: true,
  });

  const incomplete = createAppAgentServiceAdapter({
    nativeServices: {
      list: async () => [
        projection("app-gateway", "online"),
      ],
    },
  });
  await expect(incomplete.getStatus()).resolves.toMatchObject({
    status: "starting",
    service_available: true,
  });
});

test("App Agent service adapter sequences install start stop and restart", async () => {
  const calls: string[] = [];
  let projections = [
    projection("butler-main", "offline"),
    projection("app-gateway", "offline"),
  ];
  const adapter = createAppAgentServiceAdapter({
    registration: {
      install: async () => {
        calls.push("install");
        projections = [
          projection("butler-main", "offline"),
          projection("app-gateway", "offline"),
        ];
      },
    },
    nativeServices: {
      list: async () => projections,
      start: async () => {
        calls.push("start");
        projections = [
          projection("butler-main", "online"),
          projection("app-gateway", "online"),
        ];
      },
      stop: async () => {
        calls.push("stop");
        projections = [
          projection("butler-main", "offline"),
          projection("app-gateway", "offline"),
        ];
      },
    },
  });

  await expect(adapter.install()).resolves.toMatchObject({
    ok: true,
    status: "stopped",
  });
  await expect(adapter.start()).resolves.toMatchObject({
    ok: true,
    status: "ready",
  });
  await expect(adapter.stop()).resolves.toMatchObject({
    ok: true,
    status: "stopped",
  });
  await expect(adapter.restart()).resolves.toMatchObject({
    ok: true,
    status: "ready",
  });
  expect(calls).toEqual(["install", "start", "stop", "stop", "start"]);
});

test("App Agent service adapter treats start command success as asynchronous readiness", async () => {
  const adapter = createAppAgentServiceAdapter({
    nativeServices: {
      list: async () => [
        projection("butler-main", "offline"),
        projection("app-gateway", "offline"),
      ],
      start: async () => {},
    },
  });

  await expect(adapter.start()).resolves.toMatchObject({
    ok: true,
    status: "stopped",
    raw_text_included: false,
  });
});

test("App Agent service adapter fails closed without registration native hooks or status access", async () => {
  const adapter = createAppAgentServiceAdapter();

  await expect(adapter.getStatus()).resolves.toMatchObject({
    status: "needs_permission",
    service_available: false,
  });
  await expect(adapter.install()).resolves.toMatchObject({
    ok: false,
    status: "needs_permission",
    code: "service_registration_unavailable",
  });
  await expect(adapter.start()).resolves.toMatchObject({
    ok: false,
    status: "failed",
    code: "service_start_unavailable",
  });

  const throwing = createAppAgentServiceAdapter({
    nativeServices: {
      list: async () => {
        throw new Error("launchctl permission denied at /Users/alice/.butler");
      },
      start: async () => undefined,
      stop: async () => undefined,
    },
  });
  await expect(throwing.getStatus()).resolves.toMatchObject({
    status: "failed",
    service_available: true,
  });
  await expect(throwing.start()).resolves.toMatchObject({
    ok: false,
    status: "failed",
    code: "agent_service_not_ready",
    raw_text_included: false,
  });
  expect(JSON.stringify(await throwing.diagnostics())).not.toContain("alice");
});

function projection(serviceId: string, status: "online" | "offline" | "stale") {
  return {
    serviceId,
    status,
  };
}
});

describe("app-agent-service-control.test.ts", () => {
const fixedNow = () => new Date("2026-06-13T00:00:00.000Z");
test("Agent service control normalizes adapter results", async () => {
  const calls: string[] = [];
  const control = createAgentServiceControl({
    platform: "linux",
    now: fixedNow,
    adapter: {
      getStatus: async () => ({
        status: "ready",
        platform: "/Users/alice/.butler",
        requiredDecision: "/Users/alice/.butler",
        private_path: "/Users/alice/.butler/secret",
      }),
      restart: async () => {
        calls.push("restart");
        return { ok: true, status: "ready" };
      },
      prepareRuntimeUpdate: async (request) => {
        calls.push(`prepare:${(request as { generation?: string }).generation}`);
        return { ok: true, status: "staging" };
      },
      applyRuntimeUpdate: async () => {
        calls.push("apply");
        return { ok: true, status: "restarting" };
      },
      rollbackRuntimeUpdate: async () => {
        calls.push("rollback");
        return { ok: true, status: "rollback" };
      },
      diagnostics: async () => ({
        status: "ready",
        private_path: "/Users/alice/.butler/secret",
      }),
    },
  });

  await expect(control.getAgentServiceStatus()).resolves.toMatchObject({
    status: "ready",
    platform: "linux",
    required_decision: "linux-package-service-path",
    service_available: true,
  });
  const status = await control.getAgentServiceStatus();
  expect(JSON.stringify(status)).not.toContain("/Users");
  expect(JSON.stringify(status)).not.toContain(".butler");
  expect(JSON.stringify(status)).not.toContain("private_path");
  await expect(control.restartAgentService()).resolves.toMatchObject({
    action: "restart",
    ok: true,
    status: "ready",
    error_code: null,
  });
  await expect(
    control.prepareAgentRuntimeUpdate({ generation: "gen-1" }),
  ).resolves.toMatchObject({
    action: "prepare_runtime_update",
    ok: true,
    status: "staging",
    error_code: null,
  });
  await expect(control.applyAgentRuntimeUpdate()).resolves.toMatchObject({
    action: "apply_runtime_update",
    ok: true,
    status: "restarting",
    error_code: null,
  });
  await expect(control.rollbackAgentRuntimeUpdate()).resolves.toMatchObject({
    action: "rollback_runtime_update",
    ok: true,
    status: "rollback",
    error_code: null,
  });
  expect(calls).toEqual(["restart", "prepare:gen-1", "apply", "rollback"]);
  await expect(control.readAgentServiceDiagnostics()).resolves.toMatchObject({
    adapter: {
      status: "ready",
      service_available: true,
      raw_text_included: false,
    },
  });
  const diagnostics = await control.readAgentServiceDiagnostics();
  expect(JSON.stringify(diagnostics)).not.toContain("/Users");
  expect(JSON.stringify(diagnostics)).not.toContain(".butler");
  expect(JSON.stringify(diagnostics)).not.toContain("private_path");
});

test("Agent service control does not report ready on adapter returned failure", async () => {
  const control = createAgentServiceControl({
    platform: "darwin",
    now: fixedNow,
    adapter: {
      stop: async () => ({
        ok: false,
        status: "ready",
        code: "stop_failed",
      }),
    },
  });

  await expect(control.stopAgentService()).resolves.toEqual({
    schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
    action: "stop",
    ok: false,
    status: "failed",
    platform: "darwin",
    required_decision: "macos-registration-path",
    error_code: "stop_failed",
    updated_at: "2026-06-13T00:00:00.000Z",
    raw_text_included: false,
  });
});

test("Agent service control redacts adapter failures", async () => {
  const control = createAgentServiceControl({
    platform: "win32",
    now: fixedNow,
    adapter: {
      start: async () => {
        const error = new Error("failed at /Users/alice/.butler/token");
        (error as Error & { code?: string }).code = "permission denied!";
        throw error;
      },
    },
  });

  await expect(control.startAgentService()).resolves.toEqual({
    schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
    action: "start",
    ok: false,
    status: "failed",
    platform: "win32",
    required_decision: "windows-user-security-context",
    error_code: "permission_denied_",
    updated_at: "2026-06-13T00:00:00.000Z",
    raw_text_included: false,
  });
  const diagnostics = await control.readAgentServiceDiagnostics();
  expect(JSON.stringify(diagnostics)).not.toContain("alice");
  expect(JSON.stringify(diagnostics)).not.toContain(".butler");
});

test("Agent service control accepts App Agent service adapter status and actions", async () => {
  const calls: string[] = [];
  const adapter = createAppAgentServiceAdapter({
    registration: {
      install: async () => calls.push("install"),
    },
    nativeServices: {
      list: async () => [
        { serviceId: "butler-main", status: "online" },
        { serviceId: "app-gateway", status: "online" },
      ],
      start: async () => calls.push("start"),
      stop: async () => calls.push("stop"),
    },
  });
  const control = createAgentServiceControl({
    platform: "darwin",
    now: fixedNow,
    adapter,
  });

  await expect(control.getAgentServiceStatus()).resolves.toMatchObject({
    status: "ready",
    service_available: true,
  });
  await expect(control.installAgentService()).resolves.toMatchObject({
    action: "install",
    ok: true,
    status: "stopped",
  });
  await expect(control.restartAgentService()).resolves.toMatchObject({
    action: "restart",
    ok: true,
    status: "ready",
  });
  expect(calls).toEqual(["install", "stop", "start"]);
});
});
