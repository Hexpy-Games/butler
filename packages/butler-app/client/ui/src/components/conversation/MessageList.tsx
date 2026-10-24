import { useConversationRequest } from "./ConversationRequestContext.tsx";
import { MessageRow } from "@/butler-ds";
import { memo, useMemo } from "react";
import { useAnswerDrafts, draftTurns, withDraftMessages } from "@/app/answerDrafts";
import { SessionBranchSeed } from "./SessionBranchSeed";
import type { MessageRecord, TurnProgressSnapshot } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { MessageItem } from "./MessageItem";
import { TurnActivityMessage } from "./TurnActivityMessage";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { useMessageList } from "./hooks/useMessageList";
import { useMessageListLayout } from "./hooks/useMessageListLayout";
import { type ConversationColumnRect, ConversationScroll, MessageListSurface } from "@/butler-ds";
import { useEnteringMessageIds } from "./hooks/useEnteringMessageIds";
import { QueuedMessageItem } from "./QueuedMessageItem";
import { useQueuedConversation } from "./hooks/useQueuedConversation";

interface MessageListProps {
  onColumnRect?: (rect: ConversationColumnRect) => void;
  messages: MessageRecord[];
  turnProgress: Record<string, TurnProgressSnapshot>;
  bottomReserve: number;
  isSending: boolean;
}

function MessageListComponent({ messages, turnProgress, bottomReserve, isSending, onColumnRect }: MessageListProps) {
  const activeChatId = useButlerStore((state) => state.activeChatId);
  const summary = useButlerStore((state) => state.summary);
  const turns = useAnswerDrafts(state => draftTurns(state, activeChatId));
  const displayMessages = useMemo(() => withDraftMessages(messages, turns, activeChatId), [messages, turns, activeChatId]);
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
  } = useMessageList(displayMessages, summary, turnProgress, isSending);

  const liveActivity = useMemo(() => ({ rows: progressRows, state: turnState, startedAt: turnStartedAt, turnId }),
    [progressRows, turnState, turnStartedAt, turnId]);
  const enteringIds = useEnteringMessageIds(visibleMessages, activeChatId);
  const queue = useQueuedConversation(visibleMessages, activeChatId);
  const request = useConversationRequest();
  const anchored = request?.active && visibleMessages.some(message => message.id === request.sourceMessageId);
  const requestIndex = messageItemCount + queue.items.length;
  const itemCount = requestIndex + (request?.active && !anchored ? 1 : 0);
  const { parentRef, seedRef, rowVirtualizer, topOffset, virtualListHeight, scrollState } = useMessageListLayout({
    visibleMessages, showTurnActivity, itemCount, bottomReserve, activeChatId, isSending,
    queuedKeys: queue.keys, branchSeed: summary?.branch_seed,
  });

  return (
    <>
      <ConversationScroll virtualized scrollRef={parentRef}>
        <MessageListSurface height={virtualListHeight} onColumnRect={onColumnRect}>
          {summary?.branch_seed && <div ref={seedRef}><SessionBranchSeed /></div>}
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            if (request?.active && !anchored && virtualRow.index === requestIndex) return <MessageRow key="pending-request" role="assistant"
              index={virtualRow.index} rowRef={rowVirtualizer.measureElement} offsetY={virtualRow.start + topOffset}>
              <div ref={request.setTarget} data-test-class="conversation-request" />
            </MessageRow>;
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
                key={message.role === "assistant" && message.turn_id ? `answer-${message.turn_id}:${virtualRow.index}` : message.id ?? `${message.role}-${message.text}`}
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
                liveActivity={message.id === liveMessageId ? liveActivity : undefined}
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
    previous.isSending === next.isSending &&
    previous.onColumnRect === next.onColumnRect,
);
MessageList.displayName = "MessageList";
