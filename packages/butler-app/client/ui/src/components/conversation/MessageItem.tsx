import { memo } from "react";
import { areMessageItemPropsEqual } from "./messageItemMemo";
import { MessageContent } from "./MessageContent";
import type { MessageItemProps } from "./messageItemTypes";
import { VirtualMessageRow } from "./VirtualMessageRow";

function MessageItemComponent({
  message,
  virtualRow,
  topOffset,
  copied,
  footerMeta,
  onCopyAssistantMessage,
  onCopyContextMenuText,
  rowVirtualizer,
  stewardProgress,
}: MessageItemProps) {
  return (
    <VirtualMessageRow
      message={message}
      virtualRow={virtualRow}
      topOffset={topOffset}
      rowVirtualizer={rowVirtualizer}
      onCopyContextMenuText={onCopyContextMenuText}
    >
      <MessageContent
        message={message}
        copied={copied}
        footerMeta={footerMeta}
        onCopyAssistantMessage={onCopyAssistantMessage}
        stewardProgress={stewardProgress}
      />
    </VirtualMessageRow>
  );
}

export const MessageItem = memo(MessageItemComponent, areMessageItemPropsEqual);
