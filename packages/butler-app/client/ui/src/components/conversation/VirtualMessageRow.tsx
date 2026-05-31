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
import { MessageAvatar } from "./MessageAvatar";

interface VirtualMessageRowProps {
  message: MessageRecord;
  virtualRow: VirtualItem;
  topOffset: number;
  isLatestAssistant: boolean;
  markTheme: "dark" | "light";
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
  onCopyContextMenuText: (message: MessageRecord) => void;
  children: ReactNode;
}

export function VirtualMessageRow({
  message,
  virtualRow,
  topOffset,
  isLatestAssistant,
  markTheme,
  rowVirtualizer,
  onCopyContextMenuText,
  children,
}: VirtualMessageRowProps) {
  const isCompactionEvent =
    message.role === "system_event" &&
    /^Context automatically compact/iu.test(message.text);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <MessageRow
          role={message.role}
          tone={messageTone(message)}
          compactionEvent={isCompactionEvent}
          avatar={
            <MessageAvatar
              role={message.role}
              isCompactionEvent={isCompactionEvent}
              isLatestAssistant={isLatestAssistant}
              markTheme={markTheme}
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
        <ContextMenuItem onSelect={() => onCopyContextMenuText(message)}>
          <Copy size={14} />
          <span>{appCopy.common.copy}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function messageTone(message: MessageRecord) {
  if (message.status === "failed") return "failed";
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
    message.status === "failed" ? "failed" : "",
    message.status === "pending" ? "pending" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
