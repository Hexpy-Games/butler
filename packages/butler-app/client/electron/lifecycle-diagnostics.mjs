import { app, shell } from "electron";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** Privacy-safe projection only; never serialize raw supervisor errors or settings. */
export async function openLifecycleLog(state, timings, supervisor = {}) {
  const directory = join(process.env.BUTLER_DATA ?? join(homedir(), ".butler"), "app/runtime/foreground");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `lifecycle-diagnostics-${new Date().toISOString().replaceAll(":", "-")}.json`);
  const report = { kind: state.kind, stage: state.stage, failedStage: state.failedStage,
    timings, supervisor: { state: supervisor.state, pid: supervisor.pid, ready: supervisor.ready,
      exitCode: supervisor.exitCode, safeErrorCode: supervisor.safeErrorCode },
    platform: process.platform, arch: process.arch, version: app.getVersion() };
  await writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  const files = (await readdir(directory)).filter((name) => /^lifecycle-diagnostics-.*\.json$/.test(name)).sort();
  await Promise.all(files.slice(0, -5).map((name) => unlink(join(directory, name))));
  shell.showItemInFolder(file);
  return file;
}
