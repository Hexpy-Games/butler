import { appCopy } from "@/app/copy.ts";
import { SettingsSection } from "./SettingsFormComponents";
import { useSavedKeys } from "./hooks/useSavedKeys";
import { SavedKeysRows } from "./SavedKeysRows";
import { ConnectedAccountRows } from "./ConnectedAccountRows";
import type { useConnectedAccounts } from "./hooks/useConnectedAccounts";
import { GrantsSection } from "./GrantsSection";
import { useGrants } from "./useGrants";

/** Direct section elements for SettingsPage; data and effects stay with the page. */
export function securityAuthoritySections({ savedKeys, grants, accounts }: {
  savedKeys: ReturnType<typeof useSavedKeys>; grants: ReturnType<typeof useGrants>;
  accounts: ReturnType<typeof useConnectedAccounts>;
}) {
  const settingsCopy = appCopy.settings;
  const sections = settingsCopy.pageSections;
  return <>
    <SettingsSection id="grants" kind="list" title={sections.grants}
      description={settingsCopy.pageSectionDescriptions.grants}
      state={grants.state === "ready" && grants.rows.length === 0 ? "empty" : grants.state}
      emptyMessage={settingsCopy.grants.empty} errorMessage={settingsCopy.grants.loadFailed} onRetry={() => void grants.reload()}>
      <GrantsSection grants={grants} />
    </SettingsSection>
    {savedKeys.state !== "unsupported" && (
      <SettingsSection id="saved-keys" kind="list" title={sections.savedKeys}
        state={savedKeys.state === "ready" && savedKeys.credentials.length === 0 ? "empty" : savedKeys.state}
        emptyMessage={settingsCopy.savedKeys.empty} onRetry={() => void savedKeys.reload()}>
        <SavedKeysRows keys={savedKeys} />
      </SettingsSection>
    )}
    {accounts.state !== "unsupported" && (
      <SettingsSection id="connected-accounts" kind="list" title={sections.connectedAccounts}
        state={accounts.state === "ready" && accounts.credentials.length === 0 ? "empty" : accounts.state}
        emptyMessage={settingsCopy.connectedAccounts.empty} onRetry={() => void accounts.reload()}>
        <ConnectedAccountRows accounts={accounts} />
      </SettingsSection>
    )}
  </>;
}
