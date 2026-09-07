import { memo } from "react";
import type { MessageRecord } from "@/app/types.ts";
import { appCopy } from "@/app/copy.ts";
import { Stack, Tag } from "@/butler-ds";
import {
  isAssistantFailureNoticeMessage,
  isRuntimeFaultRetryableMessage,
} from "@/app/utils.ts";
import { AssistantResponseFooter } from "./AssistantResponseFooter";
import { BranchMessageActions } from "./BranchMessageActions";
import {
  AssistantFailureNotice,
  MessageRetryActionsContainer,
} from "./FailureNoticeContainer";
import { CompletedWorkBlocks } from "./CompletedWorkBlocks";
import { CompletedTurnActivity } from "./CompletedTurnActivity";
import { MessageArtifacts } from "./MessageArtifacts";
import { MessageChangedFiles } from "./MessageChangedFiles";
import { MessageAttachments } from "./MessageAttachments";
import { MessageMarkdown } from "./MessageMarkdown";
import { PlanDocumentMessage } from "./PlanDocumentMessage";
import { UserMessageText } from "./UserMessageText";
import type { AssistantFooterMeta } from "./messageFooterMeta";
import { StewardParentProgress } from "./StewardParentProgress";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection";

interface MessageContentProps {
  message: MessageRecord;
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
}: MessageContentProps) {
  const artifacts = message.artifacts ?? [];
  const failureNotice = isAssistantFailureNoticeMessage(message);
  return (
    <>
      {message.role === "assistant" ? (
        <>
          <CompletedTurnActivity
            rows={message.turn_activity_rows}
            turnId={message.turn_id}
            turnState={message.status}
          />
          <CompletedWorkBlocks
            blocks={message.work_blocks}
            turnId={message.turn_id}
          />
          {stewardProgress ? (
            <Stack data-test-class="steward-message-content" gap="md">
              {failureNotice ? (
                <AssistantFailureNotice message={message} />
              ) : (
                <MessageMarkdown
                  attachments={message.attachments}
                  text={message.text}
                />
              )}
              <StewardParentProgress progress={stewardProgress} />
            </Stack>
          ) : failureNotice ? (
            <AssistantFailureNotice message={message} />
          ) : (
            <MessageMarkdown
              attachments={message.attachments}
              text={message.text}
            />
          )}
          {message.plan_document ? (
            <PlanDocumentMessage plan={message.plan_document} />
          ) : null}
          {message.status === "cancelled" && (
            <div role="status">
              <Tag ariaLabel={appCopy.conversation.stoppedStatus}>
                {appCopy.conversation.stoppedStatus}
              </Tag>
            </div>
          )}
        </>
      ) : message.role === "user" ? (
        <UserMessageText key={message.id} text={message.text} contentParts={message.content_parts} />
      ) : (
        message.text
      )}
      {message.role !== "assistant" && (
        <MessageAttachments attachments={message.attachments ?? []} />
      )}
      {message.role === "assistant" && (
        <MessageArtifacts
          artifacts={artifacts}
          attachments={message.attachments ?? []}
        />
      )}
      {message.role === "assistant" && (
        <MessageChangedFiles files={message.changed_files ?? []} />
      )}
      {message.role === "assistant" && onCopyAssistantMessage && (
        <AssistantResponseFooter
          copied={copied}
          meta={footerMeta}
          status={message.status}
          suppressTerminalStatus={Boolean(stewardProgress)}
          onCopy={() => onCopyAssistantMessage(message)}
          actions={message.chat_id === "general" && message.text.trim() &&
            (!message.status || ["delivered", "completed", "sent"].includes(message.status)) ? (
              <BranchMessageActions sessionId={message.chat_id} messageId={message.id} />
            ) : undefined}
        />
      )}
      {message.role !== "assistant" &&
        message.status === "failed" &&
        isRuntimeFaultRetryableMessage(message) &&
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
    previous.stewardProgress === next.stewardProgress &&
    previous.onCopyAssistantMessage === next.onCopyAssistantMessage,
);
MessageContent.displayName = "MessageContent";
