import { randomUUID } from "crypto";
import type {
  InboundEnvelope,
  OutboundAction,
  RuntimeTurnInput,
} from "../../../../test-support/harness/contracts.ts";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
} from "../../../../test-support/harness/transcripts.ts";
import type { RuntimeTurnEventInput } from "../../../events/turn-events.ts";
import {
  FIRST_VISIBLE_PROGRESS_EVENT_KIND,
} from "../../../events/turn-events.ts";
import { firstVisibleProgressPayload } from "../../../events/first-visible-progress.ts";
import type { PublicWorkDecision } from "../output/tool-types.ts";
import type { ToolProgressSummary } from "../output/tool-types.ts";
import { todoProgressItemsFromArgs } from "./runtime-semantic-progress.ts";

export function buildIntermediateAction(input: {
  envelope: InboundEnvelope;
  suffix: string;
  text: string;
  metadata?: Record<string, unknown>;
}): OutboundAction {
  return {
    actionId: `runtime-intermediate:${input.envelope.eventId}:${input.suffix}`,
    transport: input.envelope.transport,
    accountId: input.envelope.accountId,
    peer: peerForOutbound(input.envelope),
    message: {
      text: input.text,
      replyToMessageId: input.envelope.message.id,
    },
    metadata: {
      source: "runtime/native-tool-loop.ts",
      kind: "intermediate",
      ...input.metadata,
    },
  };
}

export async function emitIntermediateBestEffort(
  input: RuntimeTurnInput,
  action: OutboundAction,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await input.emitIntermediateDelivery?.(action, metadata);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: input.handle.sessionId,
      kind: "system",
      payload: {
        category: "intermediate_delivery_error",
        message,
        actionId: action.actionId,
      },
      metadata: {
        source: "runtime/native-tool-loop.ts",
      },
    }));
  }
}

export async function emitTurnEventBestEffort(
  input: RuntimeTurnInput,
  event: RuntimeTurnEventInput,
): Promise<void> {
  try {
    await input.emitTurnEvent?.(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendTranscriptEvent(createTranscriptEvent({
      sessionId: input.handle.sessionId,
      kind: "system",
      payload: {
        category: "turn_event_delivery_error",
        message,
        kind: (event as { kind?: unknown }).kind ?? null,
      },
      metadata: {
        source: "runtime/native-tool-loop.ts",
      },
    }));
  }
}

export async function emitTodoProgressBestEffort(input: {
  turnInput: RuntimeTurnInput;
  args: Record<string, unknown>;
}): Promise<void> {
  const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
  if (!inboundEnvelope || !input.turnInput.emitIntermediateDelivery) return;
  const items = todoProgressItemsFromArgs(input.args);
  for (const item of items) {
    await emitIntermediateBestEffort(
      input.turnInput,
      buildIntermediateAction({
        envelope: inboundEnvelope,
        suffix: `todo-progress-${item.id}-${randomUUID().slice(0, 8)}`,
        text: "",
        metadata: {
          kind: "todo_progress",
          todoId: item.id,
          safeLabel: item.label,
          state: item.state,
          safeOrder: item.order,
          ...(item.phase ? { phase: item.phase } : {}),
        },
      }),
      {
        source: "runtime/native-tool-loop.ts#todo-progress",
        kind: "todo_progress",
        todoId: item.id,
        safeLabel: item.label,
        state: item.state,
        safeOrder: item.order,
        ...(item.phase ? { phase: item.phase } : {}),
      },
    );
  }
}

export async function emitDecisionProgressBestEffort(input: {
  turnInput: RuntimeTurnInput;
  decision: PublicWorkDecision;
  state: string;
}): Promise<void> {
  const inboundEnvelope = "eventId" in input.turnInput.input ? input.turnInput.input : null;
  if (!inboundEnvelope || !input.turnInput.emitIntermediateDelivery) return;
  await emitIntermediateBestEffort(
    input.turnInput,
    buildIntermediateAction({
      envelope: inboundEnvelope,
      suffix: `decision-progress-${input.decision.decisionId}-${input.state}`,
      text: "",
      metadata: {
        kind: "todo_progress",
        todoId: input.decision.decisionId,
        safeLabel: input.decision.summary,
        state: input.state,
      },
    }),
    {
      source: "runtime/native-tool-loop.ts#decision-progress",
      kind: "todo_progress",
      todoId: input.decision.decisionId,
      safeLabel: input.decision.summary,
      state: input.state,
    },
  );
}

export async function emitRuntimePreparationProgressBestEffort(input: {
  turnInput: RuntimeTurnInput;
  progress: ToolProgressSummary;
}): Promise<void> {
  await emitTurnEventBestEffort(input.turnInput, {
    kind: FIRST_VISIBLE_PROGRESS_EVENT_KIND,
    payload: firstVisibleProgressPayload({
      note: input.progress.safeLabel,
      source: "runtime-derived",
    }),
  });
}

function peerForOutbound(envelope: InboundEnvelope): OutboundAction["peer"] {
  if (envelope.peer.kind === "thread") {
    return {
      kind: "thread",
      id: envelope.peer.parentId ?? envelope.peer.id,
      threadId: envelope.peer.id,
    };
  }
  return {
    kind: envelope.peer.kind,
    id: envelope.peer.id,
  };
}
