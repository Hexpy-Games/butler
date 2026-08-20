import type { MessageItemProps } from "./messageItemTypes";

export function areMessageItemPropsEqual(
  previous: MessageItemProps,
  next: MessageItemProps,
): boolean {
  return previous.message === next.message &&
    previous.topOffset === next.topOffset &&
    previous.copied === next.copied &&
    previous.footerMeta === next.footerMeta &&
    previous.onCopyAssistantMessage === next.onCopyAssistantMessage &&
    previous.onCopyContextMenuText === next.onCopyContextMenuText &&
    previous.rowVirtualizer === next.rowVirtualizer &&
    previous.stewardProgress === next.stewardProgress &&
    previous.virtualRow.index === next.virtualRow.index &&
    previous.virtualRow.start === next.virtualRow.start &&
    previous.virtualRow.size === next.virtualRow.size;
}
