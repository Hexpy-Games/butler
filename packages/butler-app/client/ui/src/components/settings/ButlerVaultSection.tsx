import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Button, SettingsField, SettingsSection, Typo } from "@/butler-ds";
import { useButlerVault } from "../vault/useButlerVault";

export function ButlerVaultSection() {
  useAppLocale();
  const vault = useButlerVault();
  const copy = appCopy.butlerVault;
  const { view } = vault;
  if (vault.state !== "ready" || !view || (view.state === "off" && !view.available)) return null;
  if (view.state === "locked") {
    return <SettingsSection id="butler-vault" kind="form" title={copy.name} state="empty" emptyMessage={copy.locked} />;
  }
  const kinds = view.counts ? copy.kinds(view.counts) : "";
  async function turnOn() {
    if (await vault.enable()) notifyStatus(copy.turnedOn);
    else notifyError(undefined, copy.failed);
  }
  return (
    <SettingsSection id="butler-vault" kind="form" title={copy.name} description={copy[view.state]}>
      {view.state === "protected" && kinds && <SettingsField id="butler-vault-stored" label={copy.stored}
        control={<Typo.Body>{kinds}</Typo.Body>} />}
      {view.state === "off" && <SettingsField id="butler-vault-turn-on" label={copy.turnOnLabel} description={copy.intro}
        control={<Button disabled={vault.busy} aria-busy={vault.busy} onClick={() => void turnOn()}>{copy.turnOn}</Button>} />}
    </SettingsSection>
  );
}
