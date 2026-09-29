import { Roll } from "./MotionRoll";
import { ActivityRow } from "./ActivityRow";
import { CompactComposer } from "./CompactComposer";
import { DraftComposer } from "./DraftComposer";
import { ReplyRow } from "./ReplyRow";
import { UserRow } from "./UserRow";
import type { MotionCopy } from "./motionCopy";
import { SCORE_SPAN, SCORE_TOKENS, scoreNotes } from "./motionScore";
import { named } from "./MotionScenes";
import s from "./MotionHero.module.css";

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
