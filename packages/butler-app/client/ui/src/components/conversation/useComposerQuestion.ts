import { useRef, useState } from "react";
import { api } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { AuthorityDecisionTransportView, UserQuestionResponse } from "@/app/types";
import type { QuestionAnswer, ComposerQuestionPanelProps } from "@/butler-ds";
import { answerWire, questionProps } from "./userQuestions";

export function useComposerQuestion(): { key: string; panel: ComposerQuestionPanelProps } | undefined {
  useAppLocale();
  const sessionId = useButlerStore(s => s.activeChatId);
  const request = useButlerStore(s => s.sessionViews[s.activeChatId]?.pending_questions?.[0]
    ?? (s.sessionView?.session_id === s.activeChatId ? s.sessionView.pending_questions?.[0] : undefined));
  const [collapsed, setCollapsed] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const draft = useRef<{ key: string; answers: readonly QuestionAnswer[]; step: number } | undefined>(undefined);
  const inFlight = useRef<string | undefined>(undefined);
  if (!request) return undefined;
  const key = `${sessionId}:${request.request_ref}`;
  const questions = request.questions.questions;
  const submit = async (response: UserQuestionResponse) => {
    if (inFlight.current === key) return;
    inFlight.current = key; setPending(key); setFailed(undefined);
    try {
      const reply = await api<AuthorityDecisionTransportView>(`/authority-requests/${encodeURIComponent(request.request_ref)}/answer?session_id=${encodeURIComponent(sessionId)}`, {
        method: "POST", body: JSON.stringify(response),
      });
      if (reply.request_ref !== request.request_ref || reply.decision !== "modified" || reply.scheduled !== true) throw new Error("Answer not accepted");
      await useButlerStore.getState().refreshSessionView(sessionId);
      await useButlerStore.getState().refreshAuthorityApprovals(sessionId);
    } catch { setFailed(key); }
    finally { inFlight.current = undefined; setPending(undefined); }
  };
  return { key, panel: { labels: appCopy.interfaceDetails.questionPanel, questions: questionProps(questions), state: pending === key ? "submitting" : failed === key ? "error" : (collapsed === key || (request.question_state === "deferred" && collapsed !== `expanded:${key}`)) ? "collapsed" : "open",
    error: failed === key ? appCopy.interfaceDetails.decisionFailed : undefined,
    onSubmit: answers => void submit({ status: "answered", answers: answerWire(questions, answers) }), onSkip: () => void submit({ status: "answered", answers: answerWire(questions, []) }),
    onCollapse: () => { setCollapsed(key); if (request.question_state !== "deferred") void submit({ status: "deferred" }); }, onExpand: () => setCollapsed(`expanded:${key}`),
    defaultAnswers: draft.current?.key === key ? draft.current.answers : undefined,
    defaultStep: draft.current?.key === key ? draft.current.step : undefined,
    onDraftChange: (answers, step) => { draft.current = { key, answers, step }; },
  } };
}
