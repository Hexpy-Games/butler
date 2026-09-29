import type { ReactNode } from "react";
import { Reveal as R } from "../shared/Reveal";
import { LEVELS, type RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/** An elevation scene: the moment one shadow is cast, and under it when that shadow is used and its token. */
export function Level({ k, copy, children }: { k: number; copy: RadiusCopy; children: ReactNode }) {
  const level = LEVELS[k]!;
  return (
    <div className={s.level} data-m={`lv-${k}`}>
      {children}
      <span className={s.levelNote}>
        <span className={s.levelWhen}><R name={`lw-${k}`}>{copy[level.when]}</R></span>
        <span className={s.levelToken}><R name={`lt-${k}`}>{level.token}</R></span>
      </span>
    </div>
  );
}
