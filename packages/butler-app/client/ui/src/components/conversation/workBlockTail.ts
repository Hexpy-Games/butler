import { projectTurnActivity } from "@/app/conversation-progress";
import type { ProgressRow, SessionView } from "@/app/types.ts";
import { observerActivitySources } from "@/components/layout/observerActivitySources.ts";
import { activityDisplayTitle } from "./TurnActivityBlock.tsx";

/**
 * A collapsed work block's tail: the title of the activity before the latest
 * one and how many records the expanded timeline holds beyond the latest. It
 * counts the activities the expanded timeline lists (every turn of the
 * observed view), or the block's own rows before that view loads.
 */
export function workBlockTail(
  view: SessionView | undefined,
  rows: ProgressRow[],
  turnId: string | undefined,
): { previous?: string; earlier: number } {
  const activities = view
    ? [...observerActivitySources(view.messages, view.activity_history ?? [], view.active_turn, view.latest_turn).values()]
      .flatMap((source) => projectTurnActivity(source.rows, source.turn_id).phaseActivities
        .map((activity) => ({ activity, at: activity.createdAt ?? source.created_at })))
      .sort((left, right) => left.at && right.at ? left.at.localeCompare(right.at) : 0)
      .map(({ activity }) => activity)
    : projectTurnActivity(rows, turnId).phaseActivities;
  const previous = activities.at(-2);
  return { previous: previous ? activityDisplayTitle(previous) : undefined, earlier: Math.max(0, activities.length - 1) };
}
