import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { SetupWizardStepAction } from "@/butler-ds";
import { VaultPasswordFields } from "../vault/VaultPasswordFields";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

export function FirstRunVault({ flow }: { flow: FirstRunFlow }) {
  const [result, setResult] = useState<"intro" | "done" | "failed">("intro");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const copy = appCopy.butlerVault;
  const { vault } = flow;
  const passwordOnly = !vault.view?.available;
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
    if (await vault.decline()) flow.setScreen("connect");
  }
  return (
    <FirstRunStepCard flow={flow} title={copy.name}
      onBack={result === "done" ? undefined : () => flow.setScreen("memory")}
      description={passwordOnly && result !== "done" ? copy.passwordIntro : copy[result]}
      actions={result === "done"
        ? <SetupWizardStepAction forward onClick={() => flow.setScreen("connect")}>{copy.continue}</SetupWizardStepAction>
        : <>
          <SetupWizardStepAction variant="secondary" disabled={vault.busy} onClick={() => void skip()}>{copy.skip}</SetupWizardStepAction>
          <SetupWizardStepAction forward disabled={vault.busy} aria-busy={vault.busy} onClick={() => void enable()}>{copy.continue}</SetupWizardStepAction>
        </>}
    >
      {passwordOnly && result !== "done" && <VaultPasswordFields variant="card" password={password}
        onPasswordChange={setPassword} confirmation={confirmation} onConfirmationChange={setConfirmation}
        hint={copy.passwordHint} error={error} errorOnConfirmation={error === copy.mismatch} disabled={vault.busy} onSubmit={() => void enable()} />}
    </FirstRunStepCard>
  );
}
