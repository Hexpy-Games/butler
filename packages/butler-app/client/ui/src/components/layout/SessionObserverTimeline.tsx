import { Fragment, type ReactNode } from "react";
import type { MessageRecord } from "@/app/types.ts";
import { MessageRow } from "@/butler-ds";
import { MessageContent } from "@/components/conversation/MessageContent.tsx";

export function SessionObserverTimeline({
  messages,
  children,
}: {
  messages: MessageRecord[];
  children?: ReactNode;
}) {
  const orderedMessages = [...messages].sort((left, right) =>
    left.created_at && right.created_at
      ? left.created_at.localeCompare(right.created_at)
      : 0,
  );

  return (
    <>
      {orderedMessages.map((message) => (
        <Fragment key={message.id}>
          <MessageRow
            role={message.role === "user" ? "user" : "assistant"}
            dataTestClass="steward-observer-message"
          >
            <MessageContent message={message} copied={false} footerMeta={null} />
          </MessageRow>
        </Fragment>
      ))}
      {children}
    </>
  );
}
