import { useConversationRequest } from "./ConversationRequestContext.tsx";
import { memo, useMemo } from "react";
import { useAnswerDrafts, draftTurns, withDraftMessages } from "@/app/answerDrafts";
import { useChatsIntroVisible } from "./ChatsIntro";
import { TranscriptRows } from "./TranscriptRows";
import { SessionBranchSeed } from "./SessionBranchSeed";
import type { MessageRecord, TurnProgressSnapshot } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { useMessageList } from "./hooks/useMessageList";
import { useMessageListLayout } from "./hooks/useMessageListLayout";
import { type ConversationColumnRect, ConversationScroll, MessageListSurface } from "@/butler-ds";
import { useEnteringMessageIds } from "./hooks/useEnteringMessageIds";
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
  const list = useMessageList(displayMessages, summary, turnProgress, isSending);
  const { visibleMessages, progressRows, turnState, turnStartedAt, turnId, showTurnActivity, itemCount: messageItemCount } = list;

  const liveActivity = useMemo(() => ({ rows: progressRows, state: turnState, startedAt: turnStartedAt, turnId }),
    [progressRows, turnState, turnStartedAt, turnId]);
  const enteringIds = useEnteringMessageIds(visibleMessages, activeChatId);
  const queue = useQueuedConversation(visibleMessages, activeChatId);
  const request = useConversationRequest();
  const anchored = request?.active && visibleMessages.some(message => message.id === request.sourceMessageId);
  const requestIndex = messageItemCount + queue.items.length;
  const intro = useChatsIntroVisible();
  const introIndex = requestIndex + (request?.active && !anchored ? 1 : 0);
  const itemCount = introIndex + (intro ? 1 : 0);
  const layout = useMessageListLayout({
    visibleMessages, showTurnActivity, itemCount, bottomReserve, activeChatId, isSending,
    queuedKeys: queue.keys, branchSeed: summary?.branch_seed,
  });

  const { parentRef, seedRef, virtualListHeight, scrollState } = layout;

  return (
    <>
      <ConversationScroll virtualized scrollRef={parentRef}>
        <MessageListSurface height={virtualListHeight} onColumnRect={onColumnRect}>
          {summary?.branch_seed && <div ref={seedRef}><SessionBranchSeed /></div>}
          <TranscriptRows list={list} layout={layout} queue={queue} request={request} anchored={anchored}
            enteringIds={enteringIds} liveActivity={liveActivity} activeChatId={activeChatId}
            intro={intro} introIndex={introIndex} requestIndex={requestIndex} />
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
