import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DeliveryResult,
  InboundEnvelope,
  OutboundAction,
  RuntimeTurnEventInput,
} from "../../../test-support/harness/contracts.ts";
import { createAgentTurnEvent } from "../../../agent/events/turn-events.ts";
import { DeliveryGuard } from "../../transport/delivery-guard.ts";
import {
  APP_TRANSPORT,
} from "../../transport/app/adapter.ts";

export function appTurnEventAction(input: {
  sessionId: string;
  envelope: InboundEnvelope;
  event: RuntimeTurnEventInput;
}): OutboundAction | null {
  if (input.envelope.transport !== APP_TRANSPORT) return null;
  const turnId = input.envelope.routingHints?.turnId?.trim();
  if (!turnId) return null;
  return {
    actionId: `app-turn-event:${turnId}:${input.event.kind}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    transport: APP_TRANSPORT,
    accountId: input.envelope.accountId,
    peer: eventPeer(input.envelope),
    message: {
      text: "",
      replyToMessageId: input.envelope.message.id,
    },
    metadata: {
      kind: "turn_event",
      turnId,
      event: publicTurnEvent({
        sessionId: input.sessionId,
        turnId,
        event: input.event,
      }),
      source: "gateway/native-butler/projection-and-lifecycle.ts#turn-event",
    },
  };
}

export function startupMessage(modelRef: string): string {
  const model = modelRef.includes("/") ? modelRef.split("/", 2)[1] : modelRef;
  return `🔄 Butler started (model: ${model})`;
}

export function statusText(input: {
  sessionId: string;
  modelRef: string;
  butlerData: string;
}): string {
  return [
    "Butler status: online",
    `session: ${input.sessionId}`,
    `model: ${input.modelRef}`,
    `data: ${input.butlerData}`,
  ].join("\n");
}

export function writeStartupGraceMarker(butlerData: string): void {
  mkdirSync(join(butlerData, "state"), { recursive: true });
  writeFileSync(
    join(butlerData, "state", "startup-grace-until"),
    `${Date.now() / 1000 + 45}\n`,
    "utf8",
  );
}

export async function sendStartupNotification(input: {
  butlerHome: string;
  chatId?: string;
  sessionId: string;
  message: string;
  sendTelegram?: (input: {
    chatId: string;
    text: string;
    threadId?: string;
  }) => Promise<DeliveryResult>;
}): Promise<DeliveryResult | undefined> {
  const chatId = input.chatId?.trim();
  if (!chatId) return undefined;
  const { createTelegramTransportAdapter } = await import(
    "../../transport/telegram/adapter.ts",
  );
  const action: OutboundAction = {
    actionId: `telegram-out:${input.sessionId}:startup`,
    transport: "telegram",
    accountId: "default",
    peer: { kind: "group", id: chatId },
    message: { text: input.message },
    metadata: {
      source: "gateway/native-butler/projection-and-lifecycle.ts",
      type: "startup-notification",
    },
  };
  const guard = new DeliveryGuard({
    adapters: [createTelegramTransportAdapter({
      butlerHome: input.butlerHome,
      sendTelegram: input.sendTelegram,
    })],
  });
  return await guard.deliver(input.sessionId, action, {
    source: "gateway/native-butler/projection-and-lifecycle.ts",
    type: "startup-notification",
  });
}

export async function waitForShutdown(input: {
  shutdownFlagPath: string;
  signal?: AbortSignal;
  pollMs: number;
  onPoll?: () => Promise<void>;
}): Promise<"signal" | "flag"> {
  while (true) {
    if (input.signal?.aborted) return "signal";
    if (existsSync(input.shutdownFlagPath)) return "flag";
    await input.onPoll?.();
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
  }
}

function publicTurnEvent(input: {
  sessionId: string;
  turnId: string;
  event: RuntimeTurnEventInput;
}): RuntimeTurnEventInput {
  const normalized = createAgentTurnEvent({
    sessionId: input.sessionId,
    turnId: input.turnId,
    sessionSequence: 1,
    turnSequence: 1,
    kind: input.event.kind,
    visibility: input.event.visibility ?? "public",
    payload: input.event.payload ?? {},
    createdAt: input.event.createdAt,
  });
  return {
    kind: normalized.kind,
    visibility: normalized.visibility,
    createdAt: normalized.createdAt,
    payload: normalized.payload,
  };
}

function eventPeer(envelope: InboundEnvelope): OutboundAction["peer"] {
  if (envelope.peer.kind === "thread") {
    return {
      kind: "thread",
      id: envelope.peer.parentId ?? envelope.peer.id,
      threadId: envelope.peer.id,
    };
  }
  return { kind: envelope.peer.kind, id: envelope.peer.id };
}
