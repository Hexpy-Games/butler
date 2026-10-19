import { useRef, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { fullResetAvailable, runFullReset } from "@/app/fullReset.ts";
import { notifyStatus } from "@/app/notifications.ts";

/** Confirms with the typed phrase, then resets everything; the app restarts on success. */
export function useFullReset() {
  const [running, setRunning] = useState(false);
  const pending = useRef(false);
  const start = async () => {
    if (pending.current || !fullResetAvailable()) return;
    pending.current = true;
    const copy = appCopy.settings.fullReset;
    const memory = appCopy.settings.memory;
    try {
      const accepted = await confirmAction(copy.body, {
        title: copy.title, confirmLabel: copy.confirm, destructive: true,
        details: [{ label: memory.removed, text: copy.removed }, { label: memory.kept, text: copy.kept }],
        typedConfirmation: { phrase: copy.phrase, label: copy.field(copy.phrase), mismatchTooltip: copy.mismatch },
      });
      if (!accepted) return;
      setRunning(true);
      // On success the app quits and relaunches; this view stays busy until then.
      await runFullReset(crypto.randomUUID());
    } catch {
      setRunning(false);
      notifyStatus(memory.resetFailed, { id: "full-reset", tone: "error" });
    } finally {
      pending.current = false;
    }
  };
  return { available: fullResetAvailable(), running, start };
}
