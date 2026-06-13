import { expect, test } from "bun:test";
import {
  APP_AGENT_SERVICE_CONTROL_SCHEMA,
  createAgentServiceControl,
} from "../../packages/butler-app/client/electron/service-control.mjs";

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

  const diagnostics = await control.readAgentServiceDiagnostics();
  expect(diagnostics).toMatchObject({
    schema: APP_AGENT_SERVICE_CONTROL_SCHEMA,
    platform: "darwin",
    service_available: false,
    last_error: {
      code: "service_registration_unavailable",
      action: "install",
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
  expect(calls).toEqual(["restart"]);
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
