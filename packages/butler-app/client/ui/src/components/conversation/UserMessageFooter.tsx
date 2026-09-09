import { useAppLocale } from "@/app/copy.ts";
import { MessageFooter } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { MessageRecord } from "@/app/types.ts";
import { CopyTextButton } from "./CopyTextButton";

const timeOptions: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
function formatSentTime(date: Date, locale: string): string {
  const today = new Date();
  if (date.getFullYear() !== today.getFullYear()) return new Intl.DateTimeFormat(locale, {
    ...timeOptions, year: "numeric", month: "short", day: "numeric",
  }).format(date);
  if (date.getMonth() !== today.getMonth() || date.getDate() !== today.getDate()) {
    return new Intl.DateTimeFormat(locale, { ...timeOptions, month: "short", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, timeOptions).format(date);
}

export function UserMessageFooter({ message }: { message: MessageRecord }) {
  const locale = useAppLocale();
  const date = message.created_at ? new Date(message.created_at) : null;
  const sentAt = date && !Number.isNaN(date.getTime()) ? date : null;
  return (
    <MessageFooter dataTestClass="user-message-footer">
      {sentAt && (
        <time dateTime={sentAt.toISOString()}>{formatSentTime(sentAt, locale)}</time>
      )}
      <CopyTextButton text={message.text} label={appCopy.conversation.messageActions.copyMessage} />
    </MessageFooter>
  );
}
