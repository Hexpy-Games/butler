import { memo, useRef, useLayoutEffect, useState } from "react";
import { SessionBranchSeed } from "./SessionBranchSeed";
import { useMessageNavigation } from "@/app/messageNavigation";
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
  const seedRef = useRef<HTMLDivElement | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const target = useMessageNavigation(state => state.target);
  useLayoutEffect(() => {
    const node = seedRef.current;
    if (!node) { setHeaderHeight(0); return; }
    const measure = () => setHeaderHeight(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [summary?.branch_seed]);

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
      headerHeight,
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
  useLayoutEffect(() => {
    if (target?.sessionId !== activeChatId) return;
    const index = visibleMessages.findIndex(message => message.id === target.messageId);
    if (index < 0) return;
    const frame = requestAnimationFrame(() => {
      scrollState.releaseBottomLock();
      const offset = rowVirtualizer.getOffsetForIndex(index, "start");
      rowVirtualizer.scrollToOffset((offset?.[0] ?? 0) + topOffset);
      useMessageNavigation.setState({ target: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [target, activeChatId, visibleMessages, rowVirtualizer, scrollState.releaseBottomLock, topOffset]);

  return (
    <>
      <ConversationScroll virtualized scrollRef={parentRef}>
        <MessageListSurface height={virtualListHeight}>
          {summary?.branch_seed && <div ref={seedRef}><SessionBranchSeed /></div>}
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
