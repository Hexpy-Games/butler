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
    return this.queue.enqueue(createAppInboundEnvelope(input), metadata);
  }
}

export function appTurnEnvelope(input: AppInboundInput): InboundEnvelope {
  return createAppInboundEnvelope(input);
}
