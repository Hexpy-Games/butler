import type { UserQuestion, UserQuestionAnswer, MessageRecord, AnsweredUserQuestions } from "@/app/types";
import type { ComposerQuestion, QuestionAnswer } from "@/butler-ds";

export function questionProps(questions: readonly UserQuestion[]): ComposerQuestion[] {
  return questions.map(q => ({ id: q.id, header: q.eyebrow, text: q.title, type: q.kind,
    options: q.options, allowOther: q.allow_custom }));
}
export function answerProps(questions: readonly UserQuestion[], answers: readonly UserQuestionAnswer[]): QuestionAnswer[] {
  return answers.map(a => ({ id: a.id, selected: a.selected.map(id => questions.find(q => q.id === a.id)?.options.findIndex(o => o.id === id) ?? -1),
    text: "", other: a.custom ?? "", skipped: a.skipped }));
}
export function answerWire(questions: readonly UserQuestion[], answers: readonly QuestionAnswer[]): UserQuestionAnswer[] {
  return questions.map(q => {
    const a = answers.find(a => a.id === q.id);
    return { id: q.id, selected: a?.selected.flatMap(i => q.options[i] ? [q.options[i].id] : []) ?? [],
      custom: a?.other.trim() || a?.text.trim() || null, skipped: a?.skipped ?? true };
  });
}

/** Answers occupy their own user row before the continuing assistant response. */
export function withQuestionAnswers(messages: MessageRecord[], answers: readonly AnsweredUserQuestions[]): MessageRecord[] {
  const completed = answers.filter(a => a.response.status === "answered");
  if (!completed.length) return messages;
  const messageIds = new Set(messages.map(m => m.id));
  const followups = new Map(completed.map(a => [`question-followup-${a.request_ref}`, a]));
  const remaining = new Map<string, AnsweredUserQuestions[]>();
  for (const answer of completed) {
    if (messageIds.has(`question-followup-${answer.request_ref}`)) continue;
    const group = remaining.get(answer.source_turn_id) ?? [];
    group.push(answer); remaining.set(answer.source_turn_id, group);
  }
  const result: MessageRecord[] = [];
  const insert = (turn?: string) => {
    const group = turn ? remaining.get(turn) : undefined;
    for (const answer of group ?? []) result.push({ id: answer.request_ref, role: "user", text: "", question_answer: answer,
      turn_id: answer.source_turn_id, created_at: answer.updated_at, updated_at: answer.updated_at });
    if (turn) remaining.delete(turn);
  };
  for (const message of messages) {
    if (message.role === "assistant") insert(message.turn_id);
    const answer = followups.get(message.id);
    result.push(answer ? { ...message, text: "", question_answer: answer } : message);
  }
  for (const turn of remaining.keys()) insert(turn);
  return result;
}
