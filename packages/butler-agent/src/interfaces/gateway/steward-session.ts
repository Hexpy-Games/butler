import type { AgentRuntimeAdapter, ModelProviderAdapter } from "../../test-support/harness/contracts.ts";
import type { ConversationWriter } from "../../agent/conversation/types.ts";
import type { BtccInterruptionStateWriter } from "../../agent/conversation/session-admission.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import { BaseGatewaySessionActor } from "./session-actor.ts";

export interface StewardSessionActorOptions {
  sessionId: string;
  store: SessionBindingStore;
  runtime: AgentRuntimeAdapter;
  provider: ModelProviderAdapter;
  systemPrompt: string;
  conversationWriter?: ConversationWriter;
  btccInterruptionStateWriter?: BtccInterruptionStateWriter;
  conversationMetricsButlerData?: string;
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
