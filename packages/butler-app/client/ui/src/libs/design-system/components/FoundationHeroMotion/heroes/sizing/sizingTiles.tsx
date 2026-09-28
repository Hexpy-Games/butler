import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { NavRow } from "../../../../blocks/NavRow";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { Button } from "../../../Button";
import { Folder, MessageSquare, PanelLeft, Plus, Search, Settings } from "../../../Icons";
import { Input } from "../../../Input";
import { Tag } from "../../../Tag";
import { Reveal as R } from "../shared/Reveal";
import { HIT, RAILS, type SizingCopy } from "./sizingCopy";
import s from "./SizingHero.module.css";

/** The controls on the staff, one per rail (xs to lg). */
function railControls(copy: SizingCopy): ReactNode[] {
  return [
    <Tag key="xs" size="md">{copy.tag}</Tag>,
    <Button key="sm" size="sm" text={copy.search} variant="outline" />,
    <Button key="md" text={copy.save} />,
    <span className={s.railInput} key="lg"><Input aria-label={copy.search} readOnly value={copy.query} /></span>,
  ];
}

/**
 * The staff: four lanes, each exactly one control height tall (the live
 * token) between two rail lines, labelled at the left; a real control sits
 * in each. `name` prefixes the timeline's parts; `ghost` adds the off-rail
 * control that snaps onto md.
 */
export function Staff({ copy, name, ghost = false }: { copy: SizingCopy; name?: string; ghost?: boolean }) {
  const controls = railControls(copy);
  const t = (part: string) => (name ? `${name}-${part}` : undefined);
  return (
    <div className={s.staff}>
      {RAILS.map((rail, k) => (
        <div className={s.lane} data-rail={rail.name} key={rail.name}>
          <span className={s.laneLabel} data-t={t(`l${k}`)}>{name ? <R name={`${name}-lt${k}`}>{`${rail.name} ${rail.px}`}</R> : `${rail.name} ${rail.px}`}</span>
          <span className={s.laneBody}>
            <span className={s.laneFill} data-t={t(`f${k}`)} />
            <span className={s.note} data-k={k} data-t={t(`c${k}`)}>{controls[k]}</span>
            {ghost && rail.name === "md" ? (
              <span className={s.ghost} data-t={t("ghost")}>
                <span className={s.ghostWrong} data-t={t("gw")} />
                <span className={s.ghostRight} data-t={t("gr")} />
                <span className={s.ghostNote} data-t={t("gn")}>{copy.offRail}</span>
              </span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The cursor: an arrow; on touch, a fingertip disc takes its place. */
function Pointer() {
  return (
    <>
      <svg className={s.cursor} data-t="cur" viewBox="0 0 16 20" aria-hidden="true">
        <path d="M1 1 L1 16 L5 12 L8 19 L10.5 18 L7.5 11 L13 11 Z" />
      </svg>
      <span className={s.finger} data-t="fin" />
    </>
  );
}

/**
 * Three 24px icon buttons, 44 apart centre to centre, each with its dashed
 * hit target around it (pointer 30, or touch 44 in the poster). `name`
 * prefixes the timeline's parts; `pointer` adds the cursor on the middle one.
 */
export function Halos({ copy, name, touch = false, pointer = false }: { copy: SizingCopy; name?: string; touch?: boolean; pointer?: boolean }) {
  const icons = [[copy.newChat, <Plus key="i" size="sm" />], [copy.search, <Search key="i" size="sm" />], [copy.settings, <Settings key="i" size="sm" />]] as const;
  return (
    <span className={s.halos}>
      {icons.map(([label, icon], k) => (
        <span className={s.target} key={label}>
          <span className={s.halo} data-t={name ? `${name}-h${k}` : undefined} data-touch={touch ? "" : undefined} />
          <Button aria-label={label} iconStart={icon} size="icon-xs" variant="ghost" />
          {pointer && k === 1 ? <Pointer /> : null}
        </span>
      ))}
    </span>
  );
}

/** A titlebar strip carrying the three icon buttons. */
export function Strip({ copy, children }: { copy: SizingCopy; children: ReactNode }) {
  return (
    <div className={s.strip}>
      <TitlebarShell leading={<Button aria-label={copy.title2} iconStart={<PanelLeft size="md" />} size="icon-sm" variant="ghost" />} subtitle={copy.subtitle} title={copy.title2} trailing={children} />
    </div>
  );
}

/** A dimension line on the left edge of its parent, labelled with the parent's measured height (the live token). */
function Dim({ token, name }: { token: string; name?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [px, setPx] = useState<number | null>(null);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (parent) setPx(parent.offsetHeight);
  }, []);
  return (
    <span className={s.dim} data-t={name} ref={ref}>
      <span className={s.dimLabel}>{`${token} ${px ?? ""}`}</span>
    </span>
  );
}

/** The app frame: a titlebar and sidebar rows, each measured on the outer left edge. */
export function Frame({ copy, name }: { copy: SizingCopy; name?: string }) {
  const rows = [[copy.chats, <MessageSquare key="i" size="sm" />], [copy.projects, <Folder key="i" size="sm" />], [copy.files, <Search key="i" size="sm" />]] as const;
  return (
    <div className={s.frame}>
      <div className={s.frameBar}>
        <Dim name={name ? `${name}-d0` : undefined} token="--titlebar-height" />
        <TitlebarShell subtitle={copy.subtitle} title={copy.title2} />
      </div>
      <div className={s.frameRows}>
        {rows.map(([label, icon], k) => (
          <div className={s.frameRow} key={label}>
            <Dim name={name ? `${name}-d${k + 1}` : undefined} token="--sidebar-row-height" />
            <NavRow active={k === 0} icon={icon} label={label} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A form row on one rail: the input and its button both lg 34. */
export function FormRow({ copy }: { copy: SizingCopy }) {
  return (
    <span className={s.formRow}>
      <span className={s.railInput}><Input aria-label={copy.search} readOnly value={copy.query} /></span>
      <Button size="lg" text={copy.find} />
      <span className={s.formRail} />
    </span>
  );
}

/** Finale tiles. */
export const StaffTile = ({ copy }: { copy: SizingCopy }) => <div className={s.staffTile}><Staff copy={copy} /></div>;
export const FrameTile = ({ copy }: { copy: SizingCopy }) => <div className={s.frameTile}><Frame copy={copy} /></div>;
export const HaloTile = ({ copy }: { copy: SizingCopy }) => (
  <div className={s.captioned}>
    <Halos copy={copy} touch />
    <span className={s.caption}>{`--control-hit-target ${HIT.pointer} → ${copy.touch} ${HIT.touch}`}</span>
  </div>
);
export const FormTile = ({ copy }: { copy: SizingCopy }) => (
  <div className={s.captioned}>
    <FormRow copy={copy} />
    <span className={s.caption}>--control-height-lg 34</span>
  </div>
);
