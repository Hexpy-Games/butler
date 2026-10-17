import { app, BrowserWindow, ipcMain } from "electron";
import { startupTiming, startupTimings } from "./startup-timing.mjs";
export { startupTiming, startupTimings } from "./startup-timing.mjs";
import { createLifecycleWindow, parkLifecycleWindow } from "./lifecycle-window.mjs";
import { openLifecycleLog } from "./lifecycle-diagnostics.mjs";

let firstPaintResolve;
const firstPaint = new Promise((resolve) => { firstPaintResolve = resolve; });
let surface = null;
let timeout;
let slow;
let dwell;
let displayedAt = 0;
let state = { kind: "startup", stage: "prepare", failed: false };
let actions = {};
let retrying = false;
let readyResolve;
const rendererReady = new Promise((resolve) => { readyResolve = resolve; });
let rendererId;
const setupWindows = new WeakMap();
// After win.show(), macOS emits "show" only once the window is on screen; a locked or covered screen withholds it.
// The setup intro then settles on its still frame instead of waiting for a reveal nobody would see.
const SETUP_VISIBLE_DEADLINE_MS = 1500;
function watchSetupVisibility(win) {
  const setup = setupWindows.get(win);
  if (!setup || setup.settled) return;
  setTimeout(() => {
    // Shown (isVisible) without a "show" event: occluded. A window still hidden keeps waiting for its "show".
    if (!setup.settled && !win.isDestroyed() && win.isVisible()) setup.unseen();
  }, SETUP_VISIBLE_DEADLINE_MS);
}

ipcMain.handle("butler:setup-window-ready", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || event.senderFrame !== event.sender.mainFrame || !setupWindows.has(win)) {
    throw new Error("setup_window_unavailable");
  }
  return setupWindows.get(win).ready;
});

function publish() { surface?.update(state); displayedAt = performance.now(); }
function clearStageTimers() { clearTimeout(timeout); clearTimeout(slow); clearTimeout(dwell); }
export function startupStage(stage, deadlineAt = null) {
  if (state.failed || !surface || state.stage === stage && timeout && stage !== "storage") return;
  clearStageTimers();
  if (timeout) startupTiming(`stage_${state.stage}_end`);
  state = { ...state, stage, state: "working" };
  startupTiming(`stage_${stage}_start`);
  const remaining = 600 - (performance.now() - displayedAt);
  if (remaining > 0) dwell = setTimeout(publish, remaining); else publish();
  // Host tuning floor, 2026-10-06: keep 8 s until measured stage p95 warrants more.
  slow = setTimeout(() => { state.state = "slow"; publish(); }, 8000);
  timeout = setTimeout(failStartup, stage === "storage" && Number.isFinite(deadlineAt)
    ? Math.max(0, deadlineAt - Date.now()) : stage === "service" ? 120_000 : 30_000);
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
  const setup = { settled: false, unseen: () => {} };
  const painted = new Promise((resolve) => win.once("ready-to-show", () => { startupTiming("setup_window_painted"); resolve(); }));
  const shown = new Promise((resolve) => win.once("show", () => { startupTiming("setup_window_shown"); resolve(); }));
  const unseen = new Promise((resolve) => { setup.unseen = () => { startupTiming("setup_window_unseen"); resolve("still"); }; });
  setup.ready = Promise.race([Promise.all([painted, shown]).then(() => "shown"), unseen])
    .then((visibility) => { setup.settled = true; return visibility; });
  setupWindows.set(win, setup);
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
  if (show) { win.show(); watchSetupVisibility(win); }
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
        // Each app.relaunch() starts one more App, so a second click must not register another.
        if (retrying) return;
        retrying = true;
        startupTiming("retry_requested");
        try { await actions.retry?.(); } catch (error) { retrying = false; throw error; }
        startupTiming("retry_stopped");
        app.relaunch(); startupTiming("retry_relaunch_registered");
        if (actions.exit) actions.exit(); else app.exit(0);
      } else if (action === "log") await openLifecycleLog(state, startupTimings(), actions.diagnostics?.());
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
