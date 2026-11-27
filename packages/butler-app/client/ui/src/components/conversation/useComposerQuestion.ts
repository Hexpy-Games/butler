import { useEffect, useRef, useState } from "react";
import { api } from "@/app/api";
import { appCopy, useAppLocale } from "@/app/copy";
import { findSessionSummary } from "@/app/optimisticSession";
import { useButlerStore } from "@/app/store";
import type { AuthorityDecisionTransportView, UserQuestionResponse } from "@/app/types";
import type { QuestionAnswer, ComposerQuestionPanelProps } from "@/butler-ds";
import { stashComputerPassword } from "../settings/computersApi";
import type { ComputerPasswordSheetProps } from "./ComputerPasswordSheet";
import { answerWire, questionProps } from "./userQuestions";

export function useWaitingForQuestionAnswer(turnId?: string) {
  return useButlerStore((state) => Boolean(turnId && [...Object.values(state.sessionViews), state.sessionView]
    .some((view) => view?.pending_questions?.some((question) =>
      question.source_turn_id === turnId && question.question_state === "pending"))));
}

interface PasswordSetup {
  key: string;
  name: string;
  requestRef: string;
  answers: readonly QuestionAnswer[];
  busy?: boolean;
  error?: string;
}

export function useComposerQuestion(): {
  key: string; waiting: boolean; panel: ComposerQuestionPanelProps; passwordSheet?: ComputerPasswordSheetProps;
} | undefined {
  useAppLocale();
  const sessionId = useButlerStore(s => s.activeChatId);
  const request = useButlerStore(s => s.sessionViews[s.activeChatId]?.pending_questions?.[0]
    ?? (s.sessionView?.session_id === s.activeChatId ? s.sessionView.pending_questions?.[0] : undefined));
  const [pending, setPending] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const draft = useRef<{ key: string; answers: readonly QuestionAnswer[]; step: number } | undefined>(undefined);
  const inFlight = useRef<string | undefined>(undefined);
  const [setup, setSetup] = useState<PasswordSetup>();
  const stashInFlight = useRef(new Set<string>());
  const key = request ? `${sessionId}:${request.request_ref}` : undefined;
  useEffect(() => {
    setSetup(current => current?.key === key ? current : undefined);
  }, [key]);
  if (!request || !key) return undefined;
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
  const passwordSheet = setup?.key === key ? {
    name: setup.name, busy: Boolean(setup.busy), error: setup.error,
    onCancel: () => { if (!stashInFlight.current.has(key)) setSetup(undefined); },
    async onSubmit(password: string) {
      if (stashInFlight.current.has(key)) return;
      stashInFlight.current.add(key);
      const submitting = { ...setup, busy: true, error: undefined };
      setSetup(submitting);
      try {
        await stashComputerPassword({ request_ref: setup.requestRef, password });
        await submit({ status: "answered", answers: answerWire(questions, setup.answers) });
        setSetup(current => current === submitting ? undefined : current);
      } catch {
        setSetup(current => current === submitting ? { ...current, busy: false, error: appCopy.interfaceDetails.decisionFailed } : current);
      } finally {
        stashInFlight.current.delete(key);
      }
    },
  } : undefined;
  return { key, waiting: request.question_state === "pending", passwordSheet, panel: { labels: appCopy.interfaceDetails.questionPanel, questions: questionProps(questions), state: pending === key ? "submitting" : failed === key ? "error" : "open",
    error: failed === key ? appCopy.interfaceDetails.decisionFailed : undefined,
    onSubmit: answers => {
      const response = answerWire(questions, answers);
      const option = questions.flatMap((q, index) => q.options.filter(o =>
        o.kind === "password_setup" && response[index]?.selected.includes(o.id))).at(0);
      if (option) {
        const summary = findSessionSummary(useButlerStore.getState().navigation, sessionId);
        if (summary && !summary.computer_id) {
          setSetup({ key, name: option.description ?? "", requestRef: request.request_ref, answers });
          return;
        }
      }
      void submit({ status: "answered", answers: response });
    },
    onSkip: () => void submit({ status: "answered", answers: answerWire(questions, []) }),
    onCollapse: request.question_state === "pending" ? () => void submit({ status: "deferred" }) : undefined,
    defaultAnswers: draft.current?.key === key ? draft.current.answers : undefined,
    defaultStep: draft.current?.key === key ? draft.current.step : undefined,
    onDraftChange: (answers, step) => { draft.current = { key, answers, step }; },
  } };
}
