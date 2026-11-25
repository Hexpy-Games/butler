import { memo } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { computersSection } from "./ComputersSection";
import { useComputersSection } from "./hooks/useComputersSection";
import { useSavedKeys } from "./hooks/useSavedKeys";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { useSecuritySettings } from "./useSecuritySettings";

export const ComputersSettings = memo(function ComputersSettings() {
  useAppLocale();
  const computersState = useComputersSection();
  const savedKeys = useSavedKeys();
  const security = useSecuritySettings();
  const { load } = security;
  const refused = load === "host-only" || load === "admin-required" || load === "error";
  if (refused) {
    return (
      <SettingsPage>
        <SettingsSection
          id="computers"
          kind="list"
          title={appCopy.computers.listTitle}
          state={load === "host-only" ? "empty" : "error"}
          emptyMessage={appCopy.settings.security.hostOnly}
          errorMessage={load === "admin-required" ? appCopy.settings.security.adminRequired : undefined}
          onRetry={security.retry}
        />
      </SettingsPage>
    );
  }
  return <SettingsPage>{computersSection({ section: computersState, savedKeys: savedKeys.credentials })}</SettingsPage>;
});
