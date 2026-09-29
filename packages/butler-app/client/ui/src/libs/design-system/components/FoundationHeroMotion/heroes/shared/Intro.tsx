import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { Key, Track } from "../../heroTimeline";
import { TRANSITION } from "./beats";
import { Reveal as R, reveal, select } from "./Reveal";
import s from "./Intro.module.css";

/**
 * Beat marks of an intro: the title reveals, the lead lines follow a beat
 * apart, then everything pushes up and out (`out`) as the camera leaves
 * (`exit`, one TRANSITION long).
 */
export const INTRO = { title: 0.4, lead: 1.4, out: 6.4, exit: 6.8 } as const;

/**
 * The one intro exit every chapter shares (the Typography behaviour): the
 * camera holds on the intro until INTRO.exit, then glides in one
 * TRANSITION, flat, to the pose the chapter set for its next scene (a
 * neighbouring cell, so the glide runs on one axis). Rotation is stripped
 * from that pose: no chapter turns, tilts or twists on the way out of its
 * intro. Keys after the exit are the chapter's own.
 */
export function introCamera(camera: Key[]): Key[] {
  const first = camera[0];
  const arrive = INTRO.exit + TRANSITION;
  const next = camera.find((key) => key.at >= arrive - 0.01);
  if (!first || !next) return camera;
  const { at: _at, ease: _ease, ...front } = first;
  const { at: _next, ease: _nextEase, rx: _rx, ry: _ry, rz: _rz, ...to } = next;
  const flat = { rx: 0, ry: 0, rz: 0 };
  return [
    { at: 0, ...front, ...flat }, { at: INTRO.exit, ...front, ...flat }, { at: arrive, ...to, ...flat, ease: "standard" },
    ...camera.filter((key) => key.at > arrive + 0.01),
  ];
}

export type IntroLead = Array<[key: string, text: string]>;

/**
 * Scene 1 of a chapter: its title large on the left and its intent line by
 * line on the right (below on the tall canvas), set above the poster
 * (`data-m="intro"` for the camera).
 */
export function Intro({ title, lead, decor, titleNode }: {
  title: string; lead: IntroLead;
  /** The chapter's own touch on its title (drawn behind it, in em of the title): the title performs the concept. */
  decor?: ReactNode;
  /** The title set by the chapter itself (letters it moves one by one), in place of the plain revealed title. */
  titleNode?: ReactNode;
}) {
  // The title fits its column: never over the intent beside it, however long the word.
  const titleRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = titleRef.current;
    if (!node) return undefined;
    const fit = () => {
      node.style.removeProperty("--title-fit");
      const ratio = node.clientWidth / Math.max(1, node.scrollWidth);
      if (ratio < 1) node.style.setProperty("--title-fit", String(Math.floor(ratio * 1000) / 1000));
    };
    fit();
    // Again when the column changes (the wide and tall canvases).
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    observer?.observe(node.parentElement ?? node);
    return () => observer?.disconnect();
  }, [title]);
  return (
    <div className={s.intro} data-m="intro">
      <div className={s.introTitle} data-t="i-title" ref={titleRef}>
        {decor ? <span aria-hidden="true" className={s.decor}>{decor}</span> : null}
        {titleNode ?? <R name="i-t">{title}</R>}
      </div>
      <div className={s.introLead}>
        {lead.map(([key, text], n) => (
          <p className={s.leadLine} data-t={`i-p${n}`} key={key}>
            <span className={s.leadKey}><R name={`i-k${n}`}>{key}</R></span>
            <span className={s.leadText}><R name={`i-l${n}`}>{text}</R></span>
          </p>
        ))}
      </div>
    </div>
  );
}

/** The intro's motion: title, then each lead line (its key, then its text), left to right; then up and out from `out`. */
export function introTracks(title: string, lead: IntroLead, close: number, out: number = INTRO.out): Track[] {
  const leave = (name: string, delay: number): Track => ({
    select: select(name),
    keys: [
      { at: 0, y: 0, o: 1 }, { at: out + delay, y: 0, o: 1 }, { at: out + delay + 1, y: -56, o: 0, ease: "accelerate" },
      { at: close - 0.01, y: -56, o: 0 }, { at: close, y: 0, o: 1 },
    ] satisfies Key[],
  });
  return [
    ...reveal("i-t", INTRO.title, title, close),
    ...lead.flatMap(([key, text], n) => [...reveal(`i-k${n}`, INTRO.lead + n, key, close), ...reveal(`i-l${n}`, INTRO.lead + n + 0.3, text, close)]),
    leave("i-title", 0), ...lead.map((_, n) => leave(`i-p${n}`, 0.15 * (n + 1))),
  ];
}
