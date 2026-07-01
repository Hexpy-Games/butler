import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ProcessInspection {
  command: string;
  env: Record<string, string>;
}

export interface AppGatewayPortClaimDeps {
  findListeners: (port: number) => number[];
  inspectProcess: (pid: number) => ProcessInspection | null;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  sleepMs: (ms: number) => void;
}

export interface AppGatewayPortClaimInput {
  port: number;
  hostname: string;
  butlerData: string;
  butlerHome: string;
  currentPid?: number;
  userHome?: string;
  waitMs?: number;
}

export interface AppGatewayPortClaimResult {
  reclaimedPids: number[];
  skipped: "non-canonical-data" | "non-local-host" | null;
}

const APP_GATEWAY_CLI_FRAGMENT =
  "/packages/butler-agent/src/gateways/app/interface/cli/app-gateway-cli.ts";

export function reclaimStaleAppGatewayPort(
  input: AppGatewayPortClaimInput,
  deps: AppGatewayPortClaimDeps = defaultPortClaimDeps,
): AppGatewayPortClaimResult {
  const hostname = input.hostname.trim().toLowerCase();
  if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    return { reclaimedPids: [], skipped: "non-local-host" };
  }
  if (!isCanonicalButlerData(input.butlerData, input.userHome ?? homedir())) {
    return { reclaimedPids: [], skipped: "non-canonical-data" };
  }

  const currentPid = input.currentPid ?? process.pid;
  const reclaimedPids: number[] = [];
  for (const pid of deps.findListeners(input.port)) {
    if (pid === currentPid) continue;
    const inspection = deps.inspectProcess(pid);
    if (!inspection || !isAppGatewayProcess(inspection)) continue;
    if (sameRuntime(inspection, input)) continue;
    if (!signalPidOrGroup(deps, pid, "SIGTERM")) continue;
    reclaimedPids.push(pid);
  }

  if (reclaimedPids.length > 0) {
    const remaining = waitForListenersToExit(
      deps,
      input.port,
      reclaimedPids,
      input.waitMs ?? 2_000,
    );
    for (const pid of remaining) {
      signalPidOrGroup(deps, pid, "SIGKILL");
    }
    if (remaining.length > 0) {
      waitForListenersToExit(deps, input.port, remaining, input.waitMs ?? 2_000);
    }
  }

  return { reclaimedPids, skipped: null };
}

export function isCanonicalButlerData(
  butlerData: string,
  userHome = homedir(),
): boolean {
  return resolve(butlerData) === resolve(join(userHome, ".butler"));
}

function isAppGatewayProcess(inspection: ProcessInspection): boolean {
  return inspection.command.includes(APP_GATEWAY_CLI_FRAGMENT);
}

function sameRuntime(
  inspection: ProcessInspection,
  input: AppGatewayPortClaimInput,
): boolean {
  const ownerData = inspection.env.BUTLER_DATA;
  const ownerHome = inspection.env.BUTLER_HOME;
  return (
    Boolean(ownerData) &&
    Boolean(ownerHome) &&
    resolve(ownerData) === resolve(input.butlerData) &&
    resolve(ownerHome) === resolve(input.butlerHome)
  );
}

function signalPidOrGroup(
  deps: AppGatewayPortClaimDeps,
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    deps.killPid(-pid, signal);
    return true;
  } catch {
    try {
      deps.killPid(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function waitForListenersToExit(
  deps: AppGatewayPortClaimDeps,
  port: number,
  pids: number[],
  waitMs: number,
): number[] {
  const deadline = Date.now() + waitMs;
  let remaining = deps
    .findListeners(port)
    .filter((pid) => pids.includes(pid));
  while (Date.now() < deadline && remaining.length > 0) {
    deps.sleepMs(100);
    remaining = deps.findListeners(port).filter((pid) => pids.includes(pid));
  }
  return remaining;
}

function defaultFindListeners(port: number): number[] {
  try {
    return execFileSync("lsof", [
      `-tiTCP:${port}`,
      "-sTCP:LISTEN",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\s+/u)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

function defaultInspectProcess(pid: number): ProcessInspection | null {
  try {
    const command = execFileSync("ps", ["eww", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!command.trim()) return null;
    return { command, env: parseProcessEnv(command) };
  } catch {
    return null;
  }
}

function parseProcessEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const match of output.matchAll(/\b([A-Z0-9_]+)=([^\s]+)/gu)) {
    env[match[1]!] = match[2]!;
  }
  return env;
}

function defaultSleepMs(ms: number): void {
  execFileSync("sleep", [String(ms / 1000)], {
    stdio: "ignore",
  });
}

const defaultPortClaimDeps: AppGatewayPortClaimDeps = {
  findListeners: defaultFindListeners,
  inspectProcess: defaultInspectProcess,
  killPid: (pid, signal) => process.kill(pid, signal),
  sleepMs: defaultSleepMs,
};
