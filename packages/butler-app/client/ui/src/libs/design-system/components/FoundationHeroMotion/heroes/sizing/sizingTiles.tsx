import { useRef, type ReactNode } from "react";
import { NavRow } from "../../../../blocks/NavRow";
import { SidebarBrand, SidebarNav, SidebarShell } from "../../../../blocks/SidebarShell";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { Button } from "../../../Button";
import { ButtonContainer } from "../../../ButtonContainer";
import { IconButton } from "../../../IconButton";
import { Briefcase, FileText, MessageSquare, MoreHorizontal, PanelLeftOpen, PanelRight, PencilLine, Search } from "../../../Icons";
import { SegmentedControl } from "../../../SegmentedControl";
import { SelectButton } from "../../../Select";
import { Tag } from "../../../Tag";
import { Typo } from "../../../Typo";
import { Reveal as R } from "../shared/Reveal";
import { HIT, RAILS, type SizingCopy } from "./sizingCopy";
import { Ruler, RulerLegend, useRulerMarks } from "./SizingRuler";
import { Subtitle, TouchBar } from "./SizingTouchBar";
import s from "./SizingHero.module.css";

const noop = () => undefined;

/** The height the wrong note tries (canvas px): on no rail. */
export const GHOST_PX = 32;

/** The controls on the staff, one per rail (xs to lg), each exactly its rail's height. */
function railControls(copy: SizingCopy): ReactNode[] {
  return [
    <Tag key="xs" size="md">{copy.tag}</Tag>,
    <SegmentedControl ariaLabel={copy.period} key="sm" onValueChange={noop} options={[{ value: "d", label: copy.day }, { value: "w", label: copy.week }]} size="sm" value="w" />,
    <SelectButton aria-label={copy.model} key="md">{copy.auto}</SelectButton>,
    <Button key="lg" size="lg" text={copy.find} />,
  ];
}

/**
 * The staff: four lanes, each exactly one control height tall (the live
 * token) between two rail lines, labelled at the left; a real control sits
 * in each. `name` prefixes the timeline's parts; `ghost` adds the off-rail
 * outline that snaps onto md and becomes a real Button there.
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
                <span className={s.ghostWrong} data-t={t("gw")}>{GHOST_PX}</span>
                <span className={s.ghostButton} data-t={t("gb")}><Button text={copy.send} variant="outline" /></span>
                <span className={s.ghostNote} data-t={t("gn")}>{copy.offRail}</span>
              </span>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A Butler window's top-left: the sidebar (SidebarShell with the brand in
 * its titlebar row and the first rows) beside the conversation pane's
 * titlebar, the floating sidebar toggle over both. The ruler on the outer
 * left edge measures the titlebar row and each sidebar row.
 */
export function Frame({ copy, name, space = false }: { copy: SizingCopy; name?: string; space?: boolean }) {
  const rows = [[copy.newConversation, <PencilLine key="i" />], [copy.search, <Search key="i" />], [copy.general, <MessageSquare key="i" />]] as const;
  const more = [[copy.project, <Briefcase key="i" />], [copy.session, <FileText key="i" />]] as const;
  const host = useRef<HTMLDivElement>(null);
  const marks = useRulerMarks(host);
  return (
    <div className={s.frame}>
    <div className={s.window} ref={host}>
      <div className={s.side}>
        <SidebarShell titlebar={<span className={s.measure} data-dim="--titlebar-height"><SidebarBrand><Typo.AppTitle>{copy.product}</Typo.AppTitle></SidebarBrand></span>}>
          <SidebarNav>
            {rows.map(([label, icon], k) => (
              <span className={s.measure} data-dim="--sidebar-row-height" key={label}><NavRow active={k === 2 && !space} icon={icon} label={label} /></span>
            ))}
            {space ? more.map(([label, icon], k) => <NavRow active={k === 1} icon={icon} key={label} label={label} />) : null}
          </SidebarNav>
        </SidebarShell>
      </div>
      <div className={s.pane}>
        <TitlebarShell subtitle={<Subtitle copy={copy} />} title={copy.session}
          trailing={<ButtonContainer size="icon-sm"><IconButton label={copy.sessionMenu}><MoreHorizontal size="md" /></IconButton><IconButton label={copy.rightPanel}><PanelRight size="md" /></IconButton></ButtonContainer>} />
      </div>
      <span className={s.windowToggle}><IconButton label={copy.hideSidebar}><PanelLeftOpen size="md" /></IconButton></span>
      <Ruler marks={marks} name={name} />
    </div>
    <RulerLegend marks={marks} name={name} />
    </div>
  );
}

/** A form row on one rail: the model picker and its buttons, all md 30, on one pair of rail lines. */
export function FormRow({ copy }: { copy: SizingCopy }) {
  return (
    <span className={s.formRow}>
      <SelectButton aria-label={copy.model}>{copy.auto}</SelectButton>
      <Button text={copy.cancel} variant="outline" />
      <Button text={copy.save} />
      <span className={s.formRail} />
    </span>
  );
}

/** Finale tiles. */
export const StaffTile = ({ copy }: { copy: SizingCopy }) => <div className={s.staffTile}><Staff copy={copy} /></div>;
export const FrameTile = ({ copy }: { copy: SizingCopy }) => <div className={s.frameTile}><Frame copy={copy} space /></div>;
export const HaloTile = ({ copy }: { copy: SizingCopy }) => (
  <div className={s.captioned} data-kind="halo">
    <TouchBar copy={copy} touch />
    <span className={s.caption}>{`--control-hit-target ${HIT.pointer} → ${copy.touch} ${HIT.touch}`}</span>
  </div>
);
export const FormTile = ({ copy }: { copy: SizingCopy }) => (
  <div className={s.captioned}>
    <FormRow copy={copy} />
    <span className={s.caption}>--control-height-md 30</span>
  </div>
);
