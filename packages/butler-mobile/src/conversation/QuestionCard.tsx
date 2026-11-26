import { useRef, useState } from "react";
import { View } from "react-native";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { AnsweredUserQuestions, AuthorityDecisionResult, PendingUserQuestions, UserQuestion, UserQuestionResponse } from "../../../butler-protocol/src/index.ts";
import { Button, ButtonGroup, DecisionCard, ListRow, Surface, Text, TextField, useTokens } from "@/ds";
import { useAppLocale } from "@/i18n";
import { useConversation } from "./live";
import { answerOptions, answerWire, type QuestionDraft } from "./approval";

export function QuestionCard({ request, sessionId, reload }: { request: PendingUserQuestions; sessionId: string; reload(): void }) {
  const copy = getAppCopy(useAppLocale()), labels = copy.interfaceDetails.questionPanel;
  const t = useTokens();
  const { client } = useConversation();
  const questions = request.questions.questions;
  const [draft, setDraft] = useState<QuestionDraft[]>(() => questions.map(q => ({ id: q.id, selected: [], text: "", other: "", skipped: false })));
  const [pending, setPending] = useState<string>();
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const submit = async (response: UserQuestionResponse, action: string) => {
    if (!client || inFlight.current) return;
    inFlight.current = true; setPending(action); setFailed(false);
    try {
      const result = await client.request<AuthorityDecisionResult>(
        `/authority-requests/${encodeURIComponent(request.request_ref)}/answer?session_id=${encodeURIComponent(sessionId)}`, { body: response });
      if (result.request_ref !== request.request_ref || result.decision !== "modified" || result.scheduled !== true) throw new Error("Answer not accepted");
      setPending("done");
      reload();
    } catch { setFailed(true); inFlight.current = false; setPending(undefined); }
  };
  const update = (id: string, patch: Partial<QuestionDraft>, send = false) => {
    setDraft(previous => {
      const next = previous.map(a => a.id === id ? { ...a, ...patch } : a);
      if (send) void submit({ status: "answered", answers: answerWire(questions, next) }, "send");
      return next;
    });
  };
  const ready = draft.every(a => a.selected.length > 0 || a.text.trim() || a.other.trim());
  return <DecisionCard eyebrow={questions[0].eyebrow} title={questions[0].title}
    footnote={failed ? copy.interfaceDetails.decisionFailed : undefined}
    actions={<ButtonGroup>
      <Button label={labels.send} disabled={!!pending || !ready} loading={pending === "send"}
        onPress={() => void submit({ status: "answered", answers: answerWire(questions, draft) }, "send")} />
      <Button label={labels.skip} variant="secondary" disabled={!!pending} loading={pending === "skip"}
        onPress={() => void submit({ status: "answered", answers: answerWire(questions, []) }, "skip")} />
      {request.question_state === "pending" ? <Button label={labels.later} variant="secondary" disabled={!!pending} loading={pending === "later"}
        onPress={() => void submit({ status: "deferred" }, "later")} /> : null}
    </ButtonGroup>}>
    {questions.map((question, index) => <View key={question.id} style={{ gap: t.length("--space-3") }}>
      {index > 0 ? <><Text variant="caption" tone="secondary">{question.eyebrow}</Text><Text weight="semibold" literal>{question.title}</Text></> : null}
      <QuestionFields question={question} answer={draft[index]} disabled={!!pending}
        update={(patch, send) => update(question.id, patch, send && questions.length === 1)} />
    </View>)}
  </DecisionCard>;
}

function QuestionFields({ question, answer, disabled, update }: {
  question: UserQuestion; answer: QuestionDraft; disabled: boolean; update(patch: Partial<QuestionDraft>, send?: boolean): void;
}) {
  const labels = getAppCopy(useAppLocale()).interfaceDetails.questionPanel;
  const options = answerOptions(question);
  if (!options.length) return <TextField label={question.title} value={answer.text} disabled={disabled}
    onChangeText={text => update({ text, skipped: false })} />;
  return <>
    {options.map((option, index) => <ListRow key={option.id} title={option.label} description={option.description} titleLines={2} descriptionLines={3}
      meta={option.recommended ? labels.recommended : undefined} selected={answer.selected.includes(index)} disabled={disabled}
      selection={question.kind === "multi" ? "multi" : "single"}
      onPress={() => update({ selected: question.kind === "multi"
        ? answer.selected.includes(index) ? answer.selected.filter(i => i !== index) : [...answer.selected, index].sort((a, b) => a - b)
        : [index], skipped: false, ...(question.kind === "single" ? { other: "" } : {}) }, question.kind === "single")} />)}
    {question.allow_custom || options.length < question.options.length ? <TextField label={labels.other} value={answer.other} disabled={disabled}
      onChangeText={other => update({ other, skipped: false, ...(question.kind === "single" ? { selected: [] } : {}) })} /> : null}
  </>;
}

export function QuestionAnswerCard({ answer }: { answer: AnsweredUserQuestions }) {
  const copy = getAppCopy(useAppLocale()).interfaceDetails.questionAnswer;
  const t = useTokens();
  if (answer.response.status !== "answered") return null;
  const answers = answer.response.answers;
  return <View style={{ alignSelf: "flex-end", maxWidth: "85%" }}><Surface variant="card">
    <View style={{ gap: t.length("--space-3") }}>
      <Text variant="caption" tone="secondary">{answers.every(a => a.skipped) ? copy.skipped : copy.answered}</Text>
      {answer.questions.questions.map(question => {
        const value = answers.find(a => a.id === question.id);
        const labels = value?.selected.flatMap(id => question.options.find(o => o.id === id)?.label ?? []) ?? [];
        return <View key={question.id} style={{ gap: t.length("--space-1") }}>
          <Text weight="semibold">{question.title}</Text>
          <Text>{!value || value.skipped ? copy.skipped : [...labels, ...(value.custom ? [value.custom] : [])].join(", ")}</Text>
        </View>;
      })}
    </View>
  </Surface></View>;
}
