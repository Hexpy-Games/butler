import type { FeedbackEntry } from "./buffer.ts";

export type CapturedFeedback = {
  entry: FeedbackEntry;
  reason: string;
};

export type CaptureUserFeedbackInput = {
  butlerData: string;
  text: string;
  messageId?: string | null;
  turnId?: string | null;
  chatId?: string | null;
  now?: Date;
};

export function captureUserFeedbackFromMessage(input: CaptureUserFeedbackInput): CapturedFeedback | null {
  void input;
  return null;
}
