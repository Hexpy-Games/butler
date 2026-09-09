import type { AuthorityDecisionAction, AuthorityDecisionResult, PrincipalAuthority } from "../../../agent/btcc/authority/index.ts";
import type { AppServerStore } from "./store/app-server-store.ts";
import type { StewardObserverReader } from "../domain/sessions/steward-observer.ts";
import { NativeInboundQueue } from "../../core/inbound-queue.ts";
import { createAppResumeEnvelope } from "../../core/app-transport.ts";

export type AuthorityHandoffResult = { decision: AuthorityDecisionResult; admitted: boolean };

export async function decideAndAdmitAuthority(input: {
  authority: PrincipalAuthority;
  store: Pick<AppServerStore, "sendMessage">;
  butlerData: string;
  stewardObserver: StewardObserverReader;
  ownerSessionId: string;
  requestRef: string;
  action: AuthorityDecisionAction;
  allowScope?: "once" | "conversation";
  alternativeInput?: string;
}): Promise<AuthorityHandoffResult> {
  const decision = input.authority.decide({
    ownerSessionId: input.ownerSessionId, requestRef: input.requestRef,
    action: input.action,
    allowScope: input.allowScope,
    ...(input.alternativeInput ? { alternativeInput: input.alternativeInput } : {}),
  });
  return { decision, admitted: enqueueAuthorityResume(input.authority, decision, input.butlerData) };
}

export async function retryDecidedAuthorityInputs(input: {
  authority: PrincipalAuthority;
  butlerData: string;
  store?: Pick<AppServerStore, "sendMessage">;
  stewardObserver?: StewardObserverReader;
}): Promise<void> {
  for (const decision of input.authority.listDecided()) {
    enqueueAuthorityResume(input.authority, decision, input.butlerData);
  }
}

/** Uses the existing control queue, never a new user message or synthetic Turn. */
function enqueueAuthorityResume(authority: PrincipalAuthority, decision: AuthorityDecisionResult, butlerData: string): boolean {
  const source = authority.resumeSource(decision.requestRef);
  // A repeated decision may arrive after the same source has already resumed.
  // The persisted decision is still accepted; it must not enqueue a new Turn.
  if (!source) return true;
  const destination = source.destination;
  const envelope = createAppResumeEnvelope({
    chatId: destination?.peer.id ?? source.sessionId,
    sessionId: source.sessionId, turnId: source.turnId,
    requestId: decision.requestRef,
    requestedAt: new Date().toISOString(),
    originalEventId: source.originalEventId,
    originalMessageId: source.originalMessageId, originalMessage: source.originalMessage,
    appQueueClaimId: destination?.appQueueClaimId,
  });
  if (destination) {
    envelope.transport = destination.transport;
    envelope.accountId = destination.accountId;
    envelope.peer = destination.peer;
  }
  new NativeInboundQueue(butlerData).enqueueIdempotent(envelope);
  return true;
}

export class AuthorityHandoffError extends Error {
  constructor(readonly code: string) {
    super(code); this.name = "AuthorityHandoffError";
  }
}
