import { useAppLocale } from "@/app/copy.ts";
import { memo, useState } from "react";
import {
  Button,
  ChevronDown,
  ChevronRight,
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
  useAppLocale();
  const [expanded, setExpanded] = useState(false);
  const workCopy = appCopy.conversation.work;
  const latest = blocks.at(-1);
  if (!latest) return null;
  const headerLabel = appCopy.interfaceTemplates.activityHistory(live, latest.label, blocks.length);
  return (
    <section
      data-test-class="turn-activity-collapsed turn-work-collapsed"
      aria-label={workCopy.historyRegionLabel}
    >
      <Stack gap="md" aria-live="polite">
        <Stack cross="start">
          <Button
            aria-expanded={expanded}
            data-test-class="toggle-turn-activity-disclosure"
            iconEnd={expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            onClick={() => setExpanded((value) => !value)}
            text={headerLabel}
            type="button"
            variant="inline"
          />
        </Stack>
        <Stack gap="md">
          {expanded ? blocks.map((block) => (
            <ActivityBlock block={block} key={block.id} turnId={turnId} />
          )) : live ? (
            <RollingSwap itemKey={latest.id} motion={live}>
              <ActivityBlock block={latest} turnId={turnId} />
            </RollingSwap>
          ) : null}
          {expanded ? (
            <Stack as="footer" cross="start">
              <Button
                aria-label={workCopy.collapseHistoryLabel(latest.label, blocks.length)}
                data-test-class="collapse-turn-activity-history"
                iconStart={<ListChecks size={14} />}
                onClick={() => setExpanded(false)}
                size="xs"
                text={workCopy.collapseLabel}
                type="button"
                variant="borderless"
              />
            </Stack>
          ) : null}
        </Stack>
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
  useAppLocale();
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
