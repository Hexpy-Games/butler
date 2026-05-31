import { ButlerThinkingMark } from "@/components/common/ButlerThinkingMark.tsx";
import type { ProgressRow } from "@/app/types.ts";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { TurnActivityPanel } from "./TurnActivityPanel";
import { MessageAvatarBlock, MessageRow } from "@/butler-ds";

interface TurnActivityMessageProps {
  progressRows: ProgressRow[];
  turnState?: string;
  markTheme: "dark" | "light";
  virtualRow: VirtualItem;
  topOffset: number;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
}

export function TurnActivityMessage({
  progressRows,
  turnState,
  markTheme,
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
      avatar={
        <MessageAvatarBlock
          role="assistant"
          active
          data-test-class="assistant-mark-active"
          aria-hidden="true"
        >
          <ButlerThinkingMark state="working" theme={markTheme} />
        </MessageAvatarBlock>
      }
    >
      <TurnActivityPanel rows={progressRows} state={turnState} />
    </MessageRow>
  );
}
