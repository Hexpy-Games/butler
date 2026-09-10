import { createIngestTaskMemoryToolHandler } from "./ingest_task_memory/executor.ts";
import { createRecallMemoryToolHandler } from "./recall_memory/executor.ts";
import { createQueryMemoryToolHandler } from "./query_memory/executor.ts";
import { createSummarizeUserProfileToolHandler } from "./summarize_user_profile/executor.ts";
import { createUpdateOnboardingProfileToolHandler } from "./update_onboarding_profile/executor.ts";
import { createReadConversationContextToolHandler } from "./read_conversation_context/executor.ts";
import { createListConversationSessionsToolHandler } from "./list_conversation_sessions/executor.ts";
import { createReadConversationSessionToolHandler } from "./read_conversation_session/executor.ts";
import { createUpdateExplicitMemoryToolHandler } from "./update_explicit_memory/executor.ts";
import { createLazyConversationProjectionReader } from "../../conversation/projection-reader-store.ts";
import type { ButlerToolCall } from "../types.ts";

type MemoryToolInput = Parameters<typeof createIngestTaskMemoryToolHandler>[0];
type V2BindingFailure = {
  ok: false;
  code: "invalid_scope" | "backend_unavailable";
  diagnostics: string[];
};

export function createMemoryToolHandlers(input: MemoryToolInput) {
  const recallMemory = createRecallMemoryToolHandler(input);
  const queryMemory = createQueryMemoryToolHandler(input);
  const listConversationSessions = createListConversationSessionsToolHandler(
    input,
  );
  const readConversationSession = createReadConversationSessionToolHandler(
    input,
  );
  return {
    "ingest_task_memory": createIngestTaskMemoryToolHandler(input),
    "recall_memory": async (
      call: ButlerToolCall,
      runtimeContext?: { effectOccurrenceId?: string },
    ) => {
      const bound = bindV2CanonicalConversation(call, input);
      if (isV2BindingFailure(bound)) return bound;
      return call.toolContractVersion === 2
        ? createRecallMemoryToolHandler(bound)(call, runtimeContext)
        : recallMemory(call, runtimeContext);
    },
    "query_memory": async (call: ButlerToolCall) => {
      const bound = bindV2CanonicalConversation(call, input);
      if (isV2BindingFailure(bound)) return bound;
      return call.toolContractVersion === 2
        ? createQueryMemoryToolHandler(bound)(call)
        : queryMemory(call);
    },
    "summarize_user_profile": createSummarizeUserProfileToolHandler(input),
    "update_onboarding_profile": createUpdateOnboardingProfileToolHandler(input),
    "read_conversation_context": createReadConversationContextToolHandler(input),
    "list_conversation_sessions": async (call: ButlerToolCall) => {
      const bound = bindV2CanonicalConversation(call, input);
      if (isV2BindingFailure(bound)) return bound;
      return call.toolContractVersion === 2
        ? createListConversationSessionsToolHandler(bound)(call)
        : listConversationSessions(call);
    },
    "read_conversation_session": async (call: ButlerToolCall) => {
      const bound = bindV2CanonicalConversation(call, input);
      if (isV2BindingFailure(bound)) return bound;
      return call.toolContractVersion === 2
        ? createReadConversationSessionToolHandler(bound)(call)
        : readConversationSession(call);
    },
    "update_explicit_memory": async (
      call: ButlerToolCall,
      runtimeContext?: { effectOccurrenceId?: string },
    ) => {
      const bound = bindCanonicalAuthoredSource(input);
      if (isV2BindingFailure(bound)) return bound;
      const result = await createUpdateExplicitMemoryToolHandler(bound)(
        call,
        runtimeContext,
      );
      return {
        ok: result.ok,
        record_id: result.record_id,
        revision: result.revision,
        operation_id: result.operation_id,
        replayed: result.replayed,
      };
    },
  };
}

function bindCanonicalAuthoredSource(
  input: MemoryToolInput,
): MemoryToolInput | V2BindingFailure {
  const hasSession = Boolean(input.sessionId?.trim());
  const hasTurn = Boolean(input.turnId?.trim());
  if (!hasSession && !hasTurn) {
    return {
      ...input,
      sessionId: undefined,
      turnId: undefined,
      canonicalUserMessageId: undefined,
    };
  }
  if (!hasSession || !hasTurn) return bindingFailure("invalid_scope");
  const bound = bindCanonicalConversation(input);
  if (isV2BindingFailure(bound)) return bound;
  const reader = createLazyConversationProjectionReader({
    butlerData: input.butlerData,
  });
  try {
    if (!reader.isAvailable()) return bindingFailure("backend_unavailable");
    const outcome = reader.readTurnOutcome(bound.turnId!);
    const message = outcome?.request_message_id
      ? reader.readMessageById(outcome.request_message_id)
      : reader.readCurrentUserRequestForTurn(bound.turnId!);
    if (!message || message.role !== "user" || message.session_id !== bound.sessionId ||
      message.turn_id !== bound.turnId || message.origin_kind !== "user_input") {
      return bindingFailure("invalid_scope");
    }
    return { ...bound, canonicalUserMessageId: message.id };
  } catch {
    return bindingFailure("backend_unavailable");
  } finally {
    reader.close();
  }
}

function bindV2CanonicalConversation(
  call: ButlerToolCall,
  input: MemoryToolInput,
): MemoryToolInput | V2BindingFailure {
  if (call.toolContractVersion !== 2) return input;
  return bindCanonicalConversation(input);
}

function bindCanonicalConversation(
  input: MemoryToolInput,
): MemoryToolInput | V2BindingFailure {
  const runtimeSessionId = input.sessionId?.trim();
  const turnId = input.turnId?.trim();
  if (!runtimeSessionId || !turnId) return bindingFailure("invalid_scope");
  const reader = createLazyConversationProjectionReader({
    butlerData: input.butlerData,
  });
  try {
    if (!reader.isAvailable()) return bindingFailure("backend_unavailable");
    const turn = reader.readTurn(turnId);
    if (!turn || turn.id !== turnId) return bindingFailure("invalid_scope");
    const session = reader.getSession(turn.session_id);
    const runtimeProjectId = input.projectId?.trim() || null;
    if (
      !session || session.id !== turn.session_id ||
      session.status !== "active" || session.project_id !== runtimeProjectId ||
      !session.gateway_origin.trim()
    ) return bindingFailure("invalid_scope");
    const binding = reader.getGatewayBindingForConversation(
      session.id,
      session.gateway_origin,
    );
    if (
      !binding || binding.conversation_session_id !== session.id ||
      binding.gateway !== session.gateway_origin ||
      binding.external_session_id !== runtimeSessionId
    ) return bindingFailure("invalid_scope");
    return { ...input, sessionId: session.id, turnId: turn.id };
  } catch {
    return bindingFailure("backend_unavailable");
  } finally {
    reader.close();
  }
}

function bindingFailure(code: V2BindingFailure["code"]): V2BindingFailure {
  return { ok: false, code, diagnostics: [] };
}

function isV2BindingFailure(
  value: MemoryToolInput | V2BindingFailure,
): value is V2BindingFailure {
  return "ok" in value && value.ok === false;
}
