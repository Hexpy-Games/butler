import { MarkdownCodeFrame, MarkdownContent } from "../../../../blocks/MarkdownContent";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "../../../../blocks/MessageRow";
import { Card } from "../../../Card";
import { CopyButton } from "../../../CopyButton";
import { IconButton } from "../../../IconButton";
import { CheckCircle2, FolderPlus, MessageSquarePlus } from "../../../Icons";
import { Typo } from "../../../Typo";
import { Box } from "./Box";
import { Line } from "./Line";
import { Part } from "./Part";
import type { TypeCopy } from "./typeCopy";

/**
 * The conversation turn exactly as the product renders it (the MessageRow
 * showcase's turn): the user message; the
 * assistant reply as MarkdownContent (paragraph, list with inline code, a
 * fenced code block in MarkdownCodeFrame) followed by the assistant footer
 * (copy, branch actions, duration, time) and the completed status row.
 */
export function ChatTurn({ copy }: { copy: TypeCopy }) {
  return (
    <Box>
      <Card padding="sm">
        <MessageRow role="user">
          <Line id="ask">{copy.ask}</Line>
        </MessageRow>
        <MessageRow role="assistant">
          <Line id="answer" block>
            <div data-t="wa-i">
              <MarkdownContent>
                <p>{copy.answer}</p>
                <ul>{copy.items.map(([text, code, rest], k) => <li key={k}>{text}{code ? <code>{code}</code> : null}{rest}</li>)}</ul>
                <MarkdownCodeFrame language="bash" actions={<Part name="code-copy"><CopyButton label={copy.copy} copiedLabel={copy.copy} text={copy.command} /></Part>}>
                  <code><Line id="command">{copy.command}</Line></code>
                </MarkdownCodeFrame>
              </MarkdownContent>
            </div>
          </Line>
          <MessageFooter>
            <Part name="chat-icons">
              <CopyButton label={copy.copy} copiedLabel={copy.copy} text={copy.answer} />
              <IconButton label={copy.branch}><MessageSquarePlus size="md" /></IconButton>
              <IconButton label={copy.branchProject}><FolderPlus size="md" /></IconButton>
            </Part>
            <Line id="worked">{copy.worked}</Line>
            <Typo.Text as="time" numeric="tabular"><Line id="meta">{copy.time}</Line></Typo.Text>
          </MessageFooter>
          <MessageStatusRow>
            <MessageStatusLabel mark={<Part name="done-mark"><CheckCircle2 size="sm" /></Part>}>
              <Typo.Caption as="span"><Line id="done">{copy.done}</Line></Typo.Caption>
            </MessageStatusLabel>
          </MessageStatusRow>
        </MessageRow>
      </Card>
    </Box>
  );
}
