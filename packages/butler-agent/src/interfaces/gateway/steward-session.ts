import type { AgentRuntimeAdapter, ModelProviderAdapter } from "../../test-support/harness/contracts.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import { BaseGatewaySessionActor } from "./session-actor.ts";

export interface StewardSessionActorOptions {
  sessionId: string;
  store: SessionBindingStore;
  runtime: AgentRuntimeAdapter;
  provider: ModelProviderAdapter;
  systemPrompt: string;
  now?: () => string;
}

export class StewardSessionActor extends BaseGatewaySessionActor {
  constructor(options: StewardSessionActorOptions) {
    super({
      ...options,
      role: "steward",
    });
  }
}
