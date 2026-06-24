import { randomUUID } from "crypto";
import type {
  AgentRuntimeAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
  RuntimeTurnResult,
} from "../../test-support/harness/contracts.ts";
import {
  runFunctionToolPromptText,
  runPromptText,
  type FunctionToolPromptOptions,
} from "../../integrations/providers/provider.ts";
import type { WebSearchProvider } from "../../integrations/search/provider.ts";
import {
  getButlerData,
  getButlerHome,
} from "./native/context/runtime-paths.ts";
import {
  resolveRuntimeMessageLanguage,
  type RuntimeMessageLanguage,
} from "../output/messages.ts";
import {
  recallMemory,
  recallMemoryWithVector,
  type AssociativeRecallResult,
} from "../cognition/memory/recall/engine.ts";
import {
  type ContextBudgetOverrides,
} from "../context/budget.ts";
import { recordOperationalMetric } from "../../operations/metrics/operational-metrics.ts";
import {
  throwIfRuntimeTurnAborted,
} from "./native/policy/turn-errors.ts";
import { runNativeToolTurn } from "./native/turn-runner/turn-runner.ts";

export {
  applyCorrectionChallengeGuard,
  applyShortCueRhythmGuard,
  applyShortUtteranceCorrectionGuard,
  applyWebSearchCitationGuard,
  enforceGroundedActionClaims,
} from "../policy/runtime-policy.ts";
export { recentConversationBudgetForTurn } from "./direct-turn-budget.ts";

export interface NativeToolLoopRuntimeOptions {
  runPromptText?: typeof runPromptText;
  runFunctionToolPromptText?: typeof runFunctionToolPromptText;
  executeButlerTool?: FunctionToolPromptOptions["executeTool"];
  butlerHome?: string;
  butlerData?: string;
  appMessageDbPath?: string;
  messageLanguage?: RuntimeMessageLanguage;
  webSearchProvider?: WebSearchProvider;
  recallMemory?: typeof recallMemory;
  recallMemoryWithVector?: typeof recallMemoryWithVector;
  disableAutomaticRecall?: boolean;
  contextBudgetOverrides?: ContextBudgetOverrides;
  recentConversationTokenBudget?: number;
}

// Keep automatic recall within the same latency envelope as vector.ts' default search budget.
const AUTOMATIC_RECALL_VECTOR_TIMEOUT_MS = 1_500;

interface StoredSessionConfig {
  init: RuntimeSessionInit;
}

export class NativeToolLoopRuntime implements AgentRuntimeAdapter {
  readonly id = "native-tool-loop";

  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  private readonly sessions = new Map<string, StoredSessionConfig>();
  private readonly promptRunner: typeof runPromptText;
  private readonly toolPromptRunner: typeof runFunctionToolPromptText;
  private readonly butlerToolExecutor?: FunctionToolPromptOptions["executeTool"];
  private readonly butlerHome: string;
  private readonly butlerData: string;
  private readonly appMessageDbPath?: string;
  private readonly messageLanguage: RuntimeMessageLanguage;
  private readonly webSearchProvider?: WebSearchProvider;
  private readonly recallRunner?: typeof recallMemory;
  private readonly vectorRecallRunner: typeof recallMemoryWithVector;
  private readonly automaticRecallEnabled: boolean;
  private readonly contextBudgetOverrides?: ContextBudgetOverrides;
  private readonly recentConversationTokenBudget?: number;

  constructor(options: NativeToolLoopRuntimeOptions = {}) {
    this.promptRunner = options.runPromptText ?? runPromptText;
    this.toolPromptRunner = options.runFunctionToolPromptText ?? runFunctionToolPromptText;
    this.butlerToolExecutor = options.executeButlerTool;
    this.butlerHome = getButlerHome(options.butlerHome);
    this.butlerData = getButlerData(options.butlerData);
    this.appMessageDbPath = options.appMessageDbPath;
    this.messageLanguage = options.messageLanguage ?? resolveRuntimeMessageLanguage({
      butlerData: this.butlerData,
    });
    this.webSearchProvider = options.webSearchProvider;
    this.recallRunner = options.recallMemory;
    this.vectorRecallRunner = options.recallMemoryWithVector ?? recallMemoryWithVector;
    this.automaticRecallEnabled = options.disableAutomaticRecall !== true;
    this.contextBudgetOverrides = options.contextBudgetOverrides;
    this.recentConversationTokenBudget = options.recentConversationTokenBudget;
  }

  async createSession(input: RuntimeSessionInit): Promise<RuntimeSessionHandle> {
    this.sessions.set(input.sessionId, {
      init: input,
    });

    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `native:${input.sessionId}:${randomUUID()}`,
    };
  }

  private async runAutomaticRecall(input: {
    butlerData: string;
    cue: string;
    projectId?: string;
    limit?: number;
  }): Promise<AssociativeRecallResult> {
    if (this.recallRunner) return this.recallRunner(input);
    return await this.vectorRecallRunner({
      ...input,
      vectorTimeoutMs: AUTOMATIC_RECALL_VECTOR_TIMEOUT_MS,
    });
  }

  async runTurn(input: RuntimeTurnInput): Promise<RuntimeTurnResult> {
    const startedAt = Date.now();
    throwIfRuntimeTurnAborted(input.signal);
    const session = this.sessions.get(input.handle.sessionId);
    if (!session) {
      recordOperationalMetric({
        category: "runtime",
        name: "turn",
        status: "error",
        durationMs: Date.now() - startedAt,
        dimensions: {
          role: input.handle.role,
          runtime: this.id,
          model: input.model,
          errorName: "MissingSession",
        },
      }, { butlerData: this.butlerData });
      throw new Error(`NativeToolLoopRuntime has no stored session for ${input.handle.sessionId}`);
    }
    return await runNativeToolTurn({
      input,
      session,
      startedAt,
      deps: {
        runtimeId: this.id,
        promptRunner: this.promptRunner,
        toolPromptRunner: this.toolPromptRunner,
        butlerToolExecutor: this.butlerToolExecutor,
        butlerHome: this.butlerHome,
        butlerData: this.butlerData,
        appMessageDbPath: this.appMessageDbPath,
        messageLanguage: this.messageLanguage,
        webSearchProvider: this.webSearchProvider,
        contextBudgetOverrides: this.contextBudgetOverrides,
        recentConversationTokenBudget: this.recentConversationTokenBudget,
        automaticRecallEnabled: this.automaticRecallEnabled,
        runAutomaticRecall: async (recallInput) => await this.runAutomaticRecall(recallInput),
      },
    });
  }

  async closeSession(handle: RuntimeSessionHandle): Promise<void> {
    this.sessions.delete(handle.sessionId);
  }
}
