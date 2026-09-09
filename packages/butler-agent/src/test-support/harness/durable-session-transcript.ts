import type {
  DeliveryResult,
  InboundEnvelope,
  OutboundAction,
  SessionLifecycleState,
  SessionRole,
} from "./contracts.ts";
import { appendTranscriptEvent, createTranscriptEvent, type TranscriptEvent } from "./transcripts.ts";

type DurableSessionRole = SessionRole;

export interface DurableInboundTranscriptInput {
  sessionId: string;
  envelope: InboundEnvelope;
  route?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface DurableOutboundTranscriptInput {
  sessionId: string;
  action: OutboundAction;
  delivery?: DeliveryResult;
  metadata?: Record<string, unknown>;
  timestamp?: string;
  butlerData?: string;
}

export interface DurableSessionLifecycleInput {
  sessionId: string;
  role: DurableSessionRole;
  state: SessionLifecycleState;
  reason?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export interface DurableSystemEventInput {
  sessionId: string;
  category: string;
  message?: string;
  statusCode?: number;
  details?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

function appendEvents(events: TranscriptEvent[], butlerData?: string): TranscriptEvent[] {
  for (const event of events) {
    appendTranscriptEvent(event, butlerData);
  }
  return events;
}

export function recordDurableInbound(input: DurableInboundTranscriptInput): TranscriptEvent[] {
  return appendEvents([
    createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "inbound",
      timestamp: input.timestamp,
      transport: input.envelope.transport,
      payload: {
        eventId: input.envelope.eventId,
        accountId: input.envelope.accountId,
        peer: input.envelope.peer,
        sender: input.envelope.sender,
        message: input.envelope.message,
        routingHints: input.envelope.routingHints ?? null,
        route: input.route ?? null,
      },
      metadata: input.metadata,
    }),
  ]);
}

export function recordDurableOutbound(input: DurableOutboundTranscriptInput): TranscriptEvent[] {
  const events = [
    createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "outbound",
      timestamp: input.timestamp,
      transport: input.action.transport,
      payload: {
        actionId: input.action.actionId,
        accountId: input.action.accountId,
        peer: input.action.peer,
        message: input.action.message,
        metadata: input.action.metadata ?? null,
      },
      metadata: input.metadata,
    }),
  ];

  if (input.delivery) {
    events.push(
        createTranscriptEvent({
          sessionId: input.sessionId,
          kind: "delivery",
          timestamp: input.timestamp,
          transport: input.action.transport,
          payload: {
            actionId: input.action.actionId,
          ok: input.delivery.ok,
          transportMessageId: input.delivery.transportMessageId ?? null,
          error: input.delivery.error ?? null,
          raw: input.delivery.raw ?? null,
        },
        metadata: input.metadata,
      }),
    );
  }

  return appendEvents(events, input.butlerData);
}

export function recordSessionLifecycle(input: DurableSessionLifecycleInput): TranscriptEvent[] {
  return appendEvents([
    createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "session_status",
      timestamp: input.timestamp,
      payload: {
        role: input.role,
        state: input.state,
        reason: input.reason ?? null,
      },
      metadata: input.metadata,
    }),
  ]);
}

export function recordSystemEvent(input: DurableSystemEventInput): TranscriptEvent[] {
  return appendEvents([
    createTranscriptEvent({
      sessionId: input.sessionId,
      kind: "system",
      timestamp: input.timestamp,
      payload: {
        category: input.category,
        message: input.message ?? null,
        status_code: input.statusCode ?? null,
        details: input.details ?? null,
      },
      metadata: input.metadata,
    }),
  ]);
}
