import {
  compilePromptMaterialContextPlan,
} from "../../context/conversation-context.ts";
import { defaultRecentConversationTokenBudget } from "../../context/budget.ts";
import type { ConversationContextStoreReader } from
  "../../conversation/index.ts";
import type {
  ContextAssembly,
  PromptSection,
} from "../../prompt/prompt-assembler.ts";
import type { InboundEnvelope } from
  "../../../gateways/core/contracts.ts";
import type { StoredSessionBinding } from
  "../../../test-support/harness/contracts.ts";

export function includeRecentContext(
  store: ConversationContextStoreReader,
  binding: StoredSessionBinding,
  envelope: InboundEnvelope,
  assembly: ContextAssembly,
): ContextAssembly {
  const session = store.getSessionByGatewayBinding(
    envelope.transport,
    binding.sessionId,
  );
  if (!session) return assembly;
  const material = store.readPromptMaterial({ sessionId: session.id });
  const plan = compilePromptMaterialContextPlan(material, {
    maxTokens: defaultRecentConversationTokenBudget(binding.modelRef),
    excludeSourceRef: envelope.eventId,
  });
  const content = plan.rendered.replace(/^## Recent Conversation\s*/u, "").trim();
  if (!content) return assembly;
  const section: PromptSection = {
    id: "recent-conversation",
    title: "Recent Conversation",
    content,
    region: "working_context",
    projectionClass: "mandatory_hot_cache",
    scopeKind: "session",
  };
  return {
    ...assembly,
    workingContext: [...assembly.workingContext, section],
  };
}
