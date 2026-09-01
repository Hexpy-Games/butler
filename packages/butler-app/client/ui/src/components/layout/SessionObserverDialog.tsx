import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  MessageRow,
  ScrollArea,
  Stack,
  Typo,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { TurnActivityPanel } from "@/components/conversation/TurnActivityPanel.tsx";
import { TurnActivityPending } from "@/components/conversation/TurnActivityPending.tsx";
import { SessionObserverTimeline } from "./SessionObserverTimeline.tsx";
import { useSessionViewSubscription } from "./hooks/useSessionViewSubscription.ts";
import styles from "./SessionObserverDialog.module.css";

export function SessionObserverDialog() {
  const [cancelling, setCancelling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const sessionId = useButlerStore((state) => state.observerSessionId);
  const view = useButlerStore((state) =>
    sessionId ? state.sessionViews[sessionId] : undefined,
  );
  const close = useButlerStore((state) => state.closeSessionObserver);
  const refresh = useButlerStore((state) => state.refreshSessionObserver);
  const cancelObservedSteward = useButlerStore((state) => state.cancelObservedSteward);
  const resumeObservedSteward = useButlerStore((state) => state.resumeObservedSteward);

  useSessionViewSubscription(sessionId, refresh);

  const title = view?.relation?.safe_title ?? sessionId ?? "";
  return (
    <Dialog
      open={Boolean(sessionId)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        aria-describedby="steward-observer-description"
        className={styles.dialog}
        data-test-class="steward-observer-dialog"
        glassRadius="composer"
      >
        <DialogHeader
          className={styles.header}
          data-test-class="steward-observer-header"
        >
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription id="steward-observer-description">
            {appCopy.inspector.tabs.activity}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea fill dataTestClass="steward-observer-transcript">
          <Stack as="section" aria-label={appCopy.inspector.tabs.activity} gap="lg">
            <SessionObserverTimeline
              messages={view?.messages ?? []}
              workers={view?.workers ?? []}
            />
            {view?.active_turn ? (
              <MessageRow
                role="assistant"
                activity
                dataTestClass="steward-observer-activity"
              >
                <TurnActivityPanel
                  rows={view.active_turn.progress.safe_progress_rows}
                  state={view.active_turn.state}
                  startedAt={view.active_turn.created_at}
                  turnId={view.active_turn.id}
                />
              </MessageRow>
            ) : null}
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
              <Typo.Caption>{appCopy.conversation.work.pendingLabel}</Typo.Caption>
            ) : null}
          </Stack>
        </ScrollArea>
        {view?.latest_turn?.retryable && !view.active_turn && view.relation ? (
          <Stack className={styles.actions} align="row" justify="end">
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
          </Stack>
        ) : (view?.active_turn || view?.waiting_for_children) && view.relation ? (
          <Stack className={styles.actions} align="row" justify="end">
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
          </Stack>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
