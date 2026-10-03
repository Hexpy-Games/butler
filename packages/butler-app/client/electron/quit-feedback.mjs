import { createLifecycleWindow } from "./lifecycle-window.mjs";
import { getDesktopCopy } from "./i18n/desktop-copy.mjs";

// Same budget as the service's stop grace. Exceeding it changes copy only.
export const QUIT_BUDGET_MS = 6000;

export function createQuitFeedback(BrowserWindow, language = "en") {
  const copy = getDesktopCopy(language);
  const surface = createLifecycleWindow({ BrowserWindow, title: copy.quitting, status: copy.quitSaving });
  let started = null;
  let timer = null;
  let exceeded = false;
  let step = copy.quitSaving;
  const pending = new Map();
  const publish = () => surface.status(exceeded ? `${copy.quitSlow} ${step}` : step);
  return {
    begin(mainWindow) {
      if (started !== null) return;
      started = performance.now();
      mainWindow?.hide();
      trace("main_hidden", started);
      surface.show();
      timer = setTimeout(() => { exceeded = true; publish(); trace("budget_exceeded", started); }, QUIT_BUDGET_MS);
    },
    phase(phase, edge = "event") {
      if (started === null) return;
      if (edge === "begin") pending.set(phase, (pending.get(phase) ?? 0) + 1);
      if (edge === "end") {
        const count = (pending.get(phase) ?? 1) - 1;
        if (count) pending.set(phase, count); else pending.delete(phase);
      }
      const active = [...pending.keys()];
      if (active.includes("turn_drain") || active.includes("app_projection_join")) step = copy.quitSaving;
      else if (active.some((item) => item.includes("stor") || item === "transcript_close")) step = copy.quitStorage;
      else if (active.some((item) => item.includes("embedding"))) step = copy.quitEmbedding;
      else if (active.includes("runtime_close")) step = copy.quitServices;
      else if (active.some((item) => item.startsWith("app_") || item === "control_close")) step = copy.quitConnections;
      else if (phase === "port_release") step = copy.quitFinishing;
      publish();
    },
    failed() {
      if (timer) clearTimeout(timer);
      timer = null;
      exceeded = false;
      step = copy.quitFailed;
      publish();
    },
    destroy() { if (timer) clearTimeout(timer); surface.destroy(); },
  };
}

function trace(phase, started) {
  console.error(`[desktop-quit] elapsed_ms=${(performance.now() - started).toFixed(3)} phase=${phase}`);
}
