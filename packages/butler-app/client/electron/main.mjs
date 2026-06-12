import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} from "electron";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFirstRunSetupBridge } from "./setup-bridge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const userHome = homedir();
const butlerDataRoot = process.env.BUTLER_DATA || join(userHome, ".butler");
const preloadPath = resolve(__dirname, "preload.cjs");
const packagePath = resolve(__dirname, "package.json");
const appDisplayName = "Butler";
const appIconPath = resolve(__dirname, "assets/icon.png");
const trayIconLightThemePath = resolve(__dirname, "assets/butler-mark-flat.png");
const trayIconDarkThemePath = resolve(__dirname, "assets/butler-mark-flat-white.png");
const macAppIconPath = resolve(__dirname, "assets/butler.icns");
const macAppDockIconPath = resolve(__dirname, "assets/butler-mac.png");
const appRepositoryUrl = "https://github.com/Hexpy-Games/butler";
const appProtocolVersion = "butler.app.v1";
const nativeSettingsSchema = "butler.native-settings.v1";
const nativeSettingsFileName = "butler-native-settings.json";
const macNotificationSettingsUrl =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
const winNotificationSettingsUrl = "ms-settings:notifications";
let port = normalizePort(process.env.BUTLER_APP_SERVER_PORT, 18765);
const explicitServerUrl = process.env.BUTLER_APP_SERVER_URL;
let serverUrl = normalizeLocalHttpUrl(
  explicitServerUrl ?? localServerUrlForPort(port),
  "Butler app server URL",
);
const explicitUiUrl = process.env.BUTLER_APP_UI_URL;
let rendererUrl = explicitUiUrl
  ? normalizeLocalHttpUrl(explicitUiUrl, "Butler app UI URL")
  : serverUrl;
let rendererOrigin = new URL(rendererUrl).origin;
let serverHealthUrl = new URL("/health", serverUrl).toString();
const isMac = process.platform === "darwin";
const macTrafficLightPosition = { x: 20, y: 18 };
const macTransparentBackground = "#00000000";
const macVibrancy = "sidebar";
const appearanceThemeSources = new Set(["system", "light", "dark"]);
const projectFolderTokenSecret = resolveProjectFolderTokenSecret();
const projectFolderTokenTtlMs = 5 * 60 * 1000;
const messageFileIdPattern = /^file-[0-9a-f-]{36}$/iu;
let serverProcess = null;
let serverStartupPromise = null;
let serverShutdownKillTimer = null;
let nativeSettingsCache = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
const nativeShellPreferences = {
  trayEnabled: true,
};
const nativeNotificationState = {
  lastError: null,
  lastAttemptedAt: null,
  lastShownAt: null,
};
const firstRunSetupBridge = createFirstRunSetupBridge({
  checkExistingReady: checkExistingServer,
  ensureReady: ensureServer,
  existingAgentConfigured: Boolean(explicitServerUrl),
  gatewayProfile: "electron",
  readSettings: readSetupSettings,
});
app.setName(appDisplayName);
syncPreloadServerEnvironment();

function projectFolderTokenSecretPath(dataRoot = butlerDataRoot) {
  return join(
    dataRoot,
    "state",
    "app-gateway",
    "project-folder-token-secret",
  );
}

function resolveProjectFolderTokenSecret() {
  const envSecret = process.env.BUTLER_PROJECT_FOLDER_TOKEN_SECRET?.trim();
  if (envSecret) return envSecret;
  const secretPath = projectFolderTokenSecretPath();
  try {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Missing or unreadable secrets are recreated below for local desktop use.
  }
  const secret = randomUUID();
  mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  return secret;
}

function managedGatewayCommand() {
  for (const home of candidateButlerHomes()) {
    const localButlerCli = resolve(home, "bin", "butler.js");
    if (!existsSync(localButlerCli)) continue;
    const data = butlerDataRoot;
    const runtime = resolveButlerRuntime(data);
    return {
      command: runtime,
      args: [localButlerCli, "gateway", "app"],
      cwd: home,
      env: {
        BUTLER_HOME: home,
        BUTLER_DATA: data,
        BUTLER_BUN: runtime,
      },
    };
  }
  return {
    command: process.env.BUTLER_CLI || "butler",
    args: ["gateway", "app"],
    cwd: undefined,
  };
}

function candidateButlerHomes() {
  const homes = [
    repoRoot,
    process.env.BUTLER_HOME,
    join(userHome, "butler"),
    process.platform === "linux" ? "/opt/butler" : null,
  ];
  const seen = new Set();
  return homes
    .filter((home) => typeof home === "string" && home.trim())
    .map((home) => resolve(home))
    .filter((home) => {
      if (seen.has(home)) return false;
      seen.add(home);
      return true;
    });
}

function resolveButlerRuntime(data) {
  const candidates = [
    process.env.BUTLER_BUN,
    join(data, "runtime", "bun", "current", "bin", "bun"),
    "/opt/homebrew/bin/bun",
    "/usr/local/bin/bun",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "bun";
}

async function healthOk() {
  try {
    const response = await fetch(serverHealthUrl);
    const body = await response.json().catch(() => null);
    return (
      response.ok &&
      body?.protocol_version === "butler.app.v1" &&
      body?.data?.ok === true
    );
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (explicitServerUrl) {
    if (await healthOk()) return;
    throw new Error(`Butler app server is not healthy: ${explicitServerUrl}`);
  }
  if (serverProcess && (await healthOk())) return;
  if (serverStartupPromise) return serverStartupPromise;
  if (await healthOk()) return;
  if (!(await isPortAvailable(port))) {
    updateManagedServerPort(await findAvailablePort(port + 1));
  }
  serverStartupPromise = startManagedServer();
  try {
    await serverStartupPromise;
  } finally {
    serverStartupPromise = null;
  }
}

async function startManagedServer() {
  if (serverProcess) {
    throw new Error(
      "Butler app server is already starting but is not healthy yet.",
    );
  }

  const gateway = managedGatewayCommand();
  serverProcess = spawn(gateway.command, gateway.args, {
    ...(gateway.cwd ? { cwd: gateway.cwd } : {}),
    env: {
      ...process.env,
      ...(gateway.env ?? {}),
      BUTLER_APP_SERVER_PORT: String(port),
      BUTLER_APP_SERVER_URL: serverUrl,
      BUTLER_APP_GATEWAY_PID_FILE: "off",
      ...(explicitUiUrl ? { BUTLER_APP_DEV_ORIGIN: rendererOrigin } : {}),
      BUTLER_PROJECT_FOLDER_TOKEN_SECRET: projectFolderTokenSecret,
    },
    stdio: "inherit",
  });
  let spawnError = null;
  let earlyExit = null;
  serverProcess.once("error", (error) => {
    spawnError = error;
  });
  serverProcess.once("exit", (code, signal) => {
    earlyExit = { code, signal };
    if (serverShutdownKillTimer) clearTimeout(serverShutdownKillTimer);
    serverShutdownKillTimer = null;
    serverProcess = null;
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await healthOk()) return;
    if (spawnError) {
      throw new Error(
        `Failed to start Butler app server: ${spawnError.message}`,
      );
    }
    if (earlyExit) {
      throw new Error(
        `Butler app server exited before becoming healthy: code=${earlyExit.code ?? "null"} signal=${earlyExit.signal ?? "null"}.`,
      );
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 150));
  }
  throw new Error(
    `Timed out waiting for Butler app server at ${serverHealthUrl}.`,
  );
}

async function installDevtools() {
  if (!explicitUiUrl || !developerModeEnabled()) return;
  try {
    const { installExtension, REACT_DEVELOPER_TOOLS } =
      await import("electron-devtools-installer");
    const extension = await installExtension(REACT_DEVELOPER_TOOLS);
    const extensionName =
      typeof extension === "string"
        ? extension
        : (extension?.name ?? "React Developer Tools");
    console.log(`Installed Electron extension: ${extensionName}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`React DevTools install failed: ${message}`);
  }
}

function appInfoView() {
  const pkg = readPackageJson(packagePath);
  return {
    name: safeString(pkg.productName) || appDisplayName,
    version: safeString(pkg.version) || "0.0.0",
    repository_url: appRepositoryUrl,
    protocol_version: appProtocolVersion,
    developer_mode_available: true,
    developer_mode_enabled: developerModeEnabled(),
  };
}

async function readSetupSettings() {
  const response = await fetch(new URL("/settings", serverUrl));
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.protocol_version !== appProtocolVersion) {
    const error = new Error("settings_unavailable");
    error.code = "settings_unavailable";
    throw error;
  }
  return body.data ?? {};
}

async function checkExistingServer() {
  const response = await fetch(new URL("/health", serverUrl));
  if (!response.ok) {
    const error = new Error("existing_agent_unavailable");
    error.code = "existing_agent_unavailable";
    throw error;
  }
}

function configureAppIdentity() {
  const pkg = readPackageJson(packagePath);
  app.setName(appDisplayName);
  if (process.platform === "win32") {
    app.setAppUserModelId("com.hexpy.butler");
  }
  app.setAboutPanelOptions({
    applicationName: appDisplayName,
    applicationVersion: safeString(pkg.version) || "0.0.0",
  });
}

function configureAppIcon() {
  if (!isMac) return;
  if (app.isPackaged) return;
  for (const iconPath of [macAppIconPath, appIconPath]) {
    if (!existsSync(iconPath)) continue;
    try {
      app.dock.setIcon(iconPath);
      return;
    } catch {
      // Keep the transparent source layer out of the runtime fallback path.
    }
  }
}

function appIconForWindow() {
  if (isMac && existsSync(macAppDockIconPath)) return macAppDockIconPath;
  return existsSync(appIconPath) ? appIconPath : undefined;
}

function trayIconPathForMenuBar() {
  const themedPath = nativeTheme.shouldUseDarkColors
    ? trayIconDarkThemePath
    : trayIconLightThemePath;
  const fallbackPaths = [
    themedPath,
    trayIconLightThemePath,
    trayIconDarkThemePath,
    appIconPath,
    appIconForWindow(),
  ];
  return fallbackPaths.find((iconPath) => iconPath && existsSync(iconPath));
}

function trayIconForMenuBar() {
  const iconPath = trayIconPathForMenuBar();
  if (!iconPath) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return image;
  const iconSize = isMac ? 18 : 20;
  return image.resize({ width: iconSize, height: iconSize, quality: "best" });
}

function updateTrayIcon() {
  if (!tray) return;
  tray.setImage(trayIconForMenuBar());
}

async function readAppData(path) {
  try {
    const response = await fetch(new URL(path, serverUrl));
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.protocol_version !== appProtocolVersion) {
      return null;
    }
    return body.data ?? null;
  } catch {
    return null;
  }
}

async function loadInitialNativeShellPreferences() {
  const settings = await readAppData("/settings");
  nativeShellPreferences.trayEnabled =
    settings?.desktop_tray_enabled !== false;
}

async function recentTraySessions() {
  const navigation = await readAppData("/navigation");
  const chats = Array.isArray(navigation?.chats) ? navigation.chats : [];
  return chats
    .filter((chat) => typeof chat?.id === "string" && chat.id.trim())
    .slice(0, 6)
    .map((chat) => ({
      id: chat.id,
      title: safeString(chat.title) || "Untitled conversation",
    }));
}

async function refreshTrayMenu() {
  if (!nativeShellPreferences.trayEnabled) {
    if (tray) {
      tray.destroy();
      tray = null;
    }
    return;
  }
  if (!tray) {
    tray = new Tray(trayIconForMenuBar());
    tray.setToolTip(appDisplayName);
    tray.on("click", () => {
      void showMainWindow();
    });
  } else {
    updateTrayIcon();
  }
  const sessions = await recentTraySessions();
  const recentMenu =
    sessions.length > 0
      ? sessions.map((session) => ({
          label: session.title,
          click: () =>
            sendNativeNavigation({
              action: "open-session",
              sessionId: session.id,
            }),
        }))
      : [{ label: "No recent conversations", enabled: false }];
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show Butler",
        click: () => {
          void showMainWindow();
        },
      },
      {
        label: "New Chat",
        click: () => sendNativeNavigation({ action: "new-chat" }),
      },
      {
        label: "Recent Conversations",
        submenu: recentMenu,
      },
      { type: "separator" },
      {
        label: "Quit Butler",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function scheduleTrayMenuRefresh() {
  void refreshTrayMenu().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Tray menu refresh failed: ${message}`);
  });
}

async function showMainWindow() {
  const win =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow : await createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

function sendNativeNavigation(request) {
  void showMainWindow()
    .then((win) => {
      const send = () => win.webContents.send("butler:native-navigation", request);
      if (win.webContents.isLoading()) {
        win.webContents.once("did-finish-load", send);
      } else {
        send();
      }
    })
    .catch(handleFatalStartupError);
}

function normalizeDesktopNotification(input = {}) {
  return {
    kind:
      input?.kind === "task_completion"
        ? "task_completion"
        : input?.kind === "test"
          ? "test"
          : "assistant_message",
    title: safeString(input?.title) || appDisplayName,
    body: safeString(input?.body) || "Butler update is ready.",
    sessionId: safeString(input?.sessionId),
    force: input?.force === true,
  };
}

function notificationPlatformDetailsCode(supported) {
  if (!supported) return "unsupported";
  if (process.platform === "darwin") return "macos-permission";
  if (process.platform === "win32") return "windows-shortcut";
  if (process.platform === "linux") return "linux-libnotify";
  return "platform-dependent";
}

function notificationSettingsUrl() {
  if (process.platform === "darwin") return macNotificationSettingsUrl;
  if (process.platform === "win32") return winNotificationSettingsUrl;
  return null;
}

function notificationSettingsTarget() {
  if (process.platform === "darwin") return "macos-notifications";
  if (process.platform === "win32") return "windows-notifications";
  return null;
}

async function nativeNotificationStatus() {
  const supported =
    typeof Notification.isSupported !== "function" ||
    Notification.isSupported();
  const settingsUrl = notificationSettingsUrl();
  const settingsTarget = notificationSettingsTarget();
  return {
    platform: process.platform,
    supported,
    permission: supported ? "unknown" : "unsupported",
    source: "electron",
    details_code: notificationPlatformDetailsCode(supported),
    can_open_settings: Boolean(settingsUrl),
    settings_target: settingsTarget,
    last_error: nativeNotificationState.lastError,
    last_attempted_at: nativeNotificationState.lastAttemptedAt,
    last_shown_at: nativeNotificationState.lastShownAt,
  };
}

async function openNativeNotificationSettings() {
  const settingsUrl = notificationSettingsUrl();
  if (!settingsUrl) {
    return {
      opened: false,
      reason: "unsupported",
      status: await nativeNotificationStatus(),
    };
  }
  try {
    await shell.openExternal(settingsUrl, { activate: true });
    return {
      opened: true,
      status: await nativeNotificationStatus(),
    };
  } catch (error) {
    nativeNotificationState.lastError =
      error instanceof Error ? error.message : String(error);
    return {
      opened: false,
      reason: "failed",
      error: nativeNotificationState.lastError,
      status: await nativeNotificationStatus(),
    };
  }
}

async function showNativeNotification(input = {}) {
  if (typeof Notification.isSupported === "function" && !Notification.isSupported()) {
    return {
      shown: false,
      reason: "unsupported",
      status: await nativeNotificationStatus(),
    };
  }
  const notificationInput = normalizeDesktopNotification(input);
  const focusedWindow = BrowserWindow.getFocusedWindow();
  if (!notificationInput.force && focusedWindow?.isVisible()) {
    return {
      shown: false,
      reason: "focused",
      status: await nativeNotificationStatus(),
    };
  }
  nativeNotificationState.lastAttemptedAt = new Date().toISOString();
  nativeNotificationState.lastError = null;
  return await new Promise((resolveNotification) => {
    let settled = false;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      resolveNotification({
        ...result,
        status: await nativeNotificationStatus(),
      });
    };
    const notification = new Notification({
      title: notificationInput.title,
      body: notificationInput.body,
      icon: appIconForWindow(),
    });
    notification.on("click", () => {
      if (notificationInput.sessionId) {
        sendNativeNavigation({
          action: "open-session",
          sessionId: notificationInput.sessionId,
        });
        return;
      }
      void showMainWindow();
    });
    notification.once("show", () => {
      nativeNotificationState.lastShownAt = new Date().toISOString();
      void finish({ shown: true, kind: notificationInput.kind });
    });
    notification.once("failed", (_event, error) => {
      nativeNotificationState.lastError = safeString(error) || "Notification failed.";
      void finish({
        shown: false,
        reason: "failed",
        error: nativeNotificationState.lastError,
        kind: notificationInput.kind,
      });
    });
    notification.show();
    setTimeout(() => {
      void finish({ shown: true, kind: notificationInput.kind });
    }, 1500);
  });
}

function readPackageJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function nativeSettingsPath() {
  return resolve(app.getPath("userData"), nativeSettingsFileName);
}

function readNativeSettings() {
  if (nativeSettingsCache) return nativeSettingsCache;
  try {
    const parsed = JSON.parse(readFileSync(nativeSettingsPath(), "utf8"));
    nativeSettingsCache = {
      developerModeEnabled: parsed?.developer_mode_enabled === true,
    };
  } catch {
    nativeSettingsCache = { developerModeEnabled: false };
  }
  return nativeSettingsCache;
}

async function writeNativeSettings(settings) {
  nativeSettingsCache = {
    developerModeEnabled: settings.developerModeEnabled === true,
  };
  const path = nativeSettingsPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        schema: nativeSettingsSchema,
        developer_mode_enabled: nativeSettingsCache.developerModeEnabled,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function developerModeEnabled() {
  return readNativeSettings().developerModeEnabled === true;
}

async function setDeveloperMode(enabled) {
  await writeNativeSettings({ developerModeEnabled: enabled });
  if (enabled) {
    await installDevtools();
  }
  applyDeveloperModeToWindows(enabled);
  return appInfoView();
}

function applyDeveloperModeToWindows(enabled = developerModeEnabled()) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (enabled) {
      win.webContents.openDevTools({ mode: "detach" });
    } else if (win.webContents.isDevToolsOpened()) {
      win.webContents.closeDevTools();
    }
  }
}

function isDevToolsAccelerator(input) {
  const key = String(input?.key ?? "").toLocaleLowerCase("en-US");
  if (key === "f12") return true;
  const modifier = input?.meta || input?.control;
  return Boolean(
    modifier &&
    (input?.alt || input?.shift) &&
    (key === "i" || key === "j" || key === "c"),
  );
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function createWindow() {
  await ensureServer();
  await loadInitialNativeShellPreferences();
  scheduleTrayMenuRefresh();
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const win = new BrowserWindow({
    width: 960,
    height: 710,
    minWidth: 320,
    minHeight: 480,
    title: appDisplayName,
    icon: appIconForWindow(),
    titleBarStyle: "hidden",
    trafficLightPosition: macTrafficLightPosition,
    transparent: isMac,
    vibrancy: isMac ? macVibrancy : undefined,
    visualEffectState: isMac ? "active" : undefined,
    roundedCorners: true,
    hasShadow: true,
    autoHideMenuBar: true,
    backgroundColor: isMac ? macTransparentBackground : "#f6f6f4",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.on("close", (event) => {
    if (!nativeShellPreferences.trayEnabled || isQuitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  if (isMac) {
    // Keep the web renderer and native material transparent after BrowserWindow setup.
    win.setBackgroundColor(macTransparentBackground);
    win.setVibrancy(macVibrancy);
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (openExternalUrl(url)) return { action: "deny" };
    return { action: "deny" };
  });
  win.webContents.on("before-input-event", (event, input) => {
    if (!developerModeEnabled() && isDevToolsAccelerator(input)) {
      event.preventDefault();
    }
  });
  win.webContents.on("devtools-opened", () => {
    if (!developerModeEnabled()) {
      win.webContents.closeDevTools();
    }
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isAppNavigationUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });
  await win.loadURL(rendererUrl);
  applyDeveloperModeToWindows();
  return win;
}

ipcMain.handle("butler:get-app-info", () => appInfoView());

ipcMain.handle("butler:set-developer-mode", async (_event, input) => {
  return await setDeveloperMode(input?.enabled === true);
});

ipcMain.handle("butler:first-run-setup-status", () =>
  firstRunSetupBridge.status(),
);

ipcMain.handle("butler:first-run-setup-start", async (_event, input) =>
  await firstRunSetupBridge.start(input ?? {}),
);

ipcMain.handle("butler:first-run-setup-cancel", () =>
  firstRunSetupBridge.cancel(),
);

ipcMain.handle("butler:first-run-setup-diagnostics", () =>
  firstRunSetupBridge.diagnostics(),
);

ipcMain.handle("butler:set-native-appearance-theme", (_event, input) => {
  const themeSource = normalizeAppearanceThemeSource(input?.theme);
  nativeTheme.themeSource = themeSource;
  updateTrayIcon();
  if (isMac) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(macTransparentBackground);
      win.setVibrancy(macVibrancy);
    }
  }
  return {
    theme_source: nativeTheme.themeSource,
    should_use_dark_colors: nativeTheme.shouldUseDarkColors,
  };
});

ipcMain.handle("butler:set-native-shell-preferences", async (_event, input) => {
  nativeShellPreferences.trayEnabled = input?.trayEnabled !== false;
  await refreshTrayMenu();
  return {
    desktop_tray_enabled: nativeShellPreferences.trayEnabled,
  };
});

ipcMain.handle("butler:get-native-notification-status", async () => {
  return await nativeNotificationStatus();
});

ipcMain.handle("butler:test-desktop-notification", async () => {
  return await showNativeNotification({
    kind: "test",
    title: appDisplayName,
    body: "알림 테스트가 도착했습니다.",
    force: true,
  });
});

ipcMain.handle("butler:open-native-notification-settings", async () => {
  return await openNativeNotificationSettings();
});

ipcMain.handle("butler:show-desktop-notification", async (_event, input) => {
  return await showNativeNotification(input);
});

ipcMain.handle("butler:select-project-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose Butler project folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  const folderPath = resolve(result.filePaths[0]);
  return {
    cancelled: false,
    display_name: basename(folderPath) || "Project",
    folder_selection_token: createProjectFolderSelectionToken(
      folderPath,
      projectFolderTokenSecret,
    ),
  };
});

ipcMain.handle("butler:save-message-file", async (_event, input = {}) => {
  const fileId = typeof input?.fileId === "string" ? input.fileId : "";
  if (!messageFileIdPattern.test(fileId)) {
    throw new Error("Invalid Butler artifact file.");
  }
  const suggestedName = safeSaveFileName(input?.suggestedName);
  const result = await dialog.showSaveDialog({
    title: "Save Butler artifact",
    defaultPath: suggestedName,
    buttonLabel: "Save",
  });
  if (result.canceled || !result.filePath) return { saved: false };
  const artifactResponse = await fetch(
    new URL(`/message-files/${encodeURIComponent(fileId)}`, serverUrl),
  );
  if (!artifactResponse.ok) {
    throw new Error("Unable to load Butler artifact.");
  }
  const bytes = Buffer.from(await artifactResponse.arrayBuffer());
  await writeFile(result.filePath, bytes);
  return { saved: true };
});

function normalizeAppearanceThemeSource(value) {
  return appearanceThemeSources.has(value) ? value : "system";
}

function safeSaveFileName(value) {
  const fallback = "artifact";
  if (typeof value !== "string") return fallback;
  const withoutControlCharacters = Array.from(basename(value), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 ? "_" : character;
  }).join("");
  const name = withoutControlCharacters
    .replace(/[\\/:*?"<>|]+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 160);
  return name || fallback;
}

app
  .whenReady()
  .then(async () => {
    configureAppIdentity();
    configureAppIcon();
    Menu.setApplicationMenu(null);
    nativeTheme.on("updated", updateTrayIcon);
    await installDevtools();
    await createWindow();
  })
  .catch(handleFatalStartupError);

app.on("window-all-closed", () => {
  if (nativeShellPreferences.trayEnabled) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  void showMainWindow().catch(handleFatalStartupError);
});

app.on("before-quit", () => {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  stopServerProcess();
});

process.once("SIGINT", () => {
  stopServerProcess();
  app.quit();
});

process.once("SIGTERM", () => {
  stopServerProcess();
  app.quit();
});

function stopServerProcess() {
  if (!serverProcess) return;
  serverProcess.kill("SIGTERM");
  serverShutdownKillTimer = setTimeout(() => {
    if (serverProcess) serverProcess.kill("SIGKILL");
  }, 2000);
}

function createProjectFolderSelectionToken(folderPath, secret) {
  const issuedAt = Date.now();
  const payload = Buffer.from(
    JSON.stringify({
      path: resolve(folderPath),
      issued_at: issuedAt,
      expires_at: issuedAt + projectFolderTokenTtlMs,
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `v1.${payload}.${signature}`;
}

function handleFatalStartupError(error) {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(message);
  stopServerProcess();
  app.quit();
}

function normalizeLocalHttpUrl(value, label) {
  const url = new URL(value);
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  const isLocalhost =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "http:" || !isLocalhost) {
    throw new Error(`${label} must be a local http origin.`);
  }
  return url.toString();
}

function normalizePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

function localServerUrlForPort(nextPort) {
  return `http://127.0.0.1:${nextPort}`;
}

function syncPreloadServerEnvironment() {
  process.env.BUTLER_APP_SERVER_PORT = String(port);
  process.env.BUTLER_APP_SERVER_URL = serverUrl;
}

function updateManagedServerPort(nextPort) {
  port = nextPort;
  serverUrl = normalizeLocalHttpUrl(
    localServerUrlForPort(port),
    "Butler app server URL",
  );
  if (!explicitUiUrl) {
    rendererUrl = serverUrl;
  }
  rendererOrigin = new URL(rendererUrl).origin;
  serverHealthUrl = new URL("/health", serverUrl).toString();
  syncPreloadServerEnvironment();
}

async function isPortAvailable(candidatePort) {
  return new Promise((resolveAvailable) => {
    const probe = createServer();
    probe.once("error", () => resolveAvailable(false));
    probe.once("listening", () => {
      probe.close(() => resolveAvailable(true));
    });
    probe.listen(candidatePort, "127.0.0.1");
  });
}

async function findAvailablePort(startPort) {
  const firstPort = Math.max(
    1024,
    Math.min(65535, normalizePort(startPort, 18766)),
  );
  for (
    let offset = 0;
    offset < 200 && firstPort + offset <= 65535;
    offset += 1
  ) {
    const candidatePort = firstPort + offset;
    if (await isPortAvailable(candidatePort)) return candidatePort;
  }
  throw new Error(
    `Unable to find an available Butler app server port near ${firstPort}.`,
  );
}

function isAppNavigationUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === rendererOrigin || url.origin === new URL(serverUrl).origin
    );
  } catch {
    return false;
  }
}

function openExternalUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return false;
  void shell.openExternal(url.toString());
  return true;
}
