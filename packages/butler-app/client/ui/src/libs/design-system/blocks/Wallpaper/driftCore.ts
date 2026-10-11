// Shared state of a drifting print and its rest modes (riso-core.js settle/startSeg/step/segEnd/retime/still):
// at rest one keyframe per segment is drawn into the hidden top layer and faded in by timer-stepped opacity.
import { RISO_SEGMENT_FLOW, driftFactor, driftSegmentMs, driftStepMs, type DriftBoost, type DriftHost } from "./drift";
import type { DriftLayers } from "./driftLayers";
import type { DriftLooks } from "./driftLooks";

/** What a print frame draws besides the scene: the flow and the looks' state. */
export interface DriftFrame {
  flow: number;
  looks: DriftLooks["state"];
}

export interface DriftDeps {
  layers: DriftLayers;
  looks: DriftLooks;
  /** Draws one frame into the WebGL canvas (presented to a layer right after, in the same task). */
  render(frame: DriftFrame): void;
  /** Runs a keyframe render under the keyframe watchdog; true when the print just degraded to a still. */
  timeKeyframe(render: () => void): boolean;
  /** The canvas's CSS size and the content keep-out (CSS px, x y w h) the new-chat drop avoids. */
  geometry(): { size: readonly [number, number]; keep: readonly number[] };
}

type Mode = "off" | "static" | "xfade" | "frozen" | "live";
interface Segment { f0: number; f1: number; a0: number; t0: number; dur: number }

export interface DriftCore {
  deps: DriftDeps;
  mode: Mode;
  host: DriftHost;
  hidden: boolean;
  /** Something changed while hidden: draw again on show. */
  dirty: boolean;
  flow: number;
  layerFlow: [number, number];
  seg: Segment | null;
  boosts: DriftBoost[];
  timer: number;
  raf: number;
  /** Last live frame time; 0 = none yet. */
  last: number;
  fadeTop: { from: number; t0: number } | null;
  drawTo(layer: 0 | 1, flow: number): void;
  clearTimers(): void;
  segAlpha(now: number): number;
  displayFlow(now: number): number;
  settle(now: number): void;
  retime(now: number): void;
  still(now: number): void;
  /** Live frames take over (events, zone eases); set by the live module. */
  enterLive(now: number): void;
}

export function createDriftCore(deps: DriftDeps): DriftCore {
  const core: DriftCore = {
    deps, mode: "off", host: "full", hidden: false, dirty: false, flow: 0, layerFlow: [0, 0], seg: null, boosts: [],
    timer: 0, raf: 0, last: 0, fadeTop: null,
    drawTo(layer, flow) {
      deps.render({ flow, looks: deps.looks.state });
      deps.layers.present(layer);
      core.layerFlow[layer] = flow;
    },
    clearTimers() {
      if (core.raf) window.cancelAnimationFrame(core.raf);
      if (core.timer) window.clearTimeout(core.timer);
      core.raf = 0;
      core.timer = 0;
    },
    segAlpha(now) {
      const seg = core.seg!;
      return seg.a0 + (1 - seg.a0) * Math.min(1, Math.max(0, (now - seg.t0) / seg.dur));
    },
    displayFlow(now) {
      if (!core.seg) return core.mode === "live" ? core.flow : core.layerFlow[0];
      const a = core.mode === "frozen" || core.hidden ? core.seg.a0 : core.segAlpha(now);
      return core.seg.f0 + a * (core.seg.f1 - core.seg.f0);
    },
    settle(now) {
      core.clearTimers();
      core.last = 0;
      if (driftFactor(core.host) === 0) {
        core.mode = "static";
        core.seg = null;
        deps.layers.opacity(1, 0);
        return;
      }
      startSegment(now);
    },
    retime(now) {
      if (core.mode === "live" || core.mode === "off") return;
      if (core.host === "still") return core.still(now);
      if (core.seg && (core.mode === "xfade" || core.mode === "frozen")) {
        const a = core.mode === "frozen" ? core.seg.a0 : core.segAlpha(now);
        core.clearTimers();
        Object.assign(core.seg, { a0: a, t0: now });
        if (driftFactor(core.host) === 0) { core.mode = "frozen"; return; }
        core.mode = "xfade";
        core.seg.dur = driftSegmentMs(driftFactor(core.host)) * (1 - a);
        return runSegment();
      }
      core.settle(now);
    },
    still(now) {
      if (core.hidden) { core.dirty = true; return; }
      core.clearTimers();
      const flow = core.displayFlow(now);
      core.flow = flow;
      core.seg = null;
      core.fadeTop = null;
      core.drawTo(0, flow);
      deps.layers.opacity(1, 0);
      core.mode = "static";
    },
    enterLive: () => undefined,
  };

  function startSegment(now: number) {
    const f0 = core.layerFlow[0];
    const f1 = f0 + RISO_SEGMENT_FLOW;
    core.mode = "xfade";
    deps.layers.opacity(1, 0);
    if (deps.timeKeyframe(() => core.drawTo(1, f1))) return; // Degraded: the host turns still.
    core.seg = { f0, f1, a0: 0, t0: now, dur: driftSegmentMs(driftFactor(core.host)) };
    runSegment();
  }
  function runSegment() {
    core.timer = window.setTimeout(step, driftStepMs(driftFactor(core.host)));
  }
  function step() {
    core.timer = 0;
    if (core.hidden || !core.seg) return;
    const a = core.segAlpha(performance.now());
    deps.layers.opacity(1, a);
    core.flow = core.seg.f0 + a * (core.seg.f1 - core.seg.f0);
    if (a >= 1) segmentEnd();
    else runSegment();
  }
  function segmentEnd() {
    const seg = core.seg!;
    deps.layers.promote();
    core.layerFlow[0] = seg.f1;
    core.flow = seg.f1;
    core.seg = null;
    core.settle(performance.now());
  }
  return core;
}
