import type { InboundEnvelope } from "./contracts.ts";
import { createAppInboundEnvelope, type AppInboundInput } from "./app-transport.ts";
import { NativeInboundQueue, type QueuedInboundEvent } from "./inbound-queue.ts";

export interface ButlerServiceClient {
  enqueueAppTurn(
    input: AppInboundInput,
    metadata?: Record<string, unknown>,
  ): QueuedInboundEvent;
}

export interface FileQueueButlerServiceClientOptions {
  butlerData: string;
}

export class FileQueueButlerServiceClient implements ButlerServiceClient {
  private readonly queue: NativeInboundQueue;

  constructor(options: FileQueueButlerServiceClientOptions) {
    this.queue = new NativeInboundQueue(options.butlerData);
  }

  enqueueAppTurn(
    input: AppInboundInput,
    metadata: Record<string, unknown> = {},
  ): QueuedInboundEvent {
    const idempotencyKey = typeof metadata.idempotencyKey === "string"
      ? metadata.idempotencyKey.trim()
      : "";
    return idempotencyKey
      ? this.queue.enqueueIdempotent(
        createAppInboundEnvelope(input),
        metadata,
        idempotencyKey,
        new Date(input.timestamp),
      )
      : this.queue.enqueue(createAppInboundEnvelope(input), metadata);
  }
}

export function appTurnEnvelope(input: AppInboundInput): InboundEnvelope {
  return createAppInboundEnvelope(input);
}
