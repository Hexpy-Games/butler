import {
  compilePromptMaterialContextPlan,
} from "../../../../agent/context/conversation-context.ts";
import { defaultRecentConversationTokenBudget } from
  "../../../../agent/context/budget.ts";
import { ConversationAdmissionTurn } from
  "../../../../agent/conversation/session-admission.ts";
import type {
  ConversationContextStoreReader,
  ConversationWriter,
} from "../../../../agent/conversation/types.ts";
import type { RuntimeTurnEventInput } from
  "../../../../agent/events/turn-events.ts";
import type {
  ContextAssembly,
  PromptSection,
} from "../../../../agent/prompt/prompt-assembler.ts";
import type {
  InboundEnvelope,
  StoredSessionBinding,
} from "../../../../test-support/harness/contracts.ts";

export type GatewayConversationStore = ConversationWriter &
  ConversationContextStoreReader;

export class GatewayConversationTurn {
  private constructor(
    private readonly admission: ConversationAdmissionTurn,
    private readonly store: GatewayConversationStore,
    private readonly binding: StoredSessionBinding,
    private readonly envelope: InboundEnvelope,
    private readonly turnId: string,
  ) {}

  static begin(input: {
    store: GatewayConversationStore;
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    turnId: string;
    butlerData: string;
  }): GatewayConversationTurn {
    const admission = ConversationAdmissionTurn.begin({
      writer: input.store,
      binding: input.binding,
      envelope: input.envelope,
      turnId: input.turnId,
      timestamp: input.envelope.message.timestamp,
      butlerData: input.butlerData,
    });
    admission.admitInbound();
    return new GatewayConversationTurn(
      admission,
      input.store,
      input.binding,
      input.envelope,
      input.turnId,
    );
  }

  includeRecentContext(assembly: ContextAssembly): ContextAssembly {
    const section = this.recentContextSection();
    if (!section) return assembly;
    return {
      ...assembly,
      workingContext: [...assembly.workingContext, section],
    };
  }

  admitTurnEvent(event: RuntimeTurnEventInput): void {
    this.admission.admitTurnEvent(event);
  }

  complete(text: string): void {
    this.admission.admitFinalAssistant(text, `btcc-final:${this.turnId}`);
    this.admission.finalize("complete", new Date().toISOString());
  }

  cancel(): void {
    this.admission.finalize("aborted", new Date().toISOString());
  }

  private recentContextSection(): PromptSection | null {
    const provenance = this.admission.provenance();
    if (!provenance) return null;
    const material = this.store.readPromptMaterial({
      sessionId: provenance.conversationSessionId,
    });
    const plan = compilePromptMaterialContextPlan(material, {
      maxTokens: defaultRecentConversationTokenBudget(this.binding.modelRef),
      excludeSourceRef: this.envelope.eventId,
    });
    const content = plan.rendered.replace(/^## Recent Conversation\s*/u, "").trim();
    if (!content) return null;
    return {
      id: "recent-conversation",
      title: "Recent Conversation",
      content,
      region: "working_context",
      projectionClass: "mandatory_hot_cache",
      scopeKind: "session",
    };
  }
}
