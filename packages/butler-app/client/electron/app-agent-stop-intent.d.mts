export const AGENT_STOP_INTENT_SCHEMA: "butler.agent-stop-intent.v1";
export const AGENT_STOP_INTENT_REASONS: readonly ["stop", "restart"];
export const AGENT_STOP_INTENT_REQUESTERS: readonly ["cli", "app", "mcp"];
export const AGENT_RESTART_RECONNECT_TIMEOUT_MS: number;
export const NATIVE_SERVICE_INSTANCE_SCHEMA: "butler.native-agent-service-instance.v1";

export type AgentStopIntentReason = "stop" | "restart";
export type AgentStopIntentRequester = "cli" | "app" | "mcp";

export interface AgentStopIntent {
  reason: AgentStopIntentReason;
  requestedBy: AgentStopIntentRequester;
  instanceId: string;
  pid: number;
  requestedAt: string;
}

export interface AgentStopIntentRecord {
  schema: "butler.agent-stop-intent.v1";
  reason: AgentStopIntentReason;
  requested_by: AgentStopIntentRequester;
  instance_id: string;
  pid: number;
  requested_at: string;
}

export type AgentExitDecision =
  | { action: "stay_stopped" | "await_restart"; requestedBy: AgentStopIntentRequester }
  | { action: "recover"; cause: "no_intent" | "instance_unknown" | "instance_mismatch" };

export interface NativeServiceInstance {
  pid: number;
  instanceId: string;
  state: string;
  appEnabled: boolean;
  port: number | null;
}

type ReadFile = (path: string, encoding: "utf8") => string;

export function agentStopIntentPath(butlerData: string): string;
export function nativeServiceInstancePath(butlerData: string): string;
export function parseAgentStopIntent(input: unknown): AgentStopIntent | null;
export function readAgentStopIntent(
  butlerData: string,
  options?: { readFile?: ReadFile },
): AgentStopIntent | null;
export function writeAgentStopIntent(
  butlerData: string,
  input: {
    reason: AgentStopIntentReason;
    pid: number;
    instanceId: string;
    requestedBy?: AgentStopIntentRequester;
    now?: () => Date;
  },
): AgentStopIntentRecord;
export function decideAgentExit(input: {
  intent: AgentStopIntent | null;
  exited: { pid?: number | null; instanceId?: string | null } | null;
}): AgentExitDecision;
export function parseNativeServiceInstance(input: unknown): NativeServiceInstance | null;
export function readNativeServiceInstance(
  butlerData: string,
  options?: { readFile?: ReadFile },
): NativeServiceInstance | null;
export function selectReplacementInstance(
  record: NativeServiceInstance | null,
  options?: {
    exitedInstanceId?: string | null;
    isProcessAlive?: (pid: number) => boolean;
  },
): NativeServiceInstance | null;
export function processIsAlive(
  pid: number,
  kill?: (pid: number, signal: number) => unknown,
): boolean;
