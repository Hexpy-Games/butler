import { useEffect, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { notifyStatus } from "@/app/notifications";
import { Button, ButtonContainer, Dialog, DialogContent, DialogForm, Input, RollingSwap, SettingsField } from "@/butler-ds";
import type { useButlerAccount } from "./hooks/useButlerAccount";

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

export function ButlerAccountSignInDialog({ open, onOpenChange, account }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: ReturnType<typeof useButlerAccount>;
}) {
  useAppLocale();
  const copy = appCopy.butlerAccount;
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const { busy } = account;
  useEffect(() => {
    if (open) { setStep("email"); setEmail(""); setCode(""); setError(""); }
  }, [open]);

  async function submit() {
    const result = step === "email" ? await account.start(email.trim()) : await account.verify(email.trim(), code);
    if (!result.ok) { setError(errorMessage(result.code, step)); return; }
    setError("");
    if (step === "email") {
      if ("dev_code" in result.value && result.value.dev_code !== undefined) setCode(result.value.dev_code);
      setStep("code");
    } else {
      onOpenChange(false);
      notifyStatus(copy.signedIn, { id: "butler-account", tone: "ok" });
    }
  }
  async function resend() {
    const result = await account.start(email.trim());
    if (!result.ok) { setError(errorMessage(result.code, step)); return; }
    if (result.value.dev_code !== undefined) setCode(result.value.dev_code);
    notifyStatus(copy.resent, { id: "butler-account", tone: "ok" });
    setError("");
  }
  function changeEmail() {
    setStep("email"); setCode(""); setError("");
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={appCopy.common.close} data-test-class="modal-card">
        <DialogForm dialog title={copy.dialogTitle}
          description={<RollingSwap itemKey={step}>{step === "email" ? copy.dialogIntro : copy.codeSent(email)}</RollingSwap>}
          onSubmit={submit} footer={
            <ButtonContainer size="default" justify="end">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{copy.cancel}</Button>
              <Button type="submit" aria-busy={busy} disabled={busy || (step === "email" ? !email.trim() : code.length !== 6)}>
                {step === "email" ? copy.sendCode : copy.signIn}
              </Button>
            </ButtonContainer>
          }>
          {step === "email" ? (
            <SettingsField key="email" id="butler-account-email" label={copy.email} controlWidth="full" error={error}
              control={<Input id="butler-account-email" type="email" autoComplete="email" autoFocus value={email}
                onChange={(event) => setEmail(event.target.value)} disabled={busy} />} />
          ) : <>
            <SettingsField key="code" id="butler-account-code" label={copy.code} controlWidth="full" error={error}
              control={<Input id="butler-account-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus
                value={code} onChange={(event) => setCode(event.target.value.replace(/\D/gu, ""))} disabled={busy} />} />
            <ButtonContainer size="sm" justify="start">
              <Button type="button" size="sm" variant="inline" disabled={busy} onClick={changeEmail}>{copy.changeEmail}</Button>
              <Button type="button" size="sm" variant="inline" disabled={busy} onClick={resend}>{copy.resend}</Button>
            </ButtonContainer>
          </>}
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
