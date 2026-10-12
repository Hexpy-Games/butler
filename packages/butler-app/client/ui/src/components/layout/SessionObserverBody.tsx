import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { SessionView, SessionViewStatus } from "@/app/types.ts";
import { MessageRow, Stack, Typo } from "@/butler-ds";
import { TurnActivityPending } from "@/components/conversation/TurnActivityPending.tsx";
import { SessionObserverTimeline } from "./SessionObserverTimeline.tsx";

/**
 * One sub-session's messages and activity rows. The observer dialog and a
 * work block's inline details render this same list.
 */
export function SessionObserverBody({ view, inline = false }: {
  view?: SessionView;
  /**
   * A work block's inline details: every activity open (the block is itself
   * a disclosure) and no sub-session replies (the parent reply restates them).
   */
  inline?: boolean;
}) {
  useAppLocale();
  return (
    <Stack as="section" aria-label={appCopy.inspector.tabs.activity} gap="lg">
      <SessionObserverTimeline
        delegatedGoal={view?.relation?.safe_title}
        expandActivities={inline}
        showReplies={!inline}
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
