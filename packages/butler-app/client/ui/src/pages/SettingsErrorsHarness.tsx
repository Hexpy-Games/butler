import { ProjectWallpaperDialog } from "@/components/management/ProjectWallpaperDialog";
import { SettingsKeyErrorHarness } from "./SettingsKeyErrorHarness";
import { useEffect, useState } from "react";
import { AdaptiveShell, AdaptiveShellWorkspace, AdaptiveShellSidebar, Stack, Toaster } from "@/butler-ds";
import { EMPTY_SETTINGS } from "@/app/constants";
import { HARNESS_MODEL_CATALOG } from "@/app/fixtures";
import { setAppCopyLanguage } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { appShellTheme } from "@/app/utils";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses";
import { McpSettings } from "@/components/settings/McpSettings";
import { SkillsSettings } from "@/components/settings/SkillsSettings";
import { ArchivesSettings } from "@/components/settings/ArchivesSettings";
import { LocalModelSettings } from "@/components/settings/LocalModelSettings";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { GeneralSettings } from "@/components/settings/GeneralSettings";

/** Real settings containers and HTTP adapters over the smoke's stub gateway. */
export function SettingsErrorsHarness() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const language = params.get("locale") === "ko" ? "ko" : "en";
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  const settings = { ...EMPTY_SETTINGS, language, appearance_theme: theme } as const;
  const [ready, setReady] = useState(false);
  usePortalThemeClasses(settings);
  useEffect(() => {
    setAppCopyLanguage(language);
    useButlerStore.setState({ settings, modelCatalog: HARNESS_MODEL_CATALOG });
    useSettingsUIStore.setState({ draft: settings, baseline: settings });
    setReady(true);
  }, [language, theme]);
  return <AdaptiveShell leftOpen={false} rightOpen={false} theme={appShellTheme(settings)}>
    <AdaptiveShellSidebar open={false} />
    <AdaptiveShellWorkspace ><Stack gap="md" data-harness-ready={ready}>
      {ready ? mode === "project-wallpaper" ? <ProjectWallpaperDialog projectId="stub-project" value="inherit" open onOpenChange={() => {}} /> : mode === "keys" ? <SettingsKeyErrorHarness /> : mode === "skills" ? <SkillsSettings /> : mode === "wallpaper" ? <AppearanceSettings />
        : mode === "archives" ? <ArchivesSettings /> : mode === "local" ? <LocalModelSettings />
        : mode === "save" ? <GeneralSettings /> : <McpSettings /> : null}
      <Toaster />
    </Stack></AdaptiveShellWorkspace>
  </AdaptiveShell>;
}
