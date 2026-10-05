import { useAppLocale } from "@/app/copy.ts";
import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  MessageRow,
  ScrollArea,
  Stack,
  Typo,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SessionViewStatus } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { TurnActivityPending } from "@/components/conversation/TurnActivityPending.tsx";
import { SessionObserverControls } from "./SessionObserverControls";
import { SessionObserverTimeline } from "./SessionObserverTimeline.tsx";
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
          <Stack as="section" aria-label={appCopy.inspector.tabs.activity} gap="lg">
            <SessionObserverTimeline
              delegatedGoal={view?.relation?.safe_title}
              messages={view?.messages ?? []}
              activityHistory={view?.activity_history}
              activeTurn={view?.active_turn}
              latestTurn={view?.latest_turn}
            />
            {view?.waiting_for_children && !view.active_turn ? (
              <MessageRow
                role="assistant"
                activity
                dataTestClass="steward-observer-worker-wait"
              >
                <TurnActivityPending
                  readModels={[]}
                  state="waiting_for_children"
                />
              </MessageRow>
            ) : null}
            {!view?.messages.length && !view?.active_turn &&
                !view?.waiting_for_children ? (
              <Typo.Caption>{emptyObserverLabel(view?.status)}</Typo.Caption>
            ) : null}
          </Stack>
        </ScrollArea>
        <SessionObserverControls view={view} />
      </DialogContent>
    </Dialog>
  );
}

function emptyObserverLabel(status?: SessionViewStatus): string {
  switch (status) {
    case "delivered": return appCopy.interfaceStatus.delivered;
    case "failed": return appCopy.interfaceStatus.failedPast;
    case "cancelled": return appCopy.interfaceStatus.cancelled;
    default: return appCopy.conversation.work.pendingLabel;
  }
}
