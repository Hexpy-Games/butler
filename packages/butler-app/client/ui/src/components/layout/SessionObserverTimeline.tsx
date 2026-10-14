import { Fragment, type ReactNode } from "react";
import type { MessageRecord, SessionView } from "@/app/types.ts";
import { MessageRow, MessageTurnGroup } from "@/butler-ds";
import { MessageContent } from "@/components/conversation/MessageContent.tsx";
import { projectTurnActivity } from "@/app/conversation-progress";
import { SessionObserverActivityGroup, type ObserverPhaseActivity } from "./SessionObserverActivityGroup.tsx";
import { observerActivitySources } from "./observerActivitySources.ts";

export function SessionObserverTimeline({
  messages,
  activityHistory = [],
  activeTurn,
  latestTurn,
  children,
  delegatedGoal,
  expandActivities,
  showReplies = true,
}: {
  messages: MessageRecord[];
  /** List every activity open, for a view that is itself a disclosure (the inline work block). */
  expandActivities?: boolean;
  /** Render the sub-session's own replies; off where the parent reply restates them (inline work block). */
  showReplies?: boolean;
  delegatedGoal?: string;
  activityHistory?: SessionView["activity_history"];
  activeTurn?: SessionView["active_turn"];
  latestTurn?: SessionView["latest_turn"];
  children?: ReactNode;
}) {
  const sources = observerActivitySources(messages, activityHistory, activeTurn, latestTurn);
  const ordered = [
    ...[...sources.values()].flatMap((source) =>
      projectTurnActivity(source.rows, source.turn_id).phaseActivities.map((activity) => ({
        kind: "activity" as const, created_at: activity.createdAt ?? source.created_at,
        activity: { ...activity, turnId: source.turn_id },
      }))),
    // Replies still feed activity sources above; only their own rows are hidden.
    ...messages.filter((message) => showReplies || message.role !== "assistant").map((message) => ({ kind: "message" as const,
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
      const source = sources.get(entry.message.turn_id ?? "");
      const activity = source ? projectTurnActivity(source.rows, source.turn_id) : undefined;
      entries.push({ kind: "message", id: entry.message.id,
        message: { ...entry.message, turn_activity_rows: undefined,
          text: entry.message.delivered_text ?? entry.message.text,
          work_blocks: activity
            ? activity.phaseActivities.length ? undefined : activity.workBlocks
            : entry.message.work_blocks } });
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

  const firstActivityId = entries.find((entry) => entry.kind === "activity")?.id;
  return (
    <MessageTurnGroup>
      {entries.map((entry) => (
        <Fragment key={entry.id}>
          <MessageRow
            role={entry.kind === "message" && entry.message.role === "user" ? "user" : "assistant"}
            dataTestClass="steward-observer-message"
          >
            {entry.kind === "message"
              ? <MessageContent message={entry.message} copied={false} footerMeta={null} />
              : <SessionObserverActivityGroup delegatedGoal={entry.id === firstActivityId ? delegatedGoal : undefined} activities={entry.activities} active={entry.active} expandAll={expandActivities}
                  state={entry.activities.some((activity) => activity.turnId === latestTurn?.id) ? latestTurn?.state : undefined} />}
          </MessageRow>
        </Fragment>
      ))}
      {children}
    </MessageTurnGroup>
  );
}
