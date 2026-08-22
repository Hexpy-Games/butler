import type {
  AuthorityDecisionAction,
  AuthorityDecisionResult,
  PrincipalAuthority,
} from "../../../agent/btcc/authority/index.ts";
import type { MessageSendRequest } from "../interface/protocol/app-protocol.ts";
import type { AppServerStore } from "./store/app-server-store.ts";

export type AuthorityHandoffResult = {
  decision: AuthorityDecisionResult;
  admitted: boolean;
};

export async function decideAndAdmitAuthority(input: {
  authority: PrincipalAuthority;
  store: Pick<AppServerStore, "sendMessage">;
  ownerSessionId: string;
  requestRef: string;
  sourceSessionId: string;
  action: AuthorityDecisionAction;
  alternativeInput?: string;
}): Promise<AuthorityHandoffResult> {
  const decision = input.authority.decide({
    ownerSessionId: input.ownerSessionId,
    requestRef: input.requestRef,
    sourceSessionId: input.sourceSessionId,
    action: input.action,
    ...(input.alternativeInput ? { alternativeInput: input.alternativeInput } : {}),
  });
  return {
    decision,
    admitted: await admitStoredAuthorityInput(input.store, decision),
  };
}

export async function retryDecidedAuthorityInputs(input: {
  authority: PrincipalAuthority;
  store: Pick<AppServerStore, "sendMessage">;
}): Promise<void> {
  for (const decision of input.authority.listDecided()) {
    try {
      await admitStoredAuthorityInput(input.store, decision);
    } catch {
      // The durable decision remains eligible; the next App composition retries
      // the same stored identity through this operation.
    }
  }
}

async function admitStoredAuthorityInput(
  store: Pick<AppServerStore, "sendMessage">,
  decision: AuthorityDecisionResult,
): Promise<boolean> {
  const chatId = chatIdFromSessionHint(decision.sourceSessionId);
  if (!chatId) throw new AuthorityHandoffError("authority_source_session_invalid");
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
    await store.sendMessage(queueInput, undefined, { deferResponderTurns: true });
    return true;
  } catch (error) {
    if (isQueueIdentityConflict(error)) {
      throw new AuthorityHandoffError("authority_queue_identity_conflict");
    }
    return false;
  }
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
