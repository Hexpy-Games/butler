export const CANCELLED_TURN_ACTIVITY_TEXT = "Stopped.";

export interface CancelledTurnActivityCarrierCandidate {
  status: string;
  text: string;
}

export function isCancelledTurnActivityCarrier(
  message: CancelledTurnActivityCarrierCandidate,
): boolean {
  return message.status === "cancelled" &&
    message.text === CANCELLED_TURN_ACTIVITY_TEXT;
}
