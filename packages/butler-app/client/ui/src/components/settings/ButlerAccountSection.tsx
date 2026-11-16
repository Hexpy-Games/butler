import { useState } from "react";
import { appCopy, getAppLocale, useAppLocale } from "@/app/copy";
import { Button, ButtonContainer, SettingsField, SettingsSection, Tag, Typo } from "@/butler-ds";
import { ButlerAccountDevices } from "./ButlerAccountDevices";
import { ButlerAccountSignInDialog } from "./ButlerAccountSignInDialog";
import { useButlerAccount } from "./hooks/useButlerAccount";

export function ButlerAccountSection() {
  useAppLocale();
  const account = useButlerAccount();
  const copy = appCopy.butlerAccount;
  const [open, setOpen] = useState(false);
  const { status, busy } = account;
  if (account.state === "unsupported") return null;
  if (account.state !== "ready") return (
    <SettingsSection id="butler-account" kind="form" title={copy.name} state={account.state}
      errorMessage={copy.loadFailed} onRetry={() => void account.reload()} />
  );
  if (status?.signed_in) return <>
    <SettingsSection id="butler-account" kind="form" title={copy.name}>
      <SettingsField id="butler-account-email" label={copy.account} control={<Typo.Body>{status.account.email}</Typo.Body>} />
      <SettingsField id="butler-account-plan" label={copy.plan}
        description={status.entitlements.renews_at ? copy.renews(new Intl.DateTimeFormat(getAppLocale(), { dateStyle: "medium" }).format(new Date(status.entitlements.renews_at))) : undefined}
        control={<Tag>{copy.plans[status.entitlements.plan] ?? copy.plans.free}</Tag>} />
      <ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void account.signOut()}>{copy.signOut}</Button>
      </ButtonContainer>
    </SettingsSection>
    <ButlerAccountDevices account={account} />
  </>;
  return (
    <SettingsSection id="butler-account" kind="form" title={copy.name}>
      <SettingsField id="butler-account-sign-in" label={copy.signedOut} description={copy.intro}
        control={<Button onClick={() => setOpen(true)}>{copy.signIn}</Button>} />
      <ButlerAccountSignInDialog open={open} onOpenChange={setOpen} account={account} />
    </SettingsSection>
  );
}
