import { spawnSync } from "node:child_process";

export type ElectronLaunchPortRole = "app_server" | "electron_debug";

export interface ElectronLaunchPreflightFailure {
  stage: "electron_launch_preflight";
  cause: "port_conflict";
  owner: "electron_harness";
  exitCode: null;
  signal: null;
  portRole: ElectronLaunchPortRole;
}

export class ElectronLaunchPreflightError extends Error {
  readonly failure: ElectronLaunchPreflightFailure;

  constructor(failure: ElectronLaunchPreflightFailure) {
    super(`Electron harness ${failure.portRole} port is already in use.`);
    this.name = "ElectronLaunchPreflightError";
    this.failure = failure;
  }
}

export function listenerPids(port: number): number[] {
  if (process.platform === "win32") return [];
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  return result.stdout
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

export function preflightElectronLaunchPorts(input: {
  serverPort: number;
  debugPort: number;
}): void {
  const occupiedRole: ElectronLaunchPortRole | null =
    listenerPids(input.serverPort).length > 0
      ? "app_server"
      : listenerPids(input.debugPort).length > 0
      ? "electron_debug"
      : null;
  if (!occupiedRole) return;
  throw new ElectronLaunchPreflightError({
    stage: "electron_launch_preflight",
    cause: "port_conflict",
    owner: "electron_harness",
    exitCode: null,
    signal: null,
    portRole: occupiedRole,
  });
}
