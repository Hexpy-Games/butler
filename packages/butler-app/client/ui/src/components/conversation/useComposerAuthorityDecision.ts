import { useRef, useState } from "react";
import { selectActiveAuthorityApprovals, useButlerStore } from "@/app/store.ts";
import type { AuthorityApprovalCard } from "@/app/types.ts";
import type { ComposerSubmit } from "./hooks/composerEventTypes";
import { useComposerStore } from "./composerStore";

export interface ComposerAuthorityDecision {
  title: string; scope: AuthorityApprovalCard["scope"]; pending: boolean; error?: string;
  editingInstruction: boolean; composingMessage: boolean; pendingCount: number; instruction: string;
  setInstruction: (value: string) => void;
  onAllow: () => void; onAllowConversation: () => void; onDeny: () => void;
  onOpenInstruction: () => void; onShowDecision: () => void; onOpenSource: () => void;
  onComposeMessage: () => void;
  onSubmitInstruction: ComposerSubmit;
}

export function useComposerAuthorityDecision(): ComposerAuthorityDecision | undefined {
  const requests = useButlerStore(selectActiveAuthorityApprovals);
  const request = requests[0];
  const sessionId = useButlerStore((state) => state.activeChatId);
  // This draft never overwrites the ordinary session Composer draft.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string>();
  const [collapsed, setCollapsed] = useState<string>();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<string>();
  const inFlight = useRef(new Set<string>());
  if (!request) return undefined;
  const key = `${sessionId}:${request.requestRef}`;
  const instruction = drafts[key] ?? "";
  const decide = async (action: "allow" | "deny" | "modify", scope: "once" | "conversation" = "once") => {
    if (inFlight.current.has(key) || (action === "modify" && !instruction.trim())) return;
    inFlight.current.add(key); setPending(new Set(inFlight.current)); setFailed(undefined);
    const store = useButlerStore.getState();
    const applied = action === "allow" ? await store.allowAuthorityRequest(request.requestRef, sessionId, scope)
      : action === "deny" ? await store.denyAuthorityRequest(request.requestRef, sessionId)
      : await store.modifyAuthorityRequest(request.requestRef, instruction, sessionId);
    inFlight.current.delete(key); setPending(new Set(inFlight.current));
    if (applied) {
      setEditing((value) => value === key ? undefined : value);
      setDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
    } else setFailed(key);
  };
  return {
    title: request.scope ? `${request.scope.title} · ${request.scope.description}` : request.reason,
    scope: request.scope, pending: pending.has(key),
    error: failed === key ? "결정을 전달하지 못했습니다. 다시 시도해 주세요." : undefined,
    editingInstruction: editing === key, composingMessage: collapsed === key, pendingCount: requests.length, instruction,
    setInstruction: (value) => setDrafts((current) => ({ ...current, [key]: value })),
    onAllow: () => void decide("allow"),
    onAllowConversation: () => void decide("allow", "conversation"),
    onDeny: () => void decide("deny"),
    onShowDecision: () => { setEditing(undefined); setCollapsed(undefined); },
    onComposeMessage: () => { setEditing(undefined); setCollapsed(key); },
    onOpenInstruction: () => {
      setEditing(key); setCollapsed(undefined);
      useComposerStore.getState().setEngaged(true);
      requestAnimationFrame(() => useComposerStore.getState().textAreaRef?.current?.focus());
    },
    onSubmitInstruction: (event) => { event.preventDefault(); void decide("modify"); },
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
