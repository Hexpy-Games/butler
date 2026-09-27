import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Shared contract with the Rust agent/CLI (issue #223). The CLI, MCP, or the
// App writes this file atomically before it sends SIGTERM; the next instance
// deletes it once it is ready. The App reads it only when a supervised or
// attached Agent process exits.
export const AGENT_STOP_INTENT_SCHEMA = "butler.agent-stop-intent.v1";
export const AGENT_STOP_INTENT_REASONS = Object.freeze(["stop", "restart"]);
export const AGENT_STOP_INTENT_REQUESTERS = Object.freeze(["cli", "app", "mcp"]);

// How long the App waits for an external `butler restart` to publish a ready
// replacement before it shows a recoverable error. Agreed with the Rust side:
// it is this long because a cold disk or a data migration can slow startup.
export const AGENT_RESTART_RECONNECT_TIMEOUT_MS = 90_000;

export const NATIVE_SERVICE_INSTANCE_SCHEMA = "butler.native-agent-service-instance.v1";

const localHosts = new Set(["127.0.0.1", "localhost"]);

export function agentStopIntentPath(butlerData) {
  return join(butlerData, "state", "agent-stop-intent.json");
}

export function nativeServiceInstancePath(butlerData) {
  return join(butlerData, "state", "butler-agent-native-service.json");
}

export function parseAgentStopIntent(input) {
  const value = parseJsonObject(input);
  if (!value || value.schema !== AGENT_STOP_INTENT_SCHEMA) return null;
  if (!AGENT_STOP_INTENT_REASONS.includes(value.reason)) return null;
  if (!AGENT_STOP_INTENT_REQUESTERS.includes(value.requested_by)) return null;
  if (!nonEmptyString(value.instance_id) || !positivePid(value.pid)) return null;
  if (!nonEmptyString(value.requested_at) || Number.isNaN(Date.parse(value.requested_at))) {
    return null;
  }
  return {
    reason: value.reason,
    requestedBy: value.requested_by,
    instanceId: value.instance_id,
    pid: value.pid,
    requestedAt: value.requested_at,
  };
}

export function readAgentStopIntent(butlerData, { readFile = readFileSync } = {}) {
  return parseAgentStopIntent(readText(agentStopIntentPath(butlerData), readFile));
}

export function writeAgentStopIntent(butlerData, {
  reason,
  pid,
  instanceId,
  requestedBy = "app",
  now = () => new Date(),
}) {
  const record = {
    schema: AGENT_STOP_INTENT_SCHEMA,
    reason,
    requested_by: requestedBy,
    instance_id: instanceId,
    pid,
    requested_at: now().toISOString(),
  };
  if (!parseAgentStopIntent(record)) throw new Error("invalid Agent stop intent");
  const path = agentStopIntentPath(butlerData);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  return record;
}

/**
 * Decides what an Agent exit means. The intent matches only on the instance
 * record nonce (`instance_id`); pid, process start time, and other owner ids
 * are never identity. An exit whose nonce the App never learned is a crash.
 */
export function decideAgentExit({ intent, exited }) {
  if (!intent) return { action: "recover", cause: "no_intent" };
  if (!nonEmptyString(exited?.instanceId)) {
    return { action: "recover", cause: "instance_unknown" };
  }
  if (intent.instanceId !== exited.instanceId) {
    return { action: "recover", cause: "instance_mismatch" };
  }
  return {
    action: intent.reason === "stop" ? "stay_stopped" : "await_restart",
    requestedBy: intent.requestedBy,
  };
}

export function parseNativeServiceInstance(input) {
  const value = parseJsonObject(input);
  if (!value || value.schema !== NATIVE_SERVICE_INSTANCE_SCHEMA) return null;
  if (!positivePid(value.pid) || !nonEmptyString(value.nonce)) return null;
  return {
    pid: value.pid,
    instanceId: value.nonce,
    state: typeof value.state === "string" ? value.state : "unknown",
    appEnabled: value.app_enabled === true,
    port: localEndpointPort(value.app_endpoint),
  };
}

export function readNativeServiceInstance(butlerData, { readFile = readFileSync } = {}) {
  return parseNativeServiceInstance(readText(nativeServiceInstancePath(butlerData), readFile));
}

/** A replacement is a different instance (by nonce) that is ready and alive. */
export function selectReplacementInstance(record, {
  exitedInstanceId = null,
  isProcessAlive = processIsAlive,
} = {}) {
  if (!record || record.state !== "ready" || !record.appEnabled || !record.port) return null;
  if (record.instanceId === exitedInstanceId) return null;
  return isProcessAlive(record.pid) ? record : null;
}

export function processIsAlive(pid, kill = process.kill.bind(process)) {
  if (!positivePid(pid)) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function localEndpointPort(value) {
  if (!nonEmptyString(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !localHosts.has(url.hostname)) return null;
    const port = Number(url.port || 80);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function parseJsonObject(input) {
  try {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    return value && typeof value === "object" && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
      ? value
      : null;
  } catch {
    return null;
  }
}

function readText(path, readFile) {
  try {
    return readFile(path, "utf8");
  } catch {
    return null;
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function positivePid(value) {
  return Number.isSafeInteger(value) && value > 0;
}
