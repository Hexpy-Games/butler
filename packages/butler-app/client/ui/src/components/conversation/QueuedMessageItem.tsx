import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { QueuedMessage } from "@/butler-ds";
import type { QueuedConversationItem } from "./queuedConversationItems";
import type { QueuedConversation } from "./hooks/useQueuedConversation";

interface QueuedMessageItemProps {
  item: QueuedConversationItem;
  virtualRow: VirtualItem;
  topOffset: number;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  queue: Pick<QueuedConversation, "entering" | "actions">;
}

export function QueuedMessageItem({
  item,
  virtualRow,
  topOffset,
  rowVirtualizer,
  queue,
}: QueuedMessageItemProps) {
  const { edit, remove } = queue.actions;
  useAppLocale();
  const copy = appCopy.composer;
  const failed = item.tone === "failed";
  return (
    <QueuedMessage
      status={queuedStatus(item)}
      tone={item.tone}
      entering={queue.entering.has(item.key)}
      ariaLabel={copy.queuedMessage}
      editLabel={failed ? copy.retryFailedMessage : copy.editQueuedMessage}
      deleteLabel={failed ? copy.deleteFailedMessage : copy.deleteQueuedMessage}
      showMoreLabel={appCopy.conversation.messageActions.showMore}
      showLessLabel={appCopy.conversation.messageActions.showLess}
      onEdit={() => edit(item)}
      onDelete={() => remove(item)}
      offsetY={virtualRow.start + topOffset}
      rowRef={rowVirtualizer.measureElement}
      index={virtualRow.index}
    >
      {queuedText(item)}
    </QueuedMessage>
  );
}

function queuedStatus(item: QueuedConversationItem): string {
  const copy = appCopy.composer;
  if (item.tone === "failed") return copy.failedMessageStatus;
  return item.total > 1 ? copy.queuedPosition(item.position, item.total) : copy.queuedMessageStatus;
}

function queuedText(item: QueuedConversationItem): string {
  const { record } = item;
  const attachments = record.attachments ?? [];
  const text = record.text || attachments[0]?.safe_name || appCopy.composer.queuedMessage;
  return record.text && attachments.length > 0
    ? `${text}\n${appCopy.composer.queuedAttachmentCount(attachments.length)}`
    : text;
}
