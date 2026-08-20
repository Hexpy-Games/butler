import {
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
import { MessageContent } from "@/components/conversation/MessageContent.tsx";
import { TurnActivityPanel } from "@/components/conversation/TurnActivityPanel.tsx";
import { useSessionViewSubscription } from "./hooks/useSessionViewSubscription.ts";

export function SessionObserverDialog() {
  const sessionId = useButlerStore((state) => state.observerSessionId);
  const view = useButlerStore((state) =>
    sessionId ? state.sessionViews[sessionId] : undefined,
  );
  const close = useButlerStore((state) => state.closeSessionObserver);
  const refresh = useButlerStore((state) => state.refreshSessionObserver);

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
        data-test-class="steward-observer-dialog"
        glassRadius="composer"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription id="steward-observer-description">
            {appCopy.inspector.tabs.activity}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea fill dataTestClass="steward-observer-transcript">
          <Stack as="section" aria-label={appCopy.inspector.tabs.activity} gap="lg">
            {view?.messages.map((message) => (
              <MessageRow
                key={message.id}
                role={message.role === "user" ? "user" : "assistant"}
                data-test-class="steward-observer-message"
              >
                <MessageContent
                  message={message}
                  copied={false}
                  footerMeta={null}
                />
              </MessageRow>
            ))}
            {view?.active_turn ? (
              <MessageRow
                role="assistant"
                activity
                data-test-class="steward-observer-activity"
              >
                <TurnActivityPanel
                  rows={view.active_turn.progress.safe_progress_rows}
                  state={view.active_turn.state}
                  startedAt={view.active_turn.created_at}
                  turnId={view.active_turn.id}
                />
              </MessageRow>
            ) : null}
            {!view?.messages.length && !view?.active_turn ? (
              <Typo.Caption>{appCopy.conversation.work.pendingLabel}</Typo.Caption>
            ) : null}
          </Stack>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
