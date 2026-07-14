import { AlertCircle, Button, Notice, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { MessageRecord } from "@/app/types.ts";
import { isRuntimeFaultRetryableMessage } from "@/app/utils.ts";

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
  const reason =
    message.text.trim() || appCopy.conversation.failure.fallbackReason;
  const retrying = Boolean(
    message.turn_id && retryingTurnId === message.turn_id,
  );

  return (
    <section
      aria-label={appCopy.conversation.failure.regionLabel}
      className="failure-notice"
    >
      <Notice
        tone="error"
        icon={<AlertCircle size={16} />}
        title={appCopy.conversation.failure.title}
        message={reason}
        action={
          isRuntimeFaultRetryableMessage(message) && message.turn_id ? (
            <Stack align="row" justify="end">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  if (message.turn_id) onRetryTurn(message.turn_id);
                }}
                disabled={retrying}
              >
                {retrying
                  ? appCopy.conversation.failure.retrying
                  : appCopy.conversation.failure.retry}
              </Button>
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
            </Stack>
          ) : null
        }
      />
    </section>
  );
}
