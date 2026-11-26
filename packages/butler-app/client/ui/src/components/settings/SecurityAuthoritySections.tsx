import { AllowedFoldersSection } from "./AllowedFoldersSection";
import { CommandSandboxField } from "./CommandSandboxField";
import type { useAllowedFolders } from "./useAllowedFolders";
import { appCopy } from "@/app/copy.ts";
import { SettingsSection } from "./SettingsFormComponents";
import { GrantsSection } from "./GrantsSection";
import { useGrants } from "./useGrants";

/** Direct section elements for SettingsPage; data and effects stay with the page. */
export function securityAuthoritySections({ grants, folders }: {
  grants: ReturnType<typeof useGrants>;
  folders: ReturnType<typeof useAllowedFolders>;
}) {
  const settingsCopy = appCopy.settings;
  const sections = settingsCopy.pageSections;
  return <>
    <SettingsSection id="command-isolation" kind="form" title={sections.commandIsolation}>
      <CommandSandboxField />
    </SettingsSection>
    <SettingsSection id="allowed-folders" kind="list" title={sections.allowedFolders}
      description={settingsCopy.pageSectionDescriptions.allowedFolders} state={folders.state}
      onRetry={() => void folders.reload()}>
      <AllowedFoldersSection settings={folders} />
    </SettingsSection>
    <SettingsSection id="grants" kind="list" title={sections.grants}
      description={settingsCopy.pageSectionDescriptions.grants}
      state={grants.state === "ready" && grants.rows.length === 0 ? "empty" : grants.state}
      emptyMessage={settingsCopy.grants.empty} errorMessage={settingsCopy.grants.loadFailed} onRetry={() => void grants.reload()}>
      <GrantsSection grants={grants} />
    </SettingsSection>
  </>;
}
