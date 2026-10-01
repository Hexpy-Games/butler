import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import { answerText } from "./types";
import type { ComposerQuestionPanelProps, QuestionAnswer } from "./types";

export function useQuestionPanel(props: ComposerQuestionPanelProps) {
  const { questions, state = "open" } = props;
  const [step, setStep] = useState(props.defaultStep ?? 0);
  const [answers, setAnswers] = useState<readonly QuestionAnswer[]>(() => questions.map((q) =>
    props.defaultAnswers?.find((a) => a.id === q.id) ?? { id: q.id, selected: [], text: "", other: "", skipped: true }));
  const [highlight, setHighlight] = useState(() => Math.max(0, questions[step]?.options.findIndex((o) => o.recommended) ?? 0));
  useEffect(() => { props.onDraftChange?.(answers, step); }, [answers, step, props.onDraftChange]);
  const [otherOpen, setOtherOpen] = useState(Boolean(answers[step]?.other));
  const busy = state === "working" || state === "submitting";
  const question = questions[step];
  const review = step === questions.length;
  const answer = answers[step];
  const go = (next: number) => {
    if (busy) return;
    const index = Math.max(0, Math.min(questions.length, next));
    setStep(index); setOtherOpen(Boolean(answers[index]?.other));
    setHighlight(Math.max(0, questions[index]?.options.findIndex((o) => o.recommended) ?? 0));
  };
  const update = (patch: Partial<QuestionAnswer>) => {
    const next = answers.map((a, i) => i === step ? { ...a, ...patch } : a);
    setAnswers(next); return next;
  };
  const send = (values = answers) => {
    if (!busy) props.onSubmit(values.map((a, i) => ({ ...a, skipped: !answerText(questions[i]!, a) })));
  };
  const advance = () => questions.length > 1 ? go(step + 1) : send();
  const choose = (index: number) => {
    if (busy || !question) return;
    setHighlight(index);
    if (index === question.options.length) {
      const opening = !otherOpen;
      setOtherOpen(opening);
      update({ other: opening ? answer.other : "", skipped: false, ...(question.type === "single" ? { selected: [] } : {}) });
      return;
    }
    const selected = question.type === "multi"
      ? answer.selected.includes(index) ? answer.selected.filter((v) => v !== index) : [...answer.selected, index].sort((a, b) => a - b)
      : [index];
    const next = update({ selected, skipped: false, ...(question.type === "single" ? { other: "" } : {}) });
    if (question.type === "single") { setOtherOpen(false); if (questions.length === 1) send(next); else go(step + 1); }
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busy || event.nativeEvent.isComposing || event.defaultPrevented) return;
    const input = (event.target as HTMLElement).closest("input, textarea");
    const key = event.key;
    if (key === "Escape") { event.preventDefault(); if (input && otherOpen) { setOtherOpen(false); event.currentTarget.focus({ preventScroll: true }); } else props.onCollapse(); return; }
    if (input) { if (key === "Enter" && answerText(question, answer)) { event.preventDefault(); advance(); } return; }
    if ((event.target as HTMLElement).closest('[role="tab"], button')) return;
    if (questions.length > 1 && (key === "ArrowLeft" || key === "ArrowRight")) { event.preventDefault(); go(step + (key === "ArrowRight" ? 1 : -1)); return; }
    if (review && (event.target as HTMLElement).closest('[role="button"]')) return;
    if (review) { if (key === "Enter") { event.preventDefault(); send(); } return; }
    if (question.type !== "text" && /^[1-9]$/u.test(key) && Number(key) <= question.options.length + Number(Boolean(question.allowOther))) {
      event.preventDefault(); choose(Number(key) - 1); return;
    }
    if (question.type !== "text" && (key === "ArrowDown" || key === "ArrowUp")) {
      event.preventDefault();
      const next = Math.max(0, Math.min(question.options.length - 1 + Number(Boolean(question.allowOther)), highlight + (key === "ArrowDown" ? 1 : -1)));
      setHighlight(next);
      event.currentTarget.querySelectorAll<HTMLElement>("[data-question-option]")[next]?.focus({ preventScroll: true });
      return;
    }
    if (key === " " && question.type === "multi") { event.preventDefault(); choose(highlight); }
    if (key === "Enter") { event.preventDefault(); if (question.type === "single") choose(highlight); else if (answerText(question, answer)) advance(); }
  };
  return { step, answers, answer, question, review, busy, highlight, otherOpen, go, update, choose, send, advance, keyDown };
}
