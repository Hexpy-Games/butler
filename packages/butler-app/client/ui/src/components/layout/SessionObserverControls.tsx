import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { SessionView } from "@/app/types";
import { Button, DialogFooter } from "@/butler-ds";

export function SessionObserverControls({ view }: { view?: SessionView }) {
  useAppLocale();
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const cancelObservedSteward = useButlerStore((state) => state.cancelObservedSteward);
  const resumeObservedSteward = useButlerStore((state) => state.resumeObservedSteward);
  return (
    view?.latest_turn?.retryable && !view.active_turn && view.relation ? (
      <DialogFooter>
        <Button
          type="button"
          disabled={resuming}
          onClick={() => {
            setResuming(true);
            void resumeObservedSteward(view.relation!.relation_id)
              .finally(() => setResuming(false));
          }}
        >
          {resuming
            ? appCopy.conversation.work.pendingStateLabels.retrying
            : appCopy.conversation.work.resumeInterrupted}
        </Button>
      </DialogFooter>
    ) : (view?.active_turn || view?.waiting_for_children) && view.relation ? (
      <DialogFooter>
        <Button
          type="button"
          variant="destructive"
          disabled={cancelling}
          onClick={() => {
            setCancelling(true);
            void cancelObservedSteward(view.relation!.relation_id)
              .finally(() => setCancelling(false));
          }}
        >
          {cancelling
            ? appCopy.conversation.work.pendingStateLabels.cancelling
            : appCopy.composer.stop}
        </Button>
      </DialogFooter>
    ) : null
  );
}
