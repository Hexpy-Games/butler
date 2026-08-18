import type { InboundEnvelope } from "./contracts.ts";
import {
  createAppCancellationEnvelope,
  createAppInboundEnvelope,
  type AppCancellationInput,
  type AppInboundInput,
} from "./app-transport.ts";
import { NativeInboundQueue, type QueuedInboundEvent } from "./inbound-queue.ts";

export interface ButlerServiceClient {
  /**
   * Reconcile an App turn after an enqueue call throws.  This is required on
   * every client because the throw may happen after the durable Native queue
   * write; omitting the lookup would allow the App queue to be terminalized
   * while a Native event is still pending.
   */
  findAppTurn(input: AppInboundInput): QueuedInboundEvent | null;
  enqueueAppTurn(
    input: AppInboundInput,
    metadata?: Record<string, unknown>,
  ): QueuedInboundEvent;
  enqueueAppCancellation(
    input: AppCancellationInput,
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

  findAppTurn(input: AppInboundInput): QueuedInboundEvent | null {
    return this.queue.findIdempotent(createAppInboundEnvelope(input));
  }

  enqueueAppTurn(
    input: AppInboundInput,
    metadata: Record<string, unknown> = {},
  ): QueuedInboundEvent {
    return this.queue.enqueueIdempotent(createAppInboundEnvelope(input), metadata);
  }

  enqueueAppCancellation(
    input: AppCancellationInput,
    metadata: Record<string, unknown> = {},
  ): QueuedInboundEvent {
    return this.queue.enqueueIdempotent(createAppCancellationEnvelope(input), metadata);
  }
}

export function appTurnEnvelope(input: AppInboundInput): InboundEnvelope {
  return createAppInboundEnvelope(input);
}
