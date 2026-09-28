import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { Button, Stack } from "@/butler-ds";

interface MessageRetryActionsProps {
  turnId: string;
  retryingTurnId?: string | null;
  /** Offers "Retry with current settings" next to Retry. */
  withCurrentControls: boolean;
  onRetryTurn: (turnId: string) => void;
  onRetryTurnWithCurrentControls: (turnId: string) => void;
}

export function MessageRetryActions({
  turnId,
  retryingTurnId,
  withCurrentControls,
  onRetryTurn,
  onRetryTurnWithCurrentControls,
}: MessageRetryActionsProps) {
  useAppLocale();
  const retrying = retryingTurnId === turnId;

  return (
    <Stack align="row" justify="end">
      <Button
        type="button"
        variant="outline"
        onClick={() => onRetryTurn(turnId)}
        disabled={retrying}
      >
        {retrying
          ? appCopy.conversation.failure.retrying
          : appCopy.conversation.failure.retry}
      </Button>
      {withCurrentControls ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => onRetryTurnWithCurrentControls(turnId)}
          disabled={retrying}
        >
          {retrying
            ? appCopy.conversation.failure.retrying
            : appCopy.conversation.failure.retryCurrent}
        </Button>
      ) : null}
    </Stack>
  );
}
