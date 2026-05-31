import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface NativeMainState {
  pid: number;
  startedAt: string;
  runtime: string;
  launcher: string;
  sessionId?: string;
}

export function getNativeMainStatePath(butlerData: string): string {
  return join(butlerData, "state", "butler-main-native.json");
}

export function parseNativeMainState(content: string): NativeMainState | null {
  try {
    const parsed = JSON.parse(content) as Partial<NativeMainState>;
    if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null;
    if (typeof parsed.startedAt !== "string" || !parsed.startedAt.trim()) return null;
    if (typeof parsed.runtime !== "string" || !parsed.runtime.trim()) return null;
    if (typeof parsed.launcher !== "string" || !parsed.launcher.trim()) return null;
    return {
      pid: parsed.pid as number,
      startedAt: parsed.startedAt,
      runtime: parsed.runtime,
      launcher: parsed.launcher,
      sessionId: typeof parsed.sessionId === "string" && parsed.sessionId.trim()
        ? parsed.sessionId
        : undefined,
    };
  } catch {
    return null;
  }
}

export function readNativeMainState(path: string): NativeMainState | null {
  if (!existsSync(path)) return null;
  try {
    return parseNativeMainState(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function uptimeSecondsFromState(
  state: NativeMainState,
  nowMs: number = Date.now(),
): number | null {
  const startedAtMs = Date.parse(state.startedAt);
  if (Number.isNaN(startedAtMs) || nowMs < startedAtMs) return null;
  return Math.floor((nowMs - startedAtMs) / 1000);
}

export function formatUptime(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
