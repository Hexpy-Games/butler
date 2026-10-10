import { useAppLocale } from "@/app/copy.ts";
import { memo, useCallback, type ReactNode } from "react";
import type { MessageRecord } from "@/app/types.ts";
import { visibleSystemMessageText } from "@/app/system-event-message.ts";
import { refreshSessionFileUrls } from "@/app/messageFileRefresh.ts";
import { AssistantMessageBody } from "./AssistantMessageBody";
import {
  canRetryWithCurrentControls,
  isAssistantFailureNoticeMessage,
  isRetryableFailureMessage,
} from "@/app/utils.ts";
import { AssistantResponseFooter } from "./AssistantResponseFooter";
import { AssistantBranchActions } from "./AssistantBranchActions";
import {
  MessageRetryActionsContainer,
} from "./FailureNoticeContainer";
import { MessageArtifacts } from "./MessageArtifacts";
import { MessageChangedFiles } from "./MessageChangedFiles";
import { MessageAttachments } from "./MessageAttachments";
import { UserMessageText } from "./UserMessageText";
import type { AssistantFooterMeta } from "./messageFooterMeta";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection";

interface MessageContentProps {
  message: MessageRecord;
  liveActivity?: ReactNode;
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
  return (
    <>
      {message.role === "assistant" ? (
        <AssistantMessageBody message={message} running={running} failureNotice={failureNotice}
          stewardProgress={stewardProgress} refreshFileUrls={refreshFileUrls} />
      ) : message.role === "user" ? (
        <UserMessageText key={message.id} text={message.text} contentParts={message.content_parts} />
      ) : (
        visibleSystemMessageText(message)
      )}
      {message.role !== "assistant" && (
        <MessageAttachments attachments={message.attachments ?? []} />
      )}
      {message.role === "assistant" && (
        <MessageArtifacts
          text={message.text}
          artifacts={artifacts}
          attachments={message.attachments ?? []}
          refreshFileUrls={refreshFileUrls}
        />
      )}
      {message.role === "assistant" && (
        <MessageChangedFiles files={message.changed_files ?? []} />
      )}
      {liveActivity}
      {message.role === "assistant" && !running && onCopyAssistantMessage && (
        <AssistantResponseFooter
          copied={copied}
          meta={footerMeta}
          status={message.status}
          suppressTerminalStatus={Boolean(stewardProgress)}
          onCopy={() => onCopyAssistantMessage(message)}
          actions={<AssistantBranchActions message={message} />}
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
    </>
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
