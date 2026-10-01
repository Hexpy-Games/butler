import { useEffect, useRef } from "react";
import { Clickable } from "../../components/Clickable";
import { IconButton } from "../../components/IconButton";
import { IconSlot } from "../../components/IconSlot";
import { Clock3, ListChecks, MessageSquare, Pencil } from "../../components/Icons";
import { ComposerPanelFrame, ComposerPanelHeader, ComposerPanelBody } from "../../lib/composerPanel";
import { Inline } from "../../components/Inline";
import { PillButton } from "../../components/PillButton";
import { Stack } from "../../components/Stack";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/Tabs";
import { Typo } from "../../components/Typo";
import { dsClass } from "../../lib/internal";
import { QuestionOptions } from "./QuestionOptions";
import { QuestionActions } from "./QuestionActions";
import { useQuestionDeferral } from "./useQuestionDeferral";
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
  const panel = useRef<HTMLDivElement>(null);
  const { defer, deferring } = useQuestionDeferral(panel, props.onCollapse, props.state !== "collapsed");
  const m = useQuestionPanel({ ...props, onCollapse: () => defer(), state: deferring ? "working" : props.state });
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
  const { className, style, state = "open", error, questions, onExpand } = props;
  if (state === "collapsed") return <PillButton disabled={!onExpand} onClick={onExpand} icon={<MessageSquare size="md" aria-hidden="true" />}>{labels.pending}</PillButton>;
  const body = <>
    <ComposerPanelHeader icon={<ListChecks size="sm" aria-hidden="true" />} tabbed={questions.length > 1}
      eyebrow={m.review ? labels.review : m.question.header}
      title={<Typo.Label weight="medium" wrap="anywhere">{m.review ? labels.send : m.question.text}</Typo.Label>}
      aside={<IconButton label={labels.later} disabled={m.busy} onClick={() => defer()}><Clock3 size="md" /></IconButton>} />
    <ComposerPanelBody single={questions.length === 1} dataSlot="question-options-scroll">
      {m.review ? <Stack gap="xs">{questions.map((q, i) => <Clickable key={q.id} disabled={m.busy} stretch className={dsClass(styles.option)} onClick={() => m.go(i)}>
        <Inline cross="start" wrap={false} grow><Stack grow minWidth="0" gap="none"><Typo.Caption tone="tertiary">{q.header}</Typo.Caption>
          <Typo.Label wrap="anywhere">{answerText(q, m.answers[i]) || labels.skipped}</Typo.Label></Stack>
          <IconSlot minHeight="line" tone="tertiary"><Pencil size="md" aria-hidden="true" /></IconSlot></Inline>
      </Clickable>)}</Stack> : <QuestionOptions model={m} labels={labels} />}
    </ComposerPanelBody>
    {state === "error" && error && <Typo.Caption className={dsClass(styles.error)} tone="secondary" role="alert">{error}</Typo.Caption>}
    <QuestionActions model={m} props={props} labels={labels} />
  </>;
  return <ComposerPanelFrame panelRef={panel} className={className} style={style} tabIndex={m.busy ? -1 : 0} onKeyDownCapture={m.keyDown}
    aria-label={m.review ? labels.review : m.question.text} aria-busy={state === "submitting"} data-state={state} data-tabbed={questions.length > 1} data-slot="composer-question-panel">
    {questions.length > 1 ? <Tabs value={String(m.step)} onValueChange={(value) => m.go(Number(value))}>
      <div className={styles.tabInset}><TabsList className={dsClass(styles.tabs)} variant="line" aria-label={labels.select}>{questions.map((q, i) => <TabsTrigger className={dsClass(styles.tab)} key={q.id} value={String(i)} disabled={m.busy}>{q.header}</TabsTrigger>)}
        <TabsTrigger className={dsClass(styles.tab)} value={String(questions.length)} disabled={m.busy}>{labels.review}</TabsTrigger></TabsList></div>
      <TabsContent value={String(m.step)}>{body}</TabsContent>
    </Tabs> : body}
  </ComposerPanelFrame>;
}
