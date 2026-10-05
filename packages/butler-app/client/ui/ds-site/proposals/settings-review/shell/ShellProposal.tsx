import { useEffect } from "react";
import { chromeEnvironment } from "@/app/chromeEnvironment";
import { HARNESS_MESSAGES, HARNESS_NAVIGATION, HARNESS_SUMMARY } from "@/app/fixtures";
import { useButlerStore } from "@/app/store";
import { appShellTheme } from "@/app/utils";
import { AdaptiveShell, AdaptiveShellChrome, AdaptiveShellSidebar, AdaptiveShellWorkspace, SidebarNav } from "@/butler-ds";
import { t } from "../proposedCopy";
import { Conversation } from "@/components/conversation/Conversation";
import { WindowChromeLayer } from "@/components/layout/Chrome";
import { SidebarSettingsItem } from "@/components/layout/SidebarSettingsItem";
import { Titlebar } from "@/components/layout/Titlebar";
import type { StageState } from "../state";
import { SidebarProposal } from "./SidebarProposal";
import { UpdateSidebarRow } from "./UpdateIndicators";

/**
 * The app outside Settings, as the product visual harness renders it (AdaptiveShell, chrome
 * layer, sidebar, titlebar, conversation; harness fixtures), with the update row in the footer.
 */
export function ShellProposal({ state }: { state: StageState }) {
  const settings = useButlerStore((store) => store.settings);
  const leftOpen = useButlerStore((store) => store.leftOpen);
  useEffect(() => {
    const store = useButlerStore.getState();
    store.setNavigation(HARNESS_NAVIGATION);
    store.setMessages(HARNESS_MESSAGES);
    store.setSummary(HARNESS_SUMMARY);
    store.setActiveChatId("butler-client");
    store.setView({ kind: "session" });
    store.setRightOpen(false);
    store.setLeftOpen(true);
    store.setStatus({ label: "ready", tone: "ok" });
  }, []);
  // The footer becomes one SidebarNav group (as SpaceHeader groups 새 대화 / 검색): rows sit
  // --sidebar-row-spacing apart (4px desktop, 8px phone/touch), like every other sidebar group.
  const footer = (
    <SidebarNav ariaLabel={t(state.locale, "shell.footerNav")}>
      <UpdateSidebarRow stage={state.update} locale={state.locale} />
      <SidebarSettingsItem />
    </SidebarNav>
  );
  return (
    <AdaptiveShell theme={appShellTheme(settings)} chromeEnvironment={chromeEnvironment()} platform="browser"
      leftOpen={leftOpen} rightOpen={false} data-test-class="mac-window visual-harness">
      <AdaptiveShellChrome><WindowChromeLayer /></AdaptiveShellChrome>
      <AdaptiveShellSidebar data-test-class="sidebar-slot" id="butler-left-sidebar" open={leftOpen}>
        <SidebarProposal footer={footer} />
      </AdaptiveShellSidebar>
      <AdaptiveShellWorkspace data-test-class="workspace">
        <Titlebar />
        <Conversation />
      </AdaptiveShellWorkspace>
    </AdaptiveShell>
  );
}
