import { projectTurnActivity } from "@/app/conversation-progress";
import { appCopy, useAppLocale } from "@/app/copy";
import type { MessageRecord } from "@/app/types";
import type { RefreshFileUrls } from "@/hooks/useMessageFileSource";
import { Stack, Tag } from "@/butler-ds";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { AssistantFailureNotice } from "./FailureNoticeContainer";
import { CompletedTurnActivity } from "./CompletedTurnActivity";
import { CompletedWorkBlocks } from "./CompletedWorkBlocks";
import { MessageMarkdown } from "./MessageMarkdown";
import { PlanDocumentMessage } from "./PlanDocumentMessage";
import { StewardParentProgress } from "./StewardParentProgress";
import type { AnchoredStewardProgress } from "./stewardParentProgressProjection";

export function AssistantMessageBody({ message, running, failureNotice, stewardProgress, refreshFileUrls }: {
  message: MessageRecord;
  running: boolean;
  failureNotice: boolean;
  stewardProgress?: AnchoredStewardProgress;
  refreshFileUrls: RefreshFileUrls;
}) {
  useAppLocale();
  const hasPhaseActivity = projectTurnActivity(message.turn_activity_rows ?? [], message.turn_id).phaseActivities.length > 0;
  return (
    <>
      {!running && <CompletedTurnActivity
        rows={message.turn_activity_rows}
        turnId={message.turn_id}
        turnState={message.status}
      />}
      {!running && !hasPhaseActivity && <CompletedWorkBlocks
        blocks={message.work_blocks}
        turnId={message.turn_id}
      />}
      {stewardProgress ? (
        <Stack data-test-class="steward-message-content" gap="md">
          {failureNotice ? (
            <AssistantFailureNotice message={message} />
          ) : (
            <MessageMarkdown
              artifacts={message.artifacts}
              attachments={message.attachments}
              refreshFileUrls={refreshFileUrls}
              streaming={message.status === "streaming"}
              text={message.text}
            />
          )}
          <ErrorBoundary fallback={null}>
            <StewardParentProgress progress={stewardProgress} />
          </ErrorBoundary>
        </Stack>
      ) : failureNotice ? (
        <AssistantFailureNotice message={message} />
      ) : (
        <MessageMarkdown
          artifacts={message.artifacts}
          attachments={message.attachments}
          refreshFileUrls={refreshFileUrls}
          streaming={message.status === "streaming"}
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
  );
}
