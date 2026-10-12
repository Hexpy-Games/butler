// Run-state diagnostics of a wallpaper engine: one event per transition of what decides whether it draws (document
// visibility, the canvas on screen, the GL context) or of its effective mode, and one per episode of window resizes
// that drew nothing while it should draw. Change-driven only: nothing runs at idle, and the frame paths only bump a
// counter. The app decides where the events go (`setWallpaperDiagnostics`).
import { wallpaperDriftHost } from "./driftScheduler";
import type { WallpaperRenderer } from "./renderer";
import { wallpaperFrameMode, type WallpaperScheduleState } from "./scheduler";

export type WallpaperDiagnosticSignal = "visibility" | "onscreen" | "context" | "mode" | "resize";

/** `value`: the new state of `signal`; `mode` and `reason`: what the engine does now and why. */
export interface WallpaperDiagnosticEvent {
  signal: WallpaperDiagnosticSignal;
  value: string;
  mode: string;
  reason: string;
}

type Sink = (event: WallpaperDiagnosticEvent) => void;

let sink: Sink | null = null;

/** The app sink for every mounted wallpaper; null turns diagnostics off. */
export function setWallpaperDiagnostics(next: Sink | null): void {
  sink = next;
}

/** Why a print holds a static frame; null when nothing holds it. */
function stillReason(state: WallpaperScheduleState): string | null {
  if (state.reducedMotion) return "reduced-motion";
  if (state.motion === "paused") return "user-paused";
  if (state.pauseOnBattery && state.onBattery) return "battery";
  if (state.constrained) return "constrained";
  if (state.degraded) return "degraded";
  if (state.softwareRendering === true) return "software-gl";
  return null;
}

/** The effective mode (idle, intro, drift, paused, static, animate) and its reason. */
export function wallpaperDiagnosticMode(state: WallpaperScheduleState, intro: boolean, drift: boolean): { mode: string; reason: string } {
  if (state.contextLost) return { mode: "idle", reason: "context-lost" };
  if (state.documentHidden) return { mode: "idle", reason: "hidden" };
  if (!state.intersecting) return { mode: "idle", reason: "offscreen" };
  if (intro) return { mode: "intro", reason: "none" };
  const held = stillReason(state);
  if (drift) {
    const host = wallpaperDriftHost(state);
    if (host === "still") return { mode: "static", reason: held ?? "none" };
    if (host === "frozen") return { mode: "paused", reason: "blurred-long" };
    return { mode: "drift", reason: state.windowBlur === 1 ? "blurred" : state.onBattery ? "battery-slow" : "none" };
  }
  const frame = wallpaperFrameMode(state);
  return { mode: frame === "still" ? "static" : frame, reason: held ?? "none" };
}

export interface EngineDiagnosticsInputs {
  state(): WallpaperScheduleState;
  intro(): boolean;
  drift(): boolean;
}

export interface EngineDiagnostics {
  /** The renderer with its draws counted (one integer per draw). */
  count(renderer: WallpaperRenderer): WallpaperRenderer;
  /** The schedule state, the intro or the drift changed: report what moved. */
  check(): void;
  dispose(): void;
}

/** A window resize that drew nothing within this long, while the engine should draw, starts an episode. */
const RESIZE_SETTLE_MS = 700;

export function createEngineDiagnostics(canvas: HTMLCanvasElement, inputs: EngineDiagnosticsInputs): EngineDiagnostics {
  let draws = 0;
  let hidden: boolean | null = null, onscreen: boolean | null = null, lost: boolean | null = null;
  let mode = "", reason = "";
  let timer = 0, snapshot = 0, episode = false;
  let width = canvas.clientWidth, height = canvas.clientHeight;
  const emit = (signal: WallpaperDiagnosticSignal, value: string) => sink?.({ signal, value, mode, reason });
  const verify = () => {
    timer = 0;
    const moved = canvas.clientWidth !== width || canvas.clientHeight !== height;
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    if (draws !== snapshot) episode = false;
    else if (moved && !episode && (mode === "static" || mode === "drift")) {
      episode = true;
      emit("resize", "no_redraw");
    }
  };
  const resized = () => {
    if (!sink || timer) return;
    snapshot = draws;
    timer = window.setTimeout(verify, RESIZE_SETTLE_MS);
  };
  window.addEventListener("resize", resized);
  return {
    count(renderer) {
      return {
        ...renderer,
        draw(frame) { draws += 1; renderer.draw(frame); },
        drawIntro(frame, uniforms) { draws += 1; return renderer.drawIntro(frame, uniforms); },
      };
    },
    check() {
      if (!sink) return;
      const state = inputs.state();
      const next = wallpaperDiagnosticMode(state, inputs.intro(), inputs.drift());
      const changedMode = next.mode !== mode || next.reason !== reason;
      mode = next.mode;
      reason = next.reason;
      let reported = false;
      if (hidden !== null && hidden !== state.documentHidden) { emit("visibility", state.documentHidden ? "hidden" : "visible"); reported = true; }
      if (onscreen !== null && onscreen !== state.intersecting) { emit("onscreen", state.intersecting ? "yes" : "no"); reported = true; }
      if (lost !== null && lost !== state.contextLost) { emit("context", state.contextLost ? "lost" : "restored"); reported = true; }
      if (changedMode && !reported) emit("mode", mode);
      hidden = state.documentHidden;
      onscreen = state.intersecting;
      lost = state.contextLost;
    },
    dispose() {
      window.clearTimeout(timer);
      window.removeEventListener("resize", resized);
    },
  };
}
