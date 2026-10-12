import { useAppLocale } from "@/app/copy.ts";
import { useEffect } from "react";
import { Dialog, DialogContent, ScrollArea } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { SessionObserverControls } from "./SessionObserverControls";
import { SessionObserverBody } from "./SessionObserverBody.tsx";
import { SessionObserverHeader } from "./SessionObserverHeader.tsx";
import { useSessionViewSubscription } from "./hooks/useSessionViewSubscription.ts";

export function SessionObserverDialog() {
  useAppLocale();
  const sessionId = useButlerStore((state) => state.observerSessionId);
  const targetTurnId = useButlerStore((state) => state.observerTargetTurnId);
  const view = useButlerStore((state) =>
    sessionId ? state.sessionViews[sessionId] : undefined,
  );
  const close = useButlerStore((state) => state.closeSessionObserver);
  const refresh = useButlerStore((state) => state.refreshSessionObserver);

  useSessionViewSubscription(sessionId, refresh);
  useEffect(() => {
    if (!sessionId || !targetTurnId || !view) return;
    const target = [...document.querySelectorAll<HTMLElement>('[data-test-class="steward-observer-dialog"] [data-turn-id]')]
      .find((element) => element.dataset.turnId === targetTurnId ||
        element.dataset.turnIds?.split(" ").includes(targetTurnId));
    if (!target) return;
    target.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    useButlerStore.setState({ observerTargetTurnId: null });
  }, [sessionId, targetTurnId, view]);

  return (
    <Dialog
      open={Boolean(sessionId)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent closeLabel={appCopy.common.close}
        aria-describedby="steward-observer-description"
        layout="scroll-body"
        maxHeight="3/5"
        data-test-class="steward-observer-dialog"
        glassRadius="composer"
      >
        <SessionObserverHeader />
        <ScrollArea fill dataTestClass="steward-observer-transcript">
          <SessionObserverBody view={view} />
        </ScrollArea>
        <SessionObserverControls view={view} />
      </DialogContent>
    </Dialog>
  );
}
