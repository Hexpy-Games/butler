import type { CSSProperties, ReactNode } from "react";
import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { MessageRow } from "../../../../blocks/MessageRow";
import { Notice } from "../../../../blocks/Notice";
import { Box } from "../../../Box";
import { ButlerThinkingMark } from "../../../ButlerThinkingMark";
import { CheckCircle2 } from "../../../Icons";
import { SuccessCheck } from "../../../SuccessCheck";
import { Switch } from "../../../Switch";
import { Typo } from "../../../Typo";
import { ms, type MotionCopy } from "./motionCopy";
import s from "./MotionHero.module.css";

/** Canvas px per ms on the note bars (the metronome's scale). */
export const BAR = 1.4;
/** The score's span in beats and its events: [lane, start, length] (beats from the score's start). */
export const SCORE_SPAN = 12;
export const SCORE: Array<[lane: number, start: number, length: number]> = [
  [0, 1, 0.5], [1, 1.5, 2], [2, 3.7, 0.5], [2, 4.3, 0.5], [2, 4.9, 0.5], [2, 5.5, 0.5], [3, 6.3, 1.5], [4, 8, 0.8], [5, 9, 1.2], [5, 11.2, 0.6],
];

const named = (live: boolean) => (name: string) => (live ? name : undefined);

function Menu({ copy }: { copy: MotionCopy }) {
  return (
    <Box border="hairline" padding="xs" radius="popover" surface="overlay">
      {[copy.rename, copy.duplicate, copy.archive].map((item) => <div className={s.menuRow} key={item}><Typo.Body>{item}</Typo.Body></div>)}
    </Box>
  );
}

/** Scene 3: in fast, out faster: the same menu enters and exits, each over a note bar as long as its duration. */
export function Exits({ copy }: { copy: MotionCopy }) {
  const lanes = [
    { id: "in", label: `${copy.enter} · --motion-enter-menu`, time: ms("--motion-enter-menu", 140) },
    { id: "out", label: `${copy.exit} · --motion-exit-menu`, time: ms("exit-menu") },
  ];
  return (
    <div className={s.exits} data-m="exits">
      {lanes.map((lane) => (
        <div className={s.exitLane} key={lane.id}>
          <span className={s.exitLabel}>{lane.label}</span>
          <span className={s.exitStage}><span className={s.menuWrap} data-t={`ex-${lane.id}`}><Menu copy={copy} /></span></span>
          <span className={s.noteRow}>
            <span className={s.note} data-t={`exb-${lane.id}`} style={{ inlineSize: `${lane.time * BAR}px` }} />
            <span className={s.noteValue}>{`${lane.time} ms`}</span>
          </span>
        </div>
      ))}
      <span className={s.realTag} data-t="ex-real">{copy.real}</span>
    </div>
  );
}

/** The conversation turn the score plays: user bubble, thinking mark, reply, check, notice, composer. */
function Turn({ copy, live }: { copy: MotionCopy; live: boolean }) {
  const t = named(live);
  return (
    <div className={s.turn}>
      <div data-t={t("sc-bubble")}><MessageRow role="user">{copy.ask}</MessageRow></div>
      <div className={s.thinkRow}><span className={s.think} data-t={t("sc-think")}><ButlerThinkingMark size="md" /></span></div>
      <div data-t={t("sc-reply")}>
        <MessageRow role="assistant">
          <span className={s.replyLine}>{copy.reply}<span className={s.check} data-t={t("sc-check")}><SuccessCheck animate={false} size={16} /></span></span>
        </MessageRow>
      </div>
      <div className={s.noticeSlot} data-t={t("sc-notice")}><Notice tone="success" icon={<CheckCircle2 size="md" />} message={copy.saved} /></div>
      <ComposerCard>
        <ComposerCardExpandedBody>
          <ComposerCardEditor>
            <ComposerCardEditable><div /></ComposerCardEditable>
            <ComposerCardPlaceholder>{copy.placeholder}</ComposerCardPlaceholder>
          </ComposerCardEditor>
        </ComposerCardExpandedBody>
        <ComposerCardToolbar>
          <ComposerCardToolbarSpacer />
          <span className={s.send} data-t={t("sc-send")}><ComposerSendButton aria-label={copy.send} mode="send" /></span>
        </ComposerCardToolbar>
      </ComposerCard>
    </div>
  );
}

/** Scene 4 (signature): the score of one conversation turn: the product above, its piano roll below, a playhead in sync. */
export function Score({ copy, live }: { copy: MotionCopy; live: boolean }) {
  const t = named(live);
  return (
    <div className={s.score} data-m={live ? "score" : undefined}>
      <Turn copy={copy} live={live} />
      <div className={s.roll}>
        {copy.lanes.map((name, k) => (
          <div className={s.rollLane} key={name}>
            <span className={s.rollName}>{name}</span>
            <span className={s.rollTrack}>
              {SCORE.map(([lane, start, length], j) => (lane === k
                ? <span className={s.bar} data-t={t(`sb-${j}`)} key={j} style={{ "--l": start / SCORE_SPAN, "--w": length / SCORE_SPAN } as CSSProperties} />
                : null))}
            </span>
          </div>
        ))}
        <span className={s.playhead} data-t={t("sc-play")} />
      </div>
    </div>
  );
}

/** One side of the twins: the compact turn and its note bars (flat on the reduced side: opacity only). */
function Twin({ id, title, copy, live, reduced }: { id: string; title: string; copy: MotionCopy; live: boolean; reduced: boolean }) {
  const t = named(live);
  const part = (name: string, node: ReactNode) => <div data-t={t(`tw-${id}-${name}`)}>{node}</div>;
  return (
    <div className={s.twin} data-reduced={reduced ? "" : undefined} data-t={t(`tw-${id}`)}>
      <span className={s.twinTitle}>{title}</span>
      {part("b", <MessageRow role="user">{copy.ask}</MessageRow>)}
      {part("r", <MessageRow role="assistant"><span className={s.replyLine}>{copy.reply}<SuccessCheck animate={false} size={16} /></span></MessageRow>)}
      <span className={s.twinBars}>{["travel", "rise", "pop"].map((kind) => <span className={s.twinBar} data-kind={kind} key={kind} />)}</span>
    </div>
  );
}

/** Scene 5 (signature): Full and Reduced side by side, played one at a time, the idle twin dimmed. */
export function Twins({ copy, live }: { copy: MotionCopy; live: boolean }) {
  return (
    <div className={s.twins} data-m={live ? "twins" : undefined}>
      <Twin copy={copy} id="f" live={live} reduced={false} title={copy.full} />
      <Twin copy={copy} id="r" live={live} reduced title={copy.reduced} />
    </div>
  );
}

/** Scene 6: bounce is reserved: the Switch thumb springs; a dragged card lifts. */
export function Spring({ copy, live }: { copy: MotionCopy; live: boolean }) {
  const t = named(live);
  return (
    <div className={s.spring} data-m={live ? "spring" : undefined}>
      <span className={s.switchStack}>
        {live ? <span className={s.switchLayer} data-t="sp-off"><Switch aria-label={copy.autoSend} checked={false} onCheckedChange={() => undefined} /></span> : null}
        <span className={s.switchLayer} data-t={t("sp-on")}><Switch aria-label={copy.autoSend} checked onCheckedChange={() => undefined} /></span>
      </span>
      <span className={s.liftCard} data-lifted={live ? undefined : ""} data-t={t("sp-card")}>
        <Box border="hairline" padding="md" radius="panel" surface="raised"><Typo.Label as="span">{copy.card}</Typo.Label></Box>
      </span>
    </div>
  );
}
