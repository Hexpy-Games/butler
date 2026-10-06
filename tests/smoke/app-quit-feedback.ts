// Electron smoke: full queue recovery, immediate native feedback, real exit.
// Host: build UI/Agent, set BUTLER_NATIVE_AGENT_EXECUTABLE, then bun run this file.
// --baseline measures the unmodified shell with identical durability assertions.
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { _electron, type ElectronApplication } from "playwright";
import { quitFixture } from "./app-quit-fixture.ts";
import { smokeBrowserArgs } from "../support/smoke-browser-args.ts";
import { quitPhaseReport } from "./quit-phase-report.ts";

import { nativeSmokeRuntime } from "../support/native-smoke-runtime";
const nativeExitCode = await nativeSmokeRuntime(import.meta.url);
if (nativeExitCode !== null) process.exit(nativeExitCode);
const { DatabaseSync: Database } = await import("node:sqlite");

const baseline = process.argv.includes("--baseline");
const blocked = process.argv.includes("--blocked");
const fixture = await quitFixture();
const executablePath = createRequire(resolve("packages/butler-app/client/electron/package.json"))("electron") as string;
const extraArgs = smokeBrowserArgs();
const entry = resolve(process.env.BUTLER_QUIT_ELECTRON_ROOT ?? "packages/butler-app/client/electron");
let application: ElectronApplication | undefined;
let applicationProcess: ReturnType<ElectronApplication["process"]> | undefined;
let phaseLog = "";
const latencyMeasurements: Array<{ hidden_ms: number; feedback_ms: number; status: string }> = [];

async function waitFor(check: () => Promise<boolean>, label: string, timeout = 10_000) {
  const deadline = performance.now() + timeout;
  while (!await check()) {
    assert(performance.now() < deadline, label);
    await new Promise((done) => setTimeout(done, 20));
  }
}

async function launch() {
  const app = await _electron.launch({ executablePath, args: [...extraArgs, entry], env: fixture.env, timeout: 30_000 });
  // Buffer only structured timing lines. Never print auth, prompts or general logs.
  let pending = "";
  app.process().stderr?.on("data", (chunk) => {
    const lines = (pending + String(chunk)).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (/\[(native-shutdown|desktop-quit)\]/u.test(line)) phaseLog += `${line}\n`;
    }
  });
  application = app;
  applicationProcess = app.process();
  await waitFor(async () => {
    try { return (await fixture.api("/runtime-readiness")).btcc_executor_ready === true; } catch { return false; }
  }, "Agent not ready", 30_000);
  await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible() && !window.webContents.getURL().includes("/lifecycle/lifecycle.html"))), "main window not visible", 30_000);
  return app;
}

async function quit(app: ElectronApplication, holdStorage = blocked) {
  const process = app.process();
  const exited = new Promise<void>((done) => process.once("exit", () => done()));
  const started = performance.now();
  phaseLog = "";
  const lock = holdStorage ? new Database(resolve(fixture.data, "agent-runtime/btcc.sqlite")) : null;
  lock?.exec("BEGIN IMMEDIATE");
  let slowStatus = "";
  let slowFailure: unknown;
  const released = lock ? new Promise<void>((done) => setTimeout(() => {
    void app.evaluate(async ({ BrowserWindow }) => {
      const surface = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes("/lifecycle/lifecycle.html"));
      return surface ? await surface.webContents.executeJavaScript("document.querySelector('[data-slot=caption]').textContent") as string : "";
    }).then((status) => { slowStatus = status; }, (error: unknown) => { slowFailure = error; }).finally(() => {
      lock.exec("ROLLBACK"); lock.close(); done();
    });
  }, 15_500)) : Promise.resolve();
  let measured: { hidden_ms: number; feedback_ms: number; status: string } | undefined;
  let pending = "";
  process.stderr?.on("data", (chunk) => {
    const lines = (pending + String(chunk)).split("\n"); pending = lines.pop() ?? "";
    for (const line of lines) { try { const value = JSON.parse(line); measured = value.quitSmoke ?? measured; } catch { /* structured evidence only */ } }
  });
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    const start = performance.now();
    const main = BrowserWindow.getAllWindows().find((win) => win.isVisible() && !win.webContents.getURL().includes("/lifecycle/lifecycle.html"))!;
    {
      let hidden = -1;
      let shown = -1;
      let status = "";
      const complete = () => { if (hidden >= 0 && shown >= 0 && status) console.error(JSON.stringify({ quitSmoke: { hidden_ms: hidden, feedback_ms: shown, status } })); };
      const painted = (event: { sender: unknown }, profile: { card?: { line?: string; fontReady?: boolean; markReady?: boolean; images?: number } }) => {
        if (event.sender === main.webContents || !(event.sender as { getURL(): string }).getURL().includes("/lifecycle/lifecycle.html")) return;
        ipcMain.removeListener("butler:lifecycle-painted", painted);
        if (profile.card?.fontReady && profile.card.markReady && profile.card.images === 0) {
          shown = performance.now() - start;
          // Native visibility is the effect being budgeted; Cocoa hide events can arrive after exit.
          hidden = main.isVisible() ? -1 : shown;
          status = profile.card.line ?? ""; complete();
        }
      };
      ipcMain.on("butler:lifecycle-painted", painted);
      void main.webContents.executeJavaScript("window.butlerApp.quitApp({confirmed:true})");
    }
  });
  await exited;
  await released;
  console.log(JSON.stringify({ phases: quitPhaseReport(phaseLog) }));
  assert.ifError(slowFailure);
  assert.ok(measured, "Quit first frame evidence unavailable");
  const timing = measured;
  assert.equal(process.exitCode, 0);
  const total = performance.now() - started;
  console.log(JSON.stringify({ scenario: baseline ? "before" : "after", blocked: holdStorage, quit_to_exit_ms: total, ...timing }));
  if (!baseline) {
    latencyMeasurements.push(timing);
    assert(timing.status.length > 0);
    assert.equal(fixture.lastExit().graceful, true);
    assert.equal(fixture.lastExit().port_released, true);
    assert.equal(fixture.lastExit().process_tree_dead, true);
    if (holdStorage) assert(/평소보다 오래|longer than usual/u.test(slowStatus), slowStatus);
  }
}

try {
  const app = await launch();
  await fixture.api("/messages", { chat_id: "general", text: "Start streaming", client_message_id: crypto.randomUUID() });
  await waitFor(async () => (await fixture.api("/messages?chat_id=general")).messages?.some((message: any) => message.role === "assistant" && message.text?.startsWith("one")), "stream never active");
  await fixture.api("/session-queue", { chat_id: "general", text: "Reply waiting", client_message_id: crypto.randomUUID() });
  await quit(app);
  const restarted = await launch();
  await waitFor(async () => {
    const turns = (await fixture.api("/turns?chat_id=general")).turns;
    return turns?.length === 2 && turns.some((turn: any) => turn.state === "delivered");
  }, "follow-up not recovered");
  const queue = await fixture.api("/session-queue?chat_id=general");
  assert.equal(queue.paused, false);
  assert.equal(queue.queued_messages.length, 1);
  assert.equal(queue.queued_messages[0].safe_error_code, "turn_interrupted");
  const turns = (await fixture.api("/turns?chat_id=general")).turns;
  const interrupted = turns.find((turn: any) => (turn.turn_id ?? turn.id) === queue.queued_messages[0].turn_id);
  assert.equal(interrupted.safe_error_code, "turn_interrupted");
  assert.equal(interrupted.retryable, true);
  assert.equal(turns.filter((turn: any) => turn.state === "delivered").length, 1);
  const messages = (await fixture.api("/messages?chat_id=general")).messages;
  assert.equal(messages.filter((message: any) => message.role === "user").length, 2);
  assert.equal(messages.filter((message: any) => message.role === "assistant" && message.text?.trim() === "waiting").length, 1);
  console.log(JSON.stringify({ model_calls: fixture.calls(), turn_streams: fixture.streamingCalls() }));
  assert.equal(fixture.streamingCalls(), 2);
  await quit(restarted, false);
  application = undefined;
  console.log("PASS: active input retryable, follow-up delivered once, queue unpaused");
  for (const timing of latencyMeasurements) {
    assert(timing.hidden_ms >= 0 && timing.hidden_ms <= 200, JSON.stringify(timing));
    assert(timing.feedback_ms >= 0 && timing.feedback_ms <= 200, JSON.stringify(timing));
  }
} finally {
  if (application && applicationProcess?.exitCode === null) await application.close();
  fixture.cleanup();
}
