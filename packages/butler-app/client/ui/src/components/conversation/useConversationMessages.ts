import { useMemo } from "react";
import { useButlerStore } from "@/app/store.ts";
import { withQuestionAnswers } from "./userQuestions.ts";
import { withCanonProposals } from "./canonProposalMessages.ts";
/** Turn/call anchored cards and answered questions share the transcript projection. */
export function useConversationMessages(session: string) {
  const stored = useButlerStore(state => state.messages);
  const answers = useButlerStore(state => state.sessionViews[session]?.question_answers
    ?? (state.sessionView?.session_id === session ? state.sessionView.question_answers : undefined));
  const proposals = useButlerStore(state => state.sessionViews[session]?.canon_proposals
    ?? (state.sessionView?.session_id === session ? state.sessionView.canon_proposals : undefined));
  return useMemo(() => withCanonProposals(withQuestionAnswers(stored, answers ?? []), proposals ?? []), [stored, answers, proposals]);
}
