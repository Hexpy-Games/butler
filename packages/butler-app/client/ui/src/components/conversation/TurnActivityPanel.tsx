import {
  typedUiReadModelsFromProgressRows,
  workBlocksFromProgressRows,
  type TypedUiReadModel,
} from "@/app/utils.ts";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentTurnStatus } from "./CurrentTurnStatus";
import { TurnActivityTimeline } from "./TurnActivityTimeline";
import { TurnDecisionRow } from "./TurnDecisionRow";
import { currentModelRoundWait, currentSemanticState, latestPublicActivity,
  currentOperationActivity, phaseActivityRows } from "./turnActivityRows";
import { Stack } from "@/butler-ds";
import { TurnActivityPending } from "./TurnActivityPending";
import { appCopy } from "@/app/copy.ts";
import { CollapsedTurnActivity } from "./WorkBlocks";
import { WorkProgressPanel } from "./WorkProgressPanel";

export function TurnActivityPanel({
  rows,
  state,
  turnId,
}: {
  rows: ProgressRow[];
  state?: string;
  turnId?: string;
}) {
  const readModels = typedUiReadModelsFromProgressRows(rows);
  const todoRows = rows.filter((row) => row.kind === "todo");
  const activityRows = rows.filter((row) => row.kind !== "todo");
  const decisions = readModels.filter(isDecisionReadModel);
  const workBlocks = workBlocksFromProgressRows(activityRows);
  const phaseActivities = phaseActivityRows(activityRows);
  const publicActivity = latestPublicActivity(activityRows, phaseActivities.length > 0);
  const semanticState = currentSemanticState(activityRows, phaseActivities);
  const modelRoundWait = currentModelRoundWait(activityRows);
  const operation = currentOperationActivity(activityRows);
  if (
    decisions.length === 0 &&
    workBlocks.length === 0 &&
    phaseActivities.length === 0 &&
    !publicActivity &&
    !modelRoundWait &&
    !operation &&
    todoRows.length === 0
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
      <WorkProgressPanel rows={todoRows} turnState={state} />
      {phaseActivities.length > 0 ? (
        <TurnActivityTimeline
          activities={phaseActivities}
          currentState={semanticState}
          live
          turnId={turnId}
        />
      ) : workBlocks.length > 0 ? (
        <CollapsedTurnActivity blocks={workBlocks} live turnId={turnId} />
      ) : publicActivity || modelRoundWait || operation ? (
        <CurrentTurnStatus
          modelRoundWait={modelRoundWait}
          operation={operation}
          publicActivity={publicActivity}
        />
      ) : decisions.length > 0 ? (
        <TurnDecisionRow decision={decisions.at(-1)!} />
      ) : null}
      {workBlocks.length > 0 || phaseActivities.length > 0 ? (
        <CurrentTurnStatus
          modelRoundWait={modelRoundWait}
          operation={operation}
          publicActivity={publicActivity}
        />
      ) : null}
    </Stack>
  );
}

function isDecisionReadModel(
  model: TypedUiReadModel,
): model is Extract<TypedUiReadModel, { type: "decision" }> {
  return model.type === "decision";
}
