import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useRef, useState } from "react";
import { approvalRequestView, browserHandoffView, type ApprovalRequestView } from "@/app/approvalRequest.ts";
import { canOpenHandoffTab, openHandoffTab } from "@/components/browser/browserHandoff.ts";
import { selectActiveAuthorityApprovals, useButlerStore } from "@/app/store.ts";
import type { AuthorityApprovalCard } from "@/app/types.ts";

export interface ComposerAuthorityDecision {
  /** The plain-language question, also shown on the pending attachment. */
  title: string; details: string[]; risk: ApprovalRequestView["risk"]; actionKind: ApprovalRequestView["actionKind"];
  /** What "Always allow in this conversation" covers; the grant needs the legacy `scope`. */
  conversationScope?: string; scope: AuthorityApprovalCard["scope"]; pending: boolean; error?: string;
  composingMessage: boolean; pendingCount: number;
  onAllow: () => void; onAllowConversation: () => void; onDeny: () => void;
  onShowDecision: () => void; onOpenSource: () => void;
  onComposeMessage: () => void;
  /** A step only the user can do in a tab: open the tab or stop; the hand-back resolves it. */
  handoff?: { canOpenTab: boolean; signIn: boolean; onOpenTab: () => void; onStop: () => void };
}

export function useComposerAuthorityDecision(): ComposerAuthorityDecision | undefined {
  useAppLocale();
  const requests = useButlerStore(selectActiveAuthorityApprovals);
  const request = requests[0];
  const sessionId = useButlerStore((state) => state.activeChatId);
  const [collapsed, setCollapsed] = useState<string>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string>();
  const inFlight = useRef(new Set<string>());
  if (!request) return undefined;
  const key = `${sessionId}:${request.requestRef}`;
  const decide = async (action: "allow" | "deny", scope: "once" | "conversation" = "once") => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key); setPending(new Set(inFlight.current)); setFailed(undefined);
    const store = useButlerStore.getState();
    const applied = action === "allow" ? await store.allowAuthorityRequest(request.requestRef, sessionId, scope)
      : await store.denyAuthorityRequest(request.requestRef, sessionId);
    inFlight.current.delete(key); setPending(new Set(inFlight.current));
    if (!applied) setFailed(key);
  };
  const view = approvalRequestView(request, appCopy.interfaceTemplates.approvalRequest, appCopy.guided.tools);
  const canOpenTab = canOpenHandoffTab();
  const handoff = browserHandoffView(request, appCopy.interfaceTemplates.approvalRequest, canOpenTab);
  return {
    ...(handoff ? { handoff: { canOpenTab, signIn: handoff.signIn,
      onOpenTab: () => void openHandoffTab(sessionId),
      onStop: () => void useButlerStore.getState().cancelActiveTurn() } } : {}),
    title: handoff?.title ?? view.title, details: handoff?.details ?? view.details, risk: view.risk, actionKind: view.actionKind,
    conversationScope: view.conversationScope, scope: request.approval?.operation?.allow_conversation === false ? undefined : request.scope, pending: pending.has(key),
    error: failed === key ? appCopy.interfaceDetails.decisionFailed : undefined,
    composingMessage: collapsed === key, pendingCount: requests.length,
    onAllow: () => void decide("allow"),
    onAllowConversation: () => void decide("allow", "conversation"),
    onDeny: () => void decide("deny"),
    onShowDecision: () => setCollapsed(undefined),
    onComposeMessage: () => setCollapsed(key),
    onOpenSource: () => {
      const target = [...document.querySelectorAll<HTMLElement>("[data-turn-id]")]
        .find((element) => element.dataset.turnId === request.sourceTurnId);
      if (target) {
        target.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      else if (request.sourceSessionId && request.sourceSessionId !== `butler/app-${sessionId}`)
        useButlerStore.getState().openSessionObserver(request.sourceSessionId, request.sourceTurnId);
    },
  };
}
