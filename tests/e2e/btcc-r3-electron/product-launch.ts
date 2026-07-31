import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AppSessionView,
  ElectronFixtureFile,
  PreparedRun,
} from "./contracts.ts";
import {
  CdpPage,
  connectElectronPage,
  type CdpClient,
} from "./cdp-page.ts";
import {
  hasInterruptedInboundForExecutor,
  startNativeExecutor,
  stopChildProcess,
  stopNativeExecutor,
} from "./native-executor.ts";
import { activateProjectSessionWorkspace } from "./isolation-config.ts";
import { assert } from "./scenario-preflight.ts";

const FIRST_RUN_STORAGE_KEY = "butler:first-run-setup:v1";

type BridgeMethod =
  | "createProject"
  | "createSession"
  | "getSessionView"
  | "getSettings"
  | "health"
  | "listSessions"
  | "quitApp"
  | "updateSessionControls";

export interface ProductLaunch {
  child: ChildProcess;
  client: CdpClient;
  executor: ChildProcess;
  executorOutput: string[];
  interruptedExecutorReplaced: boolean;
  output: string[];
  page: CdpPage;
  providerEndpoint: string;
  startedAtMs: number;
}

function listenerPids(port: number): number[] {
  if (process.platform === "win32") return [];
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  return result.stdout
    .split(/\s+/u)
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

async function waitForPortClear(port: number, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (listenerPids(port).length === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Electron-owned local port ${port} did not close.`);
}

async function stopOwnedPortListeners(port: number): Promise<void> {
  const owned = new Set(listenerPids(port));
  for (const pid of owned) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      owned.delete(pid);
    }
  }
  try {
    await waitForPortClear(port, 5_000);
    return;
  } catch {
    // Electron can keep its remote-debugging child alive after the launcher exits.
  }
  const remaining = new Set(listenerPids(port));
  for (const pid of owned) {
    if (!remaining.has(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The fixture-owned listener may exit between inspection and signal.
    }
  }
  await waitForPortClear(port, 5_000);
}

async function seedCompletedFirstRun(page: CdpPage): Promise<void> {
  await page.waitFor(
    "document.readyState === 'complete' && performance.getEntriesByType('navigation')[0]?.loadEventEnd > 0",
    "initial document",
    60_000,
  );
  // Electron resolves BrowserWindow.loadURL immediately after the load event.
  // Give that startup promise one event-loop turn before intentionally reloading.
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const completedState = JSON.stringify({
    schema: "butler.app.first-run.v1",
    status: "complete",
    language: "ko",
    step: "model",
    language_confirmed: true,
    safety_accepted: true,
    install_status: "ready",
    connection_mode: "bundled-agent",
    completed_at: new Date().toISOString(),
  });
  await page.evaluate(`(() => {
    localStorage.setItem(
      ${JSON.stringify(FIRST_RUN_STORAGE_KEY)},
      ${JSON.stringify(completedState)}
    );
    return true;
  })()`);
  await page.reload();
  await page.waitFor(
    `document.querySelector(${JSON.stringify("[data-test-class=\"workspace\"]")}) !== null`,
    "workspace",
    120_000,
  );
}

function electronBinary(repoRoot: string): string {
  return resolve(
    repoRoot,
    "packages",
    "butler-app",
    "client",
    "electron",
    "node_modules",
    ".bin",
    process.platform === "win32" ? "electron.cmd" : "electron",
  );
}

function electronAppRoot(repoRoot: string): string {
  return resolve(repoRoot, "packages", "butler-app", "client", "electron");
}

function uiIndex(repoRoot: string): string {
  return resolve(
    repoRoot,
    "packages",
    "butler-app",
    "client",
    "ui",
    "dist",
    "index.html",
  );
}

export async function launchProduct(
  run: PreparedRun,
  providerEndpoint: string,
): Promise<ProductLaunch> {
  const binary = electronBinary(run.repoRoot);
  assert(existsSync(binary), `Electron binary is missing: ${binary}`);
  assert(existsSync(uiIndex(run.repoRoot)), "UI dist is missing; build the App UI first.");
  assert(listenerPids(run.serverPort).length === 0, `App server port is in use: ${run.serverPort}`);
  assert(listenerPids(run.debugPort).length === 0, `Electron debug port is in use: ${run.debugPort}`);
  const executor = await startNativeExecutor(run, providerEndpoint);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BUTLER_APP_ELECTRON_USER_DATA_DIR: run.electronProfile,
    BUTLER_APP_GATEWAY_PID_FILE: "off",
    BUTLER_APP_SERVER_PORT: String(run.serverPort),
    BUTLER_BUN: process.execPath,
    BUTLER_CODEX_BASE_URL: providerEndpoint,
    BUTLER_DATA: run.dataRoot,
    BUTLER_HOME: run.repoRoot,
    BUTLER_PROJECT_WORKSPACE: run.projectWorkspaceRoot,
  };
  delete env.BUTLER_APP_BUTLER_HOME;
  delete env.BUTLER_APP_DEV_ORIGIN;
  delete env.BUTLER_APP_SERVER_BRIDGE;
  delete env.BUTLER_APP_SERVER_DB;
  delete env.BUTLER_APP_SERVER_URL;
  delete env.BUTLER_APP_UI_URL;
  const output: string[] = [];
  const child = spawn(
    binary,
    [
      `--remote-debugging-port=${run.debugPort}`,
      `--user-data-dir=${run.electronProfile}`,
      electronAppRoot(run.repoRoot),
    ],
    {
      cwd: run.repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => output.push(String(chunk)));
  child.stderr?.on("data", (chunk) => output.push(String(chunk)));
  try {
    const connected = await connectElectronPage(run.debugPort, child);
    await seedCompletedFirstRun(connected.page);
    return {
      ...connected,
      child,
      executor: executor.child,
      executorOutput: executor.output,
      interruptedExecutorReplaced: false,
      output,
      providerEndpoint,
      startedAtMs: Date.now(),
    };
  } catch (error) {
    await stopChildProcess(child);
    await stopNativeExecutor(run, executor.child);
    throw error;
  }
}

export async function replaceInterruptedExecutorOnce(
  run: PreparedRun,
  launch: ProductLaunch,
): Promise<boolean> {
  if (!hasInterruptedInboundForExecutor(run, launch.executor.pid)) return false;
  assert(
    !run.interruptedExecutorReplacementUsed,
    "A second native executor process-replacement recovery was requested.",
  );
  await stopNativeExecutor(run, launch.executor);
  const replacement = await startNativeExecutor(
    run,
    launch.providerEndpoint,
    launch.executorOutput,
  );
  launch.executor = replacement.child;
  launch.interruptedExecutorReplaced = true;
  run.interruptedExecutorReplacementUsed = true;
  return true;
}

export async function bridgeCall<T>(
  page: CdpPage,
  method: BridgeMethod,
  argument?: unknown,
): Promise<T> {
  return await page.evaluate<T>(`(async () => {
    const bridge = window.butlerApp;
    if (!bridge) throw new Error("Electron product bridge is unavailable.");
    const callable = bridge[${JSON.stringify(method)}];
    if (typeof callable !== "function") {
      throw new Error(${JSON.stringify(`Electron product bridge method is unavailable: ${method}`)});
    }
    return await callable(${JSON.stringify(argument)});
  })()`);
}

export async function openSession(
  run: PreparedRun,
  page: CdpPage,
): Promise<void> {
  await page.clickButtonByName(run.sessionTitle);
  await page.waitFor(
    `document.querySelector(${JSON.stringify("[data-test-class=\"composer-card\"] textarea")}) !== null`,
    "composer",
  );
  const view = await bridgeCall<AppSessionView>(page, "getSessionView", {
    sessionId: run.sessionId,
  });
  assert(view.session_id === run.sessionId, "Renderer opened an unexpected session.");
  assert(view.kind === run.sessionKind, "Renderer opened an unexpected session kind.");
  if (run.sessionKind === "project") {
    assert(
      view.project_id === run.projectId,
      "Renderer opened a project session for an unexpected project.",
    );
  }
}

export async function ensureSession(
  run: PreparedRun,
  launch: ProductLaunch,
  fixtures: readonly ElectronFixtureFile[] = [],
): Promise<void> {
  await bridgeCall<Record<string, unknown>>(launch.page, "health");
  if (run.sessionKind === "project" && !run.projectId) {
    const createdProject = await bridgeCall<{
      project?: { id?: string; display_name?: string };
    }>(launch.page, "createProject", {
      displayName: run.projectDisplayName,
      idempotencyKey: `btcc-r3-e2e:${run.runId}:create-project`,
      source: "scratch",
    });
    const projectId = createdProject.project?.id;
    assert(projectId, "Electron App did not return the created scratch project.");
    activateProjectSessionWorkspace(run, projectId, fixtures);
  }
  const listed = await bridgeCall<{
    sessions?: Array<{ id?: string; project_id?: string; title?: string }>;
  }>(launch.page, "listSessions", {
    kind: run.sessionKind,
    ...(run.projectId ? { projectId: run.projectId } : {}),
  });
  if (!(listed.sessions ?? []).some((session) => session.id === run.sessionId)) {
    const created = await bridgeCall<{
      session?: { id?: string; project_id?: string };
    }>(
      launch.page,
      "createSession",
      {
        idempotencyKey: `btcc-r3-e2e:${run.runId}:create-session`,
        kind: run.sessionKind,
        ...(run.projectId ? { projectId: run.projectId } : {}),
        sessionHint: run.sessionId,
        title: run.sessionTitle,
      },
    );
    assert(
      created.session?.id === run.sessionId,
      "Electron App created an unexpected session.",
    );
    if (run.sessionKind === "project") {
      assert(
        created.session?.project_id === run.projectId,
        "Electron App created the session under an unexpected project.",
      );
    }
  }
  await bridgeCall(launch.page, "updateSessionControls", {
    sessionId: run.sessionId,
    controls: {
      access_mode: run.accessMode,
      model: run.model,
      plan_mode: false,
      reasoning_effort: run.reasoningEffort,
    },
  });
  await launch.page.reload();
  await openSession(run, launch.page);
}

export async function rendererFinalText(page: CdpPage): Promise<string> {
  try {
    await page.waitFor(
      `document.querySelectorAll(${JSON.stringify("[data-test-class=\"turn-result-section\"]")}).length > 0`,
      "final result",
    );
  } catch {
    return await page.innerText(
      '[data-test-class="turn-result-section"]',
      { last: true },
    );
  }
  return await page.innerText('[data-test-class="turn-result-section"]', { last: true });
}

export async function stopProduct(
  run: PreparedRun,
  launch: ProductLaunch,
): Promise<void> {
  try {
    await bridgeCall(launch.page, "quitApp");
  } catch {
    // Renderer may disconnect while the quit request is acknowledged.
  }
  await stopChildProcess(launch.child);
  launch.client.close();
  await stopOwnedPortListeners(run.serverPort);
  await stopOwnedPortListeners(run.debugPort);
  await stopNativeExecutor(run, launch.executor);
}
