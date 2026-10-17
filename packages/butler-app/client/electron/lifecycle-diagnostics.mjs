import { app } from "electron";
import { showItemInFolder } from "./desktop-shell.mjs";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appDataRoots } from "./app-legacy-data.mjs";
import { AGENT_LOG, agentLogExists, agentLogPath } from "./agent-log.mjs";

/**
 * Privacy-safe projection only; never serialize raw supervisor errors or settings. A refused data folder: echo only.
 * The report names the Agent's own log, which holds the real failure, and Finder reveals that log when it exists.
 */
export async function openLifecycleLog(state, timings, supervisor = {}) {
  const root = appDataRoots().writableRoot;
  const agentLog = root && agentLogExists(root) ? AGENT_LOG : undefined;
  const report = { agentLog, kind: state.kind, stage: state.stage, failedStage: state.failedStage,
    timings, supervisor: { phase: supervisor.phase, pid: supervisor.pid, agentState: supervisor.agent_state,
      safeErrorCode: supervisor.last_error_code,
      lastExit: supervisor.last_exit ? { code: supervisor.last_exit.code, signal: supervisor.last_exit.signal } : undefined,
      containment: supervisor.containment ? { kind: supervisor.containment.kind, verified: supervisor.containment.verified,
        ownerDeathGuaranteed: supervisor.containment.owner_death_guaranteed } : undefined },
    platform: process.platform, arch: process.arch, version: app.getVersion() };
  if (!root) { console.info(JSON.stringify({ lifecycleDiagnostics: report })); return null; }
  const directory = join(root, "app/runtime/foreground");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `lifecycle-diagnostics-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  const files = (await readdir(directory)).filter((name) => /^lifecycle-diagnostics-.*\.json$/.test(name)).sort();
  await Promise.all(files.slice(0, -5).map((name) => unlink(join(directory, name))));
  showItemInFolder(agentLog ? agentLogPath(root) : file);
  return file;
}
