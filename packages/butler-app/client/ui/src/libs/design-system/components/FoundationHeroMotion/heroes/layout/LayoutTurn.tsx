import type { ReactNode } from "react";
import { MessageListSurface } from "../../../../blocks/ConversationShell";
import { MarkdownContent } from "../../../../blocks/MarkdownContent";
import { MessageFooter, MessageRow } from "../../../../blocks/MessageRow";
import { CopyButton } from "../../../CopyButton";
import { Typo } from "../../../Typo";
import type { LayoutCopy } from "./layoutCopy";

function UserTurn({ copy, text }: { copy: LayoutCopy; text: string }) {
  return (
    <MessageRow
      footer={<MessageFooter><Typo.Text as="time" numeric="tabular">{copy.time}</Typo.Text><CopyButton copiedLabel={copy.copy} label={copy.copy} text={text} /></MessageFooter>}
      role="user"
    >
      {text}
    </MessageRow>
  );
}

function AssistantTurn({ copy, children, text }: { copy: LayoutCopy; children: ReactNode; text: string }) {
  return (
    <MessageRow role="assistant">
      <MarkdownContent>{children}</MarkdownContent>
      <MessageFooter>
        <CopyButton copiedLabel={copy.copy} label={copy.copy} text={text} />
        <span>{copy.worked}</span>
        <Typo.Text as="time" numeric="tabular">{copy.time}</Typo.Text>
      </MessageFooter>
    </MessageRow>
  );
}

/** The conversation (MessageList): one finished turn, the user bubble with its footer and the markdown reply (a paragraph, a list with inline code); short enough to fit the phone-width window, so nothing scrolls under the titlebar or composer. */
export function Turn({ copy }: { copy: LayoutCopy }) {
  return (
    <MessageListSurface>
      <UserTurn copy={copy} text={copy.ask1} />
      <AssistantTurn copy={copy} text={copy.answer1}>
        <p>{copy.answer1}</p>
        <ul>{copy.steps.map(([text, code, rest]) => <li key={text}>{text}{code ? <code>{code}</code> : null}{rest}</li>)}</ul>
      </AssistantTurn>
    </MessageListSurface>
  );
}
