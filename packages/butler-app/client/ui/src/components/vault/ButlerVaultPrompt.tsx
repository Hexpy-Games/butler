import { useEffect, useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { loadStartupSettings } from "@/app/startupSettings.ts";
import { Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/butler-ds";
import { VaultPasswordFields } from "./VaultPasswordFields";
import { useButlerVault } from "./useButlerVault";

/** Offers the vault once to an install that finished setup before this version; mounted with the workspace only. */
export function ButlerVaultPrompt() {
  useAppLocale();
  const vault = useButlerVault();
  const [existingUser, setExistingUser] = useState(false);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<"intro" | "done" | "failed">("intro");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const passwordOnly = !vault.view?.available;
  const offered = useRef(false);
  const copy = appCopy.butlerVault;
  useEffect(() => {
    let cancelled = false;
    void loadStartupSettings().then((settings) => {
      if (!cancelled) setExistingUser(Boolean(settings.onboarding?.completed_at));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (offered.current || !existingUser || vault.state !== "ready") return;
    if (vault.view?.state === "off" && !vault.view.declined) {
      offered.current = true;
      setOpen(true);
    }
  }, [existingUser, vault.state, vault.view]);
  async function enable() {
    if (vault.busy) return;
    if (passwordOnly && password !== confirmation) { setError(copy.mismatch); return; }
    if (passwordOnly && password.length < 12) { setError(copy.weak); return; }
    const response = await vault.enable(passwordOnly ? password : undefined);
    if (response.ok) {
      setPassword(""); setConfirmation(""); setError(""); setResult("done");
    } else if (passwordOnly) {
      setError(response.code === "vault_wrong_password" ? copy.wrongPassword : response.code === "vault_weak_password" ? copy.weak : copy.failed);
    } else setResult("failed");
  }
  async function skip() {
    if (await vault.decline()) {
      setPassword(""); setConfirmation(""); setError(""); setOpen(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{copy.name}</DialogTitle>
          <DialogDescription>{passwordOnly && result !== "done" ? copy.passwordIntro : copy[result]}</DialogDescription>
        </DialogHeader>
        {passwordOnly && result !== "done" && <VaultPasswordFields variant="card" password={password}
          onPasswordChange={setPassword} confirmation={confirmation} onConfirmationChange={setConfirmation}
          hint={copy.passwordHint} error={error} errorOnConfirmation={error === copy.mismatch} disabled={vault.busy} autoFocus onSubmit={() => void enable()} />}
        <DialogFooter>
          <ButtonContainer size="default" justify="end">
            {result === "done" ? <Button autoFocus onClick={() => setOpen(false)}>{copy.continue}</Button> : <>
              <Button variant="secondary" disabled={vault.busy} onClick={() => void skip()}>{copy.skip}</Button>
              <Button autoFocus={!passwordOnly} disabled={vault.busy} aria-busy={vault.busy} onClick={() => void enable()}>{copy.continue}</Button>
            </>}
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
