import type { ConversationContextStoreReader } from "../../conversation/index.ts";
import { compilePromptMaterialContextPlan } from "../../context/conversation-context.ts";
import { defaultRecentConversationTokenBudget } from "../../context/budget.ts";
import { recentConversationTailLimit } from "../turn/recent-conversation-context.ts";

export function renderDelegatedParentConversationContext(input: {
  conversations: ConversationContextStoreReader;
  parentSessionId: string;
  parentTurnId: string;
  modelRef: string;
}): string {
  const session = input.conversations.getSessionByGatewayBinding(
    "app",
    input.parentSessionId,
  );
  if (!session) return "";
  const plan = compilePromptMaterialContextPlan(
    input.conversations.readPromptMaterial({
      sessionId: session.id,
      tailLimit: recentConversationTailLimit(input.modelRef),
    }),
    {
      maxTokens: defaultRecentConversationTokenBudget(input.modelRef),
      excludeTurnId: input.parentTurnId,
      includeTools: false,
    },
  );
  const content = plan.rendered.replace(/^## Recent Conversation\s*/u, "").trim();
  return content ? `## Parent Conversation Context\n${content}` : "";
}
