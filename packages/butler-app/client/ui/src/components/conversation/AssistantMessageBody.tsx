import { InitiatedApprovalLine } from "./InitiatedApprovalLine";
import { InitiatedPanels } from "./InitiatedPanels";
import { isGeneralChat } from "@/app/isGeneralChat";
import { projectTurnActivity } from "@/app/conversation-progress";
import { appCopy, useAppLocale } from "@/app/copy";
import type { MessageRecord } from "@/app/types";
import type { ReactNode } from "react";
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource";
import { MessageBubble, MessageBubbleAttachments, Stack, Tag, Typo } from "@/butler-ds";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { AssistantFailureNotice } from "./FailureNoticeContainer";
import { MessageLiveGroup, MessageTurnActivity, useKeptLiveActivity } from "./MessageTurnActivity";
import type { LiveTurnActivity } from "./TurnActivityPanel";
import { CompletedWorkBlocks } from "./CompletedWorkBlocks";
import { AnswerBlocks } from "./AnswerBlocks";
import { AssistantReply, AssistantReplyText } from "./AssistantReply";
import { PlanDocumentMessage } from "./PlanDocumentMessage";
import { StewardParentProgress } from "./StewardParentProgress";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection";

export function AssistantMessageBody({ message, running, liveActivity, failureNotice, stewardProgress, refreshFileUrls, attachedParts }: {
  message: MessageRecord;
  running: boolean;
  /** Live progress of the running turn; it fills the slot the completed summary takes. */
  liveActivity?: LiveTurnActivity;
  failureNotice: boolean;
  stewardProgress?: AnchoredStewardProgress;
  refreshFileUrls: RefreshFileUrls;
  /** Parts rendered after the answer (artifacts, changed files), before the live status line. */
  attachedParts?: ReactNode;
}) {
  useAppLocale();
  const kept = useKeptLiveActivity(liveActivity);
  const hasPhaseActivity = projectTurnActivity(message.turn_activity_rows ?? [], message.turn_id).phaseActivities.length > 0;
  const bubble = isGeneralChat(message.chat_id);
  const attachments = <AssistantAttachments message={message}>{attachedParts}</AssistantAttachments>;
  return (
    <>
      {!bubble && <MessageTurnActivity message={message} live={liveActivity} kept={kept} />}
      {!bubble && !running && !hasPhaseActivity && <CompletedWorkBlocks
        blocks={message.work_blocks}
        turnId={message.turn_id}
      />}
      <MessageLiveGroup live={liveActivity} kept={kept} bubble={bubble}>
        {bubble ? <>
          {message.initiated?.kind === "approval_needed" ? (
            <MessageBubble><InitiatedApprovalLine origin={message.initiated} /></MessageBubble>
          ) : failureNotice ? <AssistantFailureNotice message={message} /> : message.text.trim() || message.initiated?.kind === "work_failed" ? (
            <MessageBubble><AssistantReplyText message={message} refreshFileUrls={refreshFileUrls} /></MessageBubble>
          ) : null}
          {stewardProgress && <ErrorBoundary fallback={null}><StewardParentProgress progress={stewardProgress} /></ErrorBoundary>}
          <MessageBubbleAttachments>
            {!failureNotice && <AnswerBlocks sets={message.answer_blocks} messageId={message.id} replyText={message.text}
              sessionId={message.chat_id} turnId={message.turn_id} />}
            {attachments}
            <InitiatedPanels origin={message.initiated} />
          </MessageBubbleAttachments>
        </> : <>
          <AnswerReply message={message} failureNotice={failureNotice} stewardProgress={stewardProgress} refreshFileUrls={refreshFileUrls} />
          {attachments}
        </>}
      </MessageLiveGroup>
    </>
  );
}

function AnswerReply({ message, failureNotice, stewardProgress, refreshFileUrls }: {
  message: MessageRecord;
  failureNotice: boolean;
  stewardProgress?: AnchoredStewardProgress;
  refreshFileUrls: RefreshFileUrls;
}) {
  const reply = failureNotice
    ? <AssistantFailureNotice message={message} />
    : <AssistantReply message={message} refreshFileUrls={refreshFileUrls} />;
  if (!stewardProgress) return reply;
  return (
    <Stack data-test-class="steward-message-content" gap="md">
      {reply}
      <ErrorBoundary fallback={null}>
        <StewardParentProgress progress={stewardProgress} />
      </ErrorBoundary>
    </Stack>
  );
}

function AssistantAttachments({ message, children }: { message: MessageRecord; children: ReactNode }) {
  return <>
    {message.question_summary?.map(question => (
      <Stack key={question.id} gap="none" data-test-class="assistant-question-summary">
        <Typo.Caption tone="tertiary">{question.eyebrow}</Typo.Caption>
        <Typo.Body wrap="anywhere">{question.title}</Typo.Body>
      </Stack>
    ))}
    {message.plan_document ? (
      <PlanDocumentMessage plan={message.plan_document} bubble={isGeneralChat(message.chat_id)} />
    ) : null}
    {(message.status === "cancelled" || message.incomplete === true) && (
      <div role="status">
        <Tag ariaLabel={message.incomplete === true ? appCopy.conversation.incompleteStatus : appCopy.conversation.stoppedStatus}>
          {message.incomplete === true ? appCopy.conversation.incompleteStatus : appCopy.conversation.stoppedStatus}
        </Tag>
      </div>
    )}
    {message.failure_notice && <AssistantFailureNotice message={message.failure_notice} />}
    {children}
    {message.limitation_codes?.includes("message_file_unavailable") && (
      <Tag ariaLabel={appCopy.conversation.attachmentUnavailable}>
        {appCopy.conversation.attachmentUnavailable}
      </Tag>
    )}
  </>;
}
