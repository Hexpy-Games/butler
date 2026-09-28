import type { CSSProperties } from "react";
import { Roll } from "./MotionRoll";
import { ActivityRow, CompactComposer, DraftComposer, ReplyRow, UserRow } from "./MotionTurn";
import type { MotionCopy } from "./motionCopy";
import { SCORE_SPAN, SCORE_TOKENS, TWIN_SPAN, scoreNotes, twinNotes } from "./motionScore";
import s from "./MotionHero.module.css";

const named = (live: boolean) => (name: string) => (live ? name : undefined);

/**
 * Scene 4 (signature): the score of one real turn. The product (left, or
 * above on the tall canvas) plays Send, the bubble's flight from the
 * composer, the working mark, the answer and its settled status; its piano
 * roll plays beside it on the metronome's grid, a playhead in step. The
 * still tile shows the finished turn over the full score.
 */
export function Score({ copy, live }: { copy: MotionCopy; live: boolean }) {
  const t = named(live);
  return (
    <div className={s.score} data-m={t("score")}>
      <div className={s.turn}>
        <div className={s.rows}>
          <UserRow copy={copy} id="sc" t={t} />
          <div className={s.slot}>
            <div className={s.part} data-t={t("sc-reply")}><ReplyRow copy={copy} /></div>
            {live ? <div className={s.activity} data-t="sc-act"><ActivityRow copy={copy} /></div> : null}
          </div>
        </div>
        <div className={s.composerSlot}>
          <div className={s.layer} data-t={t("sc-idle")}><CompactComposer copy={copy} running={false} /></div>
          {live ? <div className={s.layer} data-t="sc-stop"><CompactComposer copy={copy} running /></div> : null}
          {live ? <div className={s.draft} data-t="sc-draft"><DraftComposer copy={copy} t={t} /></div> : null}
        </div>
      </div>
      <Roll header={copy.half} id="sr" lanes={copy.lanes} live={live} notes={scoreNotes()} span={SCORE_SPAN} tokens={SCORE_TOKENS} />
    </div>
  );
}

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
