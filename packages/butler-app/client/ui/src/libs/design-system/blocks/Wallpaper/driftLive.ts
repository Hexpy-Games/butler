// Live frames of a drifting print (riso-core.js enterLive/frame/beat): events and zone eases render at 6-30 fps
// from their envelopes, then hand back to the crossfade from the last live frame.
import {
  RISO_DRIFT_RATE, RISO_ENTRY_DISSOLVE_MS, RISO_EVENTS, driftBoostLevel, driftEnvelopeLength, driftEventArea, driftExtraVelocity,
  driftFactor, driftLiveFps, driftRemainingFlow, type WallpaperEventKind,
} from "./drift";
import type { DriftCore } from "./driftCore";
import { WALLPAPER_WATCHDOG_SLOW_FRAMES, WALLPAPER_WATCHDOG_SLOW_RENDER_MS } from "./scheduler";

const smooth = (k: number) => k * k * (3 - 2 * k);

export interface DriftLive {
  /** Fires an event: live frames with its look, or (still host, hidden) its end state at once. */
  beat(kind: WallpaperEventKind): void;
  /** Ends every running event on its end state (hidden, a stalled GPU). */
  finishEvents(now: number): void;
}

export function createDriftLive(core: DriftCore): DriftLive {
  const { deps } = core;
  let slowStreak = 0;

  const request = () => {
    core.raf = window.requestAnimationFrame(frame);
  };
  // Waits for the next frame slot on a timer, so idle vsyncs never wake the page.
  const wait = (ms: number) => {
    if (ms <= 20) return request();
    core.timer = window.setTimeout(() => { core.timer = 0; request(); }, ms - 4);
  };
  const finishEvents = (now: number) => {
    deps.looks.finish();
    core.flow += driftRemainingFlow(core.boosts, now);
    core.boosts = [];
    core.fadeTop = null;
  };
  core.enterLive = (now) => {
    if (core.mode === "live") { if (!core.raf && !core.timer) request(); return; }
    let a = 0;
    if (core.seg) {
      a = core.mode === "frozen" ? core.seg.a0 : core.segAlpha(now);
      core.flow = core.seg.f0 + a * (core.seg.f1 - core.seg.f0);
    } else core.flow = core.layerFlow[0];
    core.clearTimers();
    deps.layers.opacity(1, a);
    core.seg = null;
    core.mode = "live";
    // The live frame takes over the base layer while the crossfade layer dissolves away: no pop.
    core.fadeTop = a > 0 ? { from: a, t0: now } : null;
    core.last = 0;
    slowStreak = 0;
    request();
  };
  function draw(now: number) {
    const start = performance.now();
    core.drawTo(0, core.flow);
    slowStreak = performance.now() - start > WALLPAPER_WATCHDOG_SLOW_RENDER_MS ? slowStreak + 1 : 0;
    // Too slow for live frames: the event ends on its end state.
    if (slowStreak >= WALLPAPER_WATCHDOG_SLOW_FRAMES) { finishEvents(now); core.drawTo(0, core.flow); deps.layers.opacity(1, 0); }
  }
  function frame(now: number) {
    core.raf = 0;
    if (core.hidden || core.mode !== "live") return;
    const busy = deps.looks.tweening() || core.fadeTop !== null;
    const interval = 1000 / driftLiveFps(driftBoostLevel(core.boosts, now), busy);
    if (core.last && now - core.last < interval - 3) return wait(interval - (now - core.last));
    const dt = core.last ? Math.min((now - core.last) / 1000, 0.25) : 0;
    core.last = now;
    core.flow += dt * (RISO_DRIFT_RATE * driftFactor(core.host) + driftExtraVelocity(core.boosts, now));
    deps.looks.step(now);
    core.boosts = core.boosts.filter((boost) => now - boost.t0 < driftEnvelopeLength(boost.e));
    draw(now);
    if (core.fadeTop) {
      const k = (now - core.fadeTop.t0) / RISO_ENTRY_DISSOLVE_MS;
      deps.layers.opacity(1, k >= 1 ? 0 : core.fadeTop.from * (1 - smooth(k)));
      if (k >= 1) core.fadeTop = null;
    }
    const tweening = deps.looks.tweening() || core.fadeTop !== null;
    // Hand back when the envelope is exactly 0 and no look tweens: the next segment starts from this frame.
    if (core.boosts.length === 0 && !tweening) return core.settle(now);
    wait(1000 / driftLiveFps(driftBoostLevel(core.boosts, now), tweening));
  }
  return {
    beat(kind) {
      const e = RISO_EVENTS[kind];
      const now = performance.now();
      if (core.host === "still") {
        // A static print: an event moves the state and draws one still; thinking and done change nothing.
        if (kind === "thinking" || kind === "done") return;
        const flow = core.displayFlow(now) + driftEventArea(e);
        core.clearTimers();
        core.seg = null;
        core.flow = flow;
        core.layerFlow[0] = flow;
        core.mode = "static";
        return core.still(now);
      }
      const { size, keep } = deps.geometry();
      if (core.hidden) {
        // Hidden: the end state is applied at once and drawn on show.
        deps.looks.look(kind, now, size, keep);
        core.flow = core.displayFlow(now) + driftEventArea(e);
        finishEvents(now);
        core.clearTimers();
        Object.assign(core, { seg: null, mode: "static", dirty: true });
        core.layerFlow[0] = core.flow;
        return;
      }
      deps.looks.look(kind, now, size, keep);
      core.boosts.push({ e, t0: now });
      core.enterLive(now);
    },
    finishEvents,
  };
}
