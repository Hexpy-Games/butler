import type { BtccGatewayBinding, BtccGatewayRuntime } from "./contracts.ts";

export function bindBtccGatewayRuntime(runtime: BtccGatewayRuntime): BtccGatewayBinding {
  return {
    runtime: runtime.runtime,
    contextDocuments: runtime.contextDocuments,
    observeTurn: runtime.observeTurn.bind(runtime),
  };
}
