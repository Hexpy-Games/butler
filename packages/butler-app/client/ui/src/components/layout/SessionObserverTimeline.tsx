import { Fragment, type ReactNode } from "react";
import type { MessageRecord, SessionView, WorkBlockView } from "@/app/types.ts";
import { MessageRow, Stack } from "@/butler-ds";
import { MessageContent } from "@/components/conversation/MessageContent.tsx";
import { CollapsedTurnActivity } from "@/components/conversation/WorkBlocks";
import { projectTurnActivity } from "@/app/conversation-progress";
import { SessionObserverActivityGroup, type ObserverPhaseActivity } from "./SessionObserverActivityGroup.tsx";

export function SessionObserverTimeline({
  messages,
  activityHistory = [],
  activeTurn,
  latestTurn,
  children,
}: {
  messages: MessageRecord[];
  activityHistory?: SessionView["activity_history"];
  activeTurn?: SessionView["active_turn"];
  latestTurn?: SessionView["latest_turn"];
  children?: ReactNode;
}) {
  const entries = observerTimelineEntries(messages, activityHistory, activeTurn, latestTurn);

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
              : entry.kind === "blocks" ? <Stack data-turn-id={entry.turnId}>
                  <CollapsedTurnActivity blocks={entry.blocks} turnId={entry.turnId}
                    live={activeTurn?.id === entry.turnId} />
                </Stack>
              : <SessionObserverActivityGroup activities={entry.activities} active={entry.active}
                  state={entry.activities.some((activity) => activity.turnId === latestTurn?.id) ? latestTurn?.state : undefined} />}
          </MessageRow>
        </Fragment>
      ))}
      {children}
    </>
  );
}

function observerTimelineEntries(
  messages: MessageRecord[],
  activityHistory: NonNullable<SessionView["activity_history"]>,
  activeTurn?: SessionView["active_turn"],
  latestTurn?: SessionView["latest_turn"],
) {
  const sources = observerActivitySources(messages, activityHistory, activeTurn, latestTurn);
  const projections = [...sources.values()].map(source => ({
    ...source, projection: projectTurnActivity(source.rows, source.turn_id),
  }));
  const projectedBlockTurns = new Set(projections.filter(source => source.projection.workBlocks.length).map(source => source.turn_id));
  const ordered = [
    ...projections.flatMap(({ projection, ...source }) => {
      return projection.phaseActivities.map((activity) => ({
        kind: "activity" as const, created_at: activity.createdAt ?? source.created_at,
        activity: { ...activity, turnId: source.turn_id },
      }));
    }),
    ...projections.flatMap((source) => {
      const blocks = source.projection.workBlocks;
      return blocks.length ? [{ kind: "blocks" as const, created_at: blocks[0].created_at ?? source.created_at,
        turnId: source.turn_id, blocks }] : [];
    }),
    ...messages.map((message) => ({ kind: "message" as const,
      created_at: message.created_at, message })),
  ].sort((left, right) =>
    left.created_at && right.created_at
      ? left.created_at.localeCompare(right.created_at)
      : 0,
  );
  const entries: Array<{ kind: "message"; id: string; message: MessageRecord } |
    { kind: "blocks"; id: string; turnId: string; blocks: WorkBlockView[] } |
    { kind: "activity"; id: string; activities: ObserverPhaseActivity[]; active?: SessionView["active_turn"] }> = [];
  for (const entry of ordered) {
    if (entry.kind === "message") {
      entries.push({ kind: "message", id: entry.message.id,
        message: { ...entry.message, turn_activity_rows: undefined,
          work_blocks: projectedBlockTurns.has(entry.message.turn_id ?? "") ? undefined : entry.message.work_blocks } });
    } else if (entry.kind === "blocks") {
      entries.push({ ...entry, id: `blocks:${entry.turnId}` });
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

  return entries;
}

function observerActivitySources(
  messages: MessageRecord[],
  activityHistory: NonNullable<SessionView["activity_history"]>,
  activeTurn?: SessionView["active_turn"],
  latestTurn?: SessionView["latest_turn"],
) {
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
  // Child session messages do not carry turn_activity_rows. The gateway keeps
  // their public record on latest_turn.progress even after active_turn clears.
  if (latestTurn && !sources.has(latestTurn.id)) sources.set(latestTurn.id, {
    turn_id: latestTurn.id, created_at: latestTurn.created_at,
    rows: latestTurn.progress?.safe_progress_rows ?? [],
  });
  if (activeTurn) sources.set(activeTurn.id, { turn_id: activeTurn.id,
    created_at: activeTurn.created_at, rows: activeTurn.progress?.safe_progress_rows ?? [] });
  return sources;
}
