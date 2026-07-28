import { recordDurableOutbound } from "../../test-support/harness/durable-session-transcript.ts";
import type { DeliveryResult, OutboundAction, TransportAdapter } from "../../test-support/harness/contracts.ts";
import { mapTransportAdapters, type TransportAdapterMap } from "./contracts.ts";

export interface DeliveryGuardOptions {
  adapters: TransportAdapter[] | TransportAdapterMap;
  maxAttempts?: number;
  butlerData?: string;
}

export interface DeliveryAttemptResult extends DeliveryResult {
  actionId: string;
  duplicate?: boolean;
}

function toAdapterMap(input: DeliveryGuardOptions["adapters"]): TransportAdapterMap {
  return Array.isArray(input) ? mapTransportAdapters(input) : input;
}

export class DeliveryGuard {
  private readonly adapters: TransportAdapterMap;
  private readonly deliveredKeys = new Set<string>();
  private readonly maxAttempts: number;
  private readonly butlerData?: string;

  constructor(options: DeliveryGuardOptions) {
    this.adapters = toAdapterMap(options.adapters);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 1);
    this.butlerData = options.butlerData;
  }

  async deliver(
    sessionId: string,
    action: OutboundAction,
    metadata?: Record<string, unknown>,
  ): Promise<DeliveryAttemptResult> {
    const dedupeKey = `${sessionId}\u0000${action.actionId}`;
    if (this.deliveredKeys.has(dedupeKey)) {
      return {
        actionId: action.actionId,
        ok: true,
        duplicate: true,
      };
    }

    const adapter = this.adapters[action.transport];
    if (adapter && isMetadataOnlyActivity(action) && !adapter.capabilities.supportsActivityEvents) {
      const delivery = { ok: true };
      this.deliveredKeys.add(dedupeKey);
      recordDurableOutbound({
        sessionId,
        action,
        delivery,
        butlerData: this.butlerData,
        metadata: {
          source: "transport/delivery-guard.ts",
          attempts: 0,
          skippedAdapterSend: true,
          reason: "metadata_only_activity",
          ...(metadata ?? {}),
        },
      });
      return {
        actionId: action.actionId,
        ok: true,
      };
    }

    let delivery = adapter
      ? await this.sendSafely(adapter, action)
      : {
          ok: false,
          error: `No transport adapter registered for ${action.transport}`,
        };
    let attempts = 1;

    while (adapter && !delivery.ok && attempts < this.maxAttempts) {
      attempts += 1;
      delivery = await this.sendSafely(adapter, action);
    }

    if (delivery.ok) {
      this.deliveredKeys.add(dedupeKey);
    }

    recordDurableOutbound({
      sessionId,
      action,
      delivery,
      butlerData: this.butlerData,
      metadata: {
        source: "transport/delivery-guard.ts",
        attempts,
        ...(metadata ?? {}),
      },
    });

    return {
      actionId: action.actionId,
      ok: delivery.ok,
      error: delivery.error,
      raw: delivery.raw,
      transportMessageId: delivery.transportMessageId,
    };
  }

  private async sendSafely(adapter: TransportAdapter, action: OutboundAction): Promise<DeliveryResult> {
    try {
      return await adapter.send(action);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deliverAll(
    sessionId: string,
    actions: OutboundAction[],
    metadata?: Record<string, unknown>,
  ): Promise<DeliveryAttemptResult[]> {
    const results: DeliveryAttemptResult[] = [];
    for (const action of actions) {
      results.push(await this.deliver(sessionId, action, metadata));
    }
    return results;
  }
}

function isMetadataOnlyActivity(action: OutboundAction): boolean {
  const hasVisibleText = Boolean(action.message.text?.trim());
  const hasAttachments = Boolean(action.message.attachments?.length);
  const kind = action.metadata?.kind;
  return !hasVisibleText &&
    !hasAttachments &&
    !action.presence &&
    (kind === "tool_progress" || kind === "turn_event");
}
