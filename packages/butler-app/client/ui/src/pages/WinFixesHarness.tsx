import { useEffect, useState } from "react";
import { AdaptiveShell, AdaptiveShellWorkspace, AdaptiveShellSidebar, Stack } from "@/butler-ds";
import { Conversation } from "@/components/conversation/Conversation";
import { SessionObserverDialog } from "@/components/layout/SessionObserverDialog";
import { useLiveSessionEvents } from "@/hooks/live-session/useLiveSessionEvents";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses";
import { useButlerStore } from "@/app/store";
import { appShellTheme } from "@/app/utils";
import { setAppCopyLanguage } from "@/app/copy";
import { EMPTY_SETTINGS } from "@/app/constants";
import { HARNESS_MODEL_CATALOG } from "@/app/fixtures";
import { WIN_FIXES_PARENT } from "@/app/winFixesFixture";

/** Real conversation, permissions and observers driven by the normal live stream. */
export function WinFixesHarness() {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const language = params.get("locale") === "en" ? "en" : "ko";
  const settings = { ...EMPTY_SETTINGS, appearance_theme: theme, language } as const;
  const [ready, setReady] = useState(false);
  useLiveSessionEvents();
  usePortalThemeClasses(settings);
  useEffect(() => {
    setAppCopyLanguage(language);
    const parent = structuredClone(WIN_FIXES_PARENT);
    parent.steward_children![0]!.relation.anchor_message_id = "harness-parent-user";
    useButlerStore.setState({ activeChatId: parent.session_id, settings, modelCatalog: HARNESS_MODEL_CATALOG,
      modelCatalogState: "ready", sessionViews: {}, observerSessionId: null, summary: null });
    useButlerStore.getState().setSessionView(parent);
    void useButlerStore.getState().refreshAuthorityApprovals(parent.session_id);
    setReady(true);
  }, [language, theme]);
  return <AdaptiveShell leftOpen={false} rightOpen={false} theme={appShellTheme(settings)}>
    <AdaptiveShellSidebar open={false} />
    <AdaptiveShellWorkspace><Stack fill data-harness-ready={ready}><Conversation /><SessionObserverDialog /></Stack></AdaptiveShellWorkspace>
  </AdaptiveShell>;
}
