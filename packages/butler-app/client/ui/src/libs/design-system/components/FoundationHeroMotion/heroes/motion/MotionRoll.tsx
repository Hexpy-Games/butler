import type { CSSProperties } from "react";
import type { Note } from "./motionScore";
import s from "./MotionHero.module.css";

/**
 * A piano roll on the metronome's grid: one lane per element (its name and
 * the token it plays at the left edge only), a line every beat and a stronger
 * one every bar, each note placed at its start with its token's length. A
 * note is drawn twice: its dim outline, and a fill (`<id>-n<k>`) the timeline
 * sweeps open while the note plays, in step with the playhead (`<id>-play`).
 * In a still tile every note is filled and the playhead rests off.
 */
export function Roll({ id, lanes, tokens, notes, span, live, header }: {
  id: string; lanes: string[]; tokens: readonly string[]; notes: Note[]; span: number; live: boolean; header?: string;
}) {
  const t = (name: string) => (live ? `${id}-${name}` : undefined);
  const place = (note: Note) => ({ "--l": note.at / span, "--w": note.len / span, "--reps": Math.round(note.len) } as CSSProperties);
  return (
    <div className={s.roll} data-live={live ? "" : undefined} style={{ "--span": span } as CSSProperties}>
      <div className={s.rollHead}>
        <span className={s.rollHeader}>{header}</span>
        <span className={s.bars}>
          {Array.from({ length: Math.ceil(span / 4) }, (_, bar) => <span className={s.barNumber} key={bar}>{bar + 1}</span>)}
        </span>
      </div>
      {lanes.map((name, lane) => (
        <div className={s.rollLane} key={name}>
          <span className={s.rollName}>
            <span className={s.rollLabel}>{name}</span>
            <span className={s.rollToken}>{tokens[lane]}</span>
          </span>
          <span className={s.rollTrack}>
            {notes.map((note, k) => (note.lane === lane ? (
              <span className={s.noteSlot} data-flat={note.flat ? "" : undefined} data-loop={note.loop ? "" : undefined} key={k} style={place(note)}>
                <span className={s.noteBase} />
                <span className={s.noteWindow} data-t={t(`n${k}`)}>
                  <span className={s.noteFill} data-t={t(`n${k}-in`)} />
                </span>
              </span>
            ) : null))}
          </span>
        </div>
      ))}
      {live ? <span className={s.playRail}><span className={s.playhead} data-t={t("play")} /></span> : null}
    </div>
  );
}
