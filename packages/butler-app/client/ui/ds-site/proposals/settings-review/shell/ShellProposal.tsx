import { useEffect } from "react";
import { chromeEnvironment } from "@/app/chromeEnvironment";
import { HARNESS_MESSAGES, HARNESS_NAVIGATION, HARNESS_SUMMARY } from "@/app/fixtures";
import { useButlerStore } from "@/app/store";
import { appShellTheme } from "@/app/utils";
import { AdaptiveShell, AdaptiveShellChrome, AdaptiveShellSidebar, AdaptiveShellWorkspace } from "@/butler-ds";
import { Conversation } from "@/components/conversation/Conversation";
import { WindowChromeLayer } from "@/components/layout/Chrome";
import { SidebarSettingsItem } from "@/components/layout/SidebarSettingsItem";
import type { StageState } from "../state";
import { SidebarProposal } from "./SidebarProposal";
import { TitlebarProposal } from "./TitlebarProposal";
import { SettingsBadgeItem, UpdateSidebarRow, UpdateTitlebarRing } from "./UpdateIndicators";

/**
 * The app outside Settings, as the product visual harness renders it (AdaptiveShell, chrome
 * layer, sidebar, titlebar, conversation; harness fixtures), with one update indicator variant.
 */
export function ShellProposal({ state, phone }: { state: StageState; phone: boolean }) {
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
    store.setStatus({ label: "ready", tone: "ok" });
  }, []);
  useEffect(() => {
    // A and C live in the sidebar, so it opens; B lives in the titlebar, so at phone width the
    // sidebar stays closed to show it.
    useButlerStore.getState().setLeftOpen(state.updatePlace !== "titlebar" || !phone);
  }, [state.updatePlace, phone]);
  const footer = state.updatePlace === "settingsBadge"
    ? <SettingsBadgeItem stage={state.update} locale={state.locale} />
    : <>
        {state.updatePlace === "sidebarRow" ? <UpdateSidebarRow stage={state.update} locale={state.locale} /> : null}
        <SidebarSettingsItem />
      </>;
  return (
    <AdaptiveShell theme={appShellTheme(settings)} chromeEnvironment={chromeEnvironment()} platform="browser"
      leftOpen={leftOpen} rightOpen={false} data-test-class="mac-window visual-harness">
      <AdaptiveShellChrome><WindowChromeLayer /></AdaptiveShellChrome>
      <AdaptiveShellSidebar data-test-class="sidebar-slot" id="butler-left-sidebar" open={leftOpen}>
        <SidebarProposal footer={footer} />
      </AdaptiveShellSidebar>
      <AdaptiveShellWorkspace data-test-class="workspace">
        <TitlebarProposal indicator={state.updatePlace === "titlebar" ? <UpdateTitlebarRing stage={state.update} locale={state.locale} /> : undefined} />
        <Conversation />
      </AdaptiveShellWorkspace>
    </AdaptiveShell>
  );
}
