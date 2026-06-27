import { appCopy } from "@/app/copy.ts";
import { workBlocksFromProgressRows } from "@/app/utils.ts";
import type { ProgressRow } from "@/app/types.ts";
import { WorkDecisionBody } from "./WorkDecisionBody";
import {
  toolchainRowsForBlock,
  isTerminalActivityState,
  workActivityToolsForBlock,
} from "./toolchainUtils";
import { Skeleton, Stack, Typo, WorkActivityBlock } from "@/butler-ds";

const SESSION_STARTING_STATE = "session_starting";
const PENDING_SKELETON_WIDTH = "min(420px, 100%)";
const PENDING_SKELETON_LINE_HEIGHT = "0.75rem";
const PENDING_SKELETON_LINE_WIDTHS = ["86%", "68%", "46%"] as const;

export function TurnActivityPanel({
  rows,
  state,
}: {
  rows: ProgressRow[];
  state?: string;
}) {
  const activeBlocks = workBlocksFromProgressRows(rows).filter(
    (block) =>
      !isTerminalActivityState(block.state) ||
      toolchainRowsForBlock(block).length > 0,
  );
  if (activeBlocks.length === 0) {
    const pendingLabel = turnActivityPendingLabel(state);
    if (state === SESSION_STARTING_STATE) {
      return (
        <Stack
          gap="2"
          data-test-class="turn-activity-panel turn-activity-pending-skeleton"
          aria-live="polite"
          aria-label={pendingLabel}
          style={{ width: PENDING_SKELETON_WIDTH }}
        >
          <Typo.Body
            as="p"
            data-test-class="turn-activity-pending"
            data-turn-state={state}
            style={{
              margin: 0,
              color: "var(--text-secondary)",
              fontWeight: "var(--font-weight-regular)",
            }}
          >
            {pendingLabel}
          </Typo.Body>
          {PENDING_SKELETON_LINE_WIDTHS.map((width) => (
            <Skeleton
              key={width}
              style={{
                height: PENDING_SKELETON_LINE_HEIGHT,
                width,
              }}
            />
          ))}
        </Stack>
      );
    }
    return (
      <Typo.Body
        as="p"
        data-test-class="turn-activity-panel turn-activity-pending"
        data-turn-state={state ?? "unknown"}
        aria-live="polite"
        style={{
          margin: 0,
          color: "var(--text-secondary)",
          fontWeight: "var(--font-weight-regular)",
        }}
      >
        {pendingLabel}
      </Typo.Body>
    );
  }

  return (
    <Stack
      as="section"
      gap="md"
      data-test-class="turn-activity-panel turn-work-panel"
      aria-live="polite"
      aria-label={appCopy.conversation.work.historyRegionLabel}
    >
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

function turnActivityPendingLabel(state?: string): string {
  const normalizedState = state?.trim().toLowerCase();
  return normalizedState
    ? appCopy.conversation.work.pendingStateLabels[normalizedState] ??
        appCopy.conversation.work.pendingLabel
    : appCopy.conversation.work.pendingLabel;
}
