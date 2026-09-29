import { type ReactNode } from "react";
import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellWorkspace } from "../../../../blocks/AdaptiveShell";
import { NavRow } from "../../../../blocks/NavRow";
import { NavSectionHeading } from "../../../../blocks/NavSection";
import { SidebarBrand, SidebarNav, SidebarShell } from "../../../../blocks/SidebarShell";
import { MessageSquare, PencilLine, Search, Settings } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Typo } from "../../../Typo";
import { Mark } from "../shared/Mark";
import type { FocusCopy } from "./focusCopy";
import { Workspace } from "./Workspace";
import s from "./FocusHero.module.css";

/** The app's sidebar: brand, New chat, Search, recents, Settings (view tabs left out: the DS draws no focus on an active tab). */
function Sidebar({ copy, live }: { copy: FocusCopy; live: boolean }) {
  const mark = (n: string, row: ReactNode) => (live ? <Mark block n={n}>{row}</Mark> : row);
  return (
    <SidebarShell
      ariaLabel={copy.app}
      footer={mark("set", <NavRow icon={<Settings />} label={copy.settings} />)}
      scrollHeader={
        <Stack gap="xl">
          <SidebarNav ariaLabel={copy.app}>
            {mark("nav0", <NavRow icon={<PencilLine />} label={copy.newChat} />)}
            {mark("nav1", <NavRow icon={<Search />} label={copy.search} />)}
          </SidebarNav>
        </Stack>
      }
      titlebar={<SidebarBrand><Typo.AppTitle>{copy.app}</Typo.AppTitle></SidebarBrand>}
    >
      <Stack gap="sm">
        <NavSectionHeading title={copy.recent} />
        {mark("chat", <NavRow active icon={<MessageSquare />} label={copy.chat} />)}
      </Stack>
    </SidebarShell>
  );
}

/** The expanded app window (wide): the real AdaptiveShell, sidebar docked beside the workspace. */
export function WideShell({ copy, live = false }: { copy: FocusCopy; live?: boolean }) {
  return (
    <div className={s.window} data-shell="wide">
      <AdaptiveShell chromeEnvironment="electron" leftOpen platform="darwin" rightOpen={false}>
        <AdaptiveShellSidebar open><Sidebar copy={copy} live={live} /></AdaptiveShellSidebar>
        <AdaptiveShellWorkspace><Workspace copy={copy} live={live} /></AdaptiveShellWorkspace>
      </AdaptiveShell>
    </div>
  );
}
