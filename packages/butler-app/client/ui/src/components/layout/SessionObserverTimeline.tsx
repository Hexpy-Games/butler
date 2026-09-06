import { Fragment, type ReactNode } from "react";
import type { MessageRecord, SessionView } from "@/app/types.ts";
import { MessageRow } from "@/butler-ds";
import { MessageContent } from "@/components/conversation/MessageContent.tsx";
import { CompletedTurnActivity } from "@/components/conversation/CompletedTurnActivity.tsx";

export function SessionObserverTimeline({
  messages,
  activityHistory = [],
  children,
}: {
  messages: MessageRecord[];
  activityHistory?: SessionView["activity_history"];
  children?: ReactNode;
}) {
  const entries = [
    ...messages.map((message) => ({ kind: "message" as const, id: message.id,
      created_at: message.created_at, message })),
    ...activityHistory.map((activity) => ({ kind: "activity" as const,
      id: `activity:${activity.turn_id}`, created_at: activity.created_at, activity })),
  ].sort((left, right) =>
    left.created_at && right.created_at
      ? left.created_at.localeCompare(right.created_at)
      : 0,
  );

  return (
    <>
      {entries.map((entry) => (
        <Fragment key={entry.id}>
          <MessageRow
            role={entry.kind === "message" && entry.message.role === "user" ? "user" : "assistant"}
            dataTestClass="steward-observer-message"
          >
            {entry.kind === "message"
              ? <MessageContent message={entry.message} copied={false} footerMeta={null} />
              : <CompletedTurnActivity rows={entry.activity.rows} turnId={entry.activity.turn_id} />}
          </MessageRow>
        </Fragment>
      ))}
      {children}
    </>
  );
}
