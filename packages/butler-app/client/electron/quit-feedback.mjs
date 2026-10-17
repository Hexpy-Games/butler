import { createLifecycleWindow } from "./lifecycle-window.mjs";
import { openLifecycleLog } from "./lifecycle-diagnostics.mjs";
import { startupTiming, startupTimings } from "./startup-window.mjs";
import { AGENT_STOP_KILL_TIMEOUT_MS } from "./app-agent-stop-intent.mjs";

// Quit ends within the Agent stop grace, so "slow" must show well before it.
export const QUIT_SLOW_MS = AGENT_STOP_KILL_TIMEOUT_MS / 2;
// Feedback precedes shutdown, but a quit window that never paints must not hold it.
export const QUIT_PAINT_WAIT_MS = 500;
export function createQuitFeedback(BrowserWindow, language = "en", diagnostics = () => ({})) {
  let surface;
  let started;
  let paintResolve;
  const firstPaint = new Promise((resolve) => { paintResolve = resolve; });
  let paintedOrDue;
  let timer;
  let stageTimer;
  let shown = false;
  let displayedAt = 0;
  let displayedStage = "saving";
  const pending = new Map();
  let state = { kind: "quit", stage: "saving", state: "working", forceQuit: false };
  const publish = () => {
    clearTimeout(stageTimer);
    if (!shown || displayedStage === state.stage) { surface.update(state); return; }
    const update = () => { surface.update(state); displayedStage = state.stage; displayedAt = performance.now(); };
    const remaining = 600 - (performance.now() - displayedAt);
    if (remaining > 0) stageTimer = setTimeout(update, remaining); else update();
  };
  return {
    begin(mainWindow) {
      if (started !== undefined) return paintedOrDue;
      started = performance.now(); startupTiming("quit_start");
      const hideMain = () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); trace("main_hidden", started); };
      hideMain();
      surface = createLifecycleWindow({ BrowserWindow, kind: "quit", locale: language,
        bounds: mainWindow?.getBounds(), timing: startupTiming,
        onPainted() { shown = true; displayedAt = performance.now(); displayedStage = state.stage;
          trace("window_shown", started); startupTiming("quit_shown"); paintResolve(); },
        onAction(action) { if (action === "log") return openLifecycleLog(state, startupTimings(), diagnostics()); },
      });
      timer = setTimeout(() => { clearTimeout(stageTimer); state.state = "timeout"; surface.update(state);
        displayedAt = performance.now(); displayedStage = state.stage; trace("budget_exceeded", started); }, QUIT_SLOW_MS);
      paintedOrDue = Promise.race([firstPaint, new Promise((resolve) => setTimeout(resolve, QUIT_PAINT_WAIT_MS))]);
      return paintedOrDue;
    },
    phase(phase, edge = "event") {
      if (!surface) return;
      if (edge === "begin") pending.set(phase, (pending.get(phase) ?? 0) + 1);
      if (edge === "end") {
        const count = (pending.get(phase) ?? 1) - 1;
        if (count) pending.set(phase, count); else pending.delete(phase);
      }
      const active = [...pending.keys()];
      if (active.includes("turn_drain") || active.includes("app_projection_join")) state.stage = "saving";
      else if (active.some((item) => item.includes("stor") || item === "transcript_close")) state.stage = "storage";
      else if (active.some((item) => item.includes("embedding"))) state.stage = "search";
      else if (active.includes("runtime_close")) state.stage = "services";
      else if (active.some((item) => item.startsWith("app_") || item === "control_close")) state.stage = "connections";
      else if (phase === "port_release") state.stage = "finishing";
      publish();
    },
    destroy() { clearTimeout(timer); clearTimeout(stageTimer); surface?.destroy(); startupTiming("quit_end"); },
  };
}
function trace(phase, started) {
  console.error(`[desktop-quit] elapsed_ms=${(performance.now() - started).toFixed(3)} phase=${phase}`);
}
