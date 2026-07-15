import type { AppTransportProjectionStoreOptions } from "./transport-projection-contract.ts";

export function projectAppTurnFailure(input: {
  options: AppTransportProjectionStoreOptions;
  chatId: string;
  turnId: string;
  message: Record<string, unknown>;
  metadata: Record<string, unknown>;
  eventTimestamp: string;
}): boolean {
  const { options, chatId, turnId, message, metadata, eventTimestamp } = input;
  const turn = options.getTurnRow(turnId);
  if (!turn) return false;
  if (turn.state === "delivered" || turn.state === "cancelled") return false;
  try {
    options.routeResponderRuntimeInterruption({
      chatId,
      turnId,
      message,
      metadata,
      eventTimestamp,
    });
  } catch {
    // The accepted App turn remains the durable prior owner while the Agent
    // interruption store is unavailable. Projection must never invent finality.
  }
  const continuation = options.markResponderNonPublicContinuation(
    chatId,
    turnId,
    null,
  );
  options.touchChat(chatId);
  void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
  return continuation.turn.state === "waiting_for_tool" ||
    continuation.turn.state === "retrying";
}
