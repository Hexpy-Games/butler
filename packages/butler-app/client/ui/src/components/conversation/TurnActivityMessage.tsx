import type { ProgressRow } from "@/app/types.ts";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { TurnActivityPanel } from "./TurnActivityPanel";
import { MessageRow } from "@/butler-ds";

interface TurnActivityMessageProps {
  progressRows: ProgressRow[];
  turnState?: string;
  startedAt?: string;
  turnId?: string;
  virtualRow: VirtualItem;
  topOffset: number;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
}

export function TurnActivityMessage({
  progressRows,
  turnState,
  startedAt,
  turnId,
  virtualRow,
  topOffset,
  rowVirtualizer,
}: TurnActivityMessageProps) {
  return (
    <MessageRow
      role="assistant"
      activity
      dataTestClass="message assistant turn-activity-message"
      index={virtualRow.index}
      key="active-turn-activity"
      rowRef={rowVirtualizer.measureElement}
      style={{
        transform: `translateY(${virtualRow.start + topOffset}px)`,
      }}
    >
      <TurnActivityPanel
        rows={progressRows}
        state={turnState}
        startedAt={startedAt}
        turnId={turnId}
      />
    </MessageRow>
  );
}
