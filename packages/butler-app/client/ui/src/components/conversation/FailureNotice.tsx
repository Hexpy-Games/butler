import { useChatGptFailureAction } from "../chatgpt/useChatGptFailureAction";
import { useAppLocale } from "@/app/copy.ts";
import { AlertCircle, Button, ButtonContainer, Notice } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { MessageRecord } from "@/app/types.ts";
import {
  canRetryWithCurrentControls,
  isRetryableFailureMessage,
} from "@/app/utils.ts";
import { useDeveloperMode } from "@/hooks/useDeveloperMode.ts";
import { messageTraceTarget } from "./messageTrace";
import { openLogTrace } from "@/stores/logTraceStore.ts";

export function FailureNotice({
  message,
  onRetryTurn,
  onRetryTurnWithCurrentControls,
  retryingTurnId,
}: {
  message: MessageRecord;
  onRetryTurn: (turnId: string) => void;
  onRetryTurnWithCurrentControls: (turnId: string) => void;
  retryingTurnId: string | null;
}) {
  useAppLocale();
  const planAction = useChatGptFailureAction(message.safe_error_code);
  const developerMode = useDeveloperMode();
  const reason =
    message.text.trim() || appCopy.conversation.failure.fallbackReason;
  const retrying = Boolean(
    message.turn_id && retryingTurnId === message.turn_id,
  );
  const retryable = isRetryableFailureMessage(message) && Boolean(message.turn_id);
  // Developer mode: 로그 보기 opens this message's trace.
  const trace = developerMode ? messageTraceTarget(message) : null;

  return (
    <section
      aria-label={appCopy.conversation.failure.regionLabel}
      className="failure-notice"
    >
      <Notice
        tone="error"
        icon={<AlertCircle size="md" />}
        title={appCopy.conversation.failure.title}
        message={reason}
        action={
          planAction || retryable || trace ? (
            <ButtonContainer size="sm" justify="end">
              {planAction ? <Button size="sm" variant="outline" onClick={planAction.run}>{planAction.label}</Button> : null}
              {retryable ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (message.turn_id) {
                      const resume = message.retry_mode === "resume";
                      (resume ? onRetryTurn : onRetryTurnWithCurrentControls)(message.turn_id);
                    }
                  }}
                  disabled={retrying}
                >
                  {retrying
                    ? appCopy.conversation.failure.retrying
                    : appCopy.conversation.failure.retry}
                </Button>
              ) : null}
              {retryable && canRetryWithCurrentControls(message) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if (message.turn_id) {
                      onRetryTurnWithCurrentControls(message.turn_id);
                    }
                  }}
                  disabled={retrying}
                >
                  {retrying
                    ? appCopy.conversation.failure.retrying
                    : appCopy.conversation.failure.retryCurrent}
                </Button>
              ) : null}
              {trace ? (
                <Button type="button" size="sm" variant="outline" data-test-class="failure-view-logs"
                  onClick={() => openLogTrace(trace)}>
                  {appCopy.settings.logs.trace.viewLogs}
                </Button>
              ) : null}
            </ButtonContainer>
          ) : null
        }
      />
    </section>
  );
}
