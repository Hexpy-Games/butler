import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import type { ProcessLiveness, RuntimeOwnerIdentity } from "./contracts.ts";

type ProcessObservation =
  | { kind: "found"; startedAtMs: number }
  | { kind: "missing" }
  | { kind: "unknown" };

type ObserveProcess = (processId: number) => ProcessObservation;

export function currentRuntimeOwnerIdentity(ownerId: string): RuntimeOwnerIdentity {
  const observation = observeLocalProcess(process.pid);
  const processStartedAtMs = observation.kind === "found"
    ? observation.startedAtMs
    : estimatedCurrentProcessStartedAtMs();
  return {
    ownerId,
    hostId: hostname(),
    processId: process.pid,
    processStartedAtMs,
  };
}

function estimatedCurrentProcessStartedAtMs(): number {
  return Math.floor((Date.now() - process.uptime() * 1_000) / 1_000) * 1_000;
}

export class LocalProcessLiveness implements ProcessLiveness {
  constructor(
    private readonly localHostId = hostname(),
    private readonly observeProcess: ObserveProcess = observeLocalProcess,
  ) {}

  isAlive(identity: RuntimeOwnerIdentity): boolean {
    if (identity.hostId !== this.localHostId) return true;
    const observation = this.observeProcess(identity.processId);
    if (observation.kind === "unknown") return true;
    if (observation.kind === "missing") return false;
    return observation.startedAtMs === identity.processStartedAtMs;
  }
}

function observeLocalProcess(processId: number): ProcessObservation {
  const result = spawnSync("ps", ["-p", String(processId), "-o", "lstart="], {
    encoding: "utf8",
  });
  if (result.error) return { kind: "unknown" };
  if (result.status === 1 && result.stdout.trim() === "") return { kind: "missing" };
  if (result.status !== 0) return { kind: "unknown" };
  const startedAtMs = Date.parse(result.stdout.trim());
  return Number.isFinite(startedAtMs)
    ? { kind: "found", startedAtMs }
    : { kind: "unknown" };
}
