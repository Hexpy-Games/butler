// The clock and the message channel of the first-run ink intro, shared by the wallpaper engine (the GL scene) and
// the setup shell (the card and its text): both read one clock, so the reveal and the card stay in step, and both
// pause together while the document is hidden.
import type { WallpaperContentRect } from "../types";

/** The rev 5 reveal, seconds from the drop (intro spec motion table). */
export const RISO_INTRO_TIMELINE_S = {
  bloom: [0.05, 1.5], flow: [0, 2.85], draw: [0.35, 1.2], dry: [0.53, 1.38], clear: [0.6, 1.3],
  bow: [1.05, 1.75], bowIn: 0.1, key: [1.17, 1.57], glide: [1.7, 2.25], residue: [1.3, 2.6], cardOn: [1.9, 2.45],
  markOut: [2.3, 2.42], end: 2.9,
  /** DOM cues: the DOM mark and the card surface when the glide lands, the text lines from 100 ms later. */
  dom: { mark: 2.25, card: 2.25, text: 2.35 },
  /** Without WebGL2: the SVG ring draws from 150 ms, the bow tie prints at 850, the card at 950, the text from 1050. */
  fallback: { ring: 0.15, bow: 0.85, card: 0.95, text: 1.05 },
} as const;

/** `full`: the first-install reveal. `still`: its dried final frame at once (re-run setup). */
export type WallpaperIntroMode = "full" | "still";
/** How the reveal began: the GL reveal, the dried still (reduced motion, software GL, re-run) or the no-WebGL fallback. */
export type WallpaperIntroStart = "full" | "still" | "fallback";

/** Client CSS px: the card (the ink keep-out) and the centre of its 64 px mark slot (the glide target). */
export interface WallpaperIntroLayout {
  card: WallpaperContentRect;
  slot: { x: number; y: number } | null;
}

export type WallpaperIntroEvent =
  | { type: "start"; kind: WallpaperIntroStart }
  | { type: "skip" | "pause" | "resume" | "layout" | "handoff" }
  | { type: "beat"; from: WallpaperContentRect; to: WallpaperContentRect };

export interface WallpaperIntroTimeline {
  readonly mode: WallpaperIntroMode;
  /** Reveal clock in seconds: 0 before the start, held while hidden, the end once skipped, settled or still. */
  now(): number;
  started(): WallpaperIntroStart | null;
  /** The GL or fallback reveal is running (started and not at its end). */
  playing(): boolean;
  layout(): WallpaperIntroLayout | null;
  setLayout(layout: WallpaperIntroLayout): void;
  /** The engine starts the clock once its programs are linked (or the wallpaper reports no WebGL2). */
  start(kind: WallpaperIntroStart): void;
  /** A click or a key: the reveal jumps to its end. */
  skip(): void;
  /** The card moves between two rects (intro and step): the print shifts with it. */
  beat(from: WallpaperContentRect, to: WallpaperContentRect): void;
  /** The intro is over: its dried print dissolves into the wallpaper. */
  handoff(): void;
  handedOff(): boolean;
  subscribe(listener: (event: WallpaperIntroEvent) => void): () => void;
  dispose(): void;
}

/** Where each start ends: the reveal, or the fallback once its last text line is in (five lines, 600 ms after the first). */
function endOf(kind: WallpaperIntroStart | null): number {
  const { end, fallback } = RISO_INTRO_TIMELINE_S;
  return kind === "fallback" ? fallback.text + 0.6 : end;
}

/** Within half a pixel: a re-measure that moved nothing redraws nothing. */
function sameLayout(a: WallpaperIntroLayout, b: WallpaperIntroLayout): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  const card = near(a.card.x, b.card.x) && near(a.card.y, b.card.y) && near(a.card.width, b.card.width) && near(a.card.height, b.card.height);
  const slot = a.slot && b.slot ? near(a.slot.x, b.slot.x) && near(a.slot.y, b.slot.y) : a.slot === b.slot;
  return card && slot;
}

export function createWallpaperIntroTimeline(mode: WallpaperIntroMode): WallpaperIntroTimeline {
  const listeners = new Set<(event: WallpaperIntroEvent) => void>();
  let kind: WallpaperIntroStart | null = null;
  let startedAt = 0;
  let pausedAt: number | null = null;
  let skipped = false;
  let handed = false;
  let current: WallpaperIntroLayout | null = null;
  const stopWatching = () => document.removeEventListener("visibilitychange", visibility);
  const emit = (event: WallpaperIntroEvent) => { for (const listener of [...listeners]) listener(event); };
  const end = () => endOf(kind);
  const now = () => {
    if (kind === null) return 0;
    if (kind === "still" || skipped) return end();
    return Math.min(end(), ((pausedAt ?? performance.now()) - startedAt) / 1000);
  };
  const visibility = () => {
    // The reveal is over: nothing left to pause.
    if (pausedAt === null && now() >= end()) return stopWatching();
    if (document.hidden && pausedAt === null) {
      pausedAt = performance.now();
      emit({ type: "pause" });
    } else if (!document.hidden && pausedAt !== null) {
      startedAt += performance.now() - pausedAt;
      pausedAt = null;
      emit({ type: "resume" });
    }
  };

  return {
    mode,
    now,
    started: () => kind,
    playing: () => (kind === "full" || kind === "fallback") && now() < end(),
    layout: () => current,
    setLayout(layout) {
      if (current && sameLayout(current, layout)) return;
      current = layout;
      emit({ type: "layout" });
    },
    start(next) {
      if (kind !== null) return;
      kind = next;
      startedAt = performance.now();
      pausedAt = document.hidden ? startedAt : null;
      if (next !== "still") document.addEventListener("visibilitychange", visibility);
      emit({ type: "start", kind: next });
    },
    skip() {
      if (kind === null || skipped || now() >= end()) return;
      skipped = true;
      stopWatching();
      emit({ type: "skip" });
    },
    beat: (from, to) => emit({ type: "beat", from, to }),
    handoff() {
      if (handed) return;
      handed = true;
      emit({ type: "handoff" });
    },
    handedOff: () => handed,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      stopWatching();
      listeners.clear();
    },
  };
}
