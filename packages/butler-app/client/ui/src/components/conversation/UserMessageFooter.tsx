import { useAppLocale } from "@/app/copy.ts";
import { MessageFooter, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { formatClock } from "@/app/formatClock";
import type { MessageRecord } from "@/app/types.ts";
import { CopyTextButton } from "./CopyTextButton";

export function UserMessageFooter({ message }: { message: MessageRecord }) {
  const locale = useAppLocale();
  const date = message.created_at ? new Date(message.created_at) : null;
  const sentAt = date && !Number.isNaN(date.getTime()) ? date : null;
  return (
    <MessageFooter dataTestClass="user-message-footer">
      {sentAt && (
        <Typo.Text as="time" dateTime={sentAt.toISOString()} numeric="tabular">
          {formatClock(sentAt, locale)}
        </Typo.Text>
      )}
      <CopyTextButton text={message.text} label={appCopy.conversation.messageActions.copyMessage} />
    </MessageFooter>
  );
}
