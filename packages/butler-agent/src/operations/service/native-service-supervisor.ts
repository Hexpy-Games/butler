import { randomUUID } from "crypto";
import { spawn } from "child_process";
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
import { dirname, join } from "path";
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
}

export interface NativeSupervisorPaths {
  butlerHome: string;
  butlerData: string;
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

export function defaultNativeServiceSpecs(input: Partial<NativeSupervisorPaths> = {}): NativeServiceSpec[] {
  const paths = resolveNativeSupervisorPaths(input);
  const bun = resolveBunPath({ butlerData: paths.butlerData });
  const commonEnv = {
    NODE_ENV: "production",
    BUTLER_HOME: paths.butlerHome,
    BUTLER_DATA: paths.butlerData,
    BUTLER_BUN: bun,
    TELEGRAM_SILENCE_LOG: logPath(paths.butlerData, "telegram-silence.log"),
  };

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
    },
    {
      id: "butler-sync-consumer",
      command: bun,
      args: ["run", butlerAgentSourcePath(paths.butlerHome, "agent", "cognition", "memory", "scripts", "sync-consumer.ts")],
      cwd: paths.butlerHome,
      env: commonEnv,
      stdoutFile: logPath(paths.butlerData, "sync-consumer-out.log"),
      stderrFile: logPath(paths.butlerData, "sync-consumer-err.log"),
      restartPolicy: "watchdog",
    },
    {
      id: "butler-scheduler",
      command: bun,
      args: ["run", butlerAgentScriptPath(paths.butlerHome, "native-scheduler.ts")],
      cwd: paths.butlerHome,
      env: commonEnv,
      stdoutFile: logPath(paths.butlerData, "scheduler-out.log"),
      stderrFile: logPath(paths.butlerData, "scheduler-err.log"),
      restartPolicy: "watchdog",
    },
    {
      id: "butler-watchdog",
      command: bun,
      args: ["run", butlerAgentSourcePath(paths.butlerHome, "interfaces", "mcp-server", "watchdog.ts")],
      cwd: paths.butlerHome,
      env: commonEnv,
      stdoutFile: logPath(paths.butlerData, "watchdog-out.log"),
      stderrFile: logPath(paths.butlerData, "watchdog-err.log"),
      restartPolicy: "manual",
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
    },
  ];

  if (isGatewayEnabled(paths.butlerData, "app")) {
    const app = resolveAppGatewayRuntimeConfig({
      butlerData: paths.butlerData,
      env: {},
    });
    const appLogs = appGatewayLogPaths(paths.butlerData);
    specs.push({
      id: "app-gateway",
      command: bun,
      args: [
        "run",
        butlerAgentSourcePath(paths.butlerHome, "gateways", "app", "cli.ts"),
        `--port=${app.port}`,
      ],
      cwd: paths.butlerHome,
      env: {
        ...commonEnv,
        BUTLER_APP_SERVER_HOST: app.host,
        BUTLER_APP_SERVER_PORT: String(app.port),
        BUTLER_PROJECT_FOLDER_TOKEN_SECRET:
          readOrCreateProjectFolderTokenSecret(paths.butlerData),
        ...(app.dbPath ? { BUTLER_APP_SERVER_DB: app.dbPath } : {}),
      },
      stdoutFile: appLogs.stdout,
      stderrFile: appLogs.stderr,
      restartPolicy: "watchdog",
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
  return defaultNativeServiceSpecs(resolved).map((spec) => {
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
  };
}
