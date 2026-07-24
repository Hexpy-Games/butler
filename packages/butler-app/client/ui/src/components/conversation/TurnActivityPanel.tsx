import {
  typedUiReadModelsFromProgressRows,
  workBlocksFromProgressRows,
  type TypedUiReadModel,
} from "@/app/utils.ts";
import type { ProgressRow } from "@/app/types.ts";
import { CurrentModelRoundWaiting, CurrentPhaseActivity }
  from "./PhaseActivityLog";
import { TurnActivityTimeline } from "./TurnActivityTimeline";
import { WorkDecisionBody } from "./WorkDecisionBody";
import { TurnDecisionRow } from "./TurnDecisionRow";
import { currentModelRoundWait, currentSemanticState, latestPublicActivity,
  phaseActivityRows } from "./turnActivityRows";
import {
  toolchainRowsForBlock,
  isTerminalActivityState,
  workActivityToolsForBlock,
} from "./toolchainUtils";
import { Stack, WorkActivityBlock } from "@/butler-ds";
import { TurnActivityPending } from "./TurnActivityPending";
import { appCopy } from "@/app/copy.ts";

export function TurnActivityPanel({
  rows,
  state,
}: {
  rows: ProgressRow[];
  state?: string;
}) {
  const readModels = typedUiReadModelsFromProgressRows(rows);
  const decisions = readModels.filter(isDecisionReadModel);
  const activeBlocks = workBlocksFromProgressRows(rows).filter(
    (block) =>
      !isTerminalActivityState(block.state) ||
      toolchainRowsForBlock(block).length > 0,
  );
  const phaseActivities = phaseActivityRows(rows);
  const publicActivity = latestPublicActivity(rows, phaseActivities.length > 0);
  const semanticState = currentSemanticState(rows, phaseActivities);
  const modelRoundWait = currentModelRoundWait(rows);
  if (
    decisions.length === 0 &&
    activeBlocks.length === 0 &&
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
      {decisions.map((decision, decisionIndex) => (
        <TurnDecisionRow
          decision={decision}
          key={`${decision.summary}:${decisionIndex}`}
        />
      ))}
      <TurnActivityTimeline
        activities={phaseActivities}
        currentState={semanticState}
        live
      />
      {modelRoundWait ? <CurrentModelRoundWaiting row={modelRoundWait} /> : null}
      {publicActivity ? <CurrentPhaseActivity row={publicActivity} /> : null}
      {activeBlocks.map((block, blockIndex) => (
        <WorkActivityBlock
          className="turn-activity-item"
          data-work-block-id={block.id}
          key={`${block.id}:${blockIndex}`}
          running={!isTerminalActivityState(block.state)}
          title={block.label}
          description={<WorkDecisionBody block={block} />}
          tools={workActivityToolsForBlock(block)}
          aria-label={appCopy.conversation.work.toolchainRegionLabel(
            block.label,
          )}
        />
      ))}
    </Stack>
  );
}

function isDecisionReadModel(
  model: TypedUiReadModel,
): model is Extract<TypedUiReadModel, { type: "decision" }> {
  return model.type === "decision";
}
