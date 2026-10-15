import { appCopy } from "@/app/copy.ts";
import { SettingsSection, Stack } from "@/butler-ds";
import { useVault } from "./useVault";
import { VaultCardsSection } from "./VaultCardsSection";
import { VaultSitesField } from "./VaultSitesField";
import { VaultProfilesSection } from "./VaultProfilesSection";

/** Settings → Browser: payment methods, autofill details, and the sites where a purchase needs no final card. */
export function BrowserVaultSections() {
  const vault = useVault();
  const copy = appCopy.settings.vault;
  const sites = vault.view?.purchase_sites ?? [];
  return <>
    <VaultCardsSection vault={vault} />
    <VaultProfilesSection vault={vault} />
    <SettingsSection id="purchase-sites" kind="form" title={appCopy.settings.pageSections.purchaseSites}
      state={vault.state} onRetry={() => void vault.reload()}>
      <Stack gap="sm" data-test-class="vault-purchase-sites">
        <VaultSitesField sites={sites} label={sites.length ? appCopy.settings.pageSections.purchaseSites : copy.emptyPurchaseSites}
          onChange={(next) => void vault.purchaseSites(sites, next)} />
      </Stack>
    </SettingsSection>
  </>;
}
