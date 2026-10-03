import { useCallback, useRef, useState } from "react";
import type { ShowcaseMeta, ShowcaseStory, ShowcaseStateMatrix, ShowcaseRenderContext } from "../../showcase";
import { Button } from "../../components/Button";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { ComposerCard, ComposerCardTextarea, ComposerCardToolbar } from "../ComposerCard";
import { QuestionAnswerCard } from "../QuestionAnswerCard";
import { ComposerQuestionPanel } from "./ComposerQuestionPanel";
import { questionFixtures, koLabels } from "./fixtures";
import type { ComposerQuestion, QuestionAnswer, QuestionPanelState } from "./types";

export const meta: ShowcaseMeta = { title: "ComposerQuestionPanel", category: "Composer", tags: ["question", "form", "composer", "onboarding"], status: "beta" };
function Demo({ context, kind = "single", initial = "open", step = 0 }: {
  context: ShowcaseRenderContext; kind?: keyof ReturnType<typeof questionFixtures>; initial?: QuestionPanelState; step?: number;
}) {
  const ko = context.locale === "ko-KR";
  const questions: ComposerQuestion[] = questionFixtures(ko)[kind];
  const draft = useRef<{ answers?: readonly QuestionAnswer[]; step: number }>({ step });
  const saveDraft = useCallback((values: readonly QuestionAnswer[], index: number) => { draft.current = { answers: values, step: index }; }, []);
  const [state, setState] = useState(initial);
  const [answers, setAnswers] = useState<readonly QuestionAnswer[] | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [message, setMessage] = useState("");
  const [replied, setReplied] = useState(false);
  const [revision, setRevision] = useState(0);
  return <Stack gap="md">
    <Typo.Body>{kind === "onboarding" ? (ko ? "안녕하세요, 버틀러예요. 세 가지만 여쭤볼게요." : "Hello, I’m Butler. Let’s start with three questions.") : (ko ? "준비됐어요. 몇 가지만 정해 주세요." : "Ready. Choose a few details.")}</Typo.Body>
    {(answers || skipped || replied) ? <>
      <QuestionAnswerCard questions={questions} answers={answers ?? []} variant={replied ? "message" : skipped ? "skipped" : "answered"} message={message}
        labels={ko ? { answered: "답변 완료", skipped: "건너뜀", message: "메시지로 답함" } : undefined} />
      <Button size="sm" variant="borderless" onClick={() => { setAnswers(null); setSkipped(false); setReplied(false); setState(initial); draft.current = { step }; setRevision(revision + 1); }}>{ko ? "다시" : "Reset"}</Button>
    </> : <>
      <ComposerCard onSubmit={(e) => e.preventDefault()}
        panel={<ComposerQuestionPanel key={revision} questions={questions} state={state} defaultStep={draft.current.step} onDraftChange={saveDraft}
          defaultAnswers={draft.current.answers ?? (initial === "error" || step === questions.length ? questions.map((q) => ({ id: q.id, selected: q.type === "text" ? [] : [0], text: q.type === "text" ? (ko ? "민수" : "Alex") : "", other: "", skipped: false })) : undefined)}
          labels={ko ? koLabels : undefined} error={ko ? "보내지 못했습니다. 다시 시도하세요." : "Could not send. Try again."}
          onSubmit={(values) => setAnswers(values)} onSkip={() => setSkipped(true)} onCollapse={() => setState("collapsed")} onExpand={() => setState("open")} />}
        controls={<ComposerCardToolbar><Button size="sm" disabled={state !== "collapsed" || !message.trim()} onClick={() => setReplied(true)}>{ko ? "보내기" : "Send"}</Button></ComposerCardToolbar>}>
        <ComposerCardTextarea aria-label={ko ? "메시지" : "Message"} placeholder={ko ? "메시지 작성" : "Write a message"}
          value={message} onChange={(e) => setMessage(e.target.value)} />
      </ComposerCard>
    </>}
  </Stack>;
}
export const stories: ShowcaseStory[] = [
  { name: "Single choice · recommended focus · Other", render: (context) => <Demo context={context} /> },
  { name: "Multiple choice · scroll fades", render: (context) => <Demo context={context} kind="multi" /> },
  { name: "Short text", render: (context) => <Demo context={context} kind="text" /> },
  { name: "Three questions · Tabs · review", render: (context) => <Demo context={context} kind="schedule" step={1} /> },
  { name: "Onboarding · new chat first turn", render: (context) => <Demo context={context} kind="onboarding" /> },
  { name: "Four questions · partial answers", render: (context) => <Demo context={context} kind="four" /> },
  { name: "Keyboard · focus panel to start", render: (context) => <Demo context={context} /> },
  { name: "Review", render: (context) => <Demo context={context} kind="onboarding" step={3} /> },
  { name: "Submitting", render: (context) => <Demo context={context} kind="onboarding" initial="submitting" step={3} /> },
  { name: "Error · retry", render: (context) => <Demo context={context} kind="text" initial="error" /> },
  { name: "Collapsed · answer by message", render: (context) => <Demo context={context} initial="collapsed" /> },
  { name: "Working · disabled", render: (context) => <Demo context={context} initial="working" /> },
];
export const stateMatrix: ShowcaseStateMatrix = {
  states: ["default", "hover", "focus-visible", "disabled", "loading", "invalid"],
  render: ({ state, ...context }) => <Demo context={context} initial={state === "disabled" ? "working" : state === "loading" ? "submitting" : state === "invalid" ? "error" : "open"} />,
};
