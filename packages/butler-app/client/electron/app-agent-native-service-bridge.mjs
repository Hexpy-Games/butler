import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { appManagedAgentPointerPath } from "./app-managed-runtime.mjs";
import { prepareAppLocalAuth } from "./app-agent-supervisor.mjs";

const APP_AGENT_SERVICE_IDS = [
  "embed-server",
  "butler-sync-consumer",
  "butler-scheduler",
  "butler-watchdog",
  "butler-main",
  "app-gateway",
];

const DEFAULT_SERVICE_LABEL = "com.hexpy.butler";
const DEFAULT_SYSTEMD_UNIT = "butler.service";
const SERVICE_COMMAND_TIMEOUT_MS = 15_000;

export function createAppAgentNativeServiceBridge({
  butlerData,
  platform = process.platform,
  homeDir = homedir(),
  serviceLabel = DEFAULT_SERVICE_LABEL,
  systemdUnit = DEFAULT_SYSTEMD_UNIT,
  getPort = () => 18765,
  getAppVersion = () => null,
  ensureRuntimePointer = () => {},
  prepareLocalAuth = () => prepareAppLocalAuth({ butlerData }),
  menuBarHelper = null,
  isPidRunning = defaultIsPidRunning,
  isProcessGroupRunning = defaultIsProcessGroupRunning,
  isPortAvailable = defaultIsPortAvailable,
  killPid = defaultKillPid,
  sleepMs = defaultSleepMs,
  runCommand = defaultRunCommand,
  writeFile = defaultWriteFile,
} = {}) {
  if (!butlerData) {
    throw new Error("missing Butler data root");
  }
  const resolvedServiceLabel = normalizeLaunchdLabel(serviceLabel);
  const resolvedSystemdUnit = normalizeSystemdUnit(systemdUnit);
  const resolvedMenuBarHelper = normalizeMenuBarHelper(menuBarHelper, resolvedServiceLabel);
  return {
    nativeServices: {
      list: async () => listNativeServiceProjections({ butlerData, isPidRunning }),
      start: async () => {
        const plan = createRegistrationPlan({
          action: "start",
          butlerData,
          platform,
          homeDir,
          serviceLabel: resolvedServiceLabel,
          systemdUnit: resolvedSystemdUnit,
          getPort,
          getAppVersion,
          ensureRuntimePointer,
          prepareLocalAuth,
          menuBarHelper: resolvedMenuBarHelper,
          isPidRunning,
        });
        await applyPlan(plan, {
          runCommand,
          writeFile,
          isPidRunning,
          isProcessGroupRunning,
          isPortAvailable,
          killPid,
          sleepMs,
        });
      },
      stop: async () => {
        const plan = createRegistrationPlan({
          action: "stop",
          butlerData,
          platform,
          homeDir,
          serviceLabel: resolvedServiceLabel,
          systemdUnit: resolvedSystemdUnit,
          getPort,
          getAppVersion,
          ensureRuntimePointer,
          prepareLocalAuth,
          menuBarHelper: resolvedMenuBarHelper,
          isPidRunning,
        });
        await applyPlan(plan, {
          runCommand,
          writeFile,
          isPidRunning,
          isProcessGroupRunning,
          isPortAvailable,
          killPid,
          sleepMs,
        });
      },
    },
    registration: {
      install: async () => {
        const plan = createRegistrationPlan({
          action: "install",
          butlerData,
          platform,
          homeDir,
          serviceLabel: resolvedServiceLabel,
          systemdUnit: resolvedSystemdUnit,
          getPort,
          getAppVersion,
          ensureRuntimePointer,
          prepareLocalAuth,
          menuBarHelper: resolvedMenuBarHelper,
          isPidRunning,
        });
        await applyPlan(plan, {
          runCommand,
          writeFile,
          isPidRunning,
          isProcessGroupRunning,
          isPortAvailable,
          killPid,
          sleepMs,
        });
      },
    },
  };
}

export function listNativeServiceProjections({
  butlerData,
  isPidRunning = defaultIsPidRunning,
}) {
  return APP_AGENT_SERVICE_IDS.map((serviceId) => {
    const state = readJson(serviceStatePath(butlerData, serviceId));
    if (!state) {
      return { serviceId, pid: null, status: "offline" };
    }
    const pid = Number(state.pid);
    return {
      serviceId,
      pid: Number.isInteger(pid) ? pid : null,
      status: Number.isInteger(pid) && isPidRunning(pid) ? "online" : "stale",
    };
  });
}

function isMenuBarHelperPidRunning({
  butlerData,
  isPidRunning = defaultIsPidRunning,
}) {
  const pid = readPositiveInteger(
    join(butlerData, "app", "runtime", "menu-bar-helper.pid"),
  );
  return Number.isInteger(pid) && isPidRunning(pid);
}

function createRegistrationPlan({
  action,
  butlerData,
  platform,
  homeDir,
  serviceLabel,
  systemdUnit,
  getPort,
  getAppVersion,
  ensureRuntimePointer,
  prepareLocalAuth,
  menuBarHelper,
  isPidRunning,
}) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`unsupported App Agent service platform: ${platform}`);
  }
  if (action === "stop") {
    return platform === "darwin"
      ? launchdPlan({ action, homeDir, runtime: null, serviceLabel, butlerData })
      : systemdPlan({ action, homeDir, runtime: null, systemdUnit });
  }
  const activation = ensureRuntimePointer();
  try {
    const runtime = resolveAppManagedServiceRuntime({
      butlerData,
      platform,
      getPort,
      getAppVersion,
      prepareLocalAuth,
    });
    if (platform === "darwin") {
      return {
        ...launchdPlan({
          action,
          homeDir,
          runtime,
          serviceLabel,
          butlerData,
          menuBarHelper,
          helperRunning: isMenuBarHelperPidRunning({ butlerData, isPidRunning }),
        }),
        activation,
      };
    }
    return { ...systemdPlan({ action, homeDir, runtime, systemdUnit }), activation };
  } catch (error) {
    activation?.rollbackActivation?.(normalizeError(error));
    throw error;
  }
}

function resolveAppManagedServiceRuntime({ butlerData, platform, getPort, getAppVersion, prepareLocalAuth }) {
  const pointerPath = appManagedAgentPointerPath(butlerData);
  const pointer = readJson(pointerPath);
  if (
    !pointer ||
    pointer.schema !== "butler.app-managed-agent-runtime-pointer.v1" ||
    pointer.product !== "butler-app" ||
    pointer.gateway_profile !== "electron" ||
    typeof pointer.runtime_home !== "string" ||
    !pointer.runtime_home.trim() ||
    isAbsolute(pointer.runtime_home)
  ) {
    throw new Error("invalid App-managed Agent runtime pointer");
  }
  const normalized = normalize(pointer.runtime_home);
  if (normalized === "." || normalized.startsWith("..")) {
    throw new Error("invalid App-managed Agent runtime pointer");
  }
  const runtimeHome = join(butlerData, normalized);
  const runtimeExecutable = join(
    runtimeHome,
    "packages",
    "butler-agent",
    "resources",
    "runtime",
    "bin",
    "bun",
  );
  const serviceDaemon = join(
    runtimeHome,
    "packages",
    "butler-agent",
    "scripts",
    "service-daemon.sh",
  );
  if (!existsSync(serviceDaemon)) {
    throw new Error("missing App-managed service daemon");
  }
  if (!existsSync(runtimeExecutable)) {
    throw new Error("missing App-managed runtime executable");
  }
  const localAuth = prepareLocalAuth();
  const port = Number(getPort());
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("invalid App-managed gateway port");
  }
  const embedSocket = prepareAppManagedEmbedSocket({ butlerData, platform });
  const appVersion = safeString(getAppVersion());
  return {
    butlerData,
    runtimeHome,
    runtimeExecutable,
    serviceDaemon,
    port,
    env: {
      BUTLER_HOME: runtimeHome,
      BUTLER_DATA: butlerData,
      BUTLER_BUN: runtimeExecutable,
      BUTLER_APP_MANAGED_RUNTIME_POINTER: pointerPath,
      BUTLER_APP_MANAGED_RUNTIME_HOME: runtimeHome,
      BUTLER_APP_SERVER_HOST: "127.0.0.1",
      BUTLER_APP_LOCAL_AUTH_FILE: localAuth.filePath,
      BUTLER_APP_LOCAL_AUTH_REQUIRED: "1",
      BUTLER_APP_GATEWAY_PID_FILE: "off",
      BUTLER_APP_SERVER_PORT: String(port),
      ...(appVersion ? { BUTLER_APP_VERSION: appVersion } : {}),
      EMBED_SOCKET: embedSocket,
      EMBED_HEALTH_PORT: "0",
    },
  };
}

export function prepareAppManagedEmbedSocket({
  butlerData,
  platform = process.platform,
  socketRoot = "/tmp",
  uid = typeof process.getuid === "function" ? process.getuid() : null,
}) {
  if (platform === "win32") {
    return join(butlerData, "app", "runtime", "embed", "embed.sock");
  }
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error("unable to resolve local user for App-managed embed socket");
  }

  const ownerDir = join(socketRoot, `butler-${uid}`);
  try {
    mkdirSync(ownerDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const ownerStat = lstatSync(ownerDir);
  if (!ownerStat.isDirectory() || ownerStat.uid !== uid) {
    throw new Error("unsafe App-managed embed socket directory");
  }
  chmodSync(ownerDir, 0o700);

  const socketId = createHash("sha256")
    .update(butlerData)
    .digest("hex")
    .slice(0, 20);
  return join(ownerDir, `embed-${socketId}.sock`);
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function launchdPlan({
  action,
  homeDir,
  runtime,
  serviceLabel,
  butlerData = runtime?.butlerData,
  menuBarHelper = null,
  helperRunning = false,
}) {
  const serviceFile = join(homeDir, "Library", "LaunchAgents", `${serviceLabel}.plist`);
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : "$UID"}`;
  const target = `${domain}/${serviceLabel}`;
  const helperPlan = runtime && menuBarHelper
    ? launchdMenuBarHelperPlan({ homeDir, runtime, serviceLabel, domain, menuBarHelper })
    : null;
  if (action === "install") {
    return {
      action,
      serviceFile,
      runtime,
      butlerData,
      body: launchdPlist(runtime, serviceLabel),
      files: helperPlan ? [{ path: helperPlan.serviceFile, body: helperPlan.body }] : [],
      steps: [
        serviceStep(["launchctl", "bootout", target], { optional: true }),
        terminateNativeServiceChildrenStep(),
        waitForNativeServiceChildrenExitStep(),
        waitForAppGatewayPortReleaseStep(),
        serviceStep(["launchctl", "bootstrap", domain, serviceFile]),
        serviceStep(["launchctl", "kickstart", "-k", target]),
        ...(helperPlan?.steps ?? []),
      ],
    };
  }
  if (action === "start") {
    const helperEnsureSteps = helperPlan && !helperRunning
      ? helperPlan.ensureSteps
      : [];
    return {
      action,
      serviceFile,
      runtime,
      butlerData,
      body: launchdPlist(runtime, serviceLabel),
      files: helperPlan ? [{ path: helperPlan.serviceFile, body: helperPlan.body }] : [],
      steps: [
        serviceStep(["launchctl", "bootout", target], { optional: true }),
        terminateNativeServiceChildrenStep(),
        waitForNativeServiceChildrenExitStep(),
        waitForAppGatewayPortReleaseStep(),
        serviceStep(["launchctl", "bootstrap", domain, serviceFile]),
        serviceStep(["launchctl", "kickstart", "-k", target]),
        ...helperEnsureSteps,
      ],
    };
  }
  return {
    action,
    serviceFile,
    runtime,
    butlerData,
    steps: [
      serviceStep(["launchctl", "bootout", target], { optional: true }),
      terminateNativeServiceChildrenStep(),
      waitForNativeServiceChildrenExitStep({ optional: true }),
      waitForAppGatewayPortReleaseStep({ optional: true }),
    ],
  };
}

function launchdMenuBarHelperPlan({ homeDir, runtime, serviceLabel, domain, menuBarHelper }) {
  const helperLabel = menuBarHelper.label;
  const serviceFile = join(homeDir, "Library", "LaunchAgents", `${helperLabel}.plist`);
  const target = `${domain}/${helperLabel}`;
  return {
    serviceFile,
    body: launchdMenuBarHelperPlist({
      runtime,
      serviceLabel,
      helperLabel,
      menuBarHelper,
    }),
    steps: [
      serviceStep(["launchctl", "bootout", target], { optional: true }),
      serviceStep(["launchctl", "bootstrap", domain, serviceFile], { optional: true }),
      serviceStep(["launchctl", "kickstart", "-k", target], { optional: true }),
    ],
    ensureSteps: [
      serviceStep(["launchctl", "bootstrap", domain, serviceFile], { optional: true }),
      serviceStep(["launchctl", "kickstart", target], { optional: true }),
    ],
  };
}

function systemdPlan({ action, homeDir, runtime, systemdUnit }) {
  const serviceFile = join(homeDir, ".config", "systemd", "user", systemdUnit);
  if (action === "install") {
    return {
      action,
      serviceFile,
      body: systemdUnitBody(runtime),
      steps: [
        serviceStep(["systemctl", "--user", "daemon-reload"]),
        serviceStep(["systemctl", "--user", "enable", "--now", systemdUnit]),
      ],
    };
  }
  if (action === "start" || action === "restart") {
    return {
      action,
      serviceFile,
      body: systemdUnitBody(runtime),
      steps: [
        serviceStep(["systemctl", "--user", "daemon-reload"]),
        serviceStep(["systemctl", "--user", action, systemdUnit]),
      ],
    };
  }
  return {
    action,
    serviceFile,
    steps: [serviceStep(["systemctl", "--user", action, systemdUnit])],
  };
}

function launchdPlist(runtime, serviceLabel) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(serviceLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xml(runtime.serviceDaemon)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(runtime.env).map(([key, value]) =>
    `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`,
  ).join("\n")}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(runtime.runtimeHome)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

function launchdMenuBarHelperPlist({ runtime, serviceLabel, helperLabel, menuBarHelper }) {
  const env = {
    BUTLER_DATA: runtime.butlerData,
    BUTLER_APP_AGENT_SERVICE_LABEL: serviceLabel,
    BUTLER_APP_BUNDLE_PATH: menuBarHelper.appBundlePath ?? "",
    BUTLER_APP_MAIN_EXECUTABLE: menuBarHelper.mainExecutablePath ?? "",
    BUTLER_APP_MENU_BAR_HELPER_PID_FILE: join(
      runtime.butlerData,
      "app",
      "runtime",
      "menu-bar-helper.pid",
    ),
    BUTLER_APP_SERVER_PORT: String(runtime.port),
    BUTLER_APP_SERVER_URL: `http://127.0.0.1:${runtime.port}/`,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(helperLabel)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(menuBarHelper.executablePath)}</string>
    <string>--butler-menu-bar-helper</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) =>
    `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`,
  ).join("\n")}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(dirname(menuBarHelper.executablePath))}</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function systemdUnitBody(runtime) {
  return `[Unit]
Description=Butler Agent service
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdPathValue(runtime.runtimeHome)}
${Object.entries(runtime.env).map(([key, value]) =>
    `Environment=${key}=${systemdValue(value)}`,
  ).join("\n")}
ExecStart=/bin/bash ${systemdValue(runtime.serviceDaemon)}
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

async function applyPlan(
  plan,
  {
    runCommand,
    writeFile = defaultWriteFile,
    isPidRunning = defaultIsPidRunning,
    isProcessGroupRunning = defaultIsProcessGroupRunning,
    isPortAvailable = defaultIsPortAvailable,
    killPid = defaultKillPid,
    sleepMs = defaultSleepMs,
  },
) {
  try {
    if (plan.body) {
      writeFile(plan.serviceFile, plan.body);
    }
    for (const file of plan.files ?? []) {
      writeFile(file.path, file.body);
    }
    for (const step of plan.steps) {
      if (step.kind === "terminate-native-service-children") {
        terminateNativeServiceChildren(plan.runtime?.butlerData ?? plan.butlerData, {
          isPidRunning,
          isProcessGroupRunning,
          killPid,
        });
        continue;
      }
      if (step.kind === "wait-native-service-children-exit") {
        const exited = await waitForNativeServiceChildrenExit(
          plan.runtime?.butlerData ?? plan.butlerData,
          {
            isPidRunning,
            isProcessGroupRunning,
            sleepMs,
            timeoutMs: step.timeoutMs,
          },
        );
        if (!exited && !step.optional) {
          throw new Error("App Agent service children did not exit after launchd bootout");
        }
        continue;
      }
      if (step.kind === "wait-app-gateway-port-release") {
        const released = await waitForAppGatewayPortRelease(plan.runtime, {
          isPortAvailable,
          sleepMs,
          timeoutMs: step.timeoutMs,
        });
        if (!released && !step.optional) {
          throw new Error("App Agent service gateway port did not release after launchd bootout");
        }
        continue;
      }
      const result = await runCommand(step.argv);
      if ((result?.exitCode ?? 1) !== 0 && !step.optional) {
        throw new Error(`App Agent service command failed: ${step.argv.join(" ")}`);
      }
    }
  } catch (error) {
    plan.activation?.rollbackActivation?.(normalizeError(error));
    throw error;
  }
}

function serviceStep(argv, { optional = false } = {}) {
  return { kind: "command", argv, optional };
}

function terminateNativeServiceChildrenStep() {
  return { kind: "terminate-native-service-children" };
}

function waitForNativeServiceChildrenExitStep({
  optional = false,
  timeoutMs = 8_000,
} = {}) {
  return { kind: "wait-native-service-children-exit", optional, timeoutMs };
}

function waitForAppGatewayPortReleaseStep({
  optional = false,
  timeoutMs = 8_000,
} = {}) {
  return { kind: "wait-app-gateway-port-release", optional, timeoutMs };
}

function terminateNativeServiceChildren(
  butlerData,
  { isPidRunning, isProcessGroupRunning, killPid },
) {
  if (!butlerData) return;
  for (const state of readNativeServiceStates(butlerData).reverse()) {
    const processGroupId = Number(state.processGroupId || state.pid);
    const pid = Number(state.pid);
    if (
      (!Number.isInteger(processGroupId) || processGroupId <= 0) &&
      (!Number.isInteger(pid) || pid <= 0)
    ) {
      continue;
    }
    const groupRunning = Number.isInteger(processGroupId) &&
      processGroupId > 0 &&
      isProcessGroupRunning(processGroupId);
    const pidRunning = Number.isInteger(pid) && pid > 0 && isPidRunning(pid);
    if (!groupRunning && !pidRunning) continue;
    try {
      killPid(-processGroupId, "SIGTERM");
    } catch {
      try {
        killPid(pid, "SIGTERM");
      } catch {}
    }
  }
}

async function waitForNativeServiceChildrenExit(
  butlerData,
  { isPidRunning, isProcessGroupRunning, sleepMs, timeoutMs },
) {
  if (!butlerData) return true;
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const online = readNativeServiceStates(butlerData).some((state) => {
      const pid = Number(state.pid);
      const processGroupId = Number(state.processGroupId || state.pid);
      return (
        Number.isInteger(processGroupId) &&
        processGroupId > 0 &&
        isProcessGroupRunning(processGroupId)
      ) || (
        Number.isInteger(pid) &&
        pid > 0 &&
        isPidRunning(pid)
      );
    });
    if (!online) return true;
    await sleepMs(100);
  }
  return false;
}

async function waitForAppGatewayPortRelease(
  runtime,
  { isPortAvailable, sleepMs, timeoutMs },
) {
  const port = Number(runtime?.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return true;
  const host = runtime?.env?.BUTLER_APP_SERVER_HOST || "127.0.0.1";
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await isPortAvailable(port, host)) return true;
    await sleepMs(100);
  }
  return await isPortAvailable(port, host);
}

function readNativeServiceStates(butlerData) {
  return APP_AGENT_SERVICE_IDS
    .map((serviceId) => readJson(serviceStatePath(butlerData, serviceId)))
    .filter(Boolean);
}

function normalizeLaunchdLabel(value) {
  const label = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(label)) {
    throw new Error("invalid App Agent service label");
  }
  return label;
}

function normalizeMenuBarHelper(value, serviceLabel) {
  if (!value) return null;
  const executablePath = safeString(value.executablePath);
  if (!executablePath) {
    throw new Error("invalid menu bar helper executable path");
  }
  const mainExecutablePath = safeString(value.mainExecutablePath);
  if (mainExecutablePath && executablePath === mainExecutablePath) {
    throw new Error("menu bar helper executable must be distinct from the main App executable");
  }
  return {
    executablePath,
    appBundlePath: safeString(value.appBundlePath),
    mainExecutablePath,
    label: normalizeLaunchdLabel(value.label || `${serviceLabel}.menubar-helper`),
  };
}

function normalizeSystemdUnit(value) {
  const unit = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.@-]+\.service$/u.test(unit)) {
    throw new Error("invalid App Agent systemd unit");
  }
  return unit;
}

function serviceStatePath(butlerData, serviceId) {
  return join(butlerData, "state", "services", `${serviceId}.json`);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readPositiveInteger(path) {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function defaultWriteFile(path, body) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o644 });
}

function defaultKillPid(pid, signal) {
  process.kill(pid, signal);
}

function defaultIsProcessGroupRunning(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultIsPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(value));
      } else {
        resolve(value);
      }
    };
    server.once("error", () => settle(false));
    server.once("listening", () => settle(true));
    server.listen(port, host);
  });
}

function defaultSleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultRunCommand(argv) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ exitCode: 124 });
    }, SERVICE_COMMAND_TIMEOUT_MS);
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 1 });
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1 });
    });
  });
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error("App Agent service registration failed");
}

function defaultIsPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdValue(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("%", "%%")}"`;
}

function systemdPathValue(value) {
  let escaped = "";
  for (const character of String(value)) {
    if (/^[A-Za-z0-9/_.:-]$/u.test(character)) {
      escaped += character;
      continue;
    }
    for (const byte of Buffer.from(character, "utf8")) {
      escaped += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return escaped;
}
