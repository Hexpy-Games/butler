import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DeliveryResult, InboundEnvelope } from
  "../test-support/harness/contracts.ts";
import { readTranscript } from "../test-support/harness/transcripts.ts";
import { NativeInboundQueue } from "../gateways/core/inbound-queue.ts";

export interface NativeStewardTelegramTurnInput {
  projectName: string;
  workspacePath: string;
  message: string;
  chatId: string;
  threadId?: string;
  messageId?: string;
  senderId?: string;
  senderDisplayName?: string;
  butlerHome?: string;
  butlerData?: string;
}

export interface NativeStewardTelegramTurnResult {
  sessionId: string;
  text: string;
  delivery: DeliveryResult;
}

const COMPLETION_TIMEOUT_MS = 120_000;

function getButlerData(explicit?: string): string {
  return explicit || process.env.BUTLER_DATA || join(homedir(), ".butler");
}

function makeSessionId(projectName: string): string {
  return `steward/${projectName.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

function buildEnvelope(input: NativeStewardTelegramTurnInput): InboundEnvelope {
  const timestamp = new Date().toISOString();
  return {
    eventId: `telegram:${input.chatId}:${input.threadId ?? "main"}:${input.messageId ?? timestamp}`,
    transport: "telegram",
    accountId: "default",
    peer: input.threadId
      ? { kind: "thread", id: input.threadId, parentId: input.chatId }
      : { kind: "group", id: input.chatId },
    sender: {
      id: input.senderId?.trim() || "telegram-user",
      displayName: input.senderDisplayName?.trim() || undefined,
    },
    message: {
      id: input.messageId?.trim() || `msg-${timestamp}`,
      text: input.message,
      timestamp,
    },
    routingHints: {
      projectId: input.projectName,
      stewardId: makeSessionId(input.projectName),
    },
    nativeStewardContext: {
      version: 1,
      projectName: input.projectName,
      workspacePath: input.workspacePath,
    },
  };
}

export async function handleNativeStewardTelegramTurn(
  input: NativeStewardTelegramTurnInput,
): Promise<NativeStewardTelegramTurnResult> {
  const butlerData = getButlerData(input.butlerData);
  const sessionId = makeSessionId(input.projectName);
  const queue = new NativeInboundQueue(butlerData);
  const queued = queue.enqueue(buildEnvelope(input), {
    source: "application/native-steward.ts",
    completionAuthority: "delivery-guard-transcript",
  });
  return await waitForTranscriptCompletion({
    butlerData,
    sessionId,
    queueId: queued.queueId,
  });
}

async function waitForTranscriptCompletion(input: {
  butlerData: string;
  sessionId: string;
  queueId: string;
}): Promise<NativeStewardTelegramTurnResult> {
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const events = readTranscript(input.sessionId, input.butlerData);
    const outbound = events.find((event) => {
      const metadata = event.payload.metadata;
      const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as Record<string, unknown>
        : null;
      return event.kind === "outbound" && record?.queueId === input.queueId &&
        record.kind === "final_result";
    });
    const actionId = typeof outbound?.payload.actionId === "string"
      ? outbound.payload.actionId
      : null;
    if (outbound && actionId) {
      const delivery = events.find((event) =>
        event.kind === "delivery" && event.payload.actionId === actionId,
      );
      if (delivery) {
        const message = outbound.payload.message;
        const record = message && typeof message === "object" && !Array.isArray(message)
          ? message as Record<string, unknown>
          : null;
        const text = typeof record?.text === "string"
          ? record.text
          : "";
        return {
          sessionId: input.sessionId,
          text,
          delivery: {
            ok: delivery.payload.ok === true,
            error: typeof delivery.payload.error === "string" ? delivery.payload.error : undefined,
            transportMessageId: typeof delivery.payload.transportMessageId === "string"
              ? delivery.payload.transportMessageId
              : undefined,
            raw: delivery.payload.raw,
          },
        };
      }
    }
    if (existsSync(join(input.butlerData, "runtime", "inbound-events", "failed", `${input.queueId}.json`))) {
      throw new Error("native_steward_queue_failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("native_steward_transcript_completion_timeout");
}
