import { memo } from "react";
import { useAppLocale } from "@/app/copy.ts";
import { butlerVaultSection, useButlerVaultSectionState } from "./ButlerVaultSection";
import { securityAuthoritySections } from "./SecurityAuthoritySections";
import { SettingsPage } from "./SettingsFormComponents";
import { useAllowedFolders } from "./useAllowedFolders";
import { useGrants } from "./useGrants";

/** Settings → Security: vault, command isolation, folders and approvals. */
export const SecuritySettings = memo(function SecuritySettings() {
  useAppLocale();
  const vault = useButlerVaultSectionState();
  const grants = useGrants();
  const folders = useAllowedFolders();
  return (
    <SettingsPage>
      {butlerVaultSection(vault)}
      {securityAuthoritySections({ grants, folders })}
    </SettingsPage>
  );
});
