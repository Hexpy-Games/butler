import { expect, test } from "bun:test";
import {
  MENU_BAR_HELPER_ARG,
  NEW_CHAT_ARG,
  OPEN_SESSION_ARG_PREFIX,
  QUIT_MAIN_UI_ARG,
  QUIT_MENU_BAR_HELPER_ARG,
  argsForNavigationRequest,
  helperLifecycleAction,
  helperProcessOwnsTray,
  isMenuBarHelperMode,
  isQuitMainUiSignalMode,
  isQuitMenuBarHelperSignalMode,
  mainProcessOwnsTray,
  navigationRequestFromArgs,
  persistentMenuBarHelperSupported,
  resolvePersistentMenuBarHelperLaunch,
  shouldLaunchPersistentMenuBarHelper,
} from "../../packages/butler-app/client/electron/menu-bar-helper-lifecycle.mjs";

test("packaged macOS App only enables persistent helper for background helper executables", () => {
  expect(persistentMenuBarHelperSupported({
    platform: "darwin",
    isPackaged: true,
    env: {},
    helperExecutablePath:
      "/Applications/Butler.app/Contents/Library/LoginItems/Butler Menu Bar Helper.app/Contents/MacOS/Butler Menu Bar Helper",
    helperExecutableExists: true,
    mainExecutablePath: "/Applications/Butler.app/Contents/MacOS/Butler",
  })).toBe(true);
  expect(resolvePersistentMenuBarHelperLaunch({
    platform: "darwin",
    isPackaged: true,
    env: {},
    helperExecutablePath:
      "/Applications/Butler.app/Contents/Library/LoginItems/Butler Menu Bar Helper.app/Contents/MacOS/Butler Menu Bar Helper",
    helperExecutableExists: true,
    mainExecutablePath: "/Applications/Butler.app/Contents/MacOS/Butler",
  })).toMatchObject({
    supported: true,
    executable:
      "/Applications/Butler.app/Contents/Library/LoginItems/Butler Menu Bar Helper.app/Contents/MacOS/Butler Menu Bar Helper",
  });
  expect(persistentMenuBarHelperSupported({
    platform: "darwin",
    isPackaged: true,
    env: {},
    helperExecutablePath:
      "/Applications/Butler.app/Contents/Library/LoginItems/Butler Menu Bar Helper.app/Contents/MacOS/Butler Menu Bar Helper",
    helperExecutableExists: false,
    mainExecutablePath: "/Applications/Butler.app/Contents/MacOS/Butler",
  })).toBe(false);
  expect(resolvePersistentMenuBarHelperLaunch({
    platform: "darwin",
    isPackaged: true,
    env: {},
  })).toMatchObject({
    supported: false,
    reason: "missing_background_helper_executable",
  });
  expect(persistentMenuBarHelperSupported({
    platform: "darwin",
    isPackaged: true,
    env: {
      BUTLER_APP_MENU_BAR_HELPER_EXECUTABLE:
        "/Applications/Butler.app/Contents/Library/LoginItems/Butler Menu Bar Helper.app/Contents/MacOS/Butler Menu Bar Helper",
    },
    helperExecutableExists: true,
    mainExecutablePath: "/Applications/Butler.app/Contents/MacOS/Butler",
  })).toBe(true);
  expect(resolvePersistentMenuBarHelperLaunch({
    platform: "darwin",
    isPackaged: true,
    env: {
      BUTLER_APP_MENU_BAR_HELPER_EXECUTABLE:
        "/Applications/Butler.app/Contents/MacOS/Butler",
    },
    helperExecutableExists: true,
    mainExecutablePath: "/Applications/Butler.app/Contents/MacOS/Butler",
  })).toMatchObject({
    supported: false,
    reason: "unsafe_dock_app_executable",
  });
  expect(persistentMenuBarHelperSupported({
    platform: "linux",
    isPackaged: true,
    env: {},
  })).toBe(false);
  expect(persistentMenuBarHelperSupported({
    platform: "darwin",
    isPackaged: false,
    env: {},
  })).toBe(false);
  expect(persistentMenuBarHelperSupported({
    platform: "linux",
    isPackaged: false,
    env: { BUTLER_APP_FORCE_PERSISTENT_MENU_BAR_HELPER: "1" },
  })).toBe(false);
});

test("main process and helper process have distinct tray ownership", () => {
  expect(mainProcessOwnsTray({
    trayEnabled: true,
    helperMode: false,
    persistentHelperSupported: false,
  })).toBe(true);
  expect(mainProcessOwnsTray({
    trayEnabled: true,
    helperMode: false,
    persistentHelperSupported: true,
  })).toBe(false);
  expect(helperProcessOwnsTray({
    trayEnabled: true,
    helperMode: true,
  })).toBe(true);
  expect(helperProcessOwnsTray({
    trayEnabled: false,
    helperMode: true,
  })).toBe(false);
});

test("persistent helper launch policy does not trust stale pid files", () => {
  expect(shouldLaunchPersistentMenuBarHelper({
    trayEnabled: true,
    persistentHelperSupported: true,
    launchAttempted: false,
  })).toBe(true);
  expect(shouldLaunchPersistentMenuBarHelper({
    trayEnabled: true,
    persistentHelperSupported: true,
    launchAttempted: true,
  })).toBe(false);
  expect(shouldLaunchPersistentMenuBarHelper({
    trayEnabled: true,
    persistentHelperSupported: true,
    launchAttempted: false,
    helperRunning: true,
  })).toBe(false);
  expect(shouldLaunchPersistentMenuBarHelper({
    trayEnabled: true,
    persistentHelperSupported: false,
    launchAttempted: false,
  })).toBe(false);
  expect(shouldLaunchPersistentMenuBarHelper({
    trayEnabled: false,
    persistentHelperSupported: true,
    launchAttempted: false,
  })).toBe(false);
});

test("helper lifecycle actions treat helper exit as Agent stop", () => {
  expect(helperLifecycleAction("close-window")).toEqual({
    quitsMainUi: false,
    quitsHelper: false,
    stopsAgent: false,
  });
  expect(helperLifecycleAction("quit-main-ui")).toEqual({
    quitsMainUi: true,
    quitsHelper: false,
    stopsAgent: false,
  });
  expect(helperLifecycleAction("quit-helper")).toEqual({
    quitsMainUi: false,
    quitsHelper: true,
    stopsAgent: true,
  });
  expect(helperLifecycleAction("stop-agent")).toEqual({
    quitsMainUi: false,
    quitsHelper: false,
    stopsAgent: true,
  });
});

test("helper and quit signal flags are explicit", () => {
  expect(isMenuBarHelperMode({
    argv: [MENU_BAR_HELPER_ARG],
    env: {},
  })).toBe(true);
  expect(isMenuBarHelperMode({
    argv: [],
    env: { BUTLER_APP_MENU_BAR_HELPER: "1" },
  })).toBe(true);
  expect(isQuitMainUiSignalMode({ argv: [QUIT_MAIN_UI_ARG] })).toBe(true);
  expect(isQuitMenuBarHelperSignalMode({
    argv: [QUIT_MENU_BAR_HELPER_ARG],
  })).toBe(true);
});

test("helper navigation requests round-trip through process args", () => {
  expect(argsForNavigationRequest({ action: "new-chat" })).toEqual([
    NEW_CHAT_ARG,
  ]);
  expect(navigationRequestFromArgs([NEW_CHAT_ARG])).toEqual({
    action: "new-chat",
  });
  const openSessionArg = `${OPEN_SESSION_ARG_PREFIX}session-1`;
  expect(argsForNavigationRequest({
    action: "open-session",
    sessionId: "session-1",
  })).toEqual([openSessionArg]);
  expect(navigationRequestFromArgs([openSessionArg])).toEqual({
    action: "open-session",
    sessionId: "session-1",
  });
});
