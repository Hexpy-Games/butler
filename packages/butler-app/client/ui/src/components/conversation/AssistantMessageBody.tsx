import { projectTurnActivity } from "@/app/conversation-progress";
import { appCopy, useAppLocale } from "@/app/copy";
import type { MessageRecord } from "@/app/types";
import type { ReactNode } from "react";
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource";
import { Stack, Tag, Typo } from "@/butler-ds";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { AssistantFailureNotice } from "./FailureNoticeContainer";
import { MessageLiveGroup, MessageTurnActivity, useKeptLiveActivity } from "./MessageTurnActivity";
import type { LiveTurnActivity } from "./TurnActivityPanel";
import { CompletedWorkBlocks } from "./CompletedWorkBlocks";
import { AssistantReply } from "./AssistantReply";
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
  return (
    <>
      <MessageTurnActivity message={message} live={liveActivity} kept={kept} />
      {!running && !hasPhaseActivity && <CompletedWorkBlocks
        blocks={message.work_blocks}
        turnId={message.turn_id}
      />}
      <MessageLiveGroup live={liveActivity} kept={kept}>
        <AnswerReply message={message} failureNotice={failureNotice} stewardProgress={stewardProgress} refreshFileUrls={refreshFileUrls} />
        {message.question_summary?.map(question => (
          <Stack key={question.id} gap="none" data-test-class="assistant-question-summary">
            <Typo.Caption tone="tertiary">{question.eyebrow}</Typo.Caption>
            <Typo.Body wrap="anywhere">{question.title}</Typo.Body>
          </Stack>
        ))}
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
        {attachedParts}
        {message.limitation_codes?.includes("message_file_unavailable") && (
          <Tag ariaLabel={appCopy.conversation.attachmentUnavailable}>
            {appCopy.conversation.attachmentUnavailable}
          </Tag>
        )}
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
