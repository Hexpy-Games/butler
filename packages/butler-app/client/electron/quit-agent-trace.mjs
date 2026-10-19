import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { AGENT_LOG, agentLogPath, closeAgentLog, openAgentLog } from "./agent-log.mjs";

// Decode only structured phase lines, never expose arbitrary service output to UI.
// With a writable data root, the Agent's stdout and stderr also go to its log
// file, so a failure stays readable when the App was opened without a terminal.
export function spawnTracedAgent(command, args, options, onPhase, dataRoot = null) {
  if (dataRoot) options = { ...options, env: { ...(options.env ?? process.env), BUTLER_APP_AGENT_LOG: AGENT_LOG } };
  const stdio = Array.isArray(options.stdio) ? options.stdio : [options.stdio, options.stdio, options.stdio];
  const traced = stdio[0] === "pipe";
  const log = dataRoot ? openLog(dataRoot) : null;
  if (log === null && !traced) return spawn(command, args, options);
  let child;
  try {
    child = spawn(command, args, { ...options, stdio: [stdio[0], log ?? "inherit", traced ? "pipe" : log] });
  } finally {
    if (log !== null) closeAgentLog(log);
  }
  if (traced) traceStderr(child, onPhase, log === null ? null : appendStream(dataRoot));
  return child;
}

function openLog(dataRoot) {
  try { return openAgentLog(dataRoot); } catch (error) {
    // Logging never blocks the Agent start.
    console.warn(JSON.stringify({ agentLog: { error: error?.code ?? "open_failed" } }));
    return null;
  }
}

function appendStream(dataRoot) {
  const stream = createWriteStream(agentLogPath(dataRoot), { flags: "a", mode: 0o600 });
  stream.on("error", (error) => console.warn(JSON.stringify({ agentLog: { error: error?.code ?? "write_failed" } })));
  return stream;
}

function traceStderr(child, onPhase, log) {
  let pending = "";
  child.stderr.once("end", () => log?.end());
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    log?.write(chunk);
    pending += String(chunk);
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const match = line.match(/\[native-shutdown\].*phase=([a-z_]+) edge=(begin|end|event)/u);
      if (match) onPhase(match[1], match[2]);
    }
    // Bound a malformed log line; normal phase lines are <256 bytes.
    if (pending.length > 4096) pending = "";
  });
}
