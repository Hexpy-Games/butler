import { spawn, type ChildProcess } from "child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
} from "fs";
import { dirname } from "path";
import type { EventEmitter } from "events";
import {
  NATIVE_SUPERVISOR_ID,
  appManagedNativeServiceSpecs,
  defaultNativeServiceSpecs,
  isPidRunning,
  readServiceState,
  removeServiceState,
  resolveNativeSupervisorPaths,
  writeServiceState,
  type NativeServiceId,
  type NativeServiceSpec,
  type NativeSupervisorPaths,
} from "./native-service-supervisor.ts";
import {
  clearAppGatewayPid,
  readAppGatewayPid,
} from "../gateway/registry.ts";
import { nativeServiceChildLifecycle } from "./native-service-child-lifecycle.ts";

export interface DaemonChildHandle {
  pid?: number;
  on?: (event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
}

export interface ManagedServiceDaemonOptions {
  butlerData: string;
  specs: NativeServiceSpec[];
  parentPid?: number;
  now?: () => Date;
  isPidRunning?: (pid: number) => boolean;
  killGraceMs?: number;
  sleep?: (ms: number) => Promise<void>;
  spawnChild?: (spec: NativeServiceSpec, env: Record<string, string>) => DaemonChildHandle;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  log?: (line: string) => void;
  platform?: NodeJS.Platform;
}

export interface ParentLeaseStream extends EventEmitter {
  resume?: () => unknown;
}

interface RunningChild {
  spec: NativeServiceSpec;
  pid: number;
}

function daemonEnv(spec: NativeServiceSpec): Record<string, string> {
  const env = {
    ...process.env,
    ...(spec.env ?? {}),
    BUTLER_SUPERVISOR_MODE: "foreground-daemon",
  } as Record<string, string>;
  if (spec.id === "butler-watchdog") {
    env.BUTLER_WATCHDOG_DISABLE_SINGLETON = "true";
    env.BUTLER_WATCHDOG_DISABLE_SERVICE_LIVENESS = "true";
  }
  return env;
}

function defaultSpawnChild(
  spec: NativeServiceSpec,
  env: Record<string, string>,
  platform: NodeJS.Platform,
): ChildProcess {
  mkdirSync(dirname(spec.stdoutFile), { recursive: true, mode: 0o700 });
  const stdout = openSync(spec.stdoutFile, "a", 0o600);
  const stderr = openSync(spec.stderrFile, "a", 0o600);
  try {
    return spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      detached: nativeServiceChildLifecycle(platform).detached,
      env,
      stdio: ["ignore", stdout, stderr],
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
}

function serviceStateMatchesSpec(state: { command: string; args: string[]; cwd: string }, spec: NativeServiceSpec): boolean {
  // Args are manifest-owned strings, so order-sensitive JSON comparison is a
  // sufficient identity check without shell parsing.
  return state.command === spec.command
    && state.cwd === spec.cwd
    && JSON.stringify(state.args) === JSON.stringify(spec.args);
}

export function defaultDaemonServiceSpecs(
  input: Partial<NativeSupervisorPaths> = {},
  platform: NodeJS.Platform = process.platform,
): NativeServiceSpec[] {
  const paths = resolveNativeSupervisorPaths(input);
  const appManagedPointer = process.env.BUTLER_APP_MANAGED_RUNTIME_POINTER?.trim();
  const appManagedLocalAuth = process.env.BUTLER_APP_LOCAL_AUTH_FILE?.trim();
  if (appManagedPointer && appManagedLocalAuth) {
    return appManagedNativeServiceSpecs({
      butlerData: paths.butlerData,
      runtimePointerPath: appManagedPointer,
      localAuthFile: appManagedLocalAuth,
    }, {
      appVersion: process.env.BUTLER_APP_VERSION,
      gatewayPort: appManagedGatewayPortFromEnv(),
      platform,
      embedSocket: process.env.EMBED_SOCKET,
      embedHealthPort: process.env.EMBED_HEALTH_PORT,
    });
  }
  return defaultNativeServiceSpecs(paths);
}

function appManagedGatewayPortFromEnv(): number | undefined {
  const raw = process.env.BUTLER_APP_SERVER_PORT?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("invalid App-managed gateway port");
  }
  return port;
}

export class ManagedServiceDaemon {
  private readonly running = new Map<NativeServiceId, RunningChild>();
  private stopping = false;

  constructor(private readonly options: ManagedServiceDaemonOptions) {}

  startAll(): void {
    try {
      for (const spec of this.options.specs) {
        this.startChild(spec);
      }
    } catch (error) {
      this.stopTrackedChildren();
      throw error;
    }
  }

  stopAll(): void {
    this.stopping = true;
    this.stopTrackedChildren();
  }

  async shutdownAll(): Promise<void> {
    this.stopping = true;
    const stoppedPids = this.stopTrackedChildren();
    const graceMs = this.options.killGraceMs ?? 5_000;
    if (graceMs > 0) {
      await (this.options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(graceMs);
    }
    const alive = this.options.isPidRunning ?? isPidRunning;
    for (const pid of stoppedPids) {
      if (alive(pid)) {
        this.kill(this.terminationTarget(pid), "SIGKILL");
      }
    }
  }

  private stopTrackedChildren(): number[] {
    const stoppedPids: number[] = [];
    for (const spec of [...this.options.specs].reverse()) {
      const running = this.running.get(spec.id);
      if (running) {
        this.kill(this.terminationTarget(running.pid), "SIGTERM");
        stoppedPids.push(running.pid);
        this.running.delete(spec.id);
        removeServiceState(this.options.butlerData, spec.id);
      }
    }
    return stoppedPids;
  }

  handleChildExit(serviceId: NativeServiceId, code: number | null, signal: NodeJS.Signals | null): void {
    const running = this.running.get(serviceId);
    if (!running) return;
    this.running.delete(serviceId);
    removeServiceState(this.options.butlerData, serviceId);
    this.log(`${serviceId} exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    if (this.stopping || running.spec.restartPolicy !== "watchdog") return;
    this.startChild(running.spec);
  }

  private startChild(spec: NativeServiceSpec): void {
    const existing = readServiceState(this.options.butlerData, spec.id);
    const alive = this.options.isPidRunning ?? isPidRunning;
    const parentPid = this.parentPid();
    if (existing && alive(existing.pid)) {
      if (existing.parentPid === parentPid && serviceStateMatchesSpec(existing, spec)) {
        this.running.set(spec.id, { spec, pid: existing.pid });
        this.log(`adopted ${spec.id} pid=${existing.pid}`);
        return;
      }
      if (existing.parentPid === parentPid) {
        throw new Error(
          `service ${spec.id} is already running with a mismatched command; stop Butler before running foreground service`,
        );
      }
      throw new Error(
        `service ${spec.id} is already running under pid ${existing.pid}; stop Butler before running foreground service`,
      );
    }

    if (spec.id === "app-gateway") {
      this.stopLegacyAppGateway();
    }

    const env = daemonEnv(spec);
    const lifecycle = nativeServiceChildLifecycle(this.platform());
    const child = this.options.spawnChild
      ? this.options.spawnChild(spec, env)
      : defaultSpawnChild(spec, env, this.platform());
    if (!child.pid) throw new Error(`failed to start ${spec.id}: missing child pid`);
    this.running.set(spec.id, { spec, pid: child.pid });
    writeServiceState(this.options.butlerData, {
      version: 1,
      supervisor: NATIVE_SUPERVISOR_ID,
      serviceId: spec.id,
      pid: child.pid,
      parentPid,
      ...(lifecycle.processGroupId(child.pid) !== undefined
        ? { processGroupId: lifecycle.processGroupId(child.pid) }
        : {}),
      mode: "daemon-child",
      startedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      stdoutFile: spec.stdoutFile,
      stderrFile: spec.stderrFile,
      restartPolicy: spec.restartPolicy,
      ...(spec.runtime ? { runtime: spec.runtime } : {}),
    });
    child.on?.("exit", (code, signal) => {
      this.handleChildExit(spec.id, code, signal);
    });
    this.log(`started ${spec.id} pid=${child.pid}`);
  }

  private kill(pid: number, signal: NodeJS.Signals): void {
    const killPid = this.options.killPid ?? ((target, sig) => process.kill(target, sig));
    try {
      killPid(pid, signal);
    } catch {
      if (pid < 0) {
        try {
          killPid(Math.abs(pid), signal);
        } catch {}
      }
    }
  }

  private stopLegacyAppGateway(): void {
    const pid = readAppGatewayPid(this.options.butlerData);
    if (!pid) return;
    const alive = this.options.isPidRunning ?? isPidRunning;
    if (alive(pid)) {
      this.kill(this.terminationTarget(pid), "SIGTERM");
      this.log(`stopped legacy app-gateway pid=${pid}`);
    }
    clearAppGatewayPid(this.options.butlerData);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private parentPid(): number {
    return this.options.parentPid ?? process.pid;
  }

  private platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private terminationTarget(pid: number): number {
    return nativeServiceChildLifecycle(this.platform()).terminationTarget(pid);
  }
}

export async function runForegroundServiceDaemon(input: Partial<NativeSupervisorPaths> = {}): Promise<void> {
  const paths = resolveNativeSupervisorPaths(input);
  const daemon = new ManagedServiceDaemon({
    butlerData: paths.butlerData,
    specs: defaultDaemonServiceSpecs(paths),
    log: (line) => process.stdout.write(`[service-daemon] ${line}\n`),
  });
  daemon.startAll();

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void daemon.shutdownAll().finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    attachAppForegroundParentLease({
      enabled: process.env.BUTLER_APP_FOREGROUND_LEASE === "1",
      stream: process.stdin,
      shutdown,
    });
  });
}

export function attachAppForegroundParentLease({
  enabled,
  stream,
  shutdown,
}: {
  enabled: boolean;
  stream: ParentLeaseStream;
  shutdown: () => void;
}): boolean {
  if (!enabled) return false;
  stream.resume?.();
  stream.once("end", shutdown);
  stream.once("close", shutdown);
  stream.once("error", shutdown);
  return true;
}
