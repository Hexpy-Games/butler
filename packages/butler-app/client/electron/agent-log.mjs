import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** The App-spawned Agent's stdout and stderr, next to the service manager's Agent logs. */
export const AGENT_LOG = "logs/butler-agent-app.log";
// One previous generation is kept; the Agent writes only lifecycle and failure lines.
const ROTATE_BYTES = 8 * 1024 * 1024;

export function agentLogPath(dataRoot) { return join(dataRoot, AGENT_LOG); }

/** Opens the log for appending (owner-only); a full log first moves to `.1`. */
export function openAgentLog(dataRoot) {
  const path = agentLogPath(dataRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if (statSync(path).size >= ROTATE_BYTES) renameSync(path, `${path}.1`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return openSync(path, "a", 0o600);
}

export function closeAgentLog(fd) { closeSync(fd); }

export function agentLogExists(dataRoot) { return existsSync(agentLogPath(dataRoot)); }
