import type { DsBaseProps } from "../../lib/dsProps";
import type { HTMLAttributes } from "react";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { MessageRow, type MessageRowProps } from "../MessageRow";
import { answerText, questionPanelLabels } from "../ComposerQuestionPanel/types";
import type { ComposerQuestion, QuestionAnswer } from "../ComposerQuestionPanel";

export interface QuestionAnswerCardProps extends Omit<DsBaseProps<HTMLAttributes<HTMLElement>>, "children" | "role"> {
  index?: MessageRowProps["index"];
  rowRef?: MessageRowProps["rowRef"];
  offsetY?: MessageRowProps["offsetY"];
  entering?: MessageRowProps["entering"];
  questions: readonly ComposerQuestion[];
  answers?: readonly QuestionAnswer[];
  variant?: "answered" | "skipped" | "message";
  message?: string;
  labels?: { answered: string; skipped: string; message: string };
}
/** A completed answer on the user side of the transcript; never executes a tool. */
export function QuestionAnswerCard({ questions, answers = [], variant = "answered", message, labels = {
  answered: "Answered", skipped: questionPanelLabels.skipped, message: "Answered by message",
}, ...props }: QuestionAnswerCardProps) {
  return <MessageRow role="user" data-slot="question-answer-card" {...props}>
    <Stack gap="sm">
      <Typo.Caption tone="tertiary">{labels[variant]}</Typo.Caption>
      {variant === "message" ? <Typo.Body wrap="anywhere">{message}</Typo.Body> : questions.map((q) =>
        <Stack key={q.id} gap="none"><Typo.Caption tone="tertiary">{q.header}</Typo.Caption>
          <Typo.Label wrap="anywhere">{variant === "skipped" ? labels.skipped : answerText(q, answers.find((a) => a.id === q.id)) || labels.skipped}</Typo.Label></Stack>)}
    </Stack>
  </MessageRow>;
}
