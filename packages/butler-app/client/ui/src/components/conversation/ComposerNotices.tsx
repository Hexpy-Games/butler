import type { SessionSummaryView } from "@/app/types.ts";
import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import { GitDependencyNotice } from "./GitDependencyNotice";
import { StewardComposerCapsules } from "./StewardComposerCapsules.tsx";

export function ComposerNotices({
  summary,
}: {
  summary?: SessionSummaryView | null;
}) {
  return (
    <>
      <StewardComposerCapsules
        children={summary?.steward_children ?? []}
        synthesis={summary?.turn_state && ACTIVE_TURN_STATES.has(summary.turn_state)
          ? summary.latest_turn_subsession_result
          : undefined}
      />
      <GitDependencyNotice />
    </>
  );
}
