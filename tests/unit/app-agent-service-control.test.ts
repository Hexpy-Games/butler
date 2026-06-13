import { expect, test } from "bun:test";
import {
  APP_AGENT_SERVICE_CONTROL_SCHEMA,
  createAgentServiceControl,
} from "../../packages/butler-app/client/electron/service-control.mjs";
import { createAppAgentServiceAdapter } from "../../packages/butler-app/client/electron/app-agent-service-adapter.mjs";

const fixedNow = () => new Date("2026-06-13T00:00:00.000Z");

test("Agent service control fails closed before platform service adapter lands", async () => {
  const control = createAgentServiceControl({
    platform: "darwin",
    now: fixedNow,
  });

  await expect(control.getAgentServiceStatus()).resolves.toEqual({
    schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
    status: "not_installed",
    platform: "darwin",
    required_decision: "macos-registration-path",
    service_available: false,
    diagnostics_available: true,
    updated_at: "2026-06-13T00:00:00.000Z",
    raw_text_included: false,
  });
  await expect(control.installAgentService()).resolves.toEqual({
    schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
    action: "install",
    ok: false,
    status: "needs_permission",
    platform: "darwin",
    required_decision: "macos-registration-path",
    error_code: "service_registration_unavailable",
    updated_at: "2026-06-13T00:00:00.000Z",
    raw_text_included: false,
  });
  await expect(control.prepareAgentRuntimeUpdate()).resolves.toEqual({
    schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
    action: "prepare_runtime_update",
    ok: false,
    status: "failed",
    platform: "darwin",
    required_decision: "macos-registration-path",
    error_code: "agent_runtime_update_unavailable",
    updated_at: "2026-06-13T00:00:00.000Z",
    raw_text_included: false,
  });

  const diagnostics = await control.readAgentServiceDiagnostics();
  expect(diagnostics).toMatchObject({
    schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
    platform: "darwin",
    service_available: false,
    last_error: {
      code: "agent_runtime_update_unavailable",
      action: "prepare_runtime_update",
    },
    raw_text_included: false,
  });
  expect(JSON.stringify(diagnostics)).not.toContain("/Users/");
});

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
