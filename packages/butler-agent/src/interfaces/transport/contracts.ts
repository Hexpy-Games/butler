export type {
  DeliveryResult,
  InboundEnvelope,
  OutboundAction,
  TransportAdapter,
  TransportCapabilities,
} from "../../test-support/harness/contracts.ts";

import type { TransportAdapter } from "../../test-support/harness/contracts.ts";

export type TransportAdapterMap = Record<string, TransportAdapter>;

export function mapTransportAdapters(adapters: TransportAdapter[]): TransportAdapterMap {
  return Object.fromEntries(adapters.map((adapter) => [adapter.id, adapter]));
}
