import type { ReactNode } from "react";
import { MessageListSurface } from "../../../../blocks/ConversationShell";
import { MarkdownCodeFrame, MarkdownContent } from "../../../../blocks/MarkdownContent";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "../../../../blocks/MessageRow";
import { ButlerThinkingMark } from "../../../ButlerThinkingMark";
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

function AssistantTurn({ copy, children, text, last }: { copy: LayoutCopy; children: ReactNode; text: string; last: boolean }) {
  return (
    <MessageRow role="assistant">
      <MarkdownContent>{children}</MarkdownContent>
      <MessageFooter>
        <CopyButton copiedLabel={copy.copy} label={copy.copy} text={text} />
        <span>{copy.worked}</span>
        <Typo.Text as="time" numeric="tabular">{copy.time}</Typo.Text>
      </MessageFooter>
      {last ? (
        <MessageStatusRow>
          <MessageStatusLabel mark={<ButlerThinkingMark state="idle" />}>
            <Typo.Caption as="span">{copy.done}</Typo.Caption>
          </MessageStatusLabel>
        </MessageStatusRow>
      ) : null}
    </MessageRow>
  );
}

/** The conversation (MessageList): two finished turns, the user bubbles with their footers and the markdown replies (a paragraph, a list, a code block). */
export function Turn({ copy }: { copy: LayoutCopy }) {
  return (
    <MessageListSurface>
      <UserTurn copy={copy} text={copy.ask1} />
      <AssistantTurn copy={copy} last={false} text={copy.answer1}>
        <p>{copy.answer1}</p>
        <ul>{copy.steps.map(([text, code, rest]) => <li key={text}>{text}{code ? <code>{code}</code> : null}{rest}</li>)}</ul>
      </AssistantTurn>
      <UserTurn copy={copy} text={copy.ask2} />
      <AssistantTurn copy={copy} last text={copy.answer2}>
        <p>{copy.answer2}</p>
        <MarkdownCodeFrame actions={<CopyButton copiedLabel={copy.copy} label={copy.copy} text={copy.code} />} language="ts">
          <code>{copy.code}</code>
        </MarkdownCodeFrame>
      </AssistantTurn>
    </MessageListSurface>
  );
}
