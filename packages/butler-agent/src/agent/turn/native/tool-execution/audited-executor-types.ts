import type { FunctionToolPromptOptions } from "../../../../integrations/providers/provider.ts";
import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import type { PublicWorkDecision, ToolAuditEntry } from "../output/tool-types.ts";
import type { PlannedReviewTurnContext } from "../context/planned-review-context.ts";
import type { ToolSurfacePromptController } from "../../tool-surface-prompt-controller.ts";

export type NativeToolCall = Parameters<FunctionToolPromptOptions["executeTool"]>[0];

export interface RuntimeSemanticProgressSafetyNet {
  source: "model" | "runtime" | null;
  listId: string;
  title: string;
  lastExecutionLabel: string;
}

export interface NativeAuditedToolExecutorInput {
  sessionId: string;
  turnId: string;
  audit: ToolAuditEntry[];
  publicDecisionContext: PublicWorkDecision[];
  pendingPublicDecisions: PublicWorkDecision[];
  assistantTextBeforeToolsSeen: () => boolean;
  turnInput: RuntimeTurnInput;
  butlerHome: string;
  butlerData: string;
  appMessageDbPath?: string;
  projectId?: string;
  workspacePath?: string;
  messageLanguage: RuntimeMessageLanguage;
  plannedReview: PlannedReviewTurnContext | null;
  semanticProgressSafetyNet: RuntimeSemanticProgressSafetyNet;
  toolSurfaceController?: ToolSurfacePromptController;
  activeWorkStreamBinding?: () => { contractId: string; workStreamId: string } | null;
  executor: FunctionToolPromptOptions["executeTool"];
}
