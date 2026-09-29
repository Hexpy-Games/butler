import { MarkdownContent } from "../../../../blocks/MarkdownContent";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "../../../../blocks/MessageRow";
import { ButlerThinkingMark } from "../../../ButlerThinkingMark";
import { CopyButton } from "../../../CopyButton";
import { Typo } from "../../../Typo";
import type { MotionCopy } from "./motionCopy";

/** The answer: its text, then (when done) the footer and the terminal status row with the settled mark. */
export function ReplyRow({ copy }: { copy: MotionCopy }) {
  return (
    <MessageRow role="assistant">
      <section aria-label={copy.done}><MarkdownContent><p>{copy.reply}</p></MarkdownContent></section>
      <MessageFooter>
        <CopyButton label={copy.copyResponse} copiedLabel={copy.copyResponse} text={copy.reply} />
        <span>{copy.worked}</span>
        <Typo.Text as="time" numeric="tabular">{copy.sent}</Typo.Text>
      </MessageFooter>
      <MessageStatusRow dataTestClass="assistant-terminal-status-row">
        <MessageStatusLabel mark={<ButlerThinkingMark state="idle" />} title={copy.done}>
          <Typo.Caption as="span">{copy.done}</Typo.Caption>
        </MessageStatusLabel>
      </MessageStatusRow>
    </MessageRow>
  );
}
