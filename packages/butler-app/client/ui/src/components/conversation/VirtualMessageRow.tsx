import { useAppLocale } from "@/app/copy.ts";
import type { ReactNode } from "react";
import type { VirtualItem, Virtualizer } from "@tanstack/react-virtual";
import { Copy } from "@/butler-ds";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/butler-ds";
import { MessageRow } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { MessageRecord } from "@/app/types.ts";
import { isAssistantFailureNoticeMessage } from "@/app/utils.ts";
import { MessageAvatar } from "./MessageAvatar";
import { UserMessageFooter } from "./UserMessageFooter";
import { isCompactionMessage, visibleSystemMessageText } from "@/app/system-event-message.ts";

interface VirtualMessageRowProps {
  message: MessageRecord;
  virtualRow: VirtualItem;
  topOffset: number;
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  onCopyContextMenuText: (message: MessageRecord) => void;
  children: ReactNode;
}

export function VirtualMessageRow({
  message,
  virtualRow,
  topOffset,
  rowVirtualizer,
  onCopyContextMenuText,
  children,
}: VirtualMessageRowProps) {
  useAppLocale();
  const isCompactionEvent = isCompactionMessage(message);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <MessageRow
          role={message.role}
          tone={messageTone(message)}
          footer={message.role === "user" ? <UserMessageFooter message={message} /> : undefined}
          compactionEvent={isCompactionEvent}
          avatar={
            <MessageAvatar
              role={message.role}
              isCompactionEvent={isCompactionEvent}
            />
          }
          dataTestClass={messageTestClassName(message, isCompactionEvent)}
          index={virtualRow.index}
          rowRef={rowVirtualizer.measureElement}
          style={{ transform: `translateY(${virtualRow.start + topOffset}px)` }}
        >
          {children}
        </MessageRow>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onCopyContextMenuText({ ...message, text: visibleSystemMessageText(message) })}>
          <Copy size={14} />
          <span>{appCopy.common.copy}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function messageTone(message: MessageRecord) {
  if (isAssistantFailureNoticeMessage(message)) return "failed";
  if (message.status === "pending") return "pending";
  return "complete";
}

function messageTestClassName(
  message: MessageRecord,
  isCompactionEvent: boolean,
) {
  return [
    "message",
    message.role,
    isCompactionEvent ? "compaction-event" : "",
    isAssistantFailureNoticeMessage(message) ? "failed" : "",
    message.status === "pending" ? "pending" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
