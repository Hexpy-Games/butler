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

/**
 * The prompt compiler applies an exact token budget after materialization, but
 * the conversation store must not hydrate the complete canonical tail before
 * that compiler can bound it. Keep this estimate deliberately conservative:
 * it is only a row-count guard, while the compiler remains the authority for
 * rendered prompt capacity. The store also clamps the value to its 200-row
 * maximum, so this path has a stable memory ceiling even without summaries.
 */
const RECENT_CONTEXT_ESTIMATED_TOKENS_PER_MESSAGE = 80;
const MIN_RECENT_CONTEXT_TAIL_MESSAGES = 20;
const MAX_RECENT_CONTEXT_TAIL_MESSAGES = 200;

export function recentConversationTailLimit(modelRef?: string | null): number {
  const tokenBudget = defaultRecentConversationTokenBudget(modelRef);
  return Math.max(
    MIN_RECENT_CONTEXT_TAIL_MESSAGES,
    Math.min(
      MAX_RECENT_CONTEXT_TAIL_MESSAGES,
      Math.ceil(tokenBudget / RECENT_CONTEXT_ESTIMATED_TOKENS_PER_MESSAGE),
    ),
  );
}

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
  const material = store.readPromptMaterial({
    sessionId: session.id,
    tailLimit: recentConversationTailLimit(binding.modelRef),
  });
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
