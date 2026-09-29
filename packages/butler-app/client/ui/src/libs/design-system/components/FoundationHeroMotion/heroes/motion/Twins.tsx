import type { CSSProperties } from "react";
import { Roll } from "./MotionRoll";
import { CompactComposer } from "./CompactComposer";
import { ReplyRow } from "./ReplyRow";
import { UserRow } from "./UserRow";
import type { MotionCopy } from "./motionCopy";
import { TWIN_SPAN, twinNotes } from "./motionScore";
import { named } from "./MotionScenes";
import s from "./MotionHero.module.css";

/** One twin: its header, the compact turn (bubble, answer, composer) and its two-lane roll. */
function Twin({ id, copy, live, reduced }: { id: "f" | "r"; copy: MotionCopy; live: boolean; reduced: boolean }) {
  const t = named(live);
  return (
    <div className={s.twin} data-m={t(`tw${id}`)} data-t={t(`tw-${id}`)}>
      <span className={s.twinHead}>
        <span className={s.twinTitle}>{reduced ? copy.reduced : copy.full}</span>
        <span className={s.twinHow}>{reduced ? copy.reducedHow : copy.fullHow}</span>
      </span>
      <div className={s.turn}>
        <UserRow copy={copy} id={`tw${id}`} t={t} />
        <div className={s.part} data-t={t(`tw${id}-reply`)}><ReplyRow copy={copy} /></div>
        <div className={s.part} data-m={t(`tw${id}-origin`)}><CompactComposer copy={copy} running={false} /></div>
      </div>
      <Roll id={`tr${id}`} lanes={copy.twinLanes} live={live} notes={twinNotes(reduced)} span={TWIN_SPAN}
        tokens={reduced ? ["base", "base"] : ["slow", "base"]} />
    </div>
  );
}

/** Scene 5 (signature): Full and Reduced side by side, played one at a time, the idle twin dimmed. */
export function Twins({ copy, live }: { copy: MotionCopy; live: boolean }) {
  return (
    <div className={s.twins} data-m={live ? "twins" : undefined} style={{ "--twin-span": TWIN_SPAN } as CSSProperties}>
      <Twin copy={copy} id="f" live={live} reduced={false} />
      <Twin copy={copy} id="r" live={live} reduced />
    </div>
  );
}
