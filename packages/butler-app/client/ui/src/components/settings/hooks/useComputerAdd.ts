import { useRef, useState } from "react";
import { apiErrorCode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { addFailure, hostTarget, validateComputerForm, type ComputerFieldError, type ComputerForm } from "../computerAddErrors";
import type { ComputerModelSource } from "../computerTypes";
import { addComputer, checkHostKey, editComputer, startComputer, type Computer } from "../computersApi";

type AddStep = "form" | "checking" | "adding" | "starting";

export function useComputerAdd(onAdded: (computer: Computer, failure?: string) => void) {
  const [step, setStep] = useState<AddStep>("form");
  const [error, setError] = useState<ComputerFieldError | null>(null);
  const running = useRef(false);
  const busy = step === "checking" || step === "adding" || step === "starting";

  function reset() {
    setStep("form");
    setError(null);
  }

  async function submit(form: ComputerForm, modelSource: ComputerModelSource, editing?: Computer) {
    if (running.current) return;
    const validation = validateComputerForm(form);
    setError(validation);
    if (validation) return;

    running.current = true;
    const copy = appCopy.computers;
    const target = hostTarget(form);
    const input = { ...target, name: form.name.trim(), folder: form.folder.trim(), model_source: modelSource };
    try {
      if (editing) {
        setStep("adding");
        const computer = await editComputer(editing.id, input);
        onAdded(computer);
        return;
      }
      setStep("checking");
      await checkHostKey(target);
      setStep("adding");
      const computer = await addComputer(input);
      setStep("starting");
      let failure: string | undefined;
      try {
        await startComputer(computer.id);
      } catch (error) {
        failure = addFailure(apiErrorCode(error))?.message ?? copy.errors.startFailed;
      }
      onAdded(computer, failure);
    } catch (error) {
      const code = apiErrorCode(error);
      if (editing && code === "remote_model_sync_failed") {
        onAdded(editing, copy.model.syncFailed);
        return;
      }
      const fieldError = addFailure(code);
      setError(fieldError);
      if (!fieldError) notifyError(error, copy.errors.addFailed, { id: "computers" });
    } finally {
      running.current = false;
      setStep("form");
    }
  }

  return { step, busy, error, submit, reset };
}
