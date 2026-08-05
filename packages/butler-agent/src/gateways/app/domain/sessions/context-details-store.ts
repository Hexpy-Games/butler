import { readCompactionSnapshots } from "../../../../agent/context/compaction.ts";
import {
  estimateContextTokensForModel,
  evaluateWorkingContextBudget,
  resolveContextBudgetConfig,
  WORKING_CONTEXT_AUTO_COMPACT_RATIO,
  WORKING_CONTEXT_HARD_PRESSURE_RATIO,
} from "../../../../agent/context/budget.ts";
import {
  resolveModelMetadata,
  type ProviderModelMetadata,
} from "../../../../integrations/providers/model-catalog.ts";
import { contextWindowTokensForSessionModel } from "../settings/settings-models.ts";
import {
  contextCategory,
  isReservedContextCategory,
  latestLivePromptUsage,
  reconcileOccupiedCategoryTokens,
} from "./context-details-read-model.ts";
import { sessionHintForRow } from "./session-read-model.ts";
import type { ProjectRow } from "../../infrastructure/core/records.ts";
import type {
  ContextDetailsView,
  MessageRecord,
  PersonalizationView,
  SessionArtifactSummary,
  SessionControlState,
  SettingsView,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type { AppMessageFileStore } from "../message-files/message-file-store.ts";

export class AppContextDetailsStore {
  constructor(
    private readonly butlerData: string,
    private readonly messageFiles: AppMessageFileStore,
    private readonly ensureChat: (sessionId: string) => void,
    private readonly getSessionControls: (
      sessionId: string,
    ) => SessionControlState,
    private readonly registeredModelMetadata: () => ProviderModelMetadata[],
    private readonly getSettings: () => SettingsView,
    private readonly getPersonalization: () => PersonalizationView,
    private readonly sessionViewMessages: (
      sessionId: string,
    ) => MessageRecord[],
    private readonly latestTurn: (sessionId: string) => TurnRecord | null,
    private readonly countTurns: (sessionId: string) => number,
    private readonly getProjectForSession: (
      sessionId: string,
    ) => ProjectRow | null,
    private readonly chatKindForSession: (sessionId: string) => string,
    private readonly listArtifacts: (
      sessionId: string,
    ) => SessionArtifactSummary[],
  ) {}

  getContextDetails(sessionId: string): ContextDetailsView {
    this.ensureChat(sessionId);
    const controls = this.getSessionControls(sessionId);
    const metadata = resolveModelMetadata(
      controls.model,
      this.registeredModelMetadata(),
    );
    const settings = this.getSettings();
    const sessionContextWindowTokens = contextWindowTokensForSessionModel(
      settings,
      metadata,
    );
    const budgetConfig = resolveContextBudgetConfig(metadata.model_ref, {
      contextWindowTokens: sessionContextWindowTokens,
    });
    const personalization = this.getPersonalization();
    const runtimeSessionId = sessionHintForRow(sessionId);
    const messages = this.sessionViewMessages(sessionId);
    const latestTurn = this.latestTurn(sessionId);
    const project = this.getProjectForSession(sessionId);
    const latestUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    const livePromptUsage = latestLivePromptUsage({
      butlerData: this.butlerData,
      runtimeSessionId,
      turnId: latestTurn?.id,
      latestTurnStartedAt: latestTurn?.created_at,
      currentModelRef: metadata.model_ref,
    });
    const staticContextTokens = estimateContextTokensForModel(
      "Butler runtime contract, role policy, transport contract, and safety rules.",
      metadata.model_ref,
    ).tokens;
    const liveConfigurationTokens = estimateContextTokensForModel(
      JSON.stringify({
        language: settings.language,
        persona: personalization.persona ? "configured" : "empty",
        eol: personalization.eol ? "configured" : "empty",
        model: metadata.model_ref,
        access_mode: controls.access_mode,
        plan_mode: controls.plan_mode,
      }),
      metadata.model_ref,
    ).tokens;
    const runtimeStateTokens = estimateContextTokensForModel(
      JSON.stringify({
        runtimeSessionId,
        projectId: project?.id ?? null,
        sessionKind: this.chatKindForSession(sessionId),
        turnCount: this.countTurns(sessionId),
      }),
      metadata.model_ref,
    ).tokens;
    const currentInputTokens = estimateContextTokensForModel(
      latestUserMessage?.text ?? "",
      metadata.model_ref,
    ).tokens;
    const recentConversationTokens = estimateContextTokensForModel(
      messages
        .slice(-16)
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n"),
      metadata.model_ref,
    ).tokens;
    const latestCompaction = [
      ...readCompactionSnapshots({
        butlerData: this.butlerData,
        sessionId: runtimeSessionId,
      }),
    ]
      .reverse()
      .find((snapshot) => snapshot.status === "ok");
    const retrievedContextTokens = estimateContextTokensForModel(
      latestCompaction?.summary ?? "",
      metadata.model_ref,
    ).tokens;
    const artifacts = this.listArtifacts(sessionId);
    const messageFiles = this.messageFiles.refsForSession(sessionId);
    const referenceTokens = Math.max(
      0,
      artifacts.length * 48 + messageFiles.length * 24,
    );
    const knownPromptTokens =
      staticContextTokens +
      liveConfigurationTokens +
      runtimeStateTokens +
      retrievedContextTokens +
      currentInputTokens +
      referenceTokens;
    const measuredWorkingContextTokens = livePromptUsage
      ? Math.max(0, livePromptUsage.promptTokens - knownPromptTokens)
      : 0;
    const workingContextTokens = livePromptUsage
      ? measuredWorkingContextTokens
      : recentConversationTokens;
    const workingBudget = evaluateWorkingContextBudget({
      modelRef: metadata.model_ref,
      staticContextTokens,
      liveConfigurationTokens,
      runtimeStateTokens,
      workingContextTokens:
        workingContextTokens +
        retrievedContextTokens +
        currentInputTokens +
        referenceTokens,
      overrides: {
        contextWindowTokens: budgetConfig.contextWindowTokens,
      },
    });
    let categories = [
      contextCategory(
        "static",
        "Static Context",
        staticContextTokens,
        "static_context",
        budgetConfig.contextWindowTokens,
        "Stable runtime and role contract.",
      ),
      contextCategory(
        "live-config",
        "Live Configuration",
        liveConfigurationTokens,
        "live_configuration",
        budgetConfig.contextWindowTokens,
        "Latest EOL, persona, settings, rules, and profile projection.",
      ),
      contextCategory(
        "runtime-state",
        "Runtime State",
        runtimeStateTokens,
        "runtime_state",
        budgetConfig.contextWindowTokens,
        "Protected session, project, transport, BTCC, worker, and task state.",
      ),
      contextCategory(
        "working",
        "Working Context",
        workingContextTokens,
        "working_context",
        budgetConfig.contextWindowTokens,
        "Recent conversation suffix and current turn working material.",
      ),
      contextCategory(
        "retrieved",
        "Retrieved Context",
        retrievedContextTokens,
        "retrieved_context",
        budgetConfig.contextWindowTokens,
        "Hot cache, project memory, and latest compaction summary when present.",
      ),
      contextCategory(
        "current-input",
        "Current User Input",
        currentInputTokens,
        "current_input",
        budgetConfig.contextWindowTokens,
        "Latest inbound message and current attachment references.",
      ),
      contextCategory(
        "references",
        "References",
        referenceTokens,
        "references",
        budgetConfig.contextWindowTokens,
        `${artifacts.length + messageFiles.length} stable local reference(s).`,
      ),
      contextCategory(
        "output-reserve",
        "Output Reserve",
        workingBudget.reservedOutputTokens,
        "output_reserve",
        budgetConfig.contextWindowTokens,
        "Reserved for the assistant response.",
      ),
      contextCategory(
        "tool-reserve",
        "Tool Reserve",
        workingBudget.reservedToolTokens,
        "tool_reserve",
        budgetConfig.contextWindowTokens,
        "Reserved for tool-call and tool-result growth.",
      ),
      contextCategory(
        "compaction-reserve",
        "Compaction Reserve",
        workingBudget.compactionPromptReserveTokens,
        "compaction_reserve",
        budgetConfig.contextWindowTokens,
        "Reserved so auto-compaction can run before hard pressure.",
      ),
    ];
    if (livePromptUsage) {
      categories = reconcileOccupiedCategoryTokens(
        categories,
        livePromptUsage.promptTokens,
      );
    }
    const occupiedCategories = categories.filter(
      (category) => !isReservedContextCategory(category),
    );
    const used = livePromptUsage
      ? livePromptUsage.promptTokens
      : occupiedCategories.reduce((sum, item) => sum + item.used_tokens, 0);
    return {
      session_id: sessionId,
      model_ref: metadata.model_ref,
      provider_id: metadata.provider_id,
      model_id: metadata.model_id,
      token_count_source: livePromptUsage
        ? livePromptUsage.source
        : workingBudget.tokenEstimator,
      used_tokens: used,
      budget_tokens: budgetConfig.contextWindowTokens,
      max_output_tokens: metadata.max_output_tokens,
      available_working_context_tokens:
        workingBudget.availableWorkingContextTokens,
      used_working_context_tokens: workingBudget.workingContextTokens,
      usable_user_message_tokens: workingBudget.usableUserMessageTokens,
      auto_compact_at_tokens: Math.floor(
        workingBudget.availableWorkingContextTokens *
          WORKING_CONTEXT_AUTO_COMPACT_RATIO,
      ),
      hard_pressure_at_tokens: Math.floor(
        workingBudget.availableWorkingContextTokens *
          WORKING_CONTEXT_HARD_PRESSURE_RATIO,
      ),
      ratio: used / budgetConfig.contextWindowTokens,
      status:
        workingBudget.shouldHardPressure || workingBudget.shouldAutoCompact
          ? "high"
          : workingBudget.usedWorkingRatio >= 0.7
            ? "medium"
            : "low",
      categories,
      updated_at: new Date().toISOString(),
    };
  }
}
