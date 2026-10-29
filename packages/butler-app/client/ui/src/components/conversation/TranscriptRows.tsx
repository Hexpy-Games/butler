import { MessageRow } from "@/butler-ds";
import { isGeneralChat } from "@/app/isGeneralChat";
import { ChatsIntro } from "./ChatsIntro";
import { MessageItem } from "./MessageItem";
import { TurnActivityMessage } from "./TurnActivityMessage";
import { QueuedMessageItem } from "./QueuedMessageItem";
import type { useMessageList } from "./hooks/useMessageList";
import type { useMessageListLayout } from "./hooks/useMessageListLayout";
import type { useQueuedConversation } from "./hooks/useQueuedConversation";
import { ConversationRequestSlot, type useConversationRequest } from "./ConversationRequestContext";
import type { LiveTurnActivity } from "./TurnActivityPanel";

interface TranscriptRowsProps {
  list: ReturnType<typeof useMessageList>;
  layout: ReturnType<typeof useMessageListLayout>;
  queue: ReturnType<typeof useQueuedConversation>;
  request: ReturnType<typeof useConversationRequest>;
  anchored: boolean | undefined;
  enteringIds: Set<string>;
  liveActivity: LiveTurnActivity;
  activeChatId: string;
  intro: boolean;
  introIndex: number;
  requestIndex: number;
}

/** Presentation rows share the transcript's virtual layout, without entering message history. */
export function TranscriptRows({ list, layout, queue, request, anchored, enteringIds, liveActivity, activeChatId, intro, introIndex, requestIndex }: TranscriptRowsProps) {
  const { visibleMessages, progressRows, turnState, turnStartedAt, turnId, liveMessageId, showTurnActivity,
    itemCount: messageItemCount, copiedMessageId, copyAssistantMessage, copyContextMenuText, assistantFooterMetaById, anchoredStewardProgress } = list;
  const { rowVirtualizer, topOffset } = layout;
  return rowVirtualizer.getVirtualItems().map((virtualRow) => {
    if (intro && virtualRow.index === introIndex) return <MessageRow key="chats-intro" role="assistant" bubble
      index={virtualRow.index} rowRef={rowVirtualizer.measureElement} offsetY={virtualRow.start + topOffset}>
      <ChatsIntro />
    </MessageRow>;
    if (request?.active && !anchored && virtualRow.index === requestIndex) return <MessageRow key="pending-request" role="assistant"
      index={virtualRow.index} rowRef={rowVirtualizer.measureElement} offsetY={virtualRow.start + topOffset}>
      <ConversationRequestSlot setTarget={request.setTarget} />
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
          chat={isGeneralChat(activeChatId)}
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
  });
}
