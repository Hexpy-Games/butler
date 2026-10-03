import { advanceWallpaperClock, HEALTHY_WATCHDOG, nextWallpaperFrameSlot, stepFrameWatchdog,
  WALLPAPER_ANIMATED_FPS, wallpaperFrameDue } from "../../blocks/Wallpaper/scheduler";
import { readWallpaperSignals, watchWallpaperContext, watchWallpaperSignals } from "../../blocks/Wallpaper/signals";
import { createDecorationMeter } from "./metrics";
import { createDecorationPainter } from "./painter";
import type { DecorationMetrics, DecorationOptions } from "./types";

/** One canvas, one bounded loop; keystrokes only set a timestamp. */
class DecorationRuntime {
  private signals = readWallpaperSignals();
  private painter: ReturnType<typeof createDecorationPainter>;
  private meter: ReturnType<typeof createDecorationMeter>;
  private cleanups: Array<() => void> = [];
  private frame = 0;
  private clock = 6000;
  private tickAt: number | null = null;
  private slot: number | null = null;
  private typedAt = -Infinity;
  private dirty = true;
  private available = true;
  private contextLost = false;
  private watchdog = { ...HEALTHY_WATCHDOG };
  private pulseDuration: number;

  constructor(private canvas: HTMLCanvasElement, private form: HTMLFormElement,
    private options: DecorationOptions, report: (metrics: DecorationMetrics) => void) {
    this.meter = createDecorationMeter(canvas, report);
    this.pulseDuration = parseFloat(getComputedStyle(canvas).getPropertyValue("--pulse-duration"));
    this.painter = createDecorationPainter(canvas, options, () => { this.available = false; });
    this.painter.resize();
    this.cleanups.push(watchWallpaperSignals(canvas, (patch) => {
      if (Object.entries(patch).every(([key, value]) => this.signals[key as keyof typeof this.signals] === value)) return;
      this.signals = { ...this.signals, ...patch };
      this.wake();
    }, () => { if (this.painter.resize()) this.wake(); }));
    if (options.theme === "coastal") this.cleanups.push(watchWallpaperContext(canvas,
      () => { this.contextLost = true; this.wake(); },
      () => { this.painter.restore(); this.contextLost = false; this.dirty = true; this.wake(); }));
    form.addEventListener("input", this.input);
    this.wake();
  }

  private paused() {
    return this.options.mode === "static" || this.signals.reducedMotion || this.signals.onBattery || this.watchdog.degraded;
  }

  private hidden() {
    return this.signals.documentHidden || !this.signals.intersecting || this.contextLost;
  }

  private input = (event: Event) => {
    const start = performance.now();
    if (this.paused() || this.hidden() || !this.available) return;
    if (!(event.target instanceof HTMLElement) || !event.target.closest('[role="textbox"], textarea')) return;
    this.typedAt = start;
    this.schedule();
    this.meter.input(performance.now() - start);
  };

  private schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  private wake() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.tickAt = null;
    this.slot = null;
    this.typedAt = -Infinity;
    if (this.hidden() || !this.available) {
      this.meter.report(this.available ? "hidden" : "unavailable", true);
      return;
    }
    this.dirty = true;
    this.schedule();
  }

  private tick = (now: number) => {
    this.frame = 0;
    if (this.hidden() || !this.available) return;
    const paused = this.paused();
    const phase = Math.min(1, Math.max(0, (now - this.typedAt) / this.pulseDuration));
    const pulse = paused ? 0 : (1 - phase) ** 2;
    const ambient = this.options.theme === "coastal" || this.options.theme === "cherry-blossom";
    const live = !paused && (ambient || pulse > 0);
    if (live && this.tickAt !== null) this.clock = advanceWallpaperClock(this.clock, now - this.tickAt);
    this.tickAt = live ? now : null;
    if (this.dirty || wallpaperFrameDue(now, this.slot, WALLPAPER_ANIMATED_FPS)) {
      const start = performance.now();
      this.painter.draw(this.clock, pulse, phase);
      const duration = performance.now() - start;
      this.meter.draw(duration);
      this.watchdog = stepFrameWatchdog(this.watchdog, duration);
      this.slot = nextWallpaperFrameSlot(now, this.slot, WALLPAPER_ANIMATED_FPS);
      this.dirty = false;
    }
    const running = live && !this.watchdog.degraded;
    this.meter.report(running ? "live" : "still", !running);
    if (running) this.schedule();
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.form.removeEventListener("input", this.input);
    this.cleanups.forEach((cleanup) => cleanup());
    this.painter.dispose();
  }
}

export function mountComposerDecoration(canvas: HTMLCanvasElement, form: HTMLFormElement,
  options: DecorationOptions, report: (metrics: DecorationMetrics) => void): () => void {
  const runtime = new DecorationRuntime(canvas, form, options, report);
  return () => runtime.dispose();
}
