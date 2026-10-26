import { CopyButton } from "../../components/CopyButton";
import { IconButton } from "../../components/IconButton";
import { CheckCircle2, FileText, FolderPlus, MessageSquarePlus } from "../../components/Icons";
import { Typo } from "../../components/Typo";
import { ArtifactList } from "../ArtifactList";
import { MarkdownContent } from "../MarkdownContent";
import { MessageFooter, MessageRow, MessageStatusLabel, MessageStatusRow } from "./MessageRow";
import { MessageBubble, MessageBubbleAttachments } from "./MessageBubble";

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

export const MESSAGE_FOOTER_LABELS_KO: MessageFooterLabels = {
  copy: "메시지 복사", copied: "복사됨", branchChat: "새 대화로 분기",
  branchProject: "프로젝트로 분기", completed: "응답 완료", workedFor: "9초 동안 작업",
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

export interface BubbleTurnCopy {
  question: string;
  reply: string;
  document: string;
  documentMeta: string;
  documents: string;
}

export const BUBBLE_COPY: Record<"en-US" | "ko-KR", BubbleTurnCopy> = {
  "en-US": {
    question: "Can you sum up the exchange rate and the US market this week?",
    reply: "Done. The dollar held near 1,380 won all week, and US stocks rose on tech. The details are in the document.",
    document: "Exchange rate and US market, Oct 20–24", documentMeta: "Document", documents: "Documents",
  },
  "ko-KR": {
    question: "이번 주 환율이랑 미국 증시 흐름 좀 정리해 줄래요?",
    reply: "정리해 뒀어요. 달러는 한 주 내내 1,380원 근처였고, 미국 증시는 기술주 위주로 올랐어요. 자세한 건 문서에 담았어요.",
    document: "환율·미국 증시 정리 (10월 20–24일)", documentMeta: "문서", documents: "문서",
  },
};

/** 대화 (Chats) turn: a short Butler bubble on the left, its document under it, then copy and time. */
export function BubbleTurnSample({ copy, labels = MESSAGE_FOOTER_LABELS }: { copy: BubbleTurnCopy; labels?: MessageFooterLabels }) {
  return (
    <div>
      <MessageRow role="user" dataTestClass="message user" footer={<UserFooterSample text={copy.question} time="7:48" labels={labels} />}>
        {copy.question}
      </MessageRow>
      <MessageRow role="assistant" bubble dataTestClass="message assistant">
        <MessageBubble><MarkdownContent><p>{copy.reply}</p></MarkdownContent></MessageBubble>
        <MessageBubbleAttachments>
          <ArtifactList aria-label={copy.documents} items={[{ id: "brief", title: copy.document, description: copy.documentMeta,
            icon: <FileText size="lg" />, onOpen: () => undefined }]} />
        </MessageBubbleAttachments>
        <MessageFooter>
          <CopyButton text={copy.reply} label={labels.copy} copiedLabel={labels.copied} />
          <Typo.Text as="time" numeric="tabular">7:49</Typo.Text>
        </MessageFooter>
      </MessageRow>
    </div>
  );
}
