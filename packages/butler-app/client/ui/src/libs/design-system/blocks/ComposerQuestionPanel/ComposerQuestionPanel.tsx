import { useEffect, useRef } from "react";
import { Clickable } from "../../components/Clickable";
import { IconButton } from "../../components/IconButton";
import { IconSlot } from "../../components/IconSlot";
import { ChevronDown, GitBranch, MessageSquare, Pencil } from "../../components/Icons";
import { Inline } from "../../components/Inline";
import { PillButton } from "../../components/PillButton";
import { Stack } from "../../components/Stack";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/Tabs";
import { Typo } from "../../components/Typo";
import { ScrollArea } from "../ScrollArea";
import { dsClass } from "../../lib/internal";
import { QuestionOptions } from "./QuestionOptions";
import { QuestionActions } from "./QuestionActions";
import { useQuestionPanel } from "./useQuestionPanel";
import { answerText, questionPanelLabels } from "./types";
import type { ComposerQuestionPanelProps } from "./types";
import styles from "./ComposerQuestionPanel.module.css";

/** Local form state only; the caller owns delivery, errors, collapse and transcript insertion. */
export function ComposerQuestionPanel(props: ComposerQuestionPanelProps) {
  if (props.questions.length < 1 || props.questions.length > 4) throw new Error("ComposerQuestionPanel requires 1–4 questions");
  return <QuestionPanelBody {...props} />;
}
function QuestionPanelBody(props: ComposerQuestionPanelProps) {
  const m = useQuestionPanel(props);
  const panel = useRef<HTMLDivElement>(null);
  const previousStep = useRef(m.step);
  useEffect(() => {
    const tab = panel.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
    const list = tab?.closest<HTMLElement>('[role="tablist"]');
    if (tab && list) {
      const target = tab.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      if (target.left < frame.left) list.scrollLeft -= frame.left - target.left;
      else if (target.right > frame.right) list.scrollLeft += target.right - frame.right;
    }
    if (previousStep.current === m.step) return;
    previousStep.current = m.step;
    if (document.activeElement?.getAttribute("role") === "tab") return;
    const input = panel.current?.querySelector<HTMLInputElement>("input");
    (input ?? panel.current)?.focus({ preventScroll: true });
  }, [m.step]);
  const labels = props.labels ?? questionPanelLabels;
  const { className, style, state = "open", error, questions, onCollapse, onExpand } = props;
  if (state === "collapsed") return <PillButton disabled={!onExpand} onClick={onExpand} icon={<MessageSquare size="md" aria-hidden="true" />}>{labels.pending}</PillButton>;
  const body = <>
    <Inline className={dsClass(styles.subject)} cross="start" wrap={false}>
      <IconSlot className={dsClass(styles.questionIcon)} size="sm" minHeight="line" tone="secondary"><GitBranch size="sm" aria-hidden="true" /></IconSlot>
      <Stack grow minWidth="0" gap="none">
        <Typo.Caption tone="tertiary">{m.review ? labels.review : m.question.header}</Typo.Caption>
        <Typo.Label weight="medium" wrap="anywhere">{m.review ? labels.send : m.question.text}</Typo.Label>
      </Stack>
      <IconButton label={labels.later} disabled={m.busy} onClick={onCollapse}><ChevronDown size="md" /></IconButton>
    </Inline>
    <div className={styles.body}><ScrollArea maxHeight="xs" dataSlot="question-options-scroll"><div className={styles.scrollContent}>
      {m.review ? <Stack gap="xs">{questions.map((q, i) => <Clickable key={q.id} disabled={m.busy} stretch className={dsClass(styles.option)} onClick={() => m.go(i)}>
        <Inline cross="start" wrap={false} grow><Stack grow minWidth="0" gap="none"><Typo.Caption tone="tertiary">{q.header}</Typo.Caption>
          <Typo.Label wrap="anywhere">{answerText(q, m.answers[i]) || labels.skipped}</Typo.Label></Stack>
          <IconSlot minHeight="line" tone="tertiary"><Pencil size="md" aria-hidden="true" /></IconSlot></Inline>
      </Clickable>)}</Stack> : <QuestionOptions model={m} labels={labels} />}
    </div></ScrollArea></div>
    {state === "error" && error && <Typo.Caption className={dsClass(styles.error)} tone="secondary" role="alert">{error}</Typo.Caption>}
    <QuestionActions model={m} props={props} labels={labels} />
  </>;
  return <div ref={panel} className={dsClass(styles.surface, className)} style={style} tabIndex={m.busy ? -1 : 0} onKeyDownCapture={m.keyDown}
    aria-label={m.review ? labels.review : m.question.text} aria-busy={state === "submitting"} data-state={state} data-slot="composer-question-panel">
    {questions.length > 1 ? <Tabs value={String(m.step)} onValueChange={(value) => m.go(Number(value))}>
      <div className={styles.tabInset}><TabsList className={dsClass(styles.tabs)} variant="line" aria-label={labels.select}>{questions.map((q, i) => <TabsTrigger className={dsClass(styles.tab)} key={q.id} value={String(i)} disabled={m.busy}>{q.header}</TabsTrigger>)}
        <TabsTrigger className={dsClass(styles.tab)} value={String(questions.length)} disabled={m.busy}>{labels.review}</TabsTrigger></TabsList></div>
      <TabsContent value={String(m.step)}>{body}</TabsContent>
    </Tabs> : body}
  </div>;
}
