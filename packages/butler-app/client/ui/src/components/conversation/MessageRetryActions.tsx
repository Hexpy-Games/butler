import { appCopy } from "@/app/copy.ts";
import { Button, Stack } from "@/butler-ds";

interface MessageRetryActionsProps {
  turnId: string;
  retryingTurnId?: string | null;
  onRetryTurn: (turnId: string) => void;
}

export function MessageRetryActions({
  turnId,
  retryingTurnId,
  onRetryTurn,
}: MessageRetryActionsProps) {
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
    </Stack>
  );
}
