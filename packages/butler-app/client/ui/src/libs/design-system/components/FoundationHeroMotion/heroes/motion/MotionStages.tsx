import type { CSSProperties } from "react";
import { OptionMenu, OptionMenuItem, OptionMenuSection } from "../../../../blocks/OptionMenu";
import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { motionDuration } from "../../../../lib/motion";
import { ChevronRight, FileText, ImageIcon, ListChecks, MessageSquarePlus, Paperclip } from "../../../Icons";
import { Switch } from "../../../Switch";
import { TintedGlass } from "../../../TintedGlass";
import { CompactComposer } from "./MotionTurn";
import type { MotionCopy } from "./motionCopy";
import s from "./MotionHero.module.css";

/** The composer's + menu as the product opens it (PopoverContent: tinted glass, popover radius, 4px inset). */
function AddMenu({ copy }: { copy: MotionCopy }) {
  return (
    <TintedGlass padding="none" radius="popover">
      <div className={s.menuInset}>
        <OptionMenu size="fit" title={copy.add}>
          <OptionMenuSection title={copy.attachments}>
            <OptionMenuItem description={<ChevronRight size="sm" />} icon={<FileText size="md" />} label={copy.documents} />
            <OptionMenuItem icon={<Paperclip size="md" />} label={copy.attach} />
            <OptionMenuItem icon={<ImageIcon size="md" />} label={copy.attachImage} />
          </OptionMenuSection>
          <OptionMenuSection title={copy.mode}>
            <OptionMenuItem icon={<MessageSquarePlus size="md" />} label={copy.normal} selected />
            <OptionMenuItem icon={<ListChecks size="md" />} label={copy.plan} />
          </OptionMenuSection>
        </OptionMenu>
      </div>
    </TintedGlass>
  );
}

/** Enter and exit of a popover, from the live tokens. */
export function exitTimes() {
  return { enter: motionDuration("base"), exit: motionDuration("exit-fast") };
}

/**
 * Scene 3: in fast, out faster. The composer's + menu opens above it and
 * closes again; beside it, one note per move on a shared millisecond scale
 * (the longest spans the track), each filled while it plays, with its value
 * in a column of its own so no number sits on a bar.
 */
export function Exits({ copy, live = true }: { copy: MotionCopy; live?: boolean }) {
  const t = (name: string) => (live ? name : undefined);
  const { enter, exit } = exitTimes();
  const rows = [
    { id: "in", name: copy.enter, token: "--motion-enter-overlay", time: enter },
    { id: "out", name: copy.exit, token: "--motion-exit-fast", time: exit },
  ];
  return (
    <div className={s.exits} data-m={t("exits")}>
      <div className={s.exitStage}>
        {live ? <div className={s.menuAnchor} data-t="ex-menu"><AddMenu copy={copy} /></div> : null}
        <CompactComposer copy={copy} running={false} />
      </div>
      <div className={s.exitBars}>
        <span className={s.exitHead}>
          {live ? <span data-t="ex-half">{copy.half}</span> : null}
          <span data-t={t("ex-real")}>{copy.real}</span>
        </span>
        {rows.map((row) => (
          <div className={s.exitRow} key={row.id}>
            <span className={s.rollName}>
              <span className={s.rollLabel}>{row.name}</span>
              <span className={s.rollToken}>{row.token}</span>
            </span>
            <span className={s.exitTrack}>
              <span className={s.noteSlot} style={{ "--l": 0, "--w": row.time / enter } as CSSProperties}>
                <span className={s.noteBase} />
                <span className={s.noteWindow} data-t={t(`exb-${row.id}`)}><span className={s.noteFill} data-t={t(`exb-${row.id}-in`)} /></span>
              </span>
            </span>
            <span className={s.exitValue}>{`${row.time} ms`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Scene 6: bounce is kept for the Switch thumb: a real settings row whose switch toggles on the ticks. */
export function Spring({ copy, live }: { copy: MotionCopy; live: boolean }) {
  const t = (name: string) => (live ? name : undefined);
  const control = (
    <span className={s.switchStack}>
      {live ? <span className={s.switchLayer} data-t="sp-off"><Switch aria-label={copy.field} checked={false} onCheckedChange={() => undefined} /></span> : null}
      <span className={s.switchLayer} data-t={t("sp-on")}><Switch aria-label={copy.field} checked onCheckedChange={() => undefined} /></span>
    </span>
  );
  return (
    <div className={s.spring} data-m={t("spring")}>
      <SettingsSection id={live ? "motion-hero-spring" : "motion-hero-spring-tile"} kind="form">
        <SettingsField control={control} description={copy.fieldHint} label={copy.field} />
      </SettingsSection>
      <span className={s.springNote}>--motion-ease-spring · --motion-base</span>
    </div>
  );
}

/** The finale's tail tile: the exit pair over the Switch row, both still. */
export function Tail({ copy }: { copy: MotionCopy }) {
  return (
    <div className={s.tail}>
      <Exits copy={copy} live={false} />
      <Spring copy={copy} live={false} />
    </div>
  );
}
