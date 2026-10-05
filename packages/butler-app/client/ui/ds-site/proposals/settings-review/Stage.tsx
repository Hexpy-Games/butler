import { useEffect, useState } from "react";
import { chromeEnvironment } from "@/app/chromeEnvironment";
import { appCopy, setAppCopyLanguage, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { SettingsSectionId } from "@/app/types";
import { appShellTheme } from "@/app/utils";
import { AdaptiveShell, ArrowLeft, IconButton, SettingsShell, Wallpaper } from "@/butler-ds";
import { AppConfirmationDialog } from "@/components/common/AppConfirmationDialog";
import { AppToaster } from "@/components/common/AppToaster";
import { WallpaperModulesProvider } from "@/components/common/WallpaperModulesProvider";
import { SettingsDetailHeader } from "@/components/settings/SettingsDetailHeader";
import { ModelSettingsTitle } from "@/components/settings/ModelSettingsTitle";
import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { createSettingsSectionGroups } from "@/components/settings/settingsSections";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses";
import { ApprovalsProposal } from "./approvals/ApprovalsProposal";
import { ErrorsProposal } from "./errors/ErrorsProposal";
import { installSettingsFixture, proposalSettings } from "./fixture";
import { AppearanceProposal } from "./motion/AppearanceProposal";
import { STAGE_MESSAGE, stateFromQuery, WALLPAPERS, type StageState } from "./state";
import { UpdatesProposal } from "./updates/UpdatesProposal";
import { t } from "./proposedCopy";
import { ShellProposal } from "./shell/ShellProposal";

function pageSection(state: StageState): SettingsSectionId {
  if (state.section === "updates") return "updates";
  if (state.section === "motion") return "appearance";
  if (state.section === "approvals") return "security";
  return ({ mcp: "mcp", skills: "skills", hosts: "security", wallpaper: "appearance", toasts: "general" } as const)[state.errorScreen];
}

/**
 * The framed preview: the same tree the app renders for Settings (AdaptiveShell settingsActive >
 * SettingsShell active, with the product SettingsSidebar and SettingsDetailHeader, as in
 * SettingsView). Only the detail content is the proposal. The page posts state changes in;
 * in-frame actions post patches back so the URL stays the source of truth.
 */
export function SettingsReviewStage() {
  const [state, setState] = useState<StageState>(() => stateFromQuery(new URLSearchParams(location.search)));
  const [ready, setReady] = useState(false);
  const [compactPane, setCompactPane] = useState<"master" | "detail">("detail");
  const [phone] = useState(() => window.matchMedia("(width <= 640px)").matches);
  useAppLocale();

  useEffect(() => {
    const restore = installSettingsFixture(state.locale, state.theme);
    setReady(true);
    return restore;
    // Installed once; later changes go through the stores below.
  }, []);
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== STAGE_MESSAGE) return;
      setState(event.data.state as StageState);
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, []);
  useEffect(() => {
    setAppCopyLanguage(state.locale);
    useButlerStore.setState({ settings: { ...useButlerStore.getState().settings, ...proposalSettings(state.locale, state.theme) } });
  }, [state.locale, state.theme]);
  useEffect(() => {
    if (state.section === "motion" && state.motion !== "off") document.body.dataset.motion = "reduced";
    else delete document.body.dataset.motion;
  }, [state.section, state.motion]);

  const settings = useButlerStore((store) => store.settings);
  const modelRoute = useSettingsUIStore((store) => store.modelRoute);
  const backModelRoute = useSettingsUIStore((store) => store.backModelRoute);
  const resetModelRoute = useSettingsUIStore((store) => store.resetModelRoute);
  usePortalThemeClasses(settings);
  const patch = (next: Partial<StageState>) => {
    setState((current) => ({ ...current, ...next }));
    window.parent.postMessage({ type: `${STAGE_MESSAGE}:patch`, patch: next }, location.origin);
  };
  // Proposal (Security reorganisation): Privacy's only section moves to Security, so the Privacy
  // page leaves the sidebar and Security gets a description that covers what it now holds.
  const reorganised = state.section === "approvals";
  const groups = createSettingsSectionGroups(appCopy.settings, false).map((group) => ({
    ...group,
    sections: group.sections
      .filter((item) => !(reorganised && item.id === "privacy"))
      .map((item) => reorganised && item.id === "security"
        ? { ...item, description: t(state.locale, "settings.sectionDescriptions.security") } : item),
  }));
  const sections = groups.flatMap((group) => group.sections);
  const active = pageSection(state);
  const descriptor = sections.find((item) => item.id === active);
  const title = descriptor?.label ?? appCopy.settings.title;
  if (!ready) return null;
  if (state.section === "updates" && state.updatePlace !== "settings") {
    return (
      <WallpaperModulesProvider>
        <Wallpaper source={WALLPAPERS[state.wallpaper]} scope="viewport" />
        <ShellProposal state={state} phone={phone} />
        <AppToaster />
      </WallpaperModulesProvider>
    );
  }
  return (
    <WallpaperModulesProvider>
      <Wallpaper source={WALLPAPERS[state.wallpaper]} scope="viewport" />
      <AdaptiveShell theme={appShellTheme(settings)} chromeEnvironment={chromeEnvironment()} platform="browser"
        leftOpen={false} rightOpen={false} settingsActive data-test-class="mac-window visual-harness">
        <SettingsShell
          active
          compactPane={compactPane}
          pageTitle={title}
          pageDescription={descriptor?.description}
          pageKey={active}
          pageOrder={sections.findIndex((item) => item.id === active)}
          detailNavigation={<IconButton label={appCopy.settings.back} onClick={() => setCompactPane("master")}><ArrowLeft size="lg" /></IconButton>}
          sidebar={(
            <SettingsSidebar sectionGroups={groups} activeSection={active} backLabel={appCopy.settings.back}
              onClose={() => undefined} onSectionChange={() => setCompactPane("detail")} isActive />
          )}
          detailHeader={(
            <SettingsDetailHeader title={title} description={descriptor?.description} localMessage={null}
              secondary={active === "models" ? (
                <ModelSettingsTitle modelRoute={modelRoute} onBack={backModelRoute} onRoot={resetModelRoute} onManagement={backModelRoute} />
              ) : undefined} />
          )}
          detail={
            state.section === "updates" ? <UpdatesProposal state={state} patch={patch} />
            : state.section === "motion" ? <AppearanceProposal state={state} patch={patch} />
            : state.section === "errors" ? <ErrorsProposal state={state} />
            : <ApprovalsProposal state={state} />
          }
        />
      </AdaptiveShell>
      <AppConfirmationDialog />
      <AppToaster />
    </WallpaperModulesProvider>
  );
}
