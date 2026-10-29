import type { ShowcaseGuidance } from "../../showcase";
import { Card } from "../../components/Card";
import { CopyButton } from "../../components/CopyButton";
import { CheckCircle2 } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { MarkdownContent } from "../MarkdownContent";
import { MessageBubble, MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow, MessageTurnGroup } from "./index";
import { BUBBLE_COPY, BubbleTurnSample } from "./MessageRow.showcaseParts";

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

// #region recipe: Transcript rows with attached activity
function TranscriptGroup() {
  return <MessageTurnGroup>
    <MessageRow role="assistant"><Typo.Body as="p">Here is the reply.</Typo.Body></MessageRow>
    <MessageRow role="assistant"><MessageStatusLabel mark={<CheckCircle2 size="sm" />}>
      <Typo.Caption as="span">Response completed</Typo.Caption>
    </MessageStatusLabel></MessageRow>
  </MessageTurnGroup>;
}
// #endregion

// #region recipe: Chats bubble with a document
function ChatsBubble() {
  return <BubbleTurnSample copy={BUBBLE_COPY["en-US"]} />;
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "One message in the timeline: user bubble, full-width assistant document or (in 대화 / Chats) a left Butler bubble, with footer, status line and insert motion.",
  whenToUse: ["Render a user, assistant or system message", "bubble: Butler replies in 대화 (Chats); work sessions keep the full-width answer"],
  whenNotToUse: [
    { when: "A message waiting in the queue", use: "QueuedMessage" },
    { when: "Tool calls and work progress", use: "WorkActivityBlock" },
  ],
  recipes: [{ name: "Assistant answer with footer and status", description: "MessageFooter holds actions and time; MessageStatusRow holds the terminal status.", render: () => <AssistantAnswer /> },
    { name: "Chats bubble with a document", description: "role=\"assistant\" bubble: MessageBubble holds the short reply, MessageBubbleAttachments the document card, then copy and time. No completed status row.", render: () => <ChatsBubble /> },
    { name: "Transcript rows with attached activity", description: "Chronological rows share the assistant body gap without adding row padding.", render: () => <TranscriptGroup /> }],
  doDont: [
    {
      do: { caption: "In 대화, one answer is one bubble; long content goes in a document under it.", render: () => <ChatsBubble /> },
      dont: { caption: "A bubble wrapped around the whole turn, footer and all, reads as a card.", render: () => <MessageRow role="assistant" bubble><MessageBubble><Typo.Body>Done. The details are in the document.</Typo.Body><MessageFooter><Typo.Text as="time" numeric="tabular">7:49</Typo.Text></MessageFooter></MessageBubble></MessageRow> },
    },
    {
      do: { caption: "Assistant text uses the full readable width, no avatar gutter.", render: () => <AssistantAnswer /> },
      dont: { caption: "Answers in cards look like attachments, not conversation.", render: () => <Card><Typo.Body>The header block now ends with a divider.</Typo.Body></Card> },
    },
  ],
  content: ["Virtualized rows position themselves with offsetY (translateY); nothing else styles a row.", "Status labels are short (Response completed / 응답 완료); times are local clock times.", "Bubbles (user and Butler) share one shape: --radius-popover (12px), --user-message-bg, max width min(440px, 68%)."],
  accessibility: ["Messages are articles in reading order; footers are toolbars of labelled buttons; shimmer is decorative."],
  tokens: ["--space-lg", "--user-message-bg", "--radius-popover", "--page-max-width-reading", "--motion-base", "--motion-distance-sm", "--shimmer-duration"],
};
