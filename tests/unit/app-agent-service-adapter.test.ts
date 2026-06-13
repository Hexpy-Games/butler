import { expect, test } from "bun:test";
import { createAppAgentServiceAdapter } from "../../packages/butler-app/client/electron/app-agent-service-adapter.mjs";

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
