import { selectActiveAuthorityApprovals, useButlerStore } from "@/app/store.ts";
import { usePendingAsks } from "../session-info/usePendingAsks.ts";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ComposerQuestionPanel, Stack } from "@/butler-ds";
import { useComposerDecision } from "./hooks/useComposerDecision";
import { ComposerAuthorityDecisionSurface } from "./ComposerAuthorityDecisionSurface";
import { ComposerPlanDecisionSurface } from "./ComposerPlanDecisionSurface";

interface RequestSlot {
  active: boolean;
  setActive: (active: boolean) => void;
  kind?: "approval" | "question";
  setKind: (kind: "approval" | "question" | undefined) => void;
  sourceMessageId?: string | null;
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
}
const RequestContext = createContext<RequestSlot | null>(null);
export const useConversationRequest = () => useContext(RequestContext);

export function ConversationRequestProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const [kind, setKind] = useState<"approval" | "question">();
  const sessionId = useButlerStore(state => state.activeChatId);
  const asks = usePendingAsks(sessionId);
  const sourceTurnId = useButlerStore(state => kind === "approval" ? selectActiveAuthorityApprovals(state)[0]?.sourceTurnId
    : state.sessionViews[sessionId]?.pending_questions?.[0]?.source_turn_id ?? (state.sessionView?.session_id === sessionId ? state.sessionView.pending_questions?.[0]?.source_turn_id : undefined));
  const sourceCallId = useButlerStore(state => kind === "approval" ? selectActiveAuthorityApprovals(state)[0]?.sourceCallId : undefined);
  const sourceMessageId = asks?.asks.find(ask => ask.kind === kind && ask.source_session_id === sessionId &&
    ask.source_turn_id === sourceTurnId && (!sourceCallId || ask.source_call_id === sourceCallId))?.source_message_id;
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ active, setActive, kind, setKind, sourceMessageId, target, setTarget }), [active, kind, sourceMessageId, target]);
  return <RequestContext.Provider value={value}>{children}</RequestContext.Provider>;
}

/** Composer keeps decision state and submission; the transcript owns its placement. */
export function ConversationRequestPortal({ decision }: { decision: ReturnType<typeof useComposerDecision> }) {
  const slot = useConversationRequest();
  if (!slot?.target) return null;
  const { authority, question, plan } = decision;
  const content = authority && !authority.composingMessage
    ? <ComposerAuthorityDecisionSurface decision={authority} placement="conversation" />
    : !authority && question ? <ComposerQuestionPanel key={question.key} {...question.panel} placement="conversation" />
    : !authority && plan && !plan.editingInstruction ? <ComposerPlanDecisionSurface decision={plan} placement="conversation" /> : null;
  return createPortal(content, slot.target);
}

export function useConversationDecision(isComposing: boolean, enabled: boolean) {
  const decision = useComposerDecision(isComposing, enabled);
  const requestSlot = useConversationRequest();
  const active = Boolean(decision.authority && !decision.authority.composingMessage ||
    !decision.authority && (decision.question || decision.plan && !decision.plan.editingInstruction));
  const kind = decision.authority ? "approval" : decision.question ? "question" : undefined;
  useEffect(() => { requestSlot?.setActive(active); requestSlot?.setKind(kind); }, [requestSlot?.setActive, requestSlot?.setKind, active, kind]);
  const surface = {
    planDecision: requestSlot && !decision.plan?.editingInstruction ? undefined : decision.plan,
    authorityDecision: requestSlot && !decision.authority?.composingMessage ? undefined : decision.authority,
    question: requestSlot ? undefined : decision.question,
  };
  return { decision, requestSlot, surface };
}

export function ConversationRequestAnchor({ messageId }: { messageId: string }) {
  const slot = useConversationRequest();
  return slot?.active && slot.sourceMessageId === messageId ? <ConversationRequestSlot setTarget={slot.setTarget} messageId={messageId} /> : null;
}

/** Inline-size-contained panels need the row's width, including in bubble rows. */
export function ConversationRequestSlot({ setTarget, messageId }: { setTarget: RequestSlot["setTarget"]; messageId?: string }) {
  return <Stack.Item alignSelf="stretch">
    <div ref={setTarget} data-test-class="conversation-request" data-request-source-message={messageId} />
  </Stack.Item>;
}
