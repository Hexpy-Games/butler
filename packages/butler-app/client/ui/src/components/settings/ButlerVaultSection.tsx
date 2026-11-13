import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Button, ButtonContainer, Input, SettingsField, SettingsSection, Typo } from "@/butler-ds";
import { useButlerVault } from "../vault/useButlerVault";
import { VaultPasswordFields } from "../vault/VaultPasswordFields";

export function ButlerVaultSection() {
  useAppLocale();
  const vault = useButlerVault();
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const copy = appCopy.butlerVault;
  const { view } = vault;
  if (vault.state !== "ready" || !view) return null;
  if (view.state === "locked" && view.unlock !== "password") {
    return <SettingsSection id="butler-vault" kind="form" title={copy.name} state="empty" emptyMessage={copy.locked} />;
  }
  const locked = view.state === "locked";
  const changing = view.state === "protected";
  const passwordOnly = !view.available || view.unlock === "password";
  const kinds = view.counts ? copy.kinds(view.counts) : "";
  function cancel() {
    setEditing(false); setCurrent(""); setPassword(""); setConfirmation(""); setError("");
  }
  async function submit() {
    if (vault.busy) return;
    if (!locked && password !== confirmation) { setError(copy.mismatch); return; }
    if (!locked && password.length < 12) { setError(copy.weak); return; }
    const result = locked ? await vault.unlock(password)
      : changing ? await vault.changePassword(current, password) : await vault.enable(password);
    if (!result.ok) {
      setError(result.code === "vault_wrong_password" ? copy.wrongPassword : result.code === "vault_weak_password" ? copy.weak : copy.failed);
      return;
    }
    cancel();
    if (!locked) notifyStatus(changing ? copy.passwordChanged : copy.turnedOn);
  }
  async function turnOn() {
    if (passwordOnly) { setEditing(true); return; }
    if ((await vault.enable()).ok) notifyStatus(copy.turnedOn);
    else notifyError(undefined, copy.failed);
  }
  return (
    <SettingsSection id="butler-vault" kind="form" title={copy.name} description={locked ? copy.lockedPassword : copy[view.state]}>
      {changing && kinds && <SettingsField id="butler-vault-stored" label={copy.stored} control={<Typo.Body>{kinds}</Typo.Body>} />}
      {view.state === "off" && !editing && <SettingsField id="butler-vault-turn-on" label={copy.turnOnLabel}
        description={passwordOnly ? copy.passwordIntro : copy.intro}
        control={<Button disabled={vault.busy} aria-busy={vault.busy} onClick={() => void turnOn()}>{copy.turnOn}</Button>} />}
      {changing && view.unlock === "password" && !editing && <SettingsField label={copy.masterPassword}
        control={<Button onClick={() => setEditing(true)}>{copy.change}</Button>} />}
      {(editing || locked) && <>
        {changing && <SettingsField id="butler-vault-current" label={copy.currentPassword} controlWidth="full"
          control={<Input id="butler-vault-current" type="password" autoComplete="current-password" value={current}
            disabled={vault.busy} onChange={(event) => setCurrent(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />} />}
        <VaultPasswordFields variant="settings" password={password} onPasswordChange={setPassword}
          confirmation={locked ? undefined : confirmation} onConfirmationChange={setConfirmation}
          label={changing ? copy.newPassword : copy.masterPassword} hint={locked ? copy.unlockHint : copy.passwordHint}
          error={error} errorOnConfirmation={error === copy.mismatch} disabled={vault.busy} onSubmit={() => void submit()} />
        <ButtonContainer size="default" justify="end">
          {!locked && <Button variant="secondary" disabled={vault.busy} onClick={cancel}>{copy.cancel}</Button>}
          <Button disabled={vault.busy} aria-busy={vault.busy} onClick={() => void submit()}>
            {locked ? copy.unlock : changing ? copy.change : copy.turnOn}
          </Button>
        </ButtonContainer>
      </>}
    </SettingsSection>
  );
}
