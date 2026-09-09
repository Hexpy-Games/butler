import { Fragment, type ReactNode } from "react";
import type { MessageRecord, SessionView } from "@/app/types.ts";
import { MessageRow } from "@/butler-ds";
import { MessageContent } from "@/components/conversation/MessageContent.tsx";
import { projectTurnActivity } from "@/app/conversation-progress";
import { SessionObserverActivityGroup, type ObserverPhaseActivity } from "./SessionObserverActivityGroup.tsx";

export function SessionObserverTimeline({
  messages,
  activityHistory = [],
  activeTurn,
  children,
}: {
  messages: MessageRecord[];
  activityHistory?: SessionView["activity_history"];
  activeTurn?: SessionView["active_turn"];
  children?: ReactNode;
}) {
  const sources = new Map<string, { turn_id: string; created_at?: string; rows: NonNullable<MessageRecord["turn_activity_rows"]> }>(
    activityHistory.map((source) => [source.turn_id, source]),
  );
  for (const message of messages) {
    if (message.role === "assistant" && message.turn_id && message.turn_activity_rows?.length) {
      sources.set(message.turn_id, { turn_id: message.turn_id,
        created_at: message.turn_activity_rows.find((row) => row.created_at)?.created_at ?? message.created_at,
        rows: message.turn_activity_rows });
    }
  }
  if (activeTurn) sources.set(activeTurn.id, { turn_id: activeTurn.id,
    created_at: activeTurn.created_at, rows: activeTurn.progress.safe_progress_rows });
  const ordered = [
    ...[...sources.values()].flatMap((source) =>
      projectTurnActivity(source.rows, source.turn_id).phaseActivities.map((activity) => ({
        kind: "activity" as const, created_at: activity.createdAt ?? source.created_at,
        activity: { ...activity, turnId: source.turn_id },
      }))),
    ...messages.map((message) => ({ kind: "message" as const,
      created_at: message.created_at, message })),
  ].sort((left, right) =>
    left.created_at && right.created_at
      ? left.created_at.localeCompare(right.created_at)
      : 0,
  );
  const entries: Array<{ kind: "message"; id: string; message: MessageRecord } |
    { kind: "activity"; id: string; activities: ObserverPhaseActivity[]; active?: SessionView["active_turn"] }> = [];
  for (const entry of ordered) {
    if (entry.kind === "message") {
      entries.push({ kind: "message", id: entry.message.id,
        message: { ...entry.message, turn_activity_rows: undefined } });
    } else {
      const previous = entries.at(-1);
      if (previous?.kind === "activity") previous.activities.push(entry.activity);
      else entries.push({ kind: "activity", id: `activity:${entry.activity.turnId}:${entry.activity.id}`,
        activities: [entry.activity] });
    }
  }
  if (activeTurn) {
    const last = entries.at(-1);
    if (last?.kind === "activity") last.active = activeTurn;
    else entries.push({ kind: "activity", id: `active:${activeTurn.id}`, activities: [], active: activeTurn });
  }

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
              : <SessionObserverActivityGroup activities={entry.activities} active={entry.active} />}
          </MessageRow>
        </Fragment>
      ))}
      {children}
    </>
  );
}
