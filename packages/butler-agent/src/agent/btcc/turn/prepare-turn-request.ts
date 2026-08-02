import type {
  AdmittedModelSelection,
  ButlerContextInput,
  BtccProgressDestination,
  BtccTurnRequest,
  FreshBtccTurnCommand,
} from "../contracts.ts";
import type {
  AttachmentRef,
  InboundEnvelope,
} from "../../../gateways/core/contracts.ts";
import type { StoredSessionBinding } from
  "../../../test-support/harness/contracts.ts";
import type { TurnRecord } from "./contracts.ts";
import type { StableTurnRequestIdentity } from "./load-or-admit-turn.ts";

export function requestIdentityForRequest(
  request: BtccTurnRequest,
): StableTurnRequestIdentity {
  if (request.trigger.kind === "user_message") {
    return {
      sessionId: request.sessionId,
      triggerKey: request.eventId,
      messageId: request.message.id,
      content: request.message.content,
    };
  }
  return {
    sessionId: request.sessionId,
    triggerKey: request.eventId,
    messageId: request.trigger.triggerId,
    content: request.message.content,
    wake: {
      triggerId: request.trigger.triggerId,
      sourceTurnId: request.trigger.sourceTurnId,
      authorizationRef: request.trigger.authorizationRef,
      ...(request.trigger.resultScopeRef
        ? { resultScopeRef: request.trigger.resultScopeRef }
        : {}),
    },
  };
}

export function replayBinding(
  turn: TurnRecord,
  request: BtccTurnRequest,
): StoredSessionBinding {
  const executionPolicy = turn.context.executionPolicy;
  const modelRef = `${turn.modelSelection.provider}/${turn.modelSelection.model}` as StoredSessionBinding["modelRef"];
  return {
    sessionId: turn.sessionId,
    role: executionPolicy?.role === "steward" ? "steward" : "butler",
    ...(turn.context.projectRef ? { projectId: turn.context.projectRef } : {}),
    workspacePath: executionPolicy?.workspacePath ?? "",
    runtimeAdapterId: "btcc-turn-runtime",
    modelProviderId: turn.modelSelection.provider,
    modelRef,
    transportBindings: [],
    lifecycleState: "active",
    createdAt: request.message.timestamp,
    updatedAt: request.message.timestamp,
    metadata: {
      accessMode: executionPolicy?.accessMode ?? "read_only",
      reasoning_effort: turn.modelSelection.reasoningEffort,
    },
  };
}

export function commandFor(
  request: BtccTurnRequest,
  modelSelection: AdmittedModelSelection,
  context: ButlerContextInput,
): FreshBtccTurnCommand {
  if (request.trigger.kind === "authorized_wake") {
    return {
      kind: "wake",
      turnId: request.turnId,
      sessionId: request.sessionId,
      triggerKey: request.eventId,
      trigger: {
        triggerId: request.trigger.triggerId,
        sourceTurnId: request.trigger.sourceTurnId,
        authorizationRef: request.trigger.authorizationRef,
        ...(request.trigger.resultScopeRef
          ? { resultScopeRef: request.trigger.resultScopeRef }
          : {}),
        content: request.message.content,
      },
      modelSelection,
      progressDestination: destinationForRequest(request),
      context: request.trigger.resultScopeRef
        ? {
            ...context,
            baselineObservationScopeRefs: [
              ...new Set([
                ...context.baselineObservationScopeRefs,
                request.trigger.resultScopeRef,
              ]),
            ],
          }
        : context,
    };
  }
  return {
    kind: "run",
    turnId: request.turnId,
    sessionId: request.sessionId,
    triggerKey: request.eventId,
    message: {
      messageId: request.message.id,
      content: request.message.content,
    },
    modelSelection,
    progressDestination: destinationForRequest(request),
    context,
  };
}

function destinationForRequest(request: BtccTurnRequest): BtccProgressDestination {
  return request.progressDestination ?? {
    transport: request.transport,
    accountId: request.accountId,
    peer: { ...request.peer },
    replyToMessageId: request.message.id,
  };
}

export function inboundEnvelopeFor(request: BtccTurnRequest): InboundEnvelope {
  return {
    eventId: request.eventId,
    signal: request.signal,
    transport: request.transport,
    accountId: request.accountId,
    peer: request.peer,
    sender: request.sender,
    message: {
      id: request.message.id,
      text: request.message.content,
      timestamp: request.message.timestamp,
      ...(request.message.attachments
        ? { attachments: request.message.attachments as AttachmentRef[] }
        : {}),
    },
    routingHints: {
      sessionId: request.sessionId,
      ...(request.route.projectId ? { projectId: request.route.projectId } : {}),
      turnId: request.turnId,
    },
  };
}
