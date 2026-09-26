import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { CheckCircle2 } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { MarkdownContent } from "../MarkdownContent";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "./index";

// #region recipe: Assistant answer with footer and status
function AssistantAnswer() {
  return (
    <MessageRow role="assistant">
      <MarkdownContent><p>The header block now ends with a divider.</p></MarkdownContent>
      <MessageFooter>
        <CopyButton text="The header block now ends with a divider." label="Copy message" copiedLabel="Copied" />
        <Typo.Text as="time" numeric="tabular">9:09</Typo.Text>
      </MessageFooter>
      <MessageStatusRow>
        <MessageStatusLabel mark={<CheckCircle2 size="sm" />}><Typo.Caption as="span">Response completed</Typo.Caption></MessageStatusLabel>
      </MessageStatusRow>
    </MessageRow>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One message in the timeline: user bubble or full-width assistant document, with footer, status line and insert motion.",
  whenToUse: ["Render a user, assistant or system message"],
  whenNotToUse: [
    { when: "A message waiting in the queue", use: "QueuedMessage" },
    { when: "Tool calls and work progress", use: "WorkActivityBlock" },
  ],
  recipes: [{ name: "Assistant answer with footer and status", description: "MessageFooter holds actions and time; MessageStatusRow holds the terminal status.", render: () => <AssistantAnswer /> }],
  doDont: [
    {
      do: { caption: "Assistant text uses the full readable width, no avatar gutter.", render: () => <AssistantAnswer /> },
      dont: { caption: "Answers in cards look like attachments, not conversation.", render: () => <Card><Typo.Body>The header block now ends with a divider.</Typo.Body></Card> },
    },
  ],
  content: ["Status labels are short (Response completed / 응답 완료); times are local clock times."],
  accessibility: ["Messages are articles in reading order; footers are toolbars of labelled buttons; shimmer is decorative."],
  tokens: ["--user-message-bg", "--page-max-width-reading", "--motion-base", "--motion-distance-sm", "--shimmer-duration"],
};
