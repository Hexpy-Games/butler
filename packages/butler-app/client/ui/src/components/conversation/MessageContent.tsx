import { isGeneralChat } from "@/app/isGeneralChat";
import { ConversationRequestAnchor } from "./ConversationRequestContext.tsx";
import { useAppLocale } from "@/app/copy.ts";
import { memo, useCallback } from "react";
import type { MessageRecord } from "@/app/types.ts";
import { visibleSystemMessageText } from "@/app/system-event-message.ts";
import { refreshSessionFileUrls } from "@/app/messageFileRefresh.ts";
import { AssistantMessageBody } from "./AssistantMessageBody";
import {
  canRetryWithCurrentControls,
  isAssistantFailureNoticeMessage,
  isRetryableFailureMessage,
} from "@/app/utils.ts";
import { AnswerDraftFooter } from "./AnswerDraftFooter";
import { AssistantResponseFooter } from "./AssistantResponseFooter";
import { AssistantBranchActions } from "./AssistantBranchActions";
import { MessageTraceMenu } from "./MessageTraceMenu";
import {
  MessageRetryActionsContainer,
} from "./FailureNoticeContainer";
import { MessageArtifacts } from "./MessageArtifacts";
import { MessageChangedFiles } from "./MessageChangedFiles";
import { MessageAttachments } from "./MessageAttachments";
import { UserMessageText } from "./UserMessageText";
import { MessageImageContext, openMessageImage } from "./messageImages";
import type { LiveTurnActivity } from "./TurnActivityPanel";
import type { AssistantFooterMeta } from "./messageFooterMeta";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection";

interface MessageContentProps {
  message: MessageRecord;
  liveActivity?: LiveTurnActivity;
  copied: boolean;
  footerMeta: AssistantFooterMeta | null;
  onCopyAssistantMessage?: (message: MessageRecord) => void;
  stewardProgress?: AnchoredStewardProgress;
}

function MessageContentComponent({
  message,
  copied,
  footerMeta,
  onCopyAssistantMessage,
  stewardProgress,
  liveActivity,
}: MessageContentProps) {
  useAppLocale();
  const artifacts = message.artifacts ?? [];
  const { chat_id: sessionId = "", cursor } = message;
  const refreshFileUrls = useCallback(() => refreshSessionFileUrls(sessionId, { cursor }), [cursor, sessionId]);
  const running = Boolean(liveActivity) || message.status === "streaming" || message.status === "pending";
  const failureNotice = isAssistantFailureNoticeMessage(message);
  const openImage = useCallback((key: string) => openMessageImage(message, key), [message]);
  return (
    <MessageImageContext.Provider value={openImage}>
      {message.role === "assistant" ? (
        <AssistantMessageBody message={message} running={running} liveActivity={liveActivity} failureNotice={failureNotice}
          stewardProgress={stewardProgress} refreshFileUrls={refreshFileUrls} attachedParts={<>
            <MessageArtifacts bubble={isGeneralChat(message.chat_id)} text={message.text} artifacts={artifacts} attachments={message.attachments ?? []}
              refreshFileUrls={refreshFileUrls} />
            <MessageChangedFiles bubble={isGeneralChat(message.chat_id)} files={message.changed_files ?? []} attachments={message.attachments ?? []}
              artifacts={artifacts} text={message.text} />
          </>} />
      ) : message.role === "user" ? (
        <UserMessageText key={message.id} text={message.text} contentParts={message.content_parts} />
      ) : (
        visibleSystemMessageText(message)
      )}
      {message.role !== "assistant" && (
        <MessageAttachments attachments={message.attachments ?? []} sessionId={sessionId} />
      )}
      {message.role === "assistant" && running && <AnswerDraftFooter turnId={message.turn_id} />}
      {message.role === "assistant" && !running && onCopyAssistantMessage && (
        <AssistantResponseFooter
          bubble={isGeneralChat(message.chat_id)}
          copied={copied}
          meta={footerMeta}
          status={message.failure_notice ? "failed" : message.status}
          suppressTerminalStatus={Boolean(stewardProgress) || (message.incomplete === true && !message.failure_notice)}
          onCopy={() => onCopyAssistantMessage(message)}
          actions={<><AssistantBranchActions message={message} /><MessageTraceMenu message={message} /></>}
        />
      )}
      {message.role !== "assistant" &&
        message.status === "failed" &&
        isRetryableFailureMessage(message) &&
        message.turn_id && (
          <MessageRetryActionsContainer
            turnId={message.turn_id}
            withCurrentControls={canRetryWithCurrentControls(message)}
          />
        )}
      <ConversationRequestAnchor messageId={message.id} />
    </MessageImageContext.Provider>
  );
}

export const MessageContent = memo(
  MessageContentComponent,
  (previous, next) =>
    previous.message === next.message &&
    previous.liveActivity === next.liveActivity &&
    previous.copied === next.copied &&
    previous.footerMeta === next.footerMeta &&
    previous.stewardProgress === next.stewardProgress &&
    previous.onCopyAssistantMessage === next.onCopyAssistantMessage,
);
MessageContent.displayName = "MessageContent";
