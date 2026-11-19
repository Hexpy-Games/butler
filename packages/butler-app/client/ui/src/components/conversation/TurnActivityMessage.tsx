import type { ProgressRow } from "@/app/types.ts";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { TurnActivityPanel } from "./TurnActivityPanel";
import { MessageRow } from "@/butler-ds";
import { CurrentTurnStatus } from "./CurrentTurnStatus";
import { useStewardCardState } from "./StewardParentProgress";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection";

interface TurnActivityMessageProps {
  progressRows: ProgressRow[];
  turnState?: string;
  startedAt?: string;
  turnId?: string;
  virtualRow: VirtualItem;
  topOffset: number;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  chat?: boolean;
  delegated?: AnchoredStewardProgress;
}

export function TurnActivityMessage({
  progressRows,
  turnState,
  startedAt,
  turnId,
  virtualRow,
  topOffset,
  rowVirtualizer,
  chat,
  delegated,
}: TurnActivityMessageProps) {
  return (
    <MessageRow
      role="assistant"
      activity
      dataTestClass={delegated ? "message assistant turn-activity-message delegated-turn-status" : "message assistant turn-activity-message"}
      index={virtualRow.index}
      key="active-turn-activity"
      rowRef={rowVirtualizer.measureElement}
      offsetY={virtualRow.start + topOffset}
    >
      {delegated ? <DelegatedTurnStatus progress={delegated} /> : <TurnActivityPanel
        rows={progressRows}
        state={turnState}
        startedAt={startedAt}
        turnId={turnId}
        chat={chat}
      />}
    </MessageRow>
  );
}

/** While this chat's delegated Steward works and the chat has no turn of its own: the same status line, with the work card's latest line and the time since delegation. */
function DelegatedTurnStatus({ progress }: { progress: AnchoredStewardProgress }) {
  const { latestStatus } = useStewardCardState(progress);
  return <CurrentTurnStatus activityLabel={latestStatus} startedAt={progress.child.relation.created_at} />;
}
