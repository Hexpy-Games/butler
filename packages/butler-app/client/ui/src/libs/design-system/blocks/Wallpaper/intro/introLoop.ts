/** At most 60 frames a second on high-refresh displays (2 ms vsync slack); a budget, not a duration. */
const RISO_INTRO_FRAME_MS = 1000 / 60 - 2;

/**
 * The intro frame loop: rAF, capped at 60 fps, running while `frame(dt ms)` returns true. While `blocked` (hidden,
 * context lost) it stops and calls `onBlocked`, so the owner draws again once it can.
 */
export class IntroFrameLoop {
  private raf = 0;
  private last = 0;

  constructor(
    private readonly frame: (dt: number) => boolean,
    private readonly blocked: () => boolean,
    private readonly onBlocked: () => void,
  ) {}

  running() {
    return this.raf !== 0;
  }

  run() {
    if (this.blocked()) return this.onBlocked();
    if (!this.raf) this.raf = window.requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.raf) window.cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.last = 0;
  }

  private readonly tick = (now: number) => {
    this.raf = 0;
    if (this.blocked()) {
      this.last = 0;
      return this.onBlocked();
    }
    if (this.last && now - this.last < RISO_INTRO_FRAME_MS) {
      this.raf = window.requestAnimationFrame(this.tick);
      return;
    }
    const dt = this.last ? Math.min(now - this.last, 50) : 1000 / 60;
    this.last = now;
    if (this.frame(dt)) this.raf = window.requestAnimationFrame(this.tick);
    else this.last = 0;
  };
}
