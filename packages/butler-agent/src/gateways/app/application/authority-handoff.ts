import type {
  AuthorityDecisionAction,
  AuthorityDecisionResult,
  PrincipalAuthority,
} from "../../../agent/btcc/authority/index.ts";
import type { MessageSendRequest } from "../interface/protocol/app-protocol.ts";
import type { AppServerStore } from "./store/app-server-store.ts";
import type { StewardObserverReader } from
  "../domain/sessions/steward-observer.ts";
import { NativeInboundQueue } from "../../core/inbound-queue.ts";
import { createHash } from "node:crypto";
import { resolveSubsessionAuthorityOwner } from
  "../../../agent/btcc/subsessions/index.ts";

export type AuthorityHandoffResult = {
  decision: AuthorityDecisionResult;
  admitted: boolean;
};

export async function decideAndAdmitAuthority(input: {
  authority: PrincipalAuthority;
  store: Pick<AppServerStore, "sendMessage">;
  butlerData: string;
  stewardObserver: StewardObserverReader;
  ownerSessionId: string;
  requestRef: string;
  action: AuthorityDecisionAction;
  alternativeInput?: string;
}): Promise<AuthorityHandoffResult> {
  const decision = input.authority.decide({
    ownerSessionId: input.ownerSessionId,
    requestRef: input.requestRef,
    action: input.action,
    ...(input.alternativeInput ? { alternativeInput: input.alternativeInput } : {}),
  });
  return {
    decision,
    admitted: await admitStoredAuthorityInput({
      store: input.store,
      decision,
      butlerData: input.butlerData,
      stewardObserver: input.stewardObserver,
      expectedOwnerSessionId: input.ownerSessionId,
    }),
  };
}

export async function retryDecidedAuthorityInputs(input: {
  authority: PrincipalAuthority;
  store: Pick<AppServerStore, "sendMessage">;
  butlerData: string;
  stewardObserver: StewardObserverReader;
}): Promise<void> {
  for (const decision of input.authority.listDecided()) {
    try {
      await admitStoredAuthorityInput({
        store: input.store,
        decision,
        butlerData: input.butlerData,
        stewardObserver: input.stewardObserver,
      });
    } catch {
      // The durable decision remains eligible; the next App composition retries
      // the same stored identity through this operation.
    }
  }
}

async function admitStoredAuthorityInput(
  input: {
    store: Pick<AppServerStore, "sendMessage">;
    decision: AuthorityDecisionResult;
    butlerData: string;
    stewardObserver: StewardObserverReader;
    expectedOwnerSessionId?: string;
  },
): Promise<boolean> {
  const { decision } = input;
  const chatId = chatIdFromSessionHint(decision.sourceSessionId);
  if (!chatId) {
    enqueueSubsessionAuthorityInput(input);
    return true;
  }
  const queueInput: MessageSendRequest = {
    chat_id: chatId,
    text: decision.scheduleInputText,
    client_message_id: decision.scheduleClientMessageId,
    model: decision.modelRef,
    reasoning_effort: decision.reasoningEffort as MessageSendRequest["reasoning_effort"],
    access_mode: "ask_first",
    authority_request_ref: decision.requestRef,
  };
  try {
    await input.store.sendMessage(queueInput, undefined, { deferResponderTurns: true });
    return true;
  } catch (error) {
    if (isQueueIdentityConflict(error)) {
      throw new AuthorityHandoffError("authority_queue_identity_conflict");
    }
    return false;
  }
}

function enqueueSubsessionAuthorityInput(input: {
  decision: AuthorityDecisionResult;
  butlerData: string;
  stewardObserver: StewardObserverReader;
  expectedOwnerSessionId?: string;
}): void {
  const { decision, stewardObserver } = input;
  const relation = stewardObserver.relationForChild(decision.sourceSessionId);
  if (!relation) throw new AuthorityHandoffError("authority_source_session_invalid");
  let ownerSessionId: string;
  try {
    ownerSessionId = resolveSubsessionAuthorityOwner({
      sourceSessionId: decision.sourceSessionId,
      relationForChild: (sessionId) => stewardObserver.relationForChild(sessionId),
    });
  } catch {
    throw new AuthorityHandoffError("authority_source_session_invalid");
  }
  if (input.expectedOwnerSessionId && ownerSessionId !== input.expectedOwnerSessionId) {
    throw new AuthorityHandoffError("authority_source_session_invalid");
  }
  const turnId = `authority-turn-${createHash("sha256")
    .update(decision.requestRef)
    .digest("hex")
    .slice(0, 32)}`;
  new NativeInboundQueue(input.butlerData).enqueueIdempotent({
    eventId: `authority-continuation:${decision.requestRef}`,
    transport: "app",
    accountId: "local",
    peer: {
      kind: "dm",
      id: decision.sourceSessionId,
      parentId: relation.parent_session_id,
    },
    sender: { id: "butler-authority", displayName: "Butler" },
    message: {
      id: decision.scheduleClientMessageId,
      text: decision.scheduleInputText,
      timestamp: new Date().toISOString(),
    },
    routingHints: {
      sessionId: decision.sourceSessionId,
      turnId,
      authorityRequestRef: decision.requestRef,
      authorityClientMessageId: decision.scheduleClientMessageId,
    },
    raw: { source: "btcc-authority-continuation" },
  });
}

function isQueueIdentityConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" &&
    "code" in error && (error as { code?: unknown }).code === "queued_message_identity_conflict");
}

function chatIdFromSessionHint(sessionId: string): string | null {
  const prefix = "butler/app-";
  if (!sessionId.startsWith(prefix)) return null;
  const chatId = sessionId.slice(prefix.length);
  return chatId || null;
}

export class AuthorityHandoffError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AuthorityHandoffError";
  }
}
