// The drift render policy of print modules (riso spec "Rendering strategy: crossfade"): a timer-stepped crossfade
// between pre-rendered keyframes at rest, live frames only during events, host states and the column keep-out.
import type { DriftHost, WallpaperEventKind } from "./drift";
import { createDriftCore, type DriftDeps, type DriftFrame } from "./driftCore";
import { createDriftLive } from "./driftLive";

export type { DriftDeps, DriftFrame } from "./driftCore";

/** The message column keep-out: left, right, top (CSS px in the canvas) and on (0..1). */
export type DriftColumn = readonly [number, number, number, number];

export interface DriftController {
  /** A print scene shows: the first keyframes, then the first-paint focus event. Again while active: a refresh. */
  activate(): void;
  /** Another scene (or none) shows: timers stop and the layers hide. */
  deactivate(): void;
  active(): boolean;
  setHost(host: DriftHost): void;
  /** Hidden, minimised or occluded: everything stops; the segment resumes where it stopped. */
  setHidden(hidden: boolean): void;
  /** Params, tone, size or a keep-out changed: draw what shows again (the next live frame picks it up). */
  refresh(): void;
  event(kind: WallpaperEventKind): void;
  /** The column keep-out; null eases it off. Changes ease over 300 ms unless `animate` is false. True when it drew. */
  column(rect: DriftColumn | null, animate: boolean): boolean;
  /** The current frame into the WebGL canvas only (a source crossfade snapshots it). */
  repaint(): void;
  /** The context was lost: stop; `restore()` draws again. */
  stop(): void;
  restore(): void;
  dispose(): void;
}

export function createDriftController(deps: DriftDeps): DriftController {
  const core = createDriftCore(deps);
  const live = createDriftLive(core);
  let target: DriftColumn | null = null;

  const now = () => performance.now();
  const start = () => {
    core.drawTo(0, core.layerFlow[0]);
    deps.layers.opacity(1, 0);
    if (core.host === "still") core.mode = "static";
    else core.settle(now());
  };
  const refresh = () => {
    if (core.mode === "off") return;
    if (core.hidden) { core.dirty = true; return; }
    if (core.mode === "live") return;
    core.drawTo(0, core.layerFlow[0]);
    if (core.seg) core.drawTo(1, core.layerFlow[1]);
  };

  return {
    activate() {
      if (core.mode !== "off") return refresh();
      Object.assign(core, { mode: "static", flow: 0, layerFlow: [0, 0], seg: null, boosts: [], dirty: false });
      if (core.hidden) { core.dirty = true; return; }
      start();
      live.beat("focus");
    },
    deactivate() {
      if (core.mode === "off") return;
      core.clearTimers();
      deps.looks.finish();
      Object.assign(core, { mode: "off", seg: null, boosts: [], fadeTop: null, dirty: false });
      deps.layers.hide();
    },
    active: () => core.mode !== "off",
    setHost(host) {
      if (host === core.host) return;
      core.host = host;
      if (core.mode === "off" || core.hidden) return;
      if (host === "still" && core.mode === "live") live.finishEvents(now());
      if (host === "still") return core.still(now());
      core.retime(now());
    },
    setHidden(hidden) {
      if (hidden === core.hidden) return;
      const t = now();
      if (hidden) {
        if (core.mode === "live") { live.finishEvents(t); Object.assign(core, { mode: "static", dirty: true }); core.layerFlow[0] = core.flow; }
        if (core.seg) Object.assign(core.seg, { a0: core.mode === "frozen" ? core.seg.a0 : core.segAlpha(t), t0: t });
        core.clearTimers();
        core.hidden = true;
        return;
      }
      core.hidden = false;
      if (core.mode === "off") return;
      if (core.dirty) { core.dirty = false; core.seg = null; return start(); }
      if (core.seg) core.seg.t0 = t;
      core.retime(t);
    },
    refresh,
    event(kind) {
      if (core.mode !== "off") live.beat(kind);
    },
    column(rect, animate) {
      const next: DriftColumn = rect ?? [deps.looks.state.colL, deps.looks.state.colR, deps.looks.state.colT, 0];
      if (target && target.every((value, index) => Math.abs(value - next[index]!) < 0.5)) return false;
      const previous = target;
      target = next;
      const state = deps.looks.state;
      // Nothing to slide from: only fade the zone in.
      if (state.colOn === 0) [state.colL, state.colR, state.colT] = next;
      if (!animate || !previous || core.mode === "off" || core.host === "still" || core.hidden) {
        deps.looks.snapZone(next);
        refresh();
        return core.mode !== "off";
      }
      deps.looks.zone(next, now());
      core.enterLive(now());
      return true;
    },
    repaint() {
      if (core.mode !== "off") deps.render({ flow: core.displayFlow(now()), looks: deps.looks.state } satisfies DriftFrame);
    },
    stop() {
      core.clearTimers();
      if (core.mode === "live") { live.finishEvents(now()); core.layerFlow[0] = core.flow; }
      if (core.mode !== "off") Object.assign(core, { mode: "static", seg: null, dirty: true });
    },
    restore() {
      if (core.mode === "off" || core.hidden) return;
      core.dirty = false;
      start();
    },
    dispose() {
      core.clearTimers();
      deps.layers.dispose();
    },
  };
}
