import { CopyButton } from "../../components/CopyButton";
import { IconButton } from "../../components/IconButton";
import { CheckCircle2, FolderPlus, MessageSquarePlus } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "./MessageRow";

export interface MessageFooterLabels {
  copy: string;
  copied: string;
  branchChat: string;
  branchProject: string;
  completed: string;
  workedFor: string;
}

export const MESSAGE_FOOTER_LABELS: MessageFooterLabels = {
  copy: "Copy message",
  copied: "Copied",
  branchChat: "Branch into a new chat",
  branchProject: "Branch into a project",
  completed: "Response completed",
  workedFor: "Worked for 9s",
};

/** User footer as in the product: sent time, then the icon copy action. */
export function UserFooterSample({ text, time, labels = MESSAGE_FOOTER_LABELS }: { text: string; time: string; labels?: MessageFooterLabels }) {
  return (
    <MessageFooter dataTestClass="user-message-footer">
      <Typo.Text as="time" numeric="tabular">{time}</Typo.Text>
      <CopyButton text={text} label={labels.copy} copiedLabel={labels.copied} />
    </MessageFooter>
  );
}

/** Assistant footer as in the product: icon actions, duration and time, then the terminal status row. */
export function AssistantFooterSample({ text, time, labels = MESSAGE_FOOTER_LABELS }: { text: string; time: string; labels?: MessageFooterLabels }) {
  return (
    <>
      <MessageFooter>
        <CopyButton text={text} label={labels.copy} copiedLabel={labels.copied} />
        <IconButton label={labels.branchChat}><MessageSquarePlus size="md" /></IconButton>
        <IconButton label={labels.branchProject}><FolderPlus size="md" /></IconButton>
        <span>{labels.workedFor}</span>
        <Typo.Text as="time" numeric="tabular">{time}</Typo.Text>
      </MessageFooter>
      <MessageStatusRow dataTestClass="assistant-terminal-status-row">
        <MessageStatusLabel mark={<CheckCircle2 size="sm" />}>
          <Typo.Caption as="span">{labels.completed}</Typo.Caption>
        </MessageStatusLabel>
      </MessageStatusRow>
    </>
  );
}

/** Default conversation turn: a user bubble and a complete assistant answer with footers. */
export function MessageTurnSample({ question, answer, labels = MESSAGE_FOOTER_LABELS }: {
  question: string; answer: string; labels?: MessageFooterLabels;
}) {
  return (
    <div>
      <MessageRow role="user" dataTestClass="message user" footer={<UserFooterSample text={question} time="9:08" labels={labels} />}>
        {question}
      </MessageRow>
      <MessageRow role="assistant" dataTestClass="message assistant">
        <p>{answer}</p>
        <AssistantFooterSample text={answer} time="9:09" labels={labels} />
      </MessageRow>
    </div>
  );
}
