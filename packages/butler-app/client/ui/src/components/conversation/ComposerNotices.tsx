import type { SessionSummaryView } from "@/app/types.ts";
import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import { isClientTurnId } from "@/app/utils.ts";
import { GitDependencyNotice } from "./GitDependencyNotice";
import { StewardComposerCapsules } from "./StewardComposerCapsules.tsx";

export function ComposerNotices({
  summary,
}: {
  summary?: SessionSummaryView | null;
}) {
  const parentTurnId = summary?.latest_progress?.turn_id;
  const pendingClientTurn = isClientTurnId(parentTurnId);
  return (
    <>
      <StewardComposerCapsules
        children={summary?.steward_children ?? []}
        synthesis={!pendingClientTurn && summary?.turn_state && ACTIVE_TURN_STATES.has(summary.turn_state)
          ? summary.latest_turn_subsession_result
          : undefined}
      />
      <GitDependencyNotice />
    </>
  );
}
