import { useState } from "react";
import { appCopy, getAppLocale, useAppLocale } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { Button, ButtonContainer, Input, SettingsField, SettingsSection, Tag, Typo } from "@/butler-ds";
import { ButlerAccountDevices } from "./ButlerAccountDevices";
import { useButlerAccount } from "./hooks/useButlerAccount";

function errorMessage(code: string | undefined, step: "email" | "code") {
  const copy = appCopy.butlerAccount;
  switch (code) {
    case "code_invalid": return copy.codeInvalid;
    case "code_expired": return copy.codeExpired;
    case "rate_limited": return copy.tooSoon;
    case "email_capacity": case "paused": return copy.unavailableNow;
    case "cloud_unavailable": return copy.offline;
    case "invalid_request": return step === "email" ? copy.emailInvalid : copy.failed;
    default: return copy.failed;
  }
}

export function ButlerAccountSection() {
  useAppLocale();
  const account = useButlerAccount();
  const copy = appCopy.butlerAccount;
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const { status, busy } = account;
  async function submit(resend = false) {
    if (busy || !email.trim() || (step === "code" && !resend && code.length !== 6)) return;
    const result = step === "email" || resend ? await account.start(email.trim()) : await account.verify(email.trim(), code);
    if (!result.ok) { setError(errorMessage(result.code, step)); return; }
    setError("");
    if (resend) notifyStatus(copy.resent, { id: "butler-account", tone: "ok" });
    else { setStep(step === "email" ? "code" : "email"); setCode(""); }
  }
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
    <SettingsSection id="butler-account" kind="form" title={copy.name} description={copy.intro}>
      {step === "email" ? <>
        <SettingsField id="butler-account-email" label={copy.email} controlWidth="full" error={error}
          control={<Input id="butler-account-email" type="email" autoComplete="email" value={email}
            onChange={(event) => setEmail(event.target.value)} disabled={busy}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />} />
        <ButtonContainer size="default" justify="end">
          <Button aria-busy={busy} disabled={busy || !email.trim()} onClick={() => void submit()}>{copy.sendCode}</Button>
        </ButtonContainer>
      </> : <>
        <SettingsField id="butler-account-code" label={copy.code} description={copy.codeSent(email)} controlWidth="full" error={error}
          control={<Input id="butler-account-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/gu, ""))} disabled={busy}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />} />
        <ButtonContainer size="default" justify="end">
          <Button variant="secondary" disabled={busy} onClick={() => { setStep("email"); setCode(""); setError(""); }}>{copy.changeEmail}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => void submit(true)}>{copy.resend}</Button>
          <Button aria-busy={busy} disabled={busy || code.length !== 6} onClick={() => void submit()}>{copy.signIn}</Button>
        </ButtonContainer>
      </>}
    </SettingsSection>
  );
}
