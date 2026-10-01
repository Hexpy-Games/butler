import { appCopy, useAppLocale } from "@/app/copy";
import { QuestionAnswerCard } from "@/butler-ds";
import { answerProps, questionProps } from "./userQuestions";
import { memo } from "react";
import { areMessageItemPropsEqual } from "./messageItemMemo";
import { MessageContent } from "./MessageContent";
import type { MessageItemProps } from "./messageItemTypes";
import { VirtualMessageRow } from "./VirtualMessageRow";

function MessageItemComponent({
  message,
  virtualRow,
  topOffset,
  copied,
  entering,
  footerMeta,
  onCopyAssistantMessage,
  onCopyContextMenuText,
  rowVirtualizer,
  stewardProgress,
}: MessageItemProps) {
  useAppLocale();
  const question = message.question_answer;
  if (question?.response.status === "answered") return <QuestionAnswerCard
    labels={appCopy.interfaceDetails.questionAnswer} variant={question.response.answers.every(a => a.skipped) ? "skipped" : "answered"}
    questions={questionProps(question.questions.questions)} answers={answerProps(question.questions.questions, question.response.answers)}
    index={virtualRow.index} rowRef={rowVirtualizer.measureElement} offsetY={virtualRow.start + topOffset} entering={entering} />;
  return (
    <VirtualMessageRow
      message={message}
      virtualRow={virtualRow}
      topOffset={topOffset}
      rowVirtualizer={rowVirtualizer}
      entering={entering}
      onCopyContextMenuText={onCopyContextMenuText}
    >
      <MessageContent
        message={message}
        copied={copied}
        footerMeta={footerMeta}
        onCopyAssistantMessage={onCopyAssistantMessage}
        stewardProgress={stewardProgress}
      />
    </VirtualMessageRow>
  );
}

export const MessageItem = memo(MessageItemComponent, areMessageItemPropsEqual);
