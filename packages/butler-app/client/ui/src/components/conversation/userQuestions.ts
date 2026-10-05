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
  const remaining = completed.filter(answer => !messageIds.has(`question-followup-${answer.request_ref}`))
    .sort((left, right) => Date.parse(left.updated_at) - Date.parse(right.updated_at));
  let nextAnswer = 0;
  const result: MessageRecord[] = [];
  const insert = (answer: AnsweredUserQuestions) => {
    result.push({ id: answer.request_ref, role: "user", text: "", question_answer: answer,
      turn_id: answer.source_turn_id, created_at: answer.updated_at, updated_at: answer.updated_at });
  };
  for (const message of messages) {
    // Message creation belongs to this segment, not the turn's start. A later
    // streamed delta updates the segment but never moves the principal answer.
    while (nextAnswer < remaining.length && Date.parse(remaining[nextAnswer].updated_at) <= Date.parse(message.created_at ?? "")) {
      insert(remaining[nextAnswer++]);
    }
    const answer = followups.get(message.id);
    result.push(answer ? { ...message, text: "", question_answer: answer } : message);
  }
  while (nextAnswer < remaining.length) insert(remaining[nextAnswer++]);
  return result;
}
