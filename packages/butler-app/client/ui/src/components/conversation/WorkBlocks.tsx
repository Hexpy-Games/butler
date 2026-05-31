import { memo, useState } from "react";
import { DisclosureRow, ListChecks, Stack, WorkActivityBlock } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { WorkBlockView } from "@/app/types.ts";
import { WorkDecisionBody } from "./WorkDecisionBody";
import { workActivityToolsForBlock } from "./toolchainUtils";

function CollapsedTurnActivityComponent({
  blocks,
  defaultExpanded = false,
}: {
  blocks: WorkBlockView[];
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const workCopy = appCopy.conversation.work;
  const primaryLabel = blocks[0]?.label ?? workCopy.pendingLabel;
  const label = workCopy.collapsedSummary(primaryLabel, blocks.length);

  return (
    <section
      data-test-class="turn-activity-collapsed turn-work-collapsed"
      aria-label={workCopy.historyRegionLabel}
    >
      <DisclosureRow
        aria-label={
          expanded
            ? workCopy.collapseHistoryLabel(primaryLabel, blocks.length)
            : workCopy.expandHistoryLabel(primaryLabel, blocks.length)
        }
        icon={<ListChecks size={15} />}
        open={expanded}
        surface="plain"
        title={label}
        onToggle={() => setExpanded((value) => !value)}
      >
        <Stack gap="md">
          {blocks.map((block, blockIndex) => (
            <WorkActivityBlock
              data-work-block-id={block.id}
              key={`${block.id}:${blockIndex}`}
              title={block.label}
              description={<WorkDecisionBody block={block} />}
              tools={workActivityToolsForBlock(block)}
            />
          ))}
        </Stack>
      </DisclosureRow>
    </section>
  );
}

export const CollapsedTurnActivity = memo(CollapsedTurnActivityComponent);
CollapsedTurnActivity.displayName = "CollapsedTurnActivity";
