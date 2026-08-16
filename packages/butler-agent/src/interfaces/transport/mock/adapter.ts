import type { DeliveryResult, InboundEnvelope, OutboundAction, TransportAdapter } from "../../../test-support/harness/contracts.ts";

export interface MockTransportAdapterOptions {
  id?: string;
  onSend?: (action: OutboundAction) => Promise<DeliveryResult> | DeliveryResult;
}

export class MockTransportAdapter implements TransportAdapter {
  readonly id: string;

  readonly capabilities = {
    supportsThreads: true,
    supportsMessageEdit: true,
    supportsReactions: false,
    supportsAttachments: true,
    supportsStreamingEdits: false,
    supportsPresence: true,
    supportsActivityEvents: true,
    supportsProgressDrafts: true,
    supportsFinalAggregateOnly: false,
  } as const;

  readonly sentActions: OutboundAction[] = [];
  private onEvent?: (event: InboundEnvelope) => Promise<void>;
  private readonly onSend?: MockTransportAdapterOptions["onSend"];

  constructor(options: MockTransportAdapterOptions = {}) {
    this.id = options.id ?? "mock";
    this.onSend = options.onSend;
  }

  async start(onEvent: (event: InboundEnvelope) => Promise<void>): Promise<void> {
    this.onEvent = onEvent;
  }

  async emit(event: InboundEnvelope): Promise<void> {
    if (!this.onEvent) {
      throw new Error(`MockTransportAdapter ${this.id} has not been started`);
    }
    await this.onEvent(event);
  }

  async send(action: OutboundAction): Promise<DeliveryResult> {
    if (action.transport !== this.id) {
      return {
        ok: false,
        error: `transport_mismatch:${action.transport}`,
      };
    }
    this.sentActions.push(action);
    if (this.onSend) {
      return await this.onSend(action);
    }
    return {
      ok: true,
      transportMessageId: `${this.id}:${this.sentActions.length}`,
    };
  }
}
