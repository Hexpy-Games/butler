import type {
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../../../test-support/harness/contracts.ts";
import type {
  runFunctionToolPromptText,
  runPromptText,
  FunctionToolPromptOptions,
} from "../../../../integrations/providers/provider.ts";
import type { WebSearchProvider } from "../../../../integrations/search/provider.ts";
import type { RuntimeMessageLanguage } from "../../../output/messages.ts";
import type { ContextBudgetOverrides } from "../../../context/budget.ts";
import type { AssociativeRecallResult } from "../../../cognition/memory/recall/engine.ts";

export interface NativeStoredSessionConfig {
  init: RuntimeSessionInit;
}

export interface NativeTurnRunnerDeps {
  runtimeId: string;
  promptRunner: typeof runPromptText;
  toolPromptRunner: typeof runFunctionToolPromptText;
  butlerToolExecutor?: FunctionToolPromptOptions["executeTool"];
  butlerHome: string;
  butlerData: string;
  appMessageDbPath?: string;
  messageLanguage: RuntimeMessageLanguage;
  webSearchProvider?: WebSearchProvider;
  contextBudgetOverrides?: ContextBudgetOverrides;
  recentConversationTokenBudget?: number;
  automaticRecallEnabled: boolean;
  runAutomaticRecall(input: {
    butlerData: string;
    cue: string;
    projectId?: string;
    limit?: number;
  }): Promise<AssociativeRecallResult>;
}

export interface NativeTurnRunnerInput {
  input: RuntimeTurnInput;
  session: NativeStoredSessionConfig;
  deps: NativeTurnRunnerDeps;
  startedAt: number;
}
