import { app, BrowserWindow, ipcMain } from "electron";
import { createLifecycleWindow, parkLifecycleWindow } from "./lifecycle-window.mjs";
import { openLifecycleLog } from "./lifecycle-diagnostics.mjs";

const createdAt = process.getCreationTime();
const startedAt = createdAt === null ? null : performance.now() - (Date.now() - createdAt);
const events = [];
let firstPaintResolve;
const firstPaint = new Promise((resolve) => { firstPaintResolve = resolve; });
let surface = null;
let timeout;
let slow;
let dwell;
let displayedAt = 0;
let state = { kind: "startup", stage: "prepare", failed: false };
let actions = {};
let readyResolve;
const rendererReady = new Promise((resolve) => { readyResolve = resolve; });
let rendererId;

startupTiming("process_start");
export function startupTimings() { return events.map((event) => ({ ...event })); }
export function startupTiming(stage) {
  const elapsed = startedAt === null ? null : performance.now() - startedAt;
  events.push({ stage, elapsed_ms: elapsed === null ? null : Number(elapsed.toFixed(3)), timestamp_ms: Date.now() });
  console.info(JSON.stringify({ startup: events.at(-1) }));
}
function publish() { surface?.update(state); displayedAt = performance.now(); }
function clearStageTimers() { clearTimeout(timeout); clearTimeout(slow); clearTimeout(dwell); }
export function startupStage(stage) {
  if (state.failed || !surface || state.stage === stage && timeout) return;
  clearStageTimers();
  if (timeout) startupTiming(`stage_${state.stage}_end`);
  state = { ...state, stage, state: "working" };
  startupTiming(`stage_${stage}_start`);
  const remaining = 600 - (performance.now() - displayedAt);
  if (remaining > 0) dwell = setTimeout(publish, remaining); else publish();
  // Host tuning floor, 2026-10-06: keep 8 s until measured stage p95 warrants more.
  slow = setTimeout(() => { state.state = "slow"; publish(); }, 8000);
  timeout = setTimeout(failStartup, stage === "service" ? 120_000 : 30_000);
}
export function failStartup() {
  clearStageTimers();
  state = { ...state, failed: true, failedStage: state.stage, state: "error" };
  startupTiming("failed");
  publish();
  firstPaintResolve();
  return Boolean(surface && !surface.window.isDestroyed());
}
export function configureStartupActions(next) { actions = next; }
export function waitForStartupRenderer(win) {
  rendererId = win.webContents.id;
  win.webContents.setBackgroundThrottling(false);
  const failWhileStarting = () => { if (surface) failStartup(); };
  win.webContents.once("render-process-gone", failWhileStarting);
  win.webContents.once("did-fail-load", failWhileStarting);
  return rendererReady;
}
export function isStartupWindow(win) { return win === surface?.window; }
export function startupPending() { return Boolean(surface); }
export function completeStartup(win, show = true) {
  if (state.failed) return false;
  clearStageTimers();
  startupTiming(`stage_${state.stage}_end`);
  if (show) win.show();
  win.webContents.setBackgroundThrottling(true);
  startupTiming("main_window_ready");
  parkLifecycleWindow(surface); surface = null;
  startupTiming("splash_hidden");
  return true;
}
export function createStartupWindow() {
  surface = createLifecycleWindow({ BrowserWindow, kind: "startup", timing: startupTiming,
    onPainted() { startupTiming("splash_shown"); firstPaintResolve(); },
    async onAction(action) {
      if (!state.failed) return;
      if (action === "retry") {
        startupTiming("retry_requested");
        await actions.retry?.();
        startupTiming("retry_stopped");
        app.relaunch(); startupTiming("retry_relaunch_registered"); app.exit(0);
      } else if (action === "log") await openLifecycleLog(state, events, actions.diagnostics?.());
      else if (action === "quit") app.quit();
    },
  });
  ipcMain.on("butler:renderer-ready", (event) => {
    if (surface && event.sender.id === rendererId && event.senderFrame === event.sender.mainFrame) {
      startupTiming("renderer_data_painted"); readyResolve();
    }
  });
  surface.window.webContents.once("render-process-gone", failStartup);
  surface.window.webContents.once("did-fail-load", failStartup);
  startupStage("prepare");
  return firstPaint;
}
