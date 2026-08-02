import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DeliveryResult,
  OutboundAction,
} from "../../../test-support/harness/contracts.ts";
import type {
  BtccCommittedProgressEvent,
  BtccTurnProgressPublisher,
} from "../../../agent/btcc/index.ts";
import { createAgentTurnEvent } from "../../../agent/events/turn-events.ts";
import { DeliveryGuard } from "../../transport/delivery-guard.ts";
import {
  APP_TRANSPORT,
} from "../../transport/app/adapter.ts";

const TELEGRAM_TRANSPORT = "telegram";

export function appTurnEventAction(input: {
  event: BtccCommittedProgressEvent;
}): OutboundAction | null {
  if (input.event.destination.transport !== APP_TRANSPORT) return null;
  return {
    actionId: input.event.actionId,
    transport: APP_TRANSPORT,
    accountId: input.event.destination.accountId,
    peer: eventPeer(input.event.destination.peer),
    message: {
      text: "",
      replyToMessageId: input.event.destination.replyToMessageId,
    },
    metadata: {
      kind: "turn_event",
      turnId: input.event.turnId,
      event: publicTurnEvent({
        sessionId: input.event.sessionId,
        turnId: input.event.turnId,
        committed: input.event,
      }),
      source: "gateway/native-butler/projection-and-lifecycle.ts#turn-event",
    },
  };
}

export function createNativeButlerProgressPublisher(input: {
  deliver: (
    sessionId: string,
    action: OutboundAction,
    metadata: Record<string, unknown>,
  ) => Promise<DeliveryResult>;
}): BtccTurnProgressPublisher {
  return {
    async publish(event): Promise<void> {
      if (event.destination.transport === TELEGRAM_TRANSPORT) return;

      const action = appTurnEventAction({ event });
      if (!action) {
        throw new Error(`No enabled progress publisher for ${event.destination.transport}`);
      }
      const delivery = await input.deliver(event.sessionId, action, {
        source: "gateway/native-butler/projection-and-lifecycle.ts#progress",
        kind: "turn_event",
        turnId: event.turnId,
        eventId: event.eventId,
        actionId: event.actionId,
        sessionSequence: event.sessionSequence,
        turnSequence: event.turnSequence,
      });
      if (!delivery.ok) {
        throw new Error(delivery.error || "BTCC progress delivery failed");
      }
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
  committed: BtccCommittedProgressEvent;
}): Record<string, unknown> {
  const event = input.committed.event;
  const normalized = createAgentTurnEvent({
    id: input.committed.eventId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    sessionSequence: input.committed.sessionSequence,
    turnSequence: input.committed.turnSequence,
    kind: event.kind,
    visibility: event.visibility ?? "public",
    payload: event.payload ?? {},
    createdAt: event.createdAt,
  });
  return {
    id: normalized.id,
    kind: normalized.kind,
    visibility: normalized.visibility,
    sessionSequence: normalized.sessionSequence,
    turnSequence: normalized.turnSequence,
    createdAt: normalized.createdAt,
    payload: normalized.payload,
  };
}

function eventPeer(
  peer: BtccCommittedProgressEvent["destination"]["peer"],
): OutboundAction["peer"] {
  if (peer.kind === "thread") {
    return {
      kind: "thread",
      id: peer.parentId ?? peer.id,
      threadId: peer.id,
    };
  }
  return { kind: peer.kind, id: peer.id };
}
