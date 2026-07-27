import { memo, useState } from "react";
import {
  Button,
  ListChecks,
  RollingSwap,
  Stack,
  WorkActivityBlock,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { WorkBlockView } from "@/app/types.ts";
import { WorkDecisionBody } from "./WorkDecisionBody";
import {
  isTerminalActivityState,
  workActivityToolsForBlock,
} from "./toolchainUtils";

function CollapsedTurnActivityComponent({
  blocks,
  live = false,
  turnId,
}: {
  blocks: WorkBlockView[];
  live?: boolean;
  turnId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const workCopy = appCopy.conversation.work;
  const latest = blocks.at(-1);
  if (!latest) return null;
  return (
    <section
      data-test-class="turn-activity-collapsed turn-work-collapsed"
      aria-label={workCopy.historyRegionLabel}
    >
      <Stack gap="md" aria-live="polite">
        {expanded ? blocks.map((block) => (
          <ActivityBlock block={block} key={block.id} turnId={turnId} />
        )) : (
          <RollingSwap itemKey={latest.id} motion={live}>
            <ActivityBlock block={latest} turnId={turnId} />
          </RollingSwap>
        )}
        {blocks.length > 1 ? (
          <Stack as="footer" cross="start">
            <Button
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? workCopy.collapseHistoryLabel(latest.label, blocks.length)
                  : workCopy.expandHistoryLabel(latest.label, blocks.length)
              }
              data-test-class="toggle-turn-activity-history"
              iconStart={<ListChecks size={14} />}
              onClick={() => setExpanded((value) => !value)}
              size="xs"
              text={
                expanded
                  ? workCopy.collapseLabel
                  : workCopy.viewAllLabel(blocks.length)
              }
              type="button"
              variant="borderless"
            />
          </Stack>
        ) : null}
      </Stack>
    </section>
  );
}

function ActivityBlock({
  block,
  turnId,
}: {
  block: WorkBlockView;
  turnId?: string;
}) {
  return (
    <WorkActivityBlock
      data-work-block-id={block.id}
      running={!isTerminalActivityState(block.state)}
      title={block.label}
      description={<WorkDecisionBody block={block} />}
      tools={workActivityToolsForBlock(block, turnId)}
    />
  );
}

export const CollapsedTurnActivity = memo(CollapsedTurnActivityComponent);
CollapsedTurnActivity.displayName = "CollapsedTurnActivity";
