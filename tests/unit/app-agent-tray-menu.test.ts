import { expect, test } from "bun:test";
import {
  createTrayAgentMenuModel,
  trayAgentServiceLabel,
} from "../../packages/butler-app/client/electron/tray-agent-menu.mjs";

test("tray Agent menu disables service actions when service adapter is unavailable", () => {
  expect(createTrayAgentMenuModel({
    status: "not_installed",
    service_available: false,
  })).toEqual({
    label: "Butler Agent: Not Installed",
    canStart: false,
    canStop: false,
    canRestart: false,
  });
  expect(createTrayAgentMenuModel({
    status: "failed",
    service_available: false,
  })).toMatchObject({
    canStart: false,
    canStop: false,
    canRestart: false,
  });
});

test("tray Agent menu enables only safe actions for available service states", () => {
  expect(createTrayAgentMenuModel({
    status: "ready",
    service_available: true,
  })).toMatchObject({
    canStart: false,
    canStop: true,
    canRestart: true,
  });
  expect(createTrayAgentMenuModel({
    status: "stopped",
    service_available: true,
  })).toMatchObject({
    canStart: true,
    canStop: false,
    canRestart: true,
  });
  expect(createTrayAgentMenuModel({
    status: "needs_permission",
    service_available: true,
  })).toMatchObject({
    canStart: false,
    canStop: false,
    canRestart: false,
  });
  expect(createTrayAgentMenuModel({
    status: "starting",
    service_available: true,
  })).toMatchObject({
    canStart: false,
    canStop: true,
    canRestart: false,
  });
});

test("tray Agent status labels stay coarse and path-free", () => {
  expect(trayAgentServiceLabel({ status: "ready" })).toBe("Butler Agent: Running");
  expect(trayAgentServiceLabel({ status: "failed" })).toBe("Butler Agent: Failed");
  expect(JSON.stringify(createTrayAgentMenuModel({
    status: "/Users/alice/.butler",
    service_available: true,
  }))).not.toContain("/Users");
});
