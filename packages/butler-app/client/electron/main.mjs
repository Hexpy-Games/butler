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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBundledAgentSupervisor } from "./app-agent-supervisor.mjs";
import { createAppAgentNativeServiceBridge } from "./app-agent-native-service-bridge.mjs";
import { createAppAgentServiceAdapter } from "./app-agent-service-adapter.mjs";
import {
  appManagedAgentPointerPath,
  resolveAppManagedGatewayCommand,
} from "./app-managed-runtime.mjs";
import { createAgentServiceControl } from "./service-control.mjs";
import { createFirstRunSetupBridge } from "./setup-bridge.mjs";
import { createTrayAgentMenuModel } from "./tray-agent-menu.mjs";

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
const appServerProbeTimeoutMs = 2000;
const nativeServiceGatewayReadyPollAttempts = 120;
const nativeServiceGatewayReadyPollDelayMs = 250;
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
  : defaultRendererUrl();
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
let nativeSettingsCache = null;
let mainWindow = null;
let tray = null;
let isQuitting = false;
let nativeServiceGatewayReady = false;
let nativeServiceGatewayLastErrorCode = null;
const nativeShellPreferences = {
  trayEnabled: true,
};
const nativeNotificationState = {
  lastError: null,
  lastAttemptedAt: null,
  lastShownAt: null,
};
let openAIOAuthLoginSession = null;
const bundledAgentSupervisor = createBundledAgentSupervisor({
  butlerData: butlerDataRoot,
  resolveGateway: managedGatewayCommand,
  spawnProcess: spawn,
  healthCheck: healthOk,
  readinessCheck: gatewayReady,
  isPortAvailable,
  findAvailablePort,
  updatePort: updateManagedServerPort,
  getPort: () => port,
  getServerUrl: () => serverUrl,
  getRendererOrigin: () => rendererOrigin,
  explicitServerUrl,
  explicitUiUrl,
  projectFolderTokenSecret,
});
const appAgentNativeServiceBridge = shouldUseAppAgentNativeServiceBridge()
  ? createAppAgentNativeServiceBridge({
      butlerData: butlerDataRoot,
      serviceLabel: appAgentServiceLabel(),
      systemdUnit: appAgentSystemdUnit(),
      getPort: () => port,
      ensureRuntimePointer: ensureAppManagedAgentRuntimePointer,
    })
  : null;
const appAgentServiceAdapter = appAgentNativeServiceBridge
  ? createAppAgentServiceAdapter(appAgentNativeServiceBridge)
  : null;
const agentServiceControl = createAgentServiceControl({
  platform: process.platform,
  adapter: appAgentServiceAdapter,
});
const firstRunSetupBridge = createFirstRunSetupBridge({
  ensureReady: ensureServer,
  gatewayProfile: "electron",
  readSettings: readSetupSettings,
  readRuntimeDiagnostics: readFirstRunRuntimeDiagnostics,
  serviceControl: agentServiceControl,
});
app.setName(appDisplayName);
const appSingleInstanceLock = app.requestSingleInstanceLock();
if (!appSingleInstanceLock) {
  isQuitting = true;
  app.quit();
} else {
  app.on("second-instance", () => {
    void showMainWindow().catch(handleFatalStartupError);
  });
}
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
  const appManagedGateway = resolveAppManagedGatewayCommand({
    butlerData: butlerDataRoot,
    env: process.env,
    resourcesPath: process.resourcesPath,
  });
  if (appManagedGateway) return appManagedGateway;
  if (app.isPackaged) {
    throw new Error("Packaged Butler App is missing bundled Agent resources.");
  }
  for (const home of candidateButlerHomes()) {
    const localButlerCli = resolve(home, "bin", "butler.js");
    if (!existsSync(localButlerCli)) continue;
    const data = butlerDataRoot;
    const runtime = resolveButlerRuntime(data);
    return {
      command: runtime,
      args: [localButlerCli, "gateway", "app"],
      cwd: home,
      appManaged: false,
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
    appManaged: false,
  };
}

function ensureAppManagedAgentRuntimePointer() {
  const appManagedGateway = resolveAppManagedGatewayCommand({
    butlerData: butlerDataRoot,
    env: process.env,
    resourcesPath: process.resourcesPath,
  });
  if (!appManagedGateway?.appManaged) {
    const error = new Error("App-managed Agent runtime is unavailable.");
    error.code = "app_managed_runtime_unavailable";
    throw error;
  }
  appManagedGateway.commitActivation?.();
  return appManagedGateway;
}

function shouldUseAppAgentNativeServiceBridge() {
  if (app.isPackaged && ["darwin", "linux"].includes(process.platform)) return true;
  if (process.env.BUTLER_APP_FORCE_NATIVE_SERVICE_BRIDGE !== "1") return false;
  assertNativeServiceTestBridgeEnvironment();
  return ["darwin", "linux"].includes(process.platform);
}

function appAgentServiceLabel() {
  if (process.env.BUTLER_APP_FORCE_NATIVE_SERVICE_BRIDGE !== "1") return undefined;
  return process.env.BUTLER_APP_SERVICE_LABEL?.trim() || undefined;
}

function appAgentSystemdUnit() {
  if (process.env.BUTLER_APP_FORCE_NATIVE_SERVICE_BRIDGE !== "1") return undefined;
  return process.env.BUTLER_APP_SYSTEMD_UNIT?.trim() || undefined;
}

function assertNativeServiceTestBridgeEnvironment() {
  if (process.env.BUTLER_APP_ALLOW_NATIVE_SERVICE_TEST_ENV !== "1") {
    throw new Error("Native service bridge force mode requires test-env consent.");
  }
  const serviceLabel = appAgentServiceLabel();
  if (!serviceLabel || serviceLabel === "com.hexpy.butler") {
    throw new Error("Native service bridge test mode requires a non-production service label.");
  }
  const systemdUnit = appAgentSystemdUnit();
  if (!systemdUnit || systemdUnit === "butler.service") {
    throw new Error("Native service bridge test mode requires a non-production systemd unit.");
  }
  if (port === 18765) {
    throw new Error("Native service bridge test mode requires a non-production app server port.");
  }
  const realButlerData = resolve(userHome, ".butler");
  const resolvedData = resolve(butlerDataRoot);
  if (resolvedData === realButlerData || isInsidePath(realButlerData, resolvedData)) {
    throw new Error("Native service bridge test mode refuses to use the production Butler data directory.");
  }
}

function isInsidePath(parent, child) {
  const diff = relative(parent, child);
  return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
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

async function healthOk(localAuth = null) {
  try {
    const response = await appServerProbeFetch(serverHealthUrl, localAuth);
    const body = await response.json().catch(() => null);
    return (
      response.ok &&
      body?.protocol_version === appProtocolVersion &&
      body?.data?.ok === true
    );
  } catch {
    return false;
  }
}

async function gatewayReady(localAuth = null) {
  try {
    const response = await appServerProbeFetch(new URL("/settings", serverUrl), localAuth);
    const body = await response.json().catch(() => null);
    return (
      response.ok &&
      body?.protocol_version === appProtocolVersion &&
      body?.data?.gateway_profile === "electron"
    );
  } catch {
    return false;
  }
}

async function appServerProbeFetch(url, localAuth = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), appServerProbeTimeoutMs);
  try {
    return await fetch(url, {
      headers: localAuth?.authorization
        ? { authorization: localAuth.authorization }
        : localAuth?.token
          ? { authorization: `Bearer ${localAuth.token}` }
          : {},
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureServer() {
  if (shouldUseAppAgentNativeServiceBridge()) {
    await waitForNativeServiceGatewayReady();
    return;
  }
  await bundledAgentSupervisor.ensureReady();
}

async function waitForNativeServiceGatewayReady({
  attempts = nativeServiceGatewayReadyPollAttempts,
  delayMs = nativeServiceGatewayReadyPollDelayMs,
} = {}) {
  let lastErrorCode = "service_gateway_unhealthy";
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const authHeaders = bundledAgentSupervisor.authHeaders();
    const healthy = await healthOk(authHeaders);
    const ready = healthy && await gatewayReady(authHeaders);
    if (ready) {
      nativeServiceGatewayReady = true;
      nativeServiceGatewayLastErrorCode = null;
      return;
    }
    lastErrorCode = healthy ? "service_gateway_not_ready" : "service_gateway_unhealthy";
    if (attempt + 1 < maxAttempts) await sleep(delayMs);
  }
  nativeServiceGatewayReady = false;
  nativeServiceGatewayLastErrorCode = lastErrorCode;
  const error = new Error("Butler Agent service gateway is not ready.");
  error.code = nativeServiceGatewayLastErrorCode;
  throw error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readFirstRunRuntimeDiagnostics() {
  if (shouldUseAppAgentNativeServiceBridge()) {
    const authHeaders = bundledAgentSupervisor.authHeaders();
    return {
      phase: nativeServiceGatewayReady ? "running" : "failed",
      bundled_agent: {
        source: "app-managed",
        version_configured: appManagedRuntimePointerReady(),
      },
      local_auth: {
        required: true,
        token_configured: Boolean(authHeaders.authorization),
      },
      last_error_code: nativeServiceGatewayLastErrorCode,
      app_managed_runtime_failure: nativeServiceGatewayReady
        ? null
        : readLatestAppManagedRuntimeFailure(),
      raw_text_included: false,
    };
  }
  const diagnostics = bundledAgentSupervisor.diagnostics();
  return {
    ...diagnostics,
    app_managed_runtime_failure:
      diagnostics.phase === "failed" ? readLatestAppManagedRuntimeFailure() : null,
  };
}

function appManagedRuntimePointerReady() {
  try {
    const pointer = JSON.parse(readFileSync(appManagedAgentPointerPath(butlerDataRoot), "utf8"));
    return pointer?.product === "butler-app" &&
      pointer?.gateway_profile === "electron" &&
      typeof pointer?.runtime_home === "string" &&
      pointer.runtime_home.length > 0;
  } catch {
    return false;
  }
}

function codexOAuthClientId() {
  return (
    process.env.BUTLER_CODEX_OAUTH_CLIENT_ID ||
    process.env.BUTLER_OPENAI_OAUTH_CLIENT_ID ||
    "app_EMoamEEZ73f0CkXaXp7hrann"
  );
}

function codexAuthProfilePath() {
  return (
    process.env.BUTLER_CODEX_AUTH_PROFILE ||
    process.env.BUTLER_OPENAI_AUTH_PROFILE ||
    join(butlerDataRoot, "auth", "openai-codex.json")
  );
}

async function readCodexAuthProfileLabel() {
  try {
    const parsed = JSON.parse(await readFile(codexAuthProfilePath(), "utf8"));
    return safeString(parsed.email) ||
      safeString(parsed.accountId) ||
      "OpenAI account";
  } catch {
    return null;
  }
}

async function oauthLoginScriptPath() {
  const candidates = [
    process.resourcesPath
      ? join(
          process.resourcesPath,
          "bundled-agent",
          "packages",
          "butler-agent",
          "scripts",
          "openai-oauth-login.ts",
        )
      : null,
    resolve(repoRoot, "packages", "butler-agent", "scripts", "openai-oauth-login.ts"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function oauthScriptButlerHome(scriptPath) {
  return resolve(dirname(scriptPath), "../../..");
}

async function startOpenAIOAuthLogin(input = {}) {
  if (input?.force === true) {
    cancelOpenAIOAuthLogin();
  }
  const existingLabel = input?.force === true ? null : await readCodexAuthProfileLabel();
  if (existingLabel) {
    return { status: "profile_exists", label: existingLabel };
  }
  if (["pending", "starting"].includes(openAIOAuthLoginSession?.status)) {
    return oauthLoginSessionView(openAIOAuthLoginSession);
  }
  const scriptPath = await oauthLoginScriptPath();
  if (!scriptPath) throw new Error("OpenAI OAuth login helper is missing.");
  const runtime = resolveButlerRuntime(butlerDataRoot);
  const env = {
    ...process.env,
    BUTLER_HOME: oauthScriptButlerHome(scriptPath),
    BUTLER_DATA: butlerDataRoot,
    BUTLER_BUN: runtime,
    BUTLER_CODEX_OAUTH_CLIENT_ID: codexOAuthClientId(),
    BUTLER_CODEX_OAUTH_NO_BROWSER: "1",
  };
  return await beginOAuthLoginProcess(runtime, ["run", scriptPath], env);
}

async function openAIOAuthLoginStatus() {
  if (
    openAIOAuthLoginSession?.status === "pending" ||
    openAIOAuthLoginSession?.status === "starting"
  ) {
    const label = await readCodexAuthProfileLabel();
    if (label) {
      openAIOAuthLoginSession.status = "completed";
      openAIOAuthLoginSession.label = label;
      return oauthLoginSessionView(openAIOAuthLoginSession);
    }
  }
  if (openAIOAuthLoginSession) {
    return oauthLoginSessionView(openAIOAuthLoginSession);
  }
  const existingLabel = await readCodexAuthProfileLabel();
  return existingLabel
    ? { status: "profile_exists", label: existingLabel }
    : { status: "idle" };
}

async function submitOpenAIOAuthCallback(input = {}) {
  const session = openAIOAuthLoginSession;
  if (!session || session.status !== "pending") {
    throw new Error("OAuth login is not pending.");
  }
  const callbackUrl = safeString(input?.callbackUrl);
  if (!callbackUrl) throw new Error("OAuth callback URL is required.");
  const url = new URL(callbackUrl);
  const hostname = url.hostname.toLocaleLowerCase("en-US");
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (url.protocol !== "http:" || !isLocalhost || url.pathname !== "/auth/callback") {
    throw new Error("OAuth callback URL must be a local callback URL.");
  }
  assertOAuthCallbackMatchesSession(url, session);
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return await waitForOAuthCompletion();
}

function cancelOpenAIOAuthLogin() {
  if (
    openAIOAuthLoginSession?.child &&
    ["pending", "starting"].includes(openAIOAuthLoginSession.status)
  ) {
    openAIOAuthLoginSession.child.kill("SIGTERM");
    openAIOAuthLoginSession.status = "cancelled";
  }
  return oauthLoginSessionView(openAIOAuthLoginSession);
}

function assertOAuthCallbackMatchesSession(url, session) {
  if (!session.redirectUri) {
    throw new Error("OAuth login redirect URI is missing.");
  }
  const expectedRedirect = new URL(session.redirectUri);
  if (
    url.origin !== expectedRedirect.origin ||
    url.pathname !== expectedRedirect.pathname
  ) {
    throw new Error("OAuth callback URL does not match the active login.");
  }
  const expectedState = session.state ||
    (session.authUrl ? new URL(session.authUrl).searchParams.get("state") : null);
  if (expectedState && url.searchParams.get("state") !== expectedState) {
    throw new Error("OAuth callback state mismatch.");
  }
}

async function waitForOAuthCompletion(timeoutMs = 10_000) {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    const status = await openAIOAuthLoginStatus();
    if (["completed", "profile_exists", "failed", "cancelled"].includes(status.status)) {
      return status;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return await openAIOAuthLoginStatus();
}

function beginOAuthLoginProcess(command, args, env) {
  return new Promise((resolveProcess, rejectProcess) => {
    const session = {
      id: randomUUID(),
      status: "starting",
      authUrl: null,
      redirectUri: null,
      error: null,
      child: null,
    };
    openAIOAuthLoginSession = session;
    const child = spawn(command, args, {
      cwd: env.BUTLER_HOME,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.child = child;
    let stderr = "";
    let stdout = "";
    let resolved = false;
    const urlTimeout = setTimeout(() => {
      session.status = "failed";
      session.error = "OAuth login URL was not produced.";
      child.kill("SIGTERM");
      rejectOnce(new Error(session.error));
    }, 10_000);
    const resolveOnce = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(urlTimeout);
      resolveProcess(oauthLoginSessionView(session));
    };
    const rejectOnce = (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(urlTimeout);
      rejectProcess(error);
    };
    child.stdout?.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-4000);
      const authUrl = stdout.split(/\r?\n/u).find((line) =>
        /^https?:\/\//u.test(line.trim()),
      );
      if (!authUrl || session.authUrl) return;
      session.status = "pending";
      session.authUrl = authUrl.trim();
      session.redirectUri = redirectUriFromAuthUrl(session.authUrl);
      session.state = stateFromAuthUrl(session.authUrl);
      void shell.openExternal(session.authUrl);
      resolveOnce();
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4000);
    });
    child.on("error", (error) => {
      session.status = "failed";
      session.error = error instanceof Error ? error.message : String(error);
      rejectOnce(error);
    });
    child.on("exit", (code, signal) => {
      if (code === 0) {
        void readCodexAuthProfileLabel().then((label) => {
          session.status = "completed";
          session.label = label ?? "OpenAI account";
          resolveOnce();
        });
        return;
      }
      session.status = session.status === "cancelled" ? "cancelled" : "failed";
      session.error = stderr.trim() || `OAuth login exited with ${signal ?? code}.`;
      if (resolved) return;
      rejectOnce(new Error(session.error));
    });
  });
}

function redirectUriFromAuthUrl(value) {
  try {
    return new URL(value).searchParams.get("redirect_uri") ?? undefined;
  } catch {
    return undefined;
  }
}

function stateFromAuthUrl(value) {
  try {
    return new URL(value).searchParams.get("state") ?? undefined;
  } catch {
    return undefined;
  }
}

function oauthLoginSessionView(session) {
  if (!session) return { status: "idle" };
  return {
    status: session.status,
    ...(session.authUrl ? { auth_url: session.authUrl } : {}),
    ...(session.redirectUri ? { redirect_uri: session.redirectUri } : {}),
    ...(session.label ? { label: session.label } : {}),
    ...(session.error ? { error: session.error } : {}),
  };
}

function readLatestAppManagedRuntimeFailure() {
  const failuresDir = join(butlerDataRoot, "app", "runtime", "agent", "failures");
  try {
    const files = readdirSync(failuresDir)
      .filter((name) => name.endsWith(".json"))
      .sort();
    const latest = files.at(-1);
    if (!latest) return null;
    return JSON.parse(readFileSync(join(failuresDir, latest), "utf8"));
  } catch {
    return null;
  }
}

function defaultRendererUrl() {
  return resolveStaticRendererUrl() ?? serverUrl;
}

function resolveStaticRendererUrl() {
  const explicitRendererDist = process.env.BUTLER_APP_RENDERER_DIST;
  const candidates = [
    explicitRendererDist,
    process.resourcesPath ? join(process.resourcesPath, "app-client") : null,
    process.resourcesPath ? join(process.resourcesPath, "dist") : null,
    process.resourcesPath
      ? join(
          process.resourcesPath,
          "bundled-agent",
          "packages",
          "butler-agent",
          "resources",
          "app-client",
          "dist",
        )
      : null,
    resolve(__dirname, "..", "ui", "dist"),
    resolve(repoRoot, "packages", "butler-app", "client", "ui", "dist"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const indexPath = resolve(candidate, "index.html");
    if (existsSync(indexPath)) return pathToFileURL(indexPath).toString();
  }
  return null;
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
  const response = await appServerFetch("/settings");
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.protocol_version !== appProtocolVersion) {
    const error = new Error("settings_unavailable");
    error.code = "settings_unavailable";
    throw error;
  }
  return body.data ?? {};
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
    const response = await appServerFetch(path);
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

async function trayAgentServiceStatus() {
  try {
    return await agentServiceControl.getAgentServiceStatus();
  } catch {
    return {
      status: "failed",
      service_available: false,
      diagnostics_available: true,
    };
  }
}

async function runTrayAgentServiceAction(action) {
  const actions = {
    start: () => agentServiceControl.startAgentService({ source: "tray" }),
    stop: () => agentServiceControl.stopAgentService({ source: "tray" }),
    restart: () => agentServiceControl.restartAgentService({ source: "tray" }),
  };
  await actions[action]?.();
  await refreshTrayMenu();
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
  const agentServiceStatus = await trayAgentServiceStatus();
  const agentMenu = createTrayAgentMenuModel(agentServiceStatus);
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
        label: "Open Butler",
        click: () => {
          void showMainWindow();
        },
      },
      {
        label: agentMenu.label,
        enabled: false,
      },
      {
        label: "Start Butler Agent",
        enabled: agentMenu.canStart,
        click: () => {
          void runTrayAgentServiceAction("start");
        },
      },
      {
        label: "Restart Butler Agent",
        enabled: agentMenu.canRestart,
        click: () => {
          void runTrayAgentServiceAction("restart");
        },
      },
      {
        label: "Stop Butler Agent",
        enabled: agentMenu.canStop,
        click: () => {
          void runTrayAgentServiceAction("stop");
        },
      },
      { type: "separator" },
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
        label: "Quit Butler UI",
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
  if (rendererUrl === serverUrl) {
    await ensureServer();
  }
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

ipcMain.handle("butler:first-run-setup-start", async () =>
  await firstRunSetupBridge.start(),
);

ipcMain.handle("butler:ensure-server", async () => {
  await ensureServer();
  return { ready: true };
});

ipcMain.handle("butler:get-server-url", () => serverUrl);

ipcMain.handle("butler:first-run-setup-cancel", () =>
  firstRunSetupBridge.cancel(),
);

ipcMain.handle("butler:first-run-setup-diagnostics", () =>
  firstRunSetupBridge.diagnostics(),
);

ipcMain.handle("butler:agent-service-status", () =>
  agentServiceControl.getAgentServiceStatus(),
);

ipcMain.handle("butler:agent-service-install", (_event, input = {}) =>
  agentServiceControl.installAgentService(input ?? {}),
);

ipcMain.handle("butler:agent-service-start", (_event, input = {}) =>
  agentServiceControl.startAgentService(input ?? {}),
);

ipcMain.handle("butler:agent-service-stop", (_event, input = {}) =>
  agentServiceControl.stopAgentService(input ?? {}),
);

ipcMain.handle("butler:agent-service-restart", (_event, input = {}) =>
  agentServiceControl.restartAgentService(input ?? {}),
);

ipcMain.handle("butler:agent-runtime-update-prepare", (_event, input = {}) =>
  agentServiceControl.prepareAgentRuntimeUpdate(input ?? {}),
);

ipcMain.handle("butler:agent-runtime-update-apply", (_event, input = {}) =>
  agentServiceControl.applyAgentRuntimeUpdate(input ?? {}),
);

ipcMain.handle("butler:agent-runtime-update-rollback", (_event, input = {}) =>
  agentServiceControl.rollbackAgentRuntimeUpdate(input ?? {}),
);

ipcMain.handle("butler:agent-service-diagnostics", () =>
  agentServiceControl.readAgentServiceDiagnostics(),
);

ipcMain.handle("butler:quit-app", () => {
  isQuitting = true;
  app.quit();
  return { quitting: true };
});

ipcMain.handle("butler:get-local-auth-headers", async () =>
  await appLocalAuthHeaders(),
);

ipcMain.handle("butler:start-openai-oauth-login", async () =>
  await startOpenAIOAuthLogin(),
);

ipcMain.handle("butler:restart-openai-oauth-login", async () =>
  await startOpenAIOAuthLogin({ force: true }),
);

ipcMain.handle("butler:get-openai-oauth-login-status", async () =>
  await openAIOAuthLoginStatus(),
);

ipcMain.handle("butler:submit-openai-oauth-callback", async (_event, input) =>
  await submitOpenAIOAuthCallback(input),
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
    { headers: await appLocalAuthHeaders() },
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

if (appSingleInstanceLock) {
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
}

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
  void bundledAgentSupervisor.stop();
}

async function appServerFetch(path, init = {}) {
  return await fetch(new URL(path, serverUrl), {
    ...init,
    headers: {
      ...(await appLocalAuthHeaders()),
      ...(init.headers ?? {}),
    },
  });
}

async function appLocalAuthHeaders() {
  const headers = await bundledAgentSupervisor.authHeaders();
  const authorization =
    typeof headers?.authorization === "string" ? headers.authorization : "";
  return authorization ? { authorization } : {};
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
    rendererUrl = defaultRendererUrl();
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
    const renderer = new URL(rendererUrl);
    if (renderer.protocol === "file:") {
      return url.protocol === "file:" && url.pathname === renderer.pathname;
    }
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
