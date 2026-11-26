import { appCopy } from "@/app/copy.ts";
import { ConnectedAccountRows } from "./ConnectedAccountRows";
import type { useConnectedAccounts } from "./hooks/useConnectedAccounts";
import type { useSavedKeys } from "./hooks/useSavedKeys";
import { SavedKeysRows } from "./SavedKeysRows";
import { SettingsSection } from "./SettingsFormComponents";

export function modelCredentialSections({ savedKeys, accounts }: {
  savedKeys: ReturnType<typeof useSavedKeys>;
  accounts: ReturnType<typeof useConnectedAccounts>;
}) {
  const settingsCopy = appCopy.settings;
  const sections = settingsCopy.pageSections;
  return <>
    {accounts.state !== "unsupported" && (
      <SettingsSection id="connected-accounts" kind="list" title={sections.connectedAccounts}
        state={accounts.state === "ready" && accounts.credentials.length === 0 ? "empty" : accounts.state}
        emptyMessage={settingsCopy.connectedAccounts.empty} onRetry={() => void accounts.reload()}>
        <ConnectedAccountRows accounts={accounts} />
      </SettingsSection>
    )}
    {savedKeys.state !== "unsupported" && (
      <SettingsSection id="saved-keys" kind="list" title={sections.savedKeys}
        state={savedKeys.state === "ready" && savedKeys.credentials.length === 0 ? "empty" : savedKeys.state}
        emptyMessage={settingsCopy.savedKeys.empty} onRetry={() => void savedKeys.reload()}>
        <SavedKeysRows keys={savedKeys} />
      </SettingsSection>
    )}
  </>;
}
