import { memo } from "react";
import type { MessageRecord } from "@/app/types.ts";
import { AssistantResponseFooter } from "./AssistantResponseFooter";
import {
  AssistantFailureNotice,
  MessageRetryActionsContainer,
} from "./FailureNoticeContainer";
import { CompletedWorkBlocks } from "./CompletedWorkBlocks";
import { MessageArtifacts } from "./MessageArtifacts";
import { MessageAttachments } from "./MessageAttachments";
import { MessageMarkdown } from "./MessageMarkdown";
import type { AssistantFooterMeta } from "./messageFooterMeta";

interface MessageContentProps {
  message: MessageRecord;
  copied: boolean;
  footerMeta: AssistantFooterMeta | null;
  expandWorkBlocks?: boolean;
  onCopyAssistantMessage: (message: MessageRecord) => void;
}

function MessageContentComponent({
  message,
  copied,
  footerMeta,
  expandWorkBlocks = false,
  onCopyAssistantMessage,
}: MessageContentProps) {
  return (
    <>
      {message.role === "assistant" ? (
        <>
          {message.status === "failed" ? (
            <AssistantFailureNotice message={message} />
          ) : (
            <MessageMarkdown
              attachments={message.attachments}
              text={message.text}
            />
          )}
          <CompletedWorkBlocks
            blocks={message.work_blocks}
            defaultExpanded={expandWorkBlocks}
          />
        </>
      ) : (
        message.text
      )}
      {message.role !== "assistant" && (
        <MessageAttachments attachments={message.attachments ?? []} />
      )}
      {message.role === "assistant" && (
        <MessageArtifacts
          artifacts={message.artifacts ?? []}
          attachments={message.attachments ?? []}
        />
      )}
      {message.role === "assistant" && (
        <AssistantResponseFooter
          copied={copied}
          meta={footerMeta}
          onCopy={() => onCopyAssistantMessage(message)}
        />
      )}
      {message.role !== "assistant" &&
        message.status === "failed" &&
        message.retryable &&
        message.turn_id && (
          <MessageRetryActionsContainer turnId={message.turn_id} />
        )}
    </>
  );
}

export const MessageContent = memo(
  MessageContentComponent,
  (previous, next) =>
    previous.message === next.message &&
    previous.copied === next.copied &&
    previous.footerMeta === next.footerMeta &&
    previous.expandWorkBlocks === next.expandWorkBlocks &&
    previous.onCopyAssistantMessage === next.onCopyAssistantMessage,
);
MessageContent.displayName = "MessageContent";
