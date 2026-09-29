import { useRef } from "react";
import { NavRow } from "../../../../blocks/NavRow";
import { SidebarBrand, SidebarNav, SidebarShell } from "../../../../blocks/SidebarShell";
import { TitlebarShell } from "../../../../blocks/TitlebarShell";
import { ButtonContainer } from "../../../ButtonContainer";
import { IconButton } from "../../../IconButton";
import { Briefcase, FileText, MessageSquare, MoreHorizontal, PanelLeftOpen, PanelRight, PencilLine, Search } from "../../../Icons";
import { Typo } from "../../../Typo";
import { type SizingCopy } from "./sizingCopy";
import { Ruler } from "./Ruler";
import { RulerLegend } from "./RulerLegend";
import { useRulerMarks } from "./SizingRuler";
import { Subtitle } from "./Subtitle";
import s from "./SizingHero.module.css";

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
