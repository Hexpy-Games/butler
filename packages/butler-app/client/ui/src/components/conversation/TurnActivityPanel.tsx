import {
  typedUiReadModelsFromProgressRows,
  workBlocksFromProgressRows,
  type TypedUiReadModel,
} from "@/app/utils.ts";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentModelRoundWaiting } from "./CurrentModelRoundWaiting";
import { CurrentPhaseActivity } from "./CurrentPhaseActivity";
import { TurnActivityTimeline } from "./TurnActivityTimeline";
import { TurnDecisionRow } from "./TurnDecisionRow";
import { currentModelRoundWait, currentSemanticState, latestPublicActivity,
  phaseActivityRows } from "./turnActivityRows";
import { Stack } from "@/butler-ds";
import { TurnActivityPending } from "./TurnActivityPending";
import { appCopy } from "@/app/copy.ts";
import { CollapsedTurnActivity } from "./WorkBlocks";

export function TurnActivityPanel({
  rows,
  state,
}: {
  rows: ProgressRow[];
  state?: string;
}) {
  const readModels = typedUiReadModelsFromProgressRows(rows);
  const decisions = readModels.filter(isDecisionReadModel);
  const workBlocks = workBlocksFromProgressRows(rows);
  const phaseActivities = phaseActivityRows(rows);
  const publicActivity = latestPublicActivity(rows, phaseActivities.length > 0);
  const semanticState = currentSemanticState(rows, phaseActivities);
  const modelRoundWait = currentModelRoundWait(rows);
  if (
    decisions.length === 0 &&
    workBlocks.length === 0 &&
    phaseActivities.length === 0 &&
    !publicActivity
  ) {
    return <TurnActivityPending readModels={readModels} state={state} />;
  }

  return (
    <Stack
      as="section"
      gap="md"
      data-test-class="turn-activity-panel turn-work-panel turn-decision-work-panel"
      aria-live="polite"
      aria-label={appCopy.conversation.work.historyRegionLabel}
    >
      {workBlocks.length > 0 ? (
        <CollapsedTurnActivity blocks={workBlocks} />
      ) : phaseActivities.length > 0 ? (
        <TurnActivityTimeline
          activities={phaseActivities}
          currentState={semanticState}
          live
        />
      ) : modelRoundWait ? (
        <CurrentModelRoundWaiting row={modelRoundWait} />
      ) : publicActivity ? (
        <CurrentPhaseActivity row={publicActivity} />
      ) : decisions.length > 0 ? (
        <TurnDecisionRow decision={decisions.at(-1)!} />
      ) : null}
      {modelRoundWait &&
      (workBlocks.length > 0 || phaseActivities.length > 0) ? (
        <CurrentModelRoundWaiting row={modelRoundWait} showLabel={false} />
      ) : null}
    </Stack>
  );
}

function isDecisionReadModel(
  model: TypedUiReadModel,
): model is Extract<TypedUiReadModel, { type: "decision" }> {
  return model.type === "decision";
}
