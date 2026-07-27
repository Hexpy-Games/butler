import { memo, useState } from "react";
import { Button, ListChecks, Stack, WorkActivityBlock } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { WorkBlockView } from "@/app/types.ts";
import { WorkDecisionBody } from "./WorkDecisionBody";
import {
  isTerminalActivityState,
  workActivityToolsForBlock,
} from "./toolchainUtils";

function CollapsedTurnActivityComponent({
  blocks,
  turnId,
}: {
  blocks: WorkBlockView[];
  turnId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const workCopy = appCopy.conversation.work;
  const latest = blocks.at(-1);
  if (!latest) return null;
  const visibleBlocks = expanded ? blocks : [latest];

  return (
    <section
      data-test-class="turn-activity-collapsed turn-work-collapsed"
      aria-label={workCopy.historyRegionLabel}
    >
      <Stack gap="md" aria-live="polite">
        {visibleBlocks.map((block, blockIndex) => (
          <WorkActivityBlock
            data-work-block-id={block.id}
            key={`${block.id}:${blockIndex}`}
            rolling={!expanded}
            running={!isTerminalActivityState(block.state)}
            title={block.label}
            description={<WorkDecisionBody block={block} />}
            tools={workActivityToolsForBlock(block, turnId)}
          />
        ))}
        {blocks.length > 1 ? (
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
        ) : null}
      </Stack>
    </section>
  );
}

export const CollapsedTurnActivity = memo(CollapsedTurnActivityComponent);
CollapsedTurnActivity.displayName = "CollapsedTurnActivity";
