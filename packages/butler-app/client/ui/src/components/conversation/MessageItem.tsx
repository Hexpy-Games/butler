import { memo } from "react";
import { areMessageItemPropsEqual } from "./messageItemMemo";
import { MessageContent } from "./MessageContent";
import type { MessageItemProps } from "./messageItemTypes";
import { VirtualMessageRow } from "./VirtualMessageRow";

function MessageItemComponent({
  message,
  virtualRow,
  topOffset,
  isLatestAssistant,
  markTheme,
  copied,
  footerMeta,
  onCopyAssistantMessage,
  onCopyContextMenuText,
  rowVirtualizer,
}: MessageItemProps) {
  return (
    <VirtualMessageRow
      message={message}
      virtualRow={virtualRow}
      topOffset={topOffset}
      isLatestAssistant={isLatestAssistant}
      markTheme={markTheme}
      rowVirtualizer={rowVirtualizer}
      onCopyContextMenuText={onCopyContextMenuText}
    >
      <MessageContent
        message={message}
        copied={copied}
        footerMeta={footerMeta}
        onCopyAssistantMessage={onCopyAssistantMessage}
      />
    </VirtualMessageRow>
  );
}

export const MessageItem = memo(MessageItemComponent, areMessageItemPropsEqual);
