import { memo } from "react";
import type { MessageRecord } from "@/app/types.ts";
import { appCopy } from "@/app/copy.ts";
import { Tag } from "@/butler-ds";
import { isRuntimeFaultRetryableMessage } from "@/app/utils.ts";
import { AssistantResponseFooter } from "./AssistantResponseFooter";
import {
  AssistantFailureNotice,
  MessageRetryActionsContainer,
} from "./FailureNoticeContainer";
import { CompletedWorkBlocks } from "./CompletedWorkBlocks";
import { CompletedTurnActivity } from "./CompletedTurnActivity";
import { MessageArtifacts } from "./MessageArtifacts";
import { MessageAttachments } from "./MessageAttachments";
import { MessageMarkdown } from "./MessageMarkdown";
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
          {message.status === "failed" ? (
            <AssistantFailureNotice message={message} />
          ) : (
            <MessageMarkdown
              attachments={message.attachments}
              text={message.text}
            />
          )}
          {stewardProgress ? <StewardParentProgress progress={stewardProgress} /> : null}
          {message.status === "cancelled" && (
            <div role="status">
              <Tag ariaLabel={appCopy.conversation.stoppedStatus}>
                {appCopy.conversation.stoppedStatus}
              </Tag>
            </div>
          )}
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
      {message.role === "assistant" && onCopyAssistantMessage && (
        <AssistantResponseFooter
          copied={copied}
          meta={footerMeta}
          status={message.status}
          suppressTerminalStatus={Boolean(stewardProgress)}
          onCopy={() => onCopyAssistantMessage(message)}
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
