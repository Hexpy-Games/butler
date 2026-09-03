import { MessageFooter } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { MessageRecord } from "@/app/types.ts";
import { CopyTextButton } from "./CopyTextButton";

const sentTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function UserMessageFooter({ message }: { message: MessageRecord }) {
  const date = message.created_at ? new Date(message.created_at) : null;
  const sentAt = date && !Number.isNaN(date.getTime()) ? date : null;
  return (
    <MessageFooter dataTestClass="user-message-footer">
      {sentAt && (
        <time dateTime={sentAt.toISOString()}>{sentTimeFormat.format(sentAt)}</time>
      )}
      <CopyTextButton text={message.text} label={appCopy.conversation.messageActions.copyMessage} />
    </MessageFooter>
  );
}
