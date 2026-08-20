import { memo, useRef } from "react";
import type { MessageRecord, TurnProgressSnapshot } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { MessageItem } from "./MessageItem";
import { TurnActivityMessage } from "./TurnActivityMessage";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { useMessageList } from "./hooks/useMessageList";
import { useMessageVirtualizer } from "./hooks/useMessageVirtualizer";
import { useConversationAutoScroll } from "./hooks/useConversationAutoScroll";
import { ConversationScroll, MessageListSurface } from "@/butler-ds";

interface MessageListProps {
  messages: MessageRecord[];
  turnProgress: Record<string, TurnProgressSnapshot>;
  bottomReserve: number;
  isSending: boolean;
}

function MessageListComponent({
  messages,
  turnProgress,
  bottomReserve,
  isSending,
}: MessageListProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const summary = useButlerStore((state) => state.summary);

  const {
    visibleMessages,
    progressRows,
    turnState,
    turnStartedAt,
    turnId,
    showTurnActivity,
    itemCount,
    copiedMessageId,
    copyAssistantMessage,
    copyContextMenuText,
    assistantFooterMetaById,
    anchoredStewardProgress,
  } = useMessageList(messages, summary, turnProgress, isSending);

  const { rowVirtualizer, topOffset, virtualListHeight, latestMessageVersion } =
    useMessageVirtualizer({
      visibleMessages,
      showTurnActivity,
      itemCount,
      bottomReserve,
      scrollRef: parentRef,
    });

  const scrollState = useConversationAutoScroll({
    activeChatId,
    latestMessageVersion,
    itemCount,
    virtualListHeight,
    isSending,
    showTurnActivity,
    scrollRef: parentRef,
  });

  return (
    <>
      <ConversationScroll virtualized scrollRef={parentRef}>
        <MessageListSurface height={virtualListHeight}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            if (
              showTurnActivity &&
              virtualRow.index === visibleMessages.length
            ) {
              return (
                <TurnActivityMessage
                  key="active-turn-activity"
                  virtualRow={virtualRow}
                  topOffset={topOffset}
                  progressRows={progressRows}
                  turnState={turnState}
                  startedAt={turnStartedAt}
                  turnId={turnId}
                  rowVirtualizer={rowVirtualizer}
                />
              );
            }

            const message = visibleMessages[virtualRow.index];
            if (!message) return null;

            return (
              <MessageItem
                key={message.id ?? `${message.role}-${message.text}`}
                message={message}
                virtualRow={virtualRow}
                topOffset={topOffset}
                copied={copiedMessageId === message.id}
                footerMeta={assistantFooterMetaById.get(message.id) ?? null}
                onCopyAssistantMessage={copyAssistantMessage}
                onCopyContextMenuText={copyContextMenuText}
                rowVirtualizer={rowVirtualizer}
                stewardProgress={anchoredStewardProgress.get(message.id)}
              />
            );
          })}
        </MessageListSurface>
      </ConversationScroll>
      {scrollState.isAwayFromBottom ? (
        <ScrollToBottomButton
          hasUnreadMessages={scrollState.hasUnreadMessages}
          onScrollToBottom={() =>
            scrollState.scrollToBottom({ behavior: "smooth" })
          }
        />
      ) : null}
    </>
  );
}

export const MessageList = memo(
  MessageListComponent,
  (previous, next) =>
    previous.messages === next.messages &&
    previous.turnProgress === next.turnProgress &&
    previous.bottomReserve === next.bottomReserve &&
    previous.isSending === next.isSending,
);
MessageList.displayName = "MessageList";
