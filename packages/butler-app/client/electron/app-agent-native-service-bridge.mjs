import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { spawn } from "node:child_process";
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
  ensureRuntimePointer = () => {},
  prepareLocalAuth = () => prepareAppLocalAuth({ butlerData }),
  isPidRunning = defaultIsPidRunning,
  runCommand = defaultRunCommand,
  writeFile = defaultWriteFile,
} = {}) {
  if (!butlerData) {
    throw new Error("missing Butler data root");
  }
  const resolvedServiceLabel = normalizeLaunchdLabel(serviceLabel);
  const resolvedSystemdUnit = normalizeSystemdUnit(systemdUnit);
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
          ensureRuntimePointer,
          prepareLocalAuth,
        });
        await applyPlan(plan, { runCommand });
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
          ensureRuntimePointer,
          prepareLocalAuth,
        });
        await applyPlan(plan, { runCommand });
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
          ensureRuntimePointer,
          prepareLocalAuth,
        });
        await applyPlan(plan, { runCommand, writeFile });
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

function createRegistrationPlan({
  action,
  butlerData,
  platform,
  homeDir,
  serviceLabel,
  systemdUnit,
  getPort,
  ensureRuntimePointer,
  prepareLocalAuth,
}) {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error(`unsupported App Agent service platform: ${platform}`);
  }
  if (action === "stop") {
    return platform === "darwin"
      ? launchdPlan({ action, homeDir, runtime: null, serviceLabel })
      : systemdPlan({ action, homeDir, runtime: null, systemdUnit });
  }
  const activation = ensureRuntimePointer();
  try {
    const runtime = resolveAppManagedServiceRuntime({
      butlerData,
      getPort,
      prepareLocalAuth,
    });
    if (platform === "darwin") {
      return { ...launchdPlan({ action, homeDir, runtime, serviceLabel }), activation };
    }
    return { ...systemdPlan({ action, homeDir, runtime, systemdUnit }), activation };
  } catch (error) {
    activation?.rollbackActivation?.(normalizeError(error));
    throw error;
  }
}

function resolveAppManagedServiceRuntime({ butlerData, getPort, prepareLocalAuth }) {
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
    },
  };
}

function launchdPlan({ action, homeDir, runtime, serviceLabel }) {
  const serviceFile = join(homeDir, "Library", "LaunchAgents", `${serviceLabel}.plist`);
  const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : "$UID"}`;
  const target = `${domain}/${serviceLabel}`;
  if (action === "install") {
    return {
      action,
      serviceFile,
      body: launchdPlist(runtime, serviceLabel),
      steps: [
        serviceStep(["launchctl", "bootout", target], { optional: true }),
        serviceStep(["launchctl", "bootstrap", domain, serviceFile]),
        serviceStep(["launchctl", "kickstart", "-k", target]),
      ],
    };
  }
  if (action === "start") {
    return {
      action,
      serviceFile,
      steps: [serviceStep(["launchctl", "kickstart", "-k", target])],
    };
  }
  return {
    action,
    serviceFile,
    steps: [serviceStep(["launchctl", "bootout", target], { optional: true })],
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

function systemdUnitBody(runtime) {
  return `[Unit]
Description=Butler Agent service
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdValue(runtime.runtimeHome)}
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

async function applyPlan(plan, { runCommand, writeFile = defaultWriteFile }) {
  try {
    if (plan.body) {
      writeFile(plan.serviceFile, plan.body);
    }
    for (const step of plan.steps) {
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
  return { argv, optional };
}

function normalizeLaunchdLabel(value) {
  const label = String(value ?? "").trim();
  if (!/^[A-Za-z0-9._-]+$/u.test(label)) {
    throw new Error("invalid App Agent service label");
  }
  return label;
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

function defaultWriteFile(path, body) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { mode: 0o644 });
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
