import { useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { SetupWizardStepAction } from "@/butler-ds";
import { FirstRunStepCard } from "./FirstRunStepCard";
import type { FirstRunFlow } from "./useFirstRunFlow";

export function FirstRunVault({ flow }: { flow: FirstRunFlow }) {
  const [result, setResult] = useState<"intro" | "done" | "failed">("intro");
  const copy = appCopy.butlerVault;
  const { vault } = flow;
  async function enable() {
    setResult(await vault.enable() ? "done" : "failed");
  }
  async function skip() {
    if (await vault.decline()) flow.setScreen("connect");
  }
  return (
    <FirstRunStepCard flow={flow} title={copy.name}
      onBack={result === "done" ? undefined : () => flow.setScreen("memory")}
      description={copy[result]}
      actions={result === "done"
        ? <SetupWizardStepAction forward onClick={() => flow.setScreen("connect")}>{copy.continue}</SetupWizardStepAction>
        : <>
          <SetupWizardStepAction variant="secondary" disabled={vault.busy} onClick={() => void skip()}>{copy.skip}</SetupWizardStepAction>
          <SetupWizardStepAction forward disabled={vault.busy} aria-busy={vault.busy} onClick={() => void enable()}>{copy.continue}</SetupWizardStepAction>
        </>}
    />
  );
}
