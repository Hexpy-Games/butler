import type { CSSProperties } from "react";
import { OptionMenu, OptionMenuItem, OptionMenuSection } from "../../../../blocks/OptionMenu";
import { ChevronRight, FileText, ImageIcon, ListChecks, MessageSquarePlus, Paperclip } from "../../../Icons";
import { TintedGlass } from "../../../TintedGlass";
import { CompactComposer } from "./CompactComposer";
import type { MotionCopy } from "./motionCopy";
import { exitTimes } from "./MotionStages";
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
