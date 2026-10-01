import { Button } from "../../components/Button";
import { ButtonContainer } from "../../components/ButtonContainer";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { Spinner } from "../../components/Spinner";
import { answerText } from "./types";
import type { ComposerQuestionPanelProps, QuestionPanelLabels } from "./types";
import type { useQuestionPanel } from "./useQuestionPanel";
import styles from "./ComposerQuestionPanel.module.css";

export function QuestionActions({ model: m, props, labels }: { model: ReturnType<typeof useQuestionPanel>; props: ComposerQuestionPanelProps; labels: QuestionPanelLabels }) {
  const many = props.questions.length > 1;
  const canSend = m.review || Boolean(answerText(m.question, m.answer));
  const immediate = !many && m.question.type === "single" && !m.otherOpen && !m.answer.other;
  return <div className={styles.actions}>
    {props.state === "working" && <Typo.Caption className={dsClass(styles.working)} tone="tertiary">{labels.working}</Typo.Caption>}
    <ButtonContainer size="sm" justify="end">
      {many && <Button type="button" size="sm" variant="borderless" disabled={m.busy || m.step === 0} onClick={() => m.go(m.step - 1)}>{labels.back}</Button>}
      {!m.review && <Button type="button" size="sm" variant="secondary" disabled={m.busy} onClick={() => {
        if (!many) props.onSkip(); else { m.update({ selected: [], text: "", other: "", skipped: true }); m.go(m.step + 1); }
      }}>{labels.skip}</Button>}
      {(!immediate || m.busy) && <Button type="button" size="sm" disabled={m.busy || !canSend} onClick={() => m.review ? m.send() : m.advance()}
        iconStart={props.state === "submitting" ? <Spinner size={14} /> : undefined}>{many && !m.review ? labels.next : labels.send}</Button>}
    </ButtonContainer>
  </div>;
}
