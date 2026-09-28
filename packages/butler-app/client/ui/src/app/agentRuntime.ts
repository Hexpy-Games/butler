import { appCopy } from "./copy.ts";

/** Coarse Agent lifecycle state published by Electron main (`butler:agent-state`). */
export type AgentRuntimeState =
  | "running"
  | "starting"
  | "stopped"
  | "restarting"
  | "restart_failed"
  | "failed"
  | "unknown";

/** States the workspace shows a notice for. */
export type AgentNotice = "stopped" | "restarting" | "restart_failed";

interface AgentRuntimeBridge {
  getAgentState?: () => Promise<unknown>;
  startAgent?: () => Promise<unknown>;
  onAgentState?: (handler: (state: unknown) => void) => (() => void) | Promise<() => void>;
}

const knownStates = new Set<AgentRuntimeState>([
  "running",
  "starting",
  "stopped",
  "restarting",
  "restart_failed",
  "failed",
]);

export function agentRuntimeState(value: unknown): AgentRuntimeState {
  const state = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { state?: unknown }).state
    : undefined;
  return typeof state === "string" && knownStates.has(state as AgentRuntimeState)
    ? state as AgentRuntimeState
    : "unknown";
}

export function agentNotice(state: AgentRuntimeState): AgentNotice | null {
  return state === "stopped" || state === "restarting" || state === "restart_failed"
    ? state
    : null;
}

export function agentNoticeLabel(notice: AgentNotice): string {
  if (notice === "stopped") return appCopy.feedback.agentStopped;
  if (notice === "restarting") return appCopy.feedback.agentRestarting;
  return appCopy.feedback.agentRestartFailed;
}

export async function readAgentRuntimeState(): Promise<AgentRuntimeState> {
  const bridge = agentBridge();
  if (typeof bridge?.getAgentState !== "function") return "unknown";
  return agentRuntimeState(await bridge.getAgentState());
}

export function subscribeAgentRuntimeState(
  handler: (state: AgentRuntimeState) => void,
): () => void {
  const bridge = agentBridge();
  if (typeof bridge?.onAgentState !== "function") return () => {};
  const unsubscribe = bridge.onAgentState((value) => handler(agentRuntimeState(value)));
  if (typeof unsubscribe === "function") return unsubscribe;
  let disposed = false;
  let release: (() => void) | undefined;
  void unsubscribe.then((next) => {
    if (disposed) next();
    else release = next;
  }, () => undefined);
  return () => {
    disposed = true;
    release?.();
  };
}

export async function startAgent(): Promise<AgentRuntimeState> {
  const bridge = agentBridge();
  if (typeof bridge?.startAgent !== "function") {
    throw new Error("Agent start is unavailable.");
  }
  return agentRuntimeState(await bridge.startAgent());
}

function agentBridge(): AgentRuntimeBridge | undefined {
  return typeof window !== "undefined"
    ? window.butlerApp as AgentRuntimeBridge | undefined
    : undefined;
}
