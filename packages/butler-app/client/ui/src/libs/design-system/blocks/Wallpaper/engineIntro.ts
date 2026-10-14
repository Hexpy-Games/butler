// The engine side of the first-run ink intro (spec Concept A rev 5). While a timeline is attached the intro owns the
// canvas (drift and module loop yield). Frame 0 links its programs; the reveal runs at up to 60 fps; the dried print
// holds on the drift base layer with no work, waking for the print beat and the pointer stir; at the hand-off the
// drift takes the canvas, its first segment dissolving from it, and later print beats go to it.
import { drawIntroFrame, introBoxMoved, introLocalRect } from "./intro/introFrame";
import { IntroFrameLoop } from "./intro/introLoop";
import { RISO_INTRO_TIMELINE_S, type WallpaperIntroEvent, type WallpaperIntroTimeline } from "./intro/introTimeline";
import type { EngineIntro, EngineIntroOptions } from "./intro/introTypes";
import type { WallpaperCanvasBox } from "./measure";
import { createIntroWake } from "./intro/introWake";

export type { EngineIntro, EngineIntroOptions } from "./intro/introTypes";

const END = RISO_INTRO_TIMELINE_S.end;
type Phase = "off" | "wait" | "play" | "hold";

class EngineIntroController implements EngineIntro {
  private timeline: WallpaperIntroTimeline | null = null;
  private phase: Phase = "off";
  private unsubscribe: () => void = () => undefined;
  /** Something changed while nothing could draw: draw once when it can. */
  private dirty = false;
  /** The hand-off waits for running frames (the beat) to end. */
  private leaving = false;
  private drawnBox: WallpaperCanvasBox | null = null;
  private readonly wake = createIntroWake();
  private readonly loop = new IntroFrameLoop((dt) => this.frame(dt), () => this.hidden(), () => { this.dirty = true; });

  constructor(private readonly o: EngineIntroOptions) {}

  active = () => this.phase !== "off";

  attach(next: WallpaperIntroTimeline | null) {
    if (next === this.timeline) return;
    const held = this.active();
    // Detached while holding the canvas: it goes back to the wallpaper, dissolving from the dried print.
    const seeded = held && !next && this.draw(END) && this.o.layers !== null;
    if (seeded) this.o.layers?.present(0);
    this.dispose();
    if (!next) return held ? this.o.onHandoff(seeded) : undefined;
    this.timeline = next;
    this.unsubscribe = next.subscribe(this.onEvent);
    if (next.handedOff()) return;
    this.phase = "wait";
    window.addEventListener("pointermove", this.onPointer, { passive: true });
    this.begin();
  }

  shown() { if (this.phase === "wait") this.begin(); else if (this.phase === "hold") this.loop.run(); }

  sync() {
    if (this.phase === "off") return;
    if (this.hidden()) return this.loop.stop();
    if (this.phase === "wait") return this.begin();
    // Reduced motion (or a degraded GPU) mid-reveal: jump to the dried print.
    if (this.phase === "play" && this.still()) this.timeline?.skip();
    if (this.phase === "play" || this.wake.moving() || this.dirty) this.loop.run();
  }

  /** Only a real change redraws (the first resize notice repeats the box just drawn). */
  resize() { if (this.phase === "hold" && introBoxMoved(this.drawnBox, this.o.box())) this.loop.run(); }

  repaint() { if (this.phase === "play" || this.phase === "hold") this.draw(this.phase === "play" ? this.timeline!.now() : END); }

  dispose() {
    this.loop.stop();
    this.unsubscribe();
    window.removeEventListener("pointermove", this.onPointer);
    Object.assign(this, { phase: "off", timeline: null, unsubscribe: () => undefined });
  }

  private still() { const s = this.o.state(); return s.reducedMotion || s.softwareRendering === true || s.constrained || s.degraded; }

  private hidden() { const s = this.o.state(); return s.documentHidden || s.contextLost || !s.intersecting; }

  private draw(t: number) {
    const scene = this.o.scene(), box = this.o.box();
    this.drawnBox = box;
    return scene !== null && drawIntroFrame(this.o.renderer, scene, box, this.timeline?.layout() ?? null, this.wake, t);
  }

  private begin() {
    const timeline = this.timeline;
    if (this.phase !== "wait" || !timeline || !this.o.scene() || this.hidden()) return;
    if (timeline.started() !== null || timeline.mode === "still" || this.still()) {
      this.phase = "hold";
      if (!this.draw(END)) return this.fail();
      this.o.layers?.present(0);
      this.o.onDrawn();
      timeline.start("still");
      return;
    }
    this.o.layers?.hide();
    // Frame 0 links the programs, so a cold compile never eats into the reveal; the clock starts on the next frame.
    if (!this.draw(0)) return this.fail();
    this.o.onDrawn();
    this.phase = "play";
    this.loop.run();
  }

  /** The intro programs did not link: the shell plays its no-WebGL reveal and the wallpaper draws as usual. */
  private fail() {
    this.phase = "off";
    this.timeline?.start("fallback");
    this.o.onHandoff(false);
  }

  /** One loop frame; true while something still moves. */
  private frame(dt: number): boolean {
    const timeline = this.timeline;
    if (!timeline || this.phase === "off") return false;
    let t: number = END, more = false;
    if (this.phase === "play") {
      if (timeline.started() === null) timeline.start("full");
      t = timeline.now();
      if (t >= END) { this.phase = "hold"; t = END; } else more = true;
    }
    more = this.wake.step(dt) || more;
    this.dirty = false;
    // The live reveal shows on the canvas; once settled every frame goes to the base layer, which then holds it.
    if (this.draw(t) && this.phase === "hold") this.o.layers?.present(0);
    if (!more && this.leaving) queueMicrotask(() => this.handoff());
    return more;
  }

  private handoff() {
    if (this.phase === "off") return;
    this.loop.stop();
    window.removeEventListener("pointermove", this.onPointer);
    Object.assign(this, { phase: "off", leaving: false });
    this.wake.clear();
    this.o.onHandoff(this.o.layers !== null);
  }

  private readonly onEvent = (event: WallpaperIntroEvent) => {
    const layout = this.timeline?.layout();
    if (event.type === "layout" && layout) this.o.onCard(layout.card);
    // After the hand-off a print beat (a step change) goes to the drift that holds the canvas now.
    if (this.phase === "off") return event.type === "beat" ? this.o.onBeat(event.from, event.to) : undefined;
    if (event.type === "skip" || (event.type === "layout" && this.phase === "hold")) this.loop.run();
    if (event.type === "beat" && this.phase === "hold" && !this.still()) {
      const box = this.o.box();
      this.wake.beat(introLocalRect(event.from, box), introLocalRect(event.to, box));
      this.loop.run();
    }
    if (event.type === "handoff" && (this.loop.running() || this.phase === "play")) this.leaving = true;
    else if (event.type === "handoff") this.handoff();
  };

  private readonly onPointer = (event: PointerEvent) => {
    if (event.pointerType === "touch" || this.phase !== "hold" || this.leaving || this.still()) return; // Leaving: no new stir.
    const { left, top } = this.o.box();
    if (this.wake.pointer(event.clientX - left, event.clientY - top)) this.loop.run();
  };
}

export function createEngineIntro(options: EngineIntroOptions): EngineIntro {
  return new EngineIntroController(options);
}
