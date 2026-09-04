import type { SessionSummaryView } from "@/app/types.ts";
import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import { isClientTurnId } from "@/app/utils.ts";
import { AuthorityApprovalStack } from "./AuthorityApprovalStack";
import { GitDependencyNotice } from "./GitDependencyNotice";
import { StewardComposerCapsules } from "./StewardComposerCapsules.tsx";
import { ComposerPlanDecisionNotice } from "./ComposerPlanDecisionNotice";
import type { ComposerPlanDecision } from "./useComposerPlanDecision";

export function ComposerNotices({
  planDecision,
  summary,
}: {
  planDecision?: ComposerPlanDecision;
  summary?: SessionSummaryView | null;
}) {
  const parentTurnId = summary?.latest_progress?.turn_id;
  const pendingClientTurn = isClientTurnId(parentTurnId);
  return (
    <>
      {planDecision ? <ComposerPlanDecisionNotice decision={planDecision} /> : null}
      <AuthorityApprovalStack />
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
