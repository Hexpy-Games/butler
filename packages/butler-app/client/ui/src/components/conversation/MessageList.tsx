import { memo } from "react";
import { SessionBranchSeed } from "./SessionBranchSeed";
import type { MessageRecord, TurnProgressSnapshot } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { MessageItem } from "./MessageItem";
import { TurnActivityPanel } from "./TurnActivityPanel";
import { TurnActivityMessage } from "./TurnActivityMessage";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { useMessageList } from "./hooks/useMessageList";
import { useMessageListLayout } from "./hooks/useMessageListLayout";
import { ConversationScroll, MessageListSurface } from "@/butler-ds";
import { useEnteringMessageIds } from "./hooks/useEnteringMessageIds";
import { QueuedMessageItem } from "./QueuedMessageItem";
import { useQueuedConversation } from "./hooks/useQueuedConversation";

interface MessageListProps {
  messages: MessageRecord[];
  turnProgress: Record<string, TurnProgressSnapshot>;
  bottomReserve: number;
  isSending: boolean;
}

function MessageListComponent({ messages, turnProgress, bottomReserve, isSending }: MessageListProps) {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const summary = useButlerStore((state) => state.summary);
  const {
    visibleMessages,
    progressRows,
    turnState,
    turnStartedAt, turnId,
    liveMessageId, showTurnActivity, itemCount: messageItemCount,
    copiedMessageId,
    copyAssistantMessage,
    copyContextMenuText,
    assistantFooterMetaById,
    anchoredStewardProgress,
  } = useMessageList(messages, summary, turnProgress, isSending);

  const enteringIds = useEnteringMessageIds(visibleMessages, activeChatId);
  const queue = useQueuedConversation(visibleMessages, activeChatId);
  const itemCount = messageItemCount + queue.items.length;
  const { parentRef, seedRef, rowVirtualizer, topOffset, virtualListHeight, scrollState } = useMessageListLayout({
    visibleMessages, showTurnActivity, itemCount, bottomReserve, activeChatId, isSending,
    queuedKeys: queue.keys, branchSeed: summary?.branch_seed,
  });

  return (
    <>
      <ConversationScroll virtualized scrollRef={parentRef}>
        <MessageListSurface height={virtualListHeight}>
          {summary?.branch_seed && <div ref={seedRef}><SessionBranchSeed /></div>}
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const queued = queue.items[virtualRow.index - messageItemCount];
            if (queued) return <QueuedMessageItem key={`queued-${queued.key}`} item={queued} queue={queue}
              virtualRow={virtualRow} topOffset={topOffset} rowVirtualizer={rowVirtualizer} />;
            if (showTurnActivity && virtualRow.index === visibleMessages.length) {
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
                entering={enteringIds.has(message.id) && (queue.wasQueued(message.id) ? "delivered" : true)}
                footerMeta={assistantFooterMetaById.get(message.id) ?? null}
                onCopyAssistantMessage={copyAssistantMessage}
                onCopyContextMenuText={copyContextMenuText}
                rowVirtualizer={rowVirtualizer}
                stewardProgress={anchoredStewardProgress.get(message.id)}
                liveActivity={message.id === liveMessageId ? <TurnActivityPanel
                  rows={progressRows} state={turnState} startedAt={turnStartedAt} turnId={turnId} /> : undefined}
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
