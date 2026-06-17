export const MENU_BAR_HELPER_ARG = "--butler-menu-bar-helper";
export const QUIT_MAIN_UI_ARG = "--butler-quit-main-ui";
export const QUIT_MENU_BAR_HELPER_ARG = "--butler-quit-menu-bar-helper";
export const NEW_CHAT_ARG = "--butler-new-chat";
export const OPEN_SESSION_ARG_PREFIX = "--butler-open-session=";

export function hasArg(argv = [], flag) {
  return argv.includes(flag);
}

export function isMenuBarHelperMode({ argv = [], env = {} } = {}) {
  return hasArg(argv, MENU_BAR_HELPER_ARG) ||
    env.BUTLER_APP_MENU_BAR_HELPER === "1";
}

export function isQuitMainUiSignalMode({ argv = [] } = {}) {
  return hasArg(argv, QUIT_MAIN_UI_ARG);
}

export function isQuitMenuBarHelperSignalMode({ argv = [] } = {}) {
  return hasArg(argv, QUIT_MENU_BAR_HELPER_ARG);
}

export function persistentMenuBarHelperSupported({
  platform = "darwin",
  isPackaged = false,
  env = {},
} = {}) {
  if (env.BUTLER_APP_DISABLE_PERSISTENT_MENU_BAR_HELPER === "1") return false;
  if (env.BUTLER_APP_FORCE_PERSISTENT_MENU_BAR_HELPER === "1") return true;
  return platform === "darwin" && isPackaged === true;
}

export function shouldLaunchPersistentMenuBarHelper({
  trayEnabled = true,
  persistentHelperSupported = false,
  launchAttempted = false,
} = {}) {
  return trayEnabled === true &&
    persistentHelperSupported === true &&
    launchAttempted !== true;
}

export function mainProcessOwnsTray({
  trayEnabled = true,
  helperMode = false,
  persistentHelperSupported = false,
} = {}) {
  return trayEnabled === true &&
    helperMode !== true &&
    persistentHelperSupported !== true;
}

export function helperProcessOwnsTray({
  trayEnabled = true,
  helperMode = false,
} = {}) {
  return trayEnabled === true && helperMode === true;
}

export function helperLifecycleAction(action) {
  switch (action) {
    case "quit-main-ui":
      return { quitsMainUi: true, quitsHelper: false, stopsAgent: false };
    case "quit-helper":
      return { quitsMainUi: false, quitsHelper: true, stopsAgent: false };
    case "stop-agent":
      return { quitsMainUi: false, quitsHelper: false, stopsAgent: true };
    case "close-window":
    default:
      return { quitsMainUi: false, quitsHelper: false, stopsAgent: false };
  }
}

export function navigationRequestFromArgs(argv = []) {
  if (hasArg(argv, NEW_CHAT_ARG)) return { action: "new-chat" };
  const sessionArg = argv.find((arg) => arg.startsWith(OPEN_SESSION_ARG_PREFIX));
  if (!sessionArg) return null;
  const sessionId = sessionArg.slice(OPEN_SESSION_ARG_PREFIX.length).trim();
  if (!sessionId) return null;
  return { action: "open-session", sessionId };
}

export function argsForNavigationRequest(request = {}) {
  if (request.action === "new-chat") return [NEW_CHAT_ARG];
  if (
    request.action === "open-session" &&
    typeof request.sessionId === "string" &&
    request.sessionId.trim()
  ) {
    return [`${OPEN_SESSION_ARG_PREFIX}${request.sessionId.trim()}`];
  }
  return [];
}
