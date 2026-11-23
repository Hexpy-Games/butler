import { useRef, useState } from "react";
import { apiErrorCode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { notifyError } from "@/app/notifications.ts";
import { addFailure, hostTarget, validateComputerForm, type ComputerFieldError, type ComputerForm } from "../computerAddErrors";
import { addComputer, checkHostKey, startComputer, type Computer } from "../computersApi";

type AddStep = "form" | "checking" | "confirming" | "adding" | "starting";

export function useComputerAdd(onAdded: (computer: Computer, failure?: string) => void) {
  const [step, setStep] = useState<AddStep>("form");
  const [error, setError] = useState<ComputerFieldError | null>(null);
  const running = useRef(false);
  const busy = step === "checking" || step === "adding" || step === "starting";

  function reset() {
    setStep("form");
    setError(null);
  }

  async function submit(form: ComputerForm) {
    if (running.current) return;
    const validation = validateComputerForm(form);
    setError(validation);
    if (validation) return;

    running.current = true;
    const copy = appCopy.computers;
    const target = hostTarget(form);
    try {
      setStep("checking");
      const hostKey = await checkHostKey(target);
      let fingerprint: string | undefined;
      if (!hostKey.trusted) {
        setStep("confirming");
        const confirmed = await confirmAction(copy.fingerprint.body, {
          title: copy.fingerprint.title,
          confirmLabel: copy.fingerprint.confirm,
          details: [{ label: hostKey.key_type, text: hostKey.fingerprint }],
        });
        if (!confirmed) return;
        fingerprint = hostKey.fingerprint;
      }
      setStep("adding");
      const computer = await addComputer({
        ...target, name: form.name.trim(), folder: form.folder.trim(), host_fingerprint: fingerprint,
      });
      setStep("starting");
      let failure: string | undefined;
      try {
        await startComputer(computer.id);
      } catch (error) {
        failure = addFailure(apiErrorCode(error))?.message ?? copy.errors.startFailed;
      }
      onAdded(computer, failure);
    } catch (error) {
      const fieldError = addFailure(apiErrorCode(error));
      setError(fieldError);
      if (!fieldError) notifyError(error, copy.errors.addFailed, { id: "computers" });
    } finally {
      running.current = false;
      setStep("form");
    }
  }

  return { step, busy, error, submit, reset };
}
