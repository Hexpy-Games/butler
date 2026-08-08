import { projectTurnActivity } from "@/app/conversation-progress";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentTurnStatus } from "./CurrentTurnStatus";
import { TurnActivityTimeline } from "./TurnActivityTimeline";
import { TurnDecisionRow } from "./TurnDecisionRow";
import { Stack } from "@/butler-ds";
import { TurnActivityPending } from "./TurnActivityPending";
import { appCopy } from "@/app/copy.ts";
import { CollapsedTurnActivity } from "./WorkBlocks";

export function TurnActivityPanel({
  rows,
  state,
  turnId,
}: {
  rows: ProgressRow[];
  state?: string;
  turnId?: string;
}) {
  const {
    decisions,
    modelRoundWait,
    operation,
    phaseActivities,
    publicActivity,
    readModels,
    semanticState,
    workBlocks,
  } = projectTurnActivity(rows, turnId);
  const showDecision = decisions.length > 0 &&
    !publicActivity &&
    !modelRoundWait &&
    !operation;
  if (
    decisions.length === 0 &&
    workBlocks.length === 0 &&
    phaseActivities.length === 0 &&
    !publicActivity &&
    !modelRoundWait &&
    !operation
  ) {
    return <TurnActivityPending readModels={readModels} state={state} />;
  }

  return (
    <Stack
      as="section"
      gap="md"
      data-test-class="turn-activity-panel turn-work-panel turn-decision-work-panel"
      aria-label={appCopy.conversation.work.historyRegionLabel}
    >
      {phaseActivities.length > 0 ? (
        <TurnActivityTimeline
          activities={phaseActivities}
          currentState={semanticState}
          live
          turnId={turnId}
        />
      ) : workBlocks.length > 0 ? (
        <CollapsedTurnActivity blocks={workBlocks} live turnId={turnId} />
      ) : showDecision ? (
        <TurnDecisionRow decision={decisions.at(-1)!} />
      ) : null}
      <CurrentTurnStatus
        modelRoundWait={modelRoundWait}
        operation={operation}
        publicActivity={publicActivity}
      />
    </Stack>
  );
}
