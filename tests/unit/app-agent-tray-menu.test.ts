import { expect, test } from "bun:test";
import {
  bindWindowsTrayInteractions,
  createTrayAgentMenuModel,
  trayAgentServiceLabel,
} from "../../packages/butler-app/client/electron/tray-agent-menu.mjs";

test("Windows tray left-click opens the menu and double-click restores Butler", () => {
  const handlers = new Map<string, () => void>();
  let menuOpenCount = 0;
  let restoreCount = 0;
  const tray = {
    on(event: string, handler: () => void) {
      handlers.set(event, handler);
    },
    popUpContextMenu() {
      menuOpenCount += 1;
    },
  };

  expect(bindWindowsTrayInteractions(tray, () => { restoreCount += 1; })).toBe(true);
  handlers.get("click")?.();
  handlers.get("double-click")?.();

  expect(menuOpenCount).toBe(1);
  expect(restoreCount).toBe(1);
});

test("Windows tray interaction binding is idempotent per tray instance", () => {
  const registeredEvents: string[] = [];
  const tray = {
    on(event: string) {
      registeredEvents.push(event);
    },
    popUpContextMenu() {},
  };

  expect(bindWindowsTrayInteractions(tray, () => undefined)).toBe(true);
  expect(bindWindowsTrayInteractions(tray, () => undefined)).toBe(false);
  expect(registeredEvents).toEqual(["click", "double-click"]);
});

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

test("tray Agent menu stays source-agnostic for helper-owned Agent actions", () => {
  const menu = createTrayAgentMenuModel({
    status: "ready",
    service_available: true,
  });
  expect(menu).toMatchObject({
    label: "Butler Agent: Running",
    canStop: true,
    canRestart: true,
  });
});
