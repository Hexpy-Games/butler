import type { Key, Track } from "../../heroTimeline";
import { Tag } from "../../../Tag";
import type { AnnotItem } from "./guides";
import { Reveal, reveal, select, sweep } from "./Reveal";
import c from "./ChapterHero.module.css";
import { StrokeReveal, strokeTracks } from "./StrokeReveal";

const px = (value: number) => `${Math.round(value * 10) / 10}px`;

/** Stepped values of a note or badge: every step stacked in one cell, cut in place. */
function Steps({ id, text, tag = false }: { id: string; text: string[]; tag?: boolean }) {
  return (
    <span className={c.steps}>
      {text.map((step, k) => <span className={c.step} data-last={k === text.length - 1 ? "" : undefined} data-t={`${id}-${k}`} key={k}>{tag ? <Tag>{step}</Tag> : step}</span>)}
    </span>
  );
}

/**
 * Guides, values and badges over a subject or a panel: a pure overlay
 * (absolute, no layout). `shown` layers are visible by default (the opening,
 * hidden as a whole in the poster); build layers only show while they play.
 */
export function Annotations({ items, shown = false }: { items: AnnotItem[]; shown?: boolean }) {
  return (
    <span className={c.annots} data-annots="" data-og={shown ? "" : undefined} data-shown={shown ? "" : undefined} aria-hidden="true">
      {items.flatMap((item) => [
        ...item.guides.map((guide, j) => (guide.t === "path" ? (
          guide.dashed ? <svg className={c.annotSvg} key={`${item.id}-${j}`}><path className={c.guidePath} d={guide.d} data-dashed="" data-t={`g-${item.id}-${j}`} /></svg>
            : <StrokeReveal name={`g-${item.id}-${j}`} key={`${item.id}-${j}`}><path className={c.guidePath} d={guide.d} /></StrokeReveal>
        ) : null)),
        item.badge ? <StrokeReveal name={`bl-${item.id}`} key={`${item.id}-l`}><path className={c.leader} d={item.badge.leader.d} /></StrokeReveal> : null,
      ])}
      {items.flatMap((item) => item.guides.map((guide, j) => {
        if (guide.t === "hatch") {
          const { x, y, w, h } = guide.box;
          return (
            <span className={c.hatch} data-t={`g-${item.id}-${j}`} key={`${item.id}-${j}`} style={{ left: px(x), top: px(y), inlineSize: px(w), blockSize: px(h) }}>
              <span className={c.hatchIn} data-t={`g-${item.id}-${j}-in`} />
            </span>
          );
        }
        if (guide.t === "ring") {
          const { x, y, w, h } = guide.box;
          return <span className={c.ring} data-t={`g-${item.id}-${j}`} key={`${item.id}-${j}`} style={{ left: px(x), top: px(y), inlineSize: px(w), blockSize: px(h), borderRadius: px(guide.r) }} />;
        }
        return null;
      }))}
      {items.map((item) => (item.note ? (
        <span className={c.note} data-place={item.note.place} data-t={`n-${item.id}`} key={`${item.id}-n`} style={{ left: px(item.note.x), top: px(item.note.y) }}>
          <Reveal name={`nr-${item.id}`}><Steps id={`ns-${item.id}`} text={item.note.text} /></Reveal>
        </span>
      ) : null))}
      {items.map((item) => (item.badge ? (
        <span className={c.badge} data-side={item.badge.side} data-t={`b-${item.id}`} key={`${item.id}-b`} style={{ left: px(item.badge.x), top: px(item.badge.y) }}>
          <Reveal name={`br-${item.id}`}><Steps id={`bs-${item.id}`} tag text={item.badge.text} /></Reveal>
        </span>
      ) : null))}
    </span>
  );
}

const longest = (text: string[]) => Math.max(...text.map((step) => [...step].length));

/** Cut keys: shown only in [from, to). */
function shownIn(from: number, to: number, close: number): Key[] {
  const keys: Key[] = [{ at: 0, o: 0 }];
  if (from > 0) keys.push({ at: from - 0.01, o: 0 });
  keys.push({ at: from, o: 1 });
  if (to < close) keys.push({ at: to - 0.01, o: 1 }, { at: to, o: 0 });
  return keys;
}

/**
 * One annotation's motion from `at`: its guides draw (paths along their
 * length, bands sweep left to right, a ring settles), its note or badge
 * reveals left to right and counts through its steps, the badge's leader
 * draws; everything recedes at `leave` (if given) and resets by `close`.
 */
export function annotTracks(item: AnnotItem, at: number, close: number, leave?: number): Track[] {
  const recede = (keys: Key[]): Key[] => (leave === undefined ? keys : [...keys, { at: leave, o: 1 }, { at: leave + 0.6, o: 0, ease: "accelerate" }]);
  const tracks: Track[] = item.guides.flatMap((guide, j): Track[] => {
    const from = at + 0.12 * j;
    const name = `g-${item.id}-${j}`;
    if (guide.t === "path" && !guide.dashed) {
      return strokeTracks(name, [...recede([{ at: 0, dash: guide.len, o: 0 }, { at: from, dash: guide.len, o: 0 }, { at: from + 0.05, o: 1 }, { at: from + 0.9, dash: 0, ease: "decelerate" }]), { at: close - 0.01 }, { at: close, dash: guide.len, o: 0 }]);
    }
    if (guide.t === "hatch") {
      const band = sweep(from, 0.8, close);
      return [
        { select: select(name), keys: [...recede([{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.05, o: 1 }]), { at: close - 0.01 }, { at: close, o: 0 }, ...band.outer] },
        { select: select(`${name}-in`), keys: band.inner },
      ];
    }
    const settle: Key[] = guide.t === "ring" ? [{ at: 0, o: 0, s: 1.08 }, { at: from, o: 0, s: 1.08 }, { at: from + 0.8, o: 1, s: 1, ease: "emphasized" }] : [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.6, o: 1, ease: "decelerate" }];
    return [{ select: select(name), keys: [...recede(settle), { at: close - 0.01 }, { at: close, o: 0 }] }];
  });
  const stepTimes = (from: number, text: string[]) => text.map((_, k) => (k === 0 ? 0 : from + 0.8 + 0.7 * (k - 1)));
  const steps = (id: string, from: number, text: string[]): Track[] => {
    const times = stepTimes(from, text);
    return text.length < 2 ? [] : text.map((_, k): Track => ({ select: select(`${id}-${k}`), keys: shownIn(times[k]!, k + 1 < text.length ? times[k + 1]! : close, close) }));
  };
  if (item.note) {
    const from = at + 0.3;
    tracks.push(
      { select: select(`n-${item.id}`), keys: [...recede([{ at: 0, o: 0 }, { at: from - 0.01, o: 0 }, { at: from, o: 1 }]), { at: close - 0.01 }, { at: close, o: 0 }] },
      ...reveal(`nr-${item.id}`, from, longest(item.note.text), close),
      ...steps(`ns-${item.id}`, from, item.note.text),
    );
  }
  if (item.badge) {
    const { len } = item.badge.leader;
    tracks.push(
      { select: select(`b-${item.id}`), keys: [...recede([{ at: 0, o: 0 }, { at: at - 0.01, o: 0 }, { at, o: 1 }]), { at: close - 0.01 }, { at: close, o: 0 }] },
      ...reveal(`br-${item.id}`, at, longest(item.badge.text), close),
      ...steps(`bs-${item.id}`, at, item.badge.text),
      ...strokeTracks(`bl-${item.id}`, [...recede([{ at: 0, dash: len, o: 0 }, { at: at + 0.2, dash: len, o: 0 }, { at: at + 0.25, o: 1 }, { at: at + 1, dash: 0, ease: "decelerate" }]), { at: close - 0.01 }, { at: close, dash: len, o: 0 }]),
    );
  }
  return tracks;
}
