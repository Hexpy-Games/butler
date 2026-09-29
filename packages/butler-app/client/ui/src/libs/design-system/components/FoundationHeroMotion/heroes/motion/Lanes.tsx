import { type CSSProperties } from "react";
import { EASES, GHOSTS, progress, type MotionCopy } from "./motionCopy";
import { Plot } from "./Plot";
import s from "./MotionHero.module.css";

/**
 * The onion-skin lanes: five pucks cover the same distance in the same time;
 * ghost frames every tenth of the time show where each curve spends it
 * (the spring overshoots its finish post and settles). Live in the scene
 * (pucks and ghosts keyed by the timeline), frozen in the poster (the ghosts
 * all shown, the pucks home).
 */
export function Lanes({ copy, live }: { copy: MotionCopy; live: boolean }) {
  const t = (name: string) => (live ? name : undefined);
  return (
    <div className={s.lanes} data-m={live ? "lanes" : undefined}>
      {EASES.map((ease) => (
        <div className={s.lane} key={ease}>
          <span className={s.laneName}>
            <span className={s.token}>{`--motion-ease-${ease}`}</span>
            <span className={s.job}>{copy.jobs[ease]}</span>
          </span>
          <span className={s.track}>
            <span className={s.post} data-end="start" />
            <span className={s.post} data-end="finish" />
            {Array.from({ length: GHOSTS }, (_, k) => (
              <span className={s.ghost} data-t={t(`lg-${ease}-${k}`)} key={k} style={{ "--p": progress(ease, k / (GHOSTS - 1)) } as CSSProperties} />
            ))}
            <span className={s.puck} data-home={live ? undefined : ""} data-t={t(`lp-${ease}`)} />
          </span>
          <Plot ease={ease} />
        </div>
      ))}
    </div>
  );
}
