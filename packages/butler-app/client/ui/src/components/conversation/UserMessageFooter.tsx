import { MessageFooter } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { MessageRecord } from "@/app/types.ts";
import { CopyTextButton } from "./CopyTextButton";

const timeOptions: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const sentTimeFormat = new Intl.DateTimeFormat(undefined, timeOptions);
const sentDayFormat = new Intl.DateTimeFormat(undefined, {
  ...timeOptions, month: "short", day: "numeric",
});
const sentYearFormat = new Intl.DateTimeFormat(undefined, {
  ...timeOptions, year: "numeric", month: "short", day: "numeric",
});

function formatSentTime(date: Date): string {
  const today = new Date();
  if (date.getFullYear() !== today.getFullYear()) return sentYearFormat.format(date);
  if (date.getMonth() !== today.getMonth() || date.getDate() !== today.getDate()) {
    return sentDayFormat.format(date);
  }
  return sentTimeFormat.format(date);
}

export function UserMessageFooter({ message }: { message: MessageRecord }) {
  const date = message.created_at ? new Date(message.created_at) : null;
  const sentAt = date && !Number.isNaN(date.getTime()) ? date : null;
  return (
    <MessageFooter dataTestClass="user-message-footer">
      {sentAt && (
        <time dateTime={sentAt.toISOString()}>{formatSentTime(sentAt)}</time>
      )}
      <CopyTextButton text={message.text} label={appCopy.conversation.messageActions.copyMessage} />
    </MessageFooter>
  );
}
