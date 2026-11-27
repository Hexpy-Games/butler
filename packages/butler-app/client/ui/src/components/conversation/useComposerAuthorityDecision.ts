import { imageApprovalMedia } from "../images/ImageApprovalMedia";
import type { ComposerDecisionDetail, ComposerDecisionMedia } from "@/butler-ds";
import { useBrowserDecisionMedia } from "./useBrowserDecisionMedia";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useCallback, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { approvalRequestView, browserHandoffView, type ApprovalRequestView } from "@/app/approvalRequest.ts";
import { canOpenHandoffTab, openHandoffTab } from "@/components/browser/browserHandoff.ts";
import { selectActiveAuthorityApprovals, useButlerStore } from "@/app/store.ts";
import type { AuthorityApprovalCard } from "@/app/types.ts";

export type InputKind = "username" | "password" | "otp";
export interface HandoffInput {
  origin: string;
  fields: InputKind[];
  live: boolean;
  save_offer: { username: string; host: string } | null;
}

export interface ComposerAuthorityDecision {
  /** The plain-language question, also shown on the pending attachment. */
  media?: ComposerDecisionMedia;
  pathDetails?: string[];
  /** Command bodies come as `{ code }`, drawn in the panel's code frame. */
  title: string; details: ComposerDecisionDetail[]; risk: ApprovalRequestView["risk"]; actionKind: ApprovalRequestView["actionKind"];
  /** What "Always allow in this conversation" covers; the grant needs the legacy `scope`. */
  conversationScope?: string; scope: AuthorityApprovalCard["scope"]; pending: boolean; error?: string;
  composingMessage: boolean; pendingCount: number;
  rulePrefixes?: string[];
  ruleText?: string;
  proposal?: boolean;
  onAllowAlways?: () => void;
  onDenyAlways?: () => void;
  allowSite?: "signed_in" | "payment";
  onAllowSite?: () => void;
  onAllow: () => void; onAllowConversation: () => void; onDeny: () => void;
  onShowDecision: () => void; onOpenSource: () => void;
  onComposeMessage: () => void;
  /** A step only the user can do in a tab: open the tab or stop; the hand-back resolves it. */
  handoff?: {
    canOpenTab: boolean; signIn: boolean; onOpenTab: () => void; onStop: () => void; onDone: () => void;
    inputKey: string;
    loadInput: () => Promise<HandoffInput>;
    fillInput: (origin: string, values: Partial<Record<InputKind, string>>) => Promise<{ status: string; handed_back: boolean }>;
    saveInput: (save: boolean) => Promise<{ saved: boolean; handed_back: boolean }>;
    onHandedBack: () => void;
  };
}

export function useComposerAuthorityDecision(): ComposerAuthorityDecision | undefined {
  useAppLocale();
  const requests = useButlerStore(selectActiveAuthorityApprovals);
  const request = requests[0];
  const media = useBrowserDecisionMedia(request);
  const sessionId = useButlerStore((state) => state.activeChatId);
  const [collapsed, setCollapsed] = useState<string>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string>();
  const inFlight = useRef(new Set<string>());
  const inputPath = `/authority-requests/${encodeURIComponent(request?.requestRef ?? "")}/input`;
  const inputQuery = `?session_id=${encodeURIComponent(sessionId)}`;
  const loadInput = useCallback(() => api<HandoffInput>(inputPath + inputQuery), [inputPath, inputQuery]);
  if (!request) return undefined;
  const key = `${sessionId}:${request.requestRef}`;
  const settle = async (apply: () => Promise<boolean>) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key); setPending(new Set(inFlight.current)); setFailed(undefined);
    const applied = await apply().catch(() => false);
    inFlight.current.delete(key); setPending(new Set(inFlight.current));
    if (!applied) setFailed(key);
  };
  const decide = (action: "allow" | "deny", scope: "once" | "conversation" | "site" | "always" = "once") => settle(async () => {
    const store = useButlerStore.getState();
    return action === "allow" ? store.allowAuthorityRequest(request.requestRef, sessionId, scope)
      : scope === "always" ? store.denyAuthorityRequest(request.requestRef, sessionId, { scope })
        : store.denyAuthorityRequest(request.requestRef, sessionId);
  });
  const view = approvalRequestView(request, appCopy.interfaceTemplates.approvalRequest, appCopy.guided.tools);
  const canOpenTab = canOpenHandoffTab();
  const handoff = browserHandoffView(request, appCopy.interfaceTemplates.approvalRequest, canOpenTab);
  return {
    media: imageApprovalMedia(request) ?? media,
    ...(handoff ? { handoff: { canOpenTab, signIn: handoff.signIn, inputKey: key, loadInput,
      fillInput: (origin, values) => api(inputPath + inputQuery, { method: "POST", body: JSON.stringify({ origin, values }) }),
      saveInput: (save) => api(inputPath + "-save" + inputQuery, { method: "POST", body: JSON.stringify({ save }) }),
      onHandedBack: () => void useButlerStore.getState().refreshAuthorityApprovals(sessionId),
      onOpenTab: () => media?.onOpen ? media.onOpen() : void openHandoffTab(sessionId),
      onStop: () => void stopRequest(request),
      onDone: () => void settle(async () => {
        await api(`/authority-requests/${encodeURIComponent(request.requestRef)}/hand-back?session_id=${encodeURIComponent(sessionId)}`, { method: "POST" });
        return useButlerStore.getState().refreshAuthorityApprovals(sessionId);
      }) } } : {}),
    title: handoff?.title ?? view.title, details: handoff?.details ?? view.details, risk: view.risk, actionKind: view.actionKind,
    pathDetails: view.pathDetails,
    conversationScope: view.conversationScope, scope: request.approval?.operation?.allow_conversation === false ? undefined : request.scope, pending: pending.has(key),
    error: failed === key ? appCopy.interfaceDetails.decisionFailed : undefined,
    composingMessage: collapsed === key, pendingCount: requests.length,
    rulePrefixes: request.approval?.operation?.rule_prefixes,
    ruleText: view.ruleText,
    proposal: request.approval?.operation?.tool === "propose_permission_rule",
    onAllowAlways: () => void decide("allow", "always"),
    onDenyAlways: () => void decide("deny", "always"),
    allowSite: request.approval?.operation?.allow_site,
    onAllowSite: () => void decide("allow", "site"),
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

/** Stop ends the work that raised the request: a delegated task's waiting turn, or this conversation's own. */
function stopRequest(request: AuthorityApprovalCard) {
  const store = useButlerStore.getState();
  const child = store.sessionView?.steward_children?.find((item) => item.session_id === request.sourceSessionId);
  return child ? store.cancelObservedSteward(child.relation.relation_id) : store.cancelActiveTurn();
}
