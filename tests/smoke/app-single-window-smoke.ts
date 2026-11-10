// test-category: race
// A second launch while the Agent is still starting must reuse the one main window.
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_RENDERER_ORIGIN } from "../../packages/butler-app/client/electron/app-renderer-protocol.mjs";
import { appForegroundStartupProgressPath } from "../../packages/butler-app/client/electron/app-foreground-lifecycle.mjs";
import { spawnElectron, stopElectronChild } from "../support/electron-child";
import { freeGatewayPort, freePort, nativeAgentExecutable } from "../support/native-app-server";
import { smokeBrowserArgs } from "../support/smoke-browser-args";

const root = mkdtempSync(join(tmpdir(), "butler-single-window-"));
const data = join(root, "data");
const directory = resolve("packages/butler-app/client/electron");
const executable = createRequire(join(directory, "package.json"))("electron") as string;
const port = await freePort();
const agentPort = await freeGatewayPort();
const installation = join(root, "install");
const agent = join(installation, "bin/butler-agent");
mkdirSync(join(installation, "bin"), { recursive: true });
cpSync(nativeAgentExecutable(), join(installation, "bin/butler-agent-real"));
// Hold the Agent start open, as a slow start does, so the second launch arrives during it.
writeFileSync(agent, `#!/bin/sh\nsleep 5\nexec "$(dirname "$0")/butler-agent-real" "$@"\n`);
chmodSync(agent, 0o755);
cpSync(resolve("packages/butler-agent/resources"), join(installation, "resources"), { recursive: true });
cpSync(resolve("packages/butler-app/client/ui/dist"), join(installation, "resources/app-client/dist"), { recursive: true });
const env = { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", DISPLAY: process.env.DISPLAY,
  XAUTHORITY: process.env.XAUTHORITY, HOME: join(root, "home"), BUTLER_DATA: data,
  TMPDIR: tmpdir(), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
  BUTLER_NATIVE_AGENT_EXECUTABLE: agent,
  BUTLER_APP_ELECTRON_USER_DATA_DIR: join(root, "profile"), BUTLER_APP_SERVER_PORT: String(agentPort),
  BUTLER_APP_DISABLE_SHELL_REGISTRATION: "1", BUTLER_E2E_TIER: "stub", BUTLER_SECRET_STORE: "file" };
let logs = "";
const app = spawnElectron(executable, [directory, `--remote-debugging-port=${port}`, ...smokeBrowserArgs()], {
  env, onOutput: bytes => { logs += bytes.toString(); },
});

function startupStages(): string[] {
  try {
    const progress = JSON.parse(readFileSync(appForegroundStartupProgressPath(data), "utf8"));
    return progress.timings.map((event: { stage: string }) => event.stage);
  } catch {
    return [];
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (!check()) {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error(`Electron exited: ${logs}`);
    if (Date.now() > deadline) throw new Error(`${what} timed out: ${logs}`);
    await new Promise(done => setTimeout(done, 50));
  }
}

async function appWindows(): Promise<number> {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type: string; url?: string }>;
  return targets.filter(target => target.type === "page" && target.url?.startsWith(APP_RENDERER_ORIGIN)).length;
}

try {
  await until(() => startupStages().includes("agent_starting"), "Agent start");
  assert.equal(startupStages().includes("agent_ready"), false, "Agent became ready before the second launch");
  // Same profile, so the single-instance lock hands this launch to the running App.
  const second = spawnElectron(executable, [directory, ...smokeBrowserArgs()], {
    env, cleanupPaths: [], onOutput: bytes => { logs += bytes.toString(); },
  });
  const secondExit = second.exitCode ?? await new Promise<number | null>(done => second.once("exit", code => done(code)));
  assert.equal(secondExit, 0, `Second launch did not hand off: ${logs}`);
  await until(() => startupStages().includes("window_ready"), "Main window");
  // Any duplicate window starts with the first one; give it time to appear.
  await new Promise(done => setTimeout(done, 1000));
  assert.equal(await appWindows(), 1, `Expected one App window: ${logs}`);
  assert.equal(startupStages().filter(stage => stage === "window_ready").length, 1);
  console.log(JSON.stringify({ ok: true, appWindows: 1, secondLaunchExit: secondExit }));
} finally {
  await stopElectronChild(app);
  rmSync(root, { recursive: true, force: true });
}
