import { memo } from "react";
import type { MessageRecord } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";
import { FailureNotice } from "./FailureNotice";
import { MessageRetryActions } from "./MessageRetryActions";

export const AssistantFailureNotice = memo(function AssistantFailureNotice({
  message,
}: {
  message: MessageRecord;
}) {
  const retryingTurnId = useButlerStore((state) => state.retryingTurnId);
  const retryTurn = useButlerStore((state) => state.retryTurn);
  const retryTurnWithCurrentControls = useButlerStore(
    (state) => state.retryTurnWithCurrentControls,
  );
  return (
    <FailureNotice
      message={message}
      onRetryTurn={retryTurn}
      onRetryTurnWithCurrentControls={retryTurnWithCurrentControls}
      retryingTurnId={retryingTurnId ?? null}
    />
  );
});

export const MessageRetryActionsContainer = memo(
  function MessageRetryActionsContainer({ turnId }: { turnId: string }) {
    const retryingTurnId = useButlerStore((state) => state.retryingTurnId);
    const retryTurn = useButlerStore((state) => state.retryTurn);
    const retryTurnWithCurrentControls = useButlerStore(
      (state) => state.retryTurnWithCurrentControls,
    );
    return (
      <MessageRetryActions
        turnId={turnId}
        retryingTurnId={retryingTurnId}
        onRetryTurn={retryTurn}
        onRetryTurnWithCurrentControls={retryTurnWithCurrentControls}
      />
    );
  },
);
