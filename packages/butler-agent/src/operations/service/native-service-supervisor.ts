import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { createServer } from "net";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, normalize } from "path";
import { resolveBunPath } from "../../interfaces/cli/runtime.ts";
import { butlerAgentScriptPath, butlerAgentSourcePath } from "../../runtime/paths.ts";
import {
  appGatewayLogPaths,
  clearAppGatewayPid,
  isGatewayEnabled,
  readAppGatewayPid,
  resolveAppGatewayRuntimeConfig,
} from "../gateway/registry.ts";

export const NATIVE_SUPERVISOR_ID = "native-supervisor";

export type NativeServiceId =
  | "embed-server"
  | "butler-sync-consumer"
  | "butler-scheduler"
  | "butler-watchdog"
  | "butler-main"
  | "app-gateway";

export interface NativeServiceSpec {
  id: NativeServiceId;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdoutFile: string;
  stderrFile: string;
  restartPolicy: "manual" | "watchdog";
  runtime?: NativeServiceRuntimeMetadata;
}

export interface NativeServiceRuntimeMetadata {
  managedBy: "butler-app";
  runtimePointerPath: string;
  runtimeHome: string;
  version: string | null;
}

export interface NativeServiceState {
  version: 1;
  supervisor: typeof NATIVE_SUPERVISOR_ID;
  serviceId: NativeServiceId;
  pid: number;
  parentPid?: number;
  processGroupId?: number;
  mode?: "detached" | "daemon-child";
  startedAt: string;
  command: string;
  args: string[];
  cwd: string;
  stdoutFile: string;
  stderrFile: string;
  restartPolicy: NativeServiceSpec["restartPolicy"];
  runtime?: NativeServiceRuntimeMetadata;
}

export interface NativeServiceProjection {
  serviceId: NativeServiceId;
  pid: number | null;
  parentPid?: number | null;
  processGroupId?: number | null;
  mode?: "detached" | "daemon-child";
  status: "online" | "offline" | "stale";
  startedAt: string | null;
  supervisor: typeof NATIVE_SUPERVISOR_ID;
  command: string;
  args: string[];
  cwd: string;
  stdoutFile: string;
  stderrFile: string;
  restartPolicy: NativeServiceSpec["restartPolicy"];
  runtime?: NativeServiceRuntimeMetadata;
}

export interface NativeSupervisorPaths {
  butlerHome: string;
  butlerData: string;
}

interface NativeServiceSpecOptions {
  createProjectFolderTokenSecret?: boolean;
}

interface AppManagedNativeServiceSpecOptions extends NativeServiceSpecOptions {
  appVersion?: string | null;
  gatewayHost?: string;
  gatewayPort?: number;
}

export interface AppManagedNativeServiceSpecInput {
  butlerData: string;
  runtimePointerPath?: string;
  localAuthFile: string;
}

interface AppManagedRuntimePointer {
  schema: string;
  product: string;
  gateway_profile: string;
  runtime_home: string;
  version?: string;
}

interface StartServiceOptions {
  now?: () => Date;
  isPidRunning?: (pid: number) => boolean;
  spawnDetached?: (spec: NativeServiceSpec, env: Record<string, string>) => { pid: number };
}

interface StopServiceOptions {
  isPidRunning?: (pid: number) => boolean;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
}

interface BoundedStopServiceOptions extends StopServiceOptions {
  gatewayPort?: number;
  isPortAvailable?: (port: number) => boolean | Promise<boolean>;
  isProcessGroupRunning?: (processGroupId: number) => boolean;
  sleepMs?: (ms: number) => Promise<void>;
  waitIntervalMs?: number;
  terminateTimeoutMs?: number;
  killTimeoutMs?: number;
}

function defaultButlerHome(): string {
  return process.env.BUTLER_HOME || join(homedir(), "butler");
}

function defaultButlerData(): string {
  return process.env.BUTLER_DATA || join(homedir(), ".butler");
}

export function resolveNativeSupervisorPaths(input: Partial<NativeSupervisorPaths> = {}): NativeSupervisorPaths {
  return {
    butlerHome: input.butlerHome ?? defaultButlerHome(),
    butlerData: input.butlerData ?? defaultButlerData(),
  };
}

export function serviceStateDir(butlerData: string): string {
  return join(butlerData, "state", "services");
}

export function serviceStatePath(butlerData: string, serviceId: NativeServiceId): string {
  return join(serviceStateDir(butlerData), `${serviceId}.json`);
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeServiceState(butlerData: string, state: NativeServiceState): void {
  atomicWriteJson(serviceStatePath(butlerData, state.serviceId), state);
}

export function removeServiceState(butlerData: string, serviceId: NativeServiceId): void {
  rmSync(serviceStatePath(butlerData, serviceId), { force: true });
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function isPidRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function logPath(butlerData: string, name: string): string {
  return join(butlerData, "logs", name);
}

export function appManagedRuntimePointerPath(butlerData: string): string {
  return join(butlerData, "app", "runtime", "agent", "current.json");
}

function safeAppManagedRuntimeHome(butlerData: string, pointer: AppManagedRuntimePointer): string {
  if (
    pointer.schema !== "butler.app-managed-agent-runtime-pointer.v1" ||
    pointer.product !== "butler-app" ||
    pointer.gateway_profile !== "electron" ||
    typeof pointer.runtime_home !== "string" ||
    pointer.runtime_home.trim() === "" ||
    isAbsolute(pointer.runtime_home)
  ) {
    throw new Error("invalid App-managed Agent runtime pointer");
  }
  const normalized = normalize(pointer.runtime_home);
  if (normalized === "." || normalized.startsWith("..")) {
    throw new Error("invalid App-managed Agent runtime pointer");
  }
  return join(butlerData, normalized);
}

export function resolveAppManagedNativeSupervisorPaths(
  input: AppManagedNativeServiceSpecInput,
): NativeSupervisorPaths & {
  runtimePointerPath: string;
  localAuthFile: string;
  runtimeVersion: string | null;
} {
  const runtimePointerPath = input.runtimePointerPath ?? appManagedRuntimePointerPath(input.butlerData);
  const pointer = readJson<AppManagedRuntimePointer>(runtimePointerPath);
  if (!pointer) {
    throw new Error("missing App-managed Agent runtime pointer");
  }
  assertValidAppManagedLocalAuth(input.localAuthFile);
  return {
    butlerHome: safeAppManagedRuntimeHome(input.butlerData, pointer),
    butlerData: input.butlerData,
    runtimePointerPath,
    localAuthFile: input.localAuthFile,
    runtimeVersion: typeof pointer.version === "string" ? pointer.version : null,
  };
}

function assertValidAppManagedLocalAuth(localAuthFile: string): void {
  if (!localAuthFile.trim()) {
    throw new Error("missing App-managed local auth file");
  }
  const auth = readJson<{ schema?: string; token?: string }>(localAuthFile);
  if (
    !auth ||
    auth.schema !== "butler.app-local-agent-auth.v1" ||
    typeof auth.token !== "string" ||
    auth.token.length < 32
  ) {
    throw new Error("invalid App-managed local auth file");
  }
}

export function projectFolderTokenSecretPath(butlerData: string): string {
  return join(
    butlerData,
    "state",
    "app-gateway",
    "project-folder-token-secret",
  );
}

export function readOrCreateProjectFolderTokenSecret(butlerData: string): string {
  const envSecret = process.env.BUTLER_PROJECT_FOLDER_TOKEN_SECRET?.trim();
  if (envSecret) return envSecret;
  const secretPath = projectFolderTokenSecretPath(butlerData);
  try {
    const existing = readFileSync(secretPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Missing or unreadable secrets are recreated below for local app gateway use.
  }
  const secret = randomUUID();
  mkdirSync(dirname(secretPath), { recursive: true, mode: 0o700 });
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  return secret;
}

export function defaultNativeServiceSpecs(
  input: Partial<NativeSupervisorPaths> = {},
  options: NativeServiceSpecOptions = {},
): NativeServiceSpec[] {
  const paths = resolveNativeSupervisorPaths(input);
  return nativeServiceSpecsForRuntime(paths, {}, options);
}

export function appManagedNativeServiceSpecs(
  input: AppManagedNativeServiceSpecInput,
  options: AppManagedNativeServiceSpecOptions = {},
): NativeServiceSpec[] {
  const paths = resolveAppManagedNativeSupervisorPaths(input);
  return nativeServiceSpecsForRuntime(paths, {
    runtimePointerPath: paths.runtimePointerPath,
    runtimeHome: paths.butlerHome,
    runtimeVersion: paths.runtimeVersion,
    localAuthFile: paths.localAuthFile,
    appVersion: options.appVersion,
    gatewayHost: options.gatewayHost,
    gatewayPort: options.gatewayPort,
  }, options);
}

function nativeServiceSpecsForRuntime(
  paths: NativeSupervisorPaths,
  appManaged: {
    runtimePointerPath?: string;
    runtimeHome?: string;
    runtimeVersion?: string | null;
    appVersion?: string | null;
    localAuthFile?: string;
    gatewayHost?: string;
    gatewayPort?: number;
  } = {},
  options: NativeServiceSpecOptions = {},
): NativeServiceSpec[] {
  const createProjectFolderTokenSecret = options.createProjectFolderTokenSecret ?? true;
  const appVersion = safeString(appManaged.appVersion);
  const bun = resolveBunPath({ butlerData: paths.butlerData });
  const serviceBun = appManaged.runtimeHome
    ? join(
        appManaged.runtimeHome,
        "packages",
        "butler-agent",
        "resources",
        "runtime",
        "bin",
        "bun",
      )
    : bun;
  const commonEnv = {
    NODE_ENV: "production",
    BUTLER_HOME: paths.butlerHome,
    BUTLER_DATA: paths.butlerData,
    BUTLER_BUN: serviceBun,
    ...(appManaged.runtimePointerPath
      ? { BUTLER_APP_MANAGED_RUNTIME_POINTER: appManaged.runtimePointerPath }
      : {}),
    ...(appManaged.runtimeHome
      ? { BUTLER_APP_MANAGED_RUNTIME_HOME: appManaged.runtimeHome }
      : {}),
    TELEGRAM_SILENCE_LOG: logPath(paths.butlerData, "telegram-silence.log"),
  };
  const runtimeMetadata = appManaged.runtimePointerPath && appManaged.runtimeHome
    ? {
        managedBy: "butler-app" as const,
        runtimePointerPath: appManaged.runtimePointerPath,
        runtimeHome: appManaged.runtimeHome,
        version: appManaged.runtimeVersion ?? null,
      }
    : undefined;

  const specs: NativeServiceSpec[] = [
    {
      id: "embed-server",
      command: "bash",
      args: [butlerAgentScriptPath(paths.butlerHome, "start-embed-server.sh")],
      cwd: paths.butlerHome,
      env: commonEnv,
      stdoutFile: logPath(paths.butlerData, "embed-server-out.log"),
      stderrFile: logPath(paths.butlerData, "embed-server-err.log"),
      restartPolicy: "watchdog",
      ...(runtimeMetadata ? { runtime: runtimeMetadata } : {}),
    },
    {
      id: "butler-sync-consumer",
      command: serviceBun,
      args: ["run", butlerAgentSourcePath(paths.butlerHome, "agent", "cognition", "memory", "scripts", "sync-consumer.ts")],
      cwd: paths.butlerHome,
      env: commonEnv,
      stdoutFile: logPath(paths.butlerData, "sync-consumer-out.log"),
      stderrFile: logPath(paths.butlerData, "sync-consumer-err.log"),
      restartPolicy: "watchdog",
      ...(runtimeMetadata ? { runtime: runtimeMetadata } : {}),
    },
    {
      id: "butler-scheduler",
      command: serviceBun,
      args: ["run", butlerAgentScriptPath(paths.butlerHome, "native-scheduler.ts")],
      cwd: paths.butlerHome,
      env: commonEnv,
      stdoutFile: logPath(paths.butlerData, "scheduler-out.log"),
      stderrFile: logPath(paths.butlerData, "scheduler-err.log"),
      restartPolicy: "watchdog",
      ...(runtimeMetadata ? { runtime: runtimeMetadata } : {}),
    },
    {
      id: "butler-watchdog",
      command: serviceBun,
      args: ["run", butlerAgentSourcePath(paths.butlerHome, "interfaces", "mcp-server", "watchdog.ts")],
      cwd: paths.butlerHome,
      env: commonEnv,
      stdoutFile: logPath(paths.butlerData, "watchdog-out.log"),
      stderrFile: logPath(paths.butlerData, "watchdog-err.log"),
      restartPolicy: "manual",
      ...(runtimeMetadata ? { runtime: runtimeMetadata } : {}),
    },
    {
      id: "butler-main",
      command: "bash",
      args: [butlerAgentScriptPath(paths.butlerHome, "start-butler.sh")],
      cwd: paths.butlerHome,
      env: {
        ...commonEnv,
        BUTLER_SERVICE_CHILD: "butler-main",
        ENABLE_NATIVE_MCP_SERVERS: "true",
      },
      stdoutFile: logPath(paths.butlerData, "butler-out.log"),
      stderrFile: logPath(paths.butlerData, "butler-err.log"),
      restartPolicy: "watchdog",
      ...(runtimeMetadata ? { runtime: runtimeMetadata } : {}),
    },
  ];

  if (appManaged.runtimeHome || isGatewayEnabled(paths.butlerData, "app")) {
    const app = resolveAppGatewayRuntimeConfig({
      butlerData: paths.butlerData,
      env: {},
    });
    const appHost = appManaged.gatewayHost ?? app.host;
    const appPort = appManaged.gatewayPort ?? app.port;
    const appLogs = appGatewayLogPaths(paths.butlerData);
    specs.push({
      id: "app-gateway",
      command: serviceBun,
      args: [
        "run",
        butlerAgentSourcePath(paths.butlerHome, "gateways", "app", "cli.ts"),
        `--port=${appPort}`,
      ],
      cwd: paths.butlerHome,
      env: {
        ...commonEnv,
        BUTLER_APP_SERVER_HOST: appHost,
        BUTLER_APP_SERVER_PORT: String(appPort),
        ...(appManaged.localAuthFile
          ? {
              BUTLER_APP_GATEWAY_PID_FILE: "off",
              BUTLER_APP_LOCAL_AUTH_REQUIRED: "1",
              BUTLER_APP_LOCAL_AUTH_FILE: appManaged.localAuthFile,
            }
          : {}),
        ...(app.dbPath ? { BUTLER_APP_SERVER_DB: app.dbPath } : {}),
        ...(appVersion ? { BUTLER_APP_VERSION: appVersion } : {}),
        ...(createProjectFolderTokenSecret
          ? { BUTLER_PROJECT_FOLDER_TOKEN_SECRET: readOrCreateProjectFolderTokenSecret(paths.butlerData) }
          : {}),
      },
      stdoutFile: appLogs.stdout,
      stderrFile: appLogs.stderr,
      restartPolicy: "watchdog",
      ...(runtimeMetadata ? { runtime: runtimeMetadata } : {}),
    });
  }

  return specs;
}

function defaultSpawnDetached(spec: NativeServiceSpec, env: Record<string, string>): { pid: number } {
  mkdirSync(dirname(spec.stdoutFile), { recursive: true, mode: 0o700 });
  const stdout = openSync(spec.stdoutFile, "a", 0o600);
  const stderr = openSync(spec.stderrFile, "a", 0o600);
  try {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: true,
      env,
      stdio: ["ignore", stdout, stderr],
    });
    child.unref();
    if (!child.pid) {
      throw new Error(`failed to start ${spec.id}: missing child pid`);
    }
    return { pid: child.pid };
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

export function readServiceState(butlerData: string, serviceId: NativeServiceId): NativeServiceState | null {
  const state = readJson<NativeServiceState>(serviceStatePath(butlerData, serviceId));
  if (!state || state.supervisor !== NATIVE_SUPERVISOR_ID || state.serviceId !== serviceId) return null;
  return state;
}

export function startService(
  butlerData: string,
  spec: NativeServiceSpec,
  options: StartServiceOptions = {},
): NativeServiceProjection {
  const alive = options.isPidRunning ?? isPidRunning;
  const existing = readServiceState(butlerData, spec.id);
  if (existing && alive(existing.pid)) {
    return projectService(spec, existing, "online");
  }

  const env = {
    ...process.env,
    ...(spec.env ?? {}),
  } as Record<string, string>;
  const started = (options.spawnDetached ?? defaultSpawnDetached)(spec, env);
  const state: NativeServiceState = {
    version: 1,
    supervisor: NATIVE_SUPERVISOR_ID,
    serviceId: spec.id,
    pid: started.pid,
    processGroupId: started.pid,
    mode: "detached",
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    stdoutFile: spec.stdoutFile,
    stderrFile: spec.stderrFile,
    restartPolicy: spec.restartPolicy,
    ...(spec.runtime ? { runtime: spec.runtime } : {}),
  };
  atomicWriteJson(serviceStatePath(butlerData, spec.id), state);
  return projectService(spec, state, "online");
}

export function startServices(
  paths: Partial<NativeSupervisorPaths> = {},
  options: StartServiceOptions = {},
): NativeServiceProjection[] {
  const resolved = resolveNativeSupervisorPaths(paths);
  return defaultNativeServiceSpecs(resolved).map((spec) => startService(resolved.butlerData, spec, options));
}

export function stopService(
  butlerData: string,
  spec: NativeServiceSpec,
  options: StopServiceOptions = {},
): NativeServiceProjection {
  const state = readServiceState(butlerData, spec.id);
  const alive = options.isPidRunning ?? isPidRunning;
  const kill = options.killPid ?? ((pid, signal) => process.kill(pid, signal));
  if (state && alive(state.pid)) {
    let signaled = false;
    try {
      // Services are spawned detached, so the recorded pid is also the process
      // group id. Terminating the group prevents wrapper scripts from leaving
      // Bun child processes behind during restart.
      kill(-state.pid, "SIGTERM");
      signaled = true;
    } catch {}
    if (!signaled) {
      try {
        kill(state.pid, "SIGTERM");
      } catch {}
    }
  }
  if (spec.id === "app-gateway") {
    const gatewayPid = readAppGatewayPid(butlerData);
    if (gatewayPid && (!state || gatewayPid !== state.pid) && alive(gatewayPid)) {
      let signaled = false;
      try {
        kill(-gatewayPid, "SIGTERM");
        signaled = true;
      } catch {}
      if (!signaled) {
        try {
          kill(gatewayPid, "SIGTERM");
        } catch {}
      }
    }
    clearAppGatewayPid(butlerData);
  }
  removeServiceState(butlerData, spec.id);
  return projectService(spec, state, "offline");
}

export async function stopServiceBounded(
  butlerData: string,
  spec: NativeServiceSpec,
  options: BoundedStopServiceOptions = {},
): Promise<NativeServiceProjection> {
  const state = readServiceState(butlerData, spec.id);
  const alive = options.isPidRunning ?? isPidRunning;
  const groupAlive = options.isProcessGroupRunning ?? isProcessGroupRunning;
  const kill = options.killPid ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = options.sleepMs ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitIntervalMs = options.waitIntervalMs ?? 100;
  const terminateTimeoutMs = options.terminateTimeoutMs ?? 5_000;
  const killTimeoutMs = options.killTimeoutMs ?? 2_000;
  const pids = new Set<number>();
  const processGroups = new Set<number>();
  if (state?.pid) {
    const processGroupId = state.processGroupId ?? state.pid;
    const stateProcessRunning = groupAlive(processGroupId) || alive(state.pid);
    pids.add(state.pid);
    processGroups.add(processGroupId);
    if (stateProcessRunning) {
      signalServiceProcess(kill, processGroupId, "SIGTERM");
    }
  }
  if (spec.id === "app-gateway") {
    const gatewayPid = readAppGatewayPid(butlerData);
    if (
      gatewayPid &&
      (!state || gatewayPid !== state.pid) &&
      (groupAlive(gatewayPid) || alive(gatewayPid))
    ) {
      pids.add(gatewayPid);
      processGroups.add(gatewayPid);
      signalServiceProcess(kill, gatewayPid, "SIGTERM");
    }
  }

  const terminated = await waitForProcessGroupsToExit(
    [...processGroups],
    groupAlive,
    alive,
    sleep,
    waitIntervalMs,
    terminateTimeoutMs,
  );
  if (!terminated) {
    for (const processGroupId of processGroups) {
      if (groupAlive(processGroupId) || alive(processGroupId)) {
        signalServiceProcess(kill, processGroupId, "SIGKILL");
      }
    }
    const killed = await waitForProcessGroupsToExit(
      [...processGroups],
      groupAlive,
      alive,
      sleep,
      waitIntervalMs,
      killTimeoutMs,
    );
    if (!killed) {
      throw new Error(`failed to stop ${spec.id}: process group still running`);
    }
  }

  if (spec.id === "app-gateway") {
    const gatewayPort = options.gatewayPort ?? Number(spec.env?.BUTLER_APP_SERVER_PORT);
    if (Number.isInteger(gatewayPort) && gatewayPort > 0) {
      const portAvailable = options.isPortAvailable ?? ((port) =>
        defaultIsPortAvailable(port, spec.env?.BUTLER_APP_SERVER_HOST ?? "127.0.0.1"));
      const released = await waitForPortRelease(
        gatewayPort,
        portAvailable,
        sleep,
        waitIntervalMs,
        terminateTimeoutMs + killTimeoutMs,
      );
      if (!released) {
        throw new Error(`failed to stop ${spec.id}: app gateway port still in use`);
      }
    }
    clearAppGatewayPid(butlerData);
  }
  removeServiceState(butlerData, spec.id);
  return projectService(spec, state, "offline");
}

export function stopServices(
  paths: Partial<NativeSupervisorPaths> = {},
  options: StopServiceOptions = {},
): NativeServiceProjection[] {
  const resolved = resolveNativeSupervisorPaths(paths);
  return [...defaultNativeServiceSpecs(resolved)]
    .reverse()
    .map((spec) => stopService(resolved.butlerData, spec, options));
}

export function listServices(
  paths: Partial<NativeSupervisorPaths> = {},
  options: { isPidRunning?: (pid: number) => boolean } = {},
): NativeServiceProjection[] {
  const resolved = resolveNativeSupervisorPaths(paths);
  const alive = options.isPidRunning ?? isPidRunning;
  return defaultNativeServiceSpecs(resolved, { createProjectFolderTokenSecret: false }).map((spec) => {
    const state = readServiceState(resolved.butlerData, spec.id);
    if (!state && spec.id === "app-gateway") {
      const gatewayPid = readAppGatewayPid(resolved.butlerData);
      if (gatewayPid) {
        return {
          ...projectService(spec, null, alive(gatewayPid) ? "online" : "stale"),
          pid: gatewayPid,
          processGroupId: gatewayPid,
          mode: "detached",
        };
      }
    }
    if (!state) return projectService(spec, null, "offline");
    return projectService(spec, state, alive(state.pid) ? "online" : "stale");
  });
}

function signalServiceProcess(
  kill: (pid: number, signal: NodeJS.Signals) => void,
  pid: number,
  signal: NodeJS.Signals,
): void {
  let signaled = false;
  try {
    kill(-pid, signal);
    signaled = true;
  } catch {}
  if (!signaled) {
    try {
      kill(pid, signal);
    } catch {}
  }
}

function isProcessGroupRunning(processGroupId: number): boolean {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGroupsToExit(
  processGroupIds: number[],
  groupAlive: (processGroupId: number) => boolean,
  alive: (pid: number) => boolean,
  sleep: (ms: number) => Promise<void>,
  waitIntervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  if (processGroupIds.length === 0) return true;
  let elapsedMs = 0;
  while (elapsedMs <= timeoutMs) {
    if (processGroupIds.every((processGroupId) =>
      !groupAlive(processGroupId) && !alive(processGroupId),
    )) {
      return true;
    }
    await sleep(waitIntervalMs);
    elapsedMs += waitIntervalMs;
  }
  return processGroupIds.every((processGroupId) =>
    !groupAlive(processGroupId) && !alive(processGroupId),
  );
}

async function waitForPortRelease(
  port: number,
  isPortAvailable: (port: number) => boolean | Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
  waitIntervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  let elapsedMs = 0;
  while (elapsedMs <= timeoutMs) {
    if (await isPortAvailable(port)) return true;
    await sleep(waitIntervalMs);
    elapsedMs += waitIntervalMs;
  }
  return Boolean(await isPortAvailable(port));
}

function defaultIsPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function safeString(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function projectService(
  spec: NativeServiceSpec,
  state: NativeServiceState | null,
  status: NativeServiceProjection["status"],
): NativeServiceProjection {
  return {
    serviceId: spec.id,
    pid: state?.pid ?? null,
    parentPid: state?.parentPid ?? null,
    processGroupId: state?.processGroupId ?? null,
    mode: state?.mode ?? undefined,
    status,
    startedAt: state?.startedAt ?? null,
    supervisor: NATIVE_SUPERVISOR_ID,
    command: state?.command ?? spec.command,
    args: state?.args ?? spec.args,
    cwd: state?.cwd ?? spec.cwd,
    stdoutFile: state?.stdoutFile ?? spec.stdoutFile,
    stderrFile: state?.stderrFile ?? spec.stderrFile,
    restartPolicy: state?.restartPolicy ?? spec.restartPolicy,
    runtime: state?.runtime ?? spec.runtime,
  };
}
